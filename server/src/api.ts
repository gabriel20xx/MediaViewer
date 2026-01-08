import path from 'node:path';
import fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import { spawn } from 'node:child_process';
import express from 'express';
import mime from 'mime-types';
import { upsertMediaFromDisk } from './mediaScanner.js';
import { loadFunscriptIfExists } from './funscript.js';
import type { Db } from './db.js';
import { getPlaybackState, getSyncPlaybackState, upsertPlaybackState, upsertSyncPlaybackState } from './runtimeState.js';
import { probeDurationMsWithFfprobe } from './ffprobe.js';

import { generateThumbnail, CACHE_DIR } from './thumbnails/generator.js';

// Global scan progress tracker
let scanProgress = { isScanning: false, scanned: 0, total: 0, message: '' };

// Throttled scan logging (avoid spamming console)
let lastScanLogAtMs = 0;
let lastScanLogScanned = 0;
let lastScanLogMessage = '';

function logScanProgressThrottled(scanned: number, message: string) {
  try {
    const now = Date.now();
    const msg = String(message || '').trim();
    const sc = Math.max(0, Math.round(Number(scanned) || 0));

    const messageChanged = msg && msg !== lastScanLogMessage;
    const scannedJump = sc - lastScanLogScanned;
    const minIntervalMs = 2500;
    const minScannedDelta = 250;

    const shouldLog =
      messageChanged ||
      (scannedJump >= minScannedDelta) ||
      (now - lastScanLogAtMs >= minIntervalMs && scannedJump >= 50);

    if (!shouldLog) return;

    lastScanLogAtMs = now;
    lastScanLogScanned = sc;
    if (msg) lastScanLogMessage = msg;

    // eslint-disable-next-line no-console
    console.log(`[MediaViewer] Scan: ${msg || 'Scanning...'} (${sc} files)`);
  } catch {
    // ignore
  }
}



export function buildApiRouter(opts: {
  db: Db;
  mediaRoot: string;
  onVrStream?: (info: {
    sessionId: string;
    mediaId: string;
    fromClientId: string;
    userAgent: string;
    ipAddress: string;
    timeMs: number;
    paused: boolean;
    fps: number;
    frame: number;
  }) => Promise<void> | void;
}) {
  const { db, mediaRoot } = opts;
  const router = express.Router();

  // Deduplicate per (sessionId, vr client) so Range requests don't spam sync.
  const lastVrStreamMediaByClient = new Map<string, string>();

  // DeoVR doesn't send explicit playback events. We approximate play/pause/time based on
  // ongoing stream Range requests (heartbeat):
  // - When requests start/resume, mark playing and advance timeMs by wall-clock.
  // - When requests stop for a short period, mark paused.
  type DeovrPlaybackState = {
    sessionId: string;
    fromClientId: string;
    ipAddress: string;
    userAgent: string;
    mediaId: string;
    startedAtMs: number;
    lastSeenAtMs: number;
    lastPublishAtMs: number;
    lastTimeMs: number;
    paused: boolean;
    inFlight: number;
    pauseTimer: NodeJS.Timeout | null;
    // For long-lived streams where the request stays open.
    lastDataAtMs: number;
    tickTimer: NodeJS.Timeout | null;
    idleTimer: NodeJS.Timeout | null;
  };

  const deovrPlaybackByKey = new Map<
    string,
    DeovrPlaybackState
  >();

  const DEOVR_FPS = 30;
  const DEOVR_PUBLISH_MIN_MS = 750;
  const DEOVR_FORGET_MS = 60_000;

  // How quickly we treat "no active stream" as paused.
  // Keeping this very small makes the desktop pause essentially instantly when DeoVR stops/ closes.
  const DEOVR_INSTANT_PAUSE_DEBOUNCE_MS = 125;

  // If DeoVR keeps a single request open, in-flight counting never drops to zero.
  // In that case we infer pause when the server stops being able to push bytes
  // (backpressure) for a short period.
  const DEOVR_IDLE_PAUSE_MS = 650;

  // For long-lived streams, publish time periodically so desktop can follow.
  const DEOVR_TICK_MS = 1000;

  // Background cleanup (forget dead clients). Pause detection is handled by request close events.
  setInterval(() => {
    const now = Date.now();
    for (const [key, st] of Array.from(deovrPlaybackByKey.entries())) {
      if (!st) {
        deovrPlaybackByKey.delete(key);
        continue;
      }
      const age = now - (st.lastSeenAtMs || 0);
      if (age > DEOVR_FORGET_MS) {
        try {
          if (st.pauseTimer) clearTimeout(st.pauseTimer);
          if (st.tickTimer) clearInterval(st.tickTimer);
          if (st.idleTimer) clearInterval(st.idleTimer);
        } catch {}
        deovrPlaybackByKey.delete(key);
      }
    }
  }, 5000).unref?.();

  function normalizeIp(ip: string): string {
    // Express may provide ::ffff:1.2.3.4 or ::1
    return String(ip || '').replace(/^::ffff:/, '').trim() || 'unknown';
  }

  function getClientIp(req: express.Request): string {
    const xff = String(req.get('x-forwarded-for') || '').trim();
    if (xff) {
      const first = xff.split(',')[0]?.trim();
      if (first) return normalizeIp(first);
    }
    return normalizeIp(String(req.ip || (req.socket as any)?.remoteAddress || ''));
  }

  router.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  router.post('/cache/clear', async (_req, res) => {
    try {
      // Clear the thumbnail cache directory
      await fs.rm(CACHE_DIR, { recursive: true, force: true });
      await fs.mkdir(CACHE_DIR, { recursive: true });
      res.json({ ok: true, message: 'Cache cleared' });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/scan', async (_req, res) => {
    if (scanProgress.isScanning) {
      return res.status(409).json({ error: 'Scan already in progress' });
    }
    
    scanProgress = { isScanning: true, scanned: 0, total: 0, message: 'Starting scan...' };

    lastScanLogAtMs = 0;
    lastScanLogScanned = 0;
    lastScanLogMessage = '';
    // eslint-disable-next-line no-console
    console.log('[MediaViewer] Scan started');
    
    // Start scan in background
    upsertMediaFromDisk({ 
      db, 
      mediaRoot,
      onProgress: (scanned, message) => {
        scanProgress = { isScanning: true, scanned, total: 0, message };
        logScanProgressThrottled(scanned, message);
      }
    })
      .then((result) => {
        const removed = typeof (result as any).removed === 'number' ? (result as any).removed : 0;
        const removedMsg = removed > 0 ? `, ${removed} removed` : '';
        const doneMsg = `Complete: ${result.scanned} files scanned, ${result.upserted} updated${removedMsg}`;
        scanProgress = { isScanning: false, scanned: result.scanned, total: result.scanned, message: doneMsg };
        // eslint-disable-next-line no-console
        console.log(`[MediaViewer] Scan finished: ${result.scanned} scanned, ${result.upserted} updated${removedMsg}`);
      })
      .catch((err) => {
        scanProgress = { isScanning: false, scanned: 0, total: 0, message: `Error: ${err.message}` };
        // eslint-disable-next-line no-console
        console.warn(`[MediaViewer] Scan error: ${err instanceof Error ? err.message : String(err)}`);
      });
    
    res.json({ ok: true, message: 'Scan started' });
  });

  router.get('/scan/progress', async (_req, res) => {
    res.json(scanProgress);
  });

  router.get('/sync', async (req, res) => {
    const sessionId = String(req.query.sessionId ?? 'default').trim() || 'default';
    const state = getSyncPlaybackState(sessionId);
    res.json(state);
  });

  router.put('/sync', express.json(), async (req, res) => {
    const body = req.body as Partial<{
      sessionId: string;
      clientId: string;
      mediaId: string | null;
      timeMs: number;
      paused: boolean;
      fps: number;
      frame: number;
    }>;

    const sessionId = String(body.sessionId ?? 'default').trim() || 'default';
    const clientId = String(body.clientId ?? '').trim();
    if (!clientId) return res.status(400).json({ error: 'clientId required' });

    const mediaId = body.mediaId === null ? null : String(body.mediaId ?? '').trim();
    if (mediaId === '') return res.status(400).json({ error: 'mediaId required (or null)' });

    const timeMs = typeof body.timeMs === 'number' ? body.timeMs : 0;
    const paused = Boolean(body.paused);
    const fps = typeof body.fps === 'number' && Number.isFinite(body.fps) ? body.fps : 30;
    const frame = typeof body.frame === 'number' && Number.isFinite(body.frame) ? body.frame : 0;

    const saved = upsertSyncPlaybackState({
      sessionId,
      mediaId,
      timeMs,
      paused,
      fps,
      frame,
      fromClientId: clientId,
    });

    res.json(saved);
  });

  router.get('/media', async (req, res) => {
    const q = String(req.query.q ?? '').trim().toLowerCase();
    const page = Math.max(1, Number(req.query.page ?? 1) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize ?? 48) || 48));
    const mediaType = String(req.query.mediaType ?? '').trim();
    const hasFunscriptParam = String(req.query.hasFunscript ?? '').trim();
    const isVrParam = String(req.query.isVr ?? '').trim();

    const sortByRaw = String(req.query.sortBy ?? '').trim().toLowerCase();
    const sortDirRaw = String(req.query.sortDir ?? '').trim().toLowerCase();

    const minDurationSec = Number(req.query.minDurationSec ?? NaN);
    const maxDurationSec = Number(req.query.maxDurationSec ?? NaN);
    const minSpeed = Number(req.query.minSpeed ?? NaN);
    const maxSpeed = Number(req.query.maxSpeed ?? NaN);
    const minWidth = Number(req.query.minWidth ?? NaN);
    const minHeight = Number(req.query.minHeight ?? NaN);

    const hasFunscript =
      hasFunscriptParam === '1' || hasFunscriptParam.toLowerCase() === 'true'
        ? true
        : hasFunscriptParam === '0' || hasFunscriptParam.toLowerCase() === 'false'
          ? false
          : null;

    const isVr =
      isVrParam === '1' || isVrParam.toLowerCase() === 'true'
        ? true
        : isVrParam === '0' || isVrParam.toLowerCase() === 'false'
          ? false
          : null;

    const offset = (page - 1) * pageSize;

    const whereClauses: string[] = [];
    const params: Array<string | number | boolean> = [];
    const add = (value: string | number | boolean) => {
      params.push(value);
      return `$${params.length}`;
    };

    if (q) {
      whereClauses.push(`(filename ILIKE '%' || ${add(q)} || '%' OR COALESCE(title,'') ILIKE '%' || ${add(q)} || '%')`);
    }
    if (mediaType) {
      whereClauses.push(`media_type = ${add(mediaType)}`);
    }
    if (hasFunscript !== null) {
      whereClauses.push(`has_funscript = ${add(hasFunscript)}`);
    }

    if (isVr !== null) {
      whereClauses.push(`is_vr = ${add(isVr)}`);
    }

    if (Number.isFinite(minDurationSec) && minDurationSec > 0) {
      whereClauses.push(`duration_ms >= ${add(Math.round(minDurationSec * 1000))}`);
    }
    if (Number.isFinite(maxDurationSec) && maxDurationSec > 0) {
      whereClauses.push(`duration_ms <= ${add(Math.round(maxDurationSec * 1000))}`);
    }
    if (Number.isFinite(minSpeed) && minSpeed >= 0) {
      whereClauses.push(`funscript_avg_speed >= ${add(minSpeed)}`);
    }
    if (Number.isFinite(maxSpeed) && maxSpeed >= 0) {
      whereClauses.push(`funscript_avg_speed <= ${add(maxSpeed)}`);
    }
    if (Number.isFinite(minWidth) && minWidth > 0) {
      whereClauses.push(`width >= ${add(Math.round(minWidth))}`);
    }
    if (Number.isFinite(minHeight) && minHeight > 0) {
      whereClauses.push(`height >= ${add(Math.round(minHeight))}`);
    }

    const whereSql = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const sortDir = sortDirRaw === 'asc' ? 'ASC' : 'DESC';
    const sortBy = sortByRaw || 'modified';
    const orderBySql = (() => {
      switch (sortBy) {
        case 'title':
          return `ORDER BY COALESCE(title, filename) ${sortDir} NULLS LAST, modified_ms DESC`;
        case 'filename':
          return `ORDER BY filename ${sortDir} NULLS LAST, modified_ms DESC`;
        case 'duration':
          return `ORDER BY duration_ms ${sortDir} NULLS LAST, modified_ms DESC`;
        case 'speed':
          return `ORDER BY funscript_avg_speed ${sortDir} NULLS LAST, modified_ms DESC`;
        case 'resolution':
          return `ORDER BY (COALESCE(width,0)::bigint * COALESCE(height,0)::bigint) ${sortDir} NULLS LAST, modified_ms DESC`;
        case 'modified':
        default:
          return `ORDER BY modified_ms ${sortDir} NULLS LAST`;
      }
    })();

    const totalRes = await db.pool.query(
      `SELECT COUNT(*)::bigint AS total FROM media_items ${whereSql}`,
      params
    );
    const total = Number(totalRes.rows[0]?.total ?? 0);

    const listParams = [...params, pageSize, offset];

    const itemsRes = await db.pool.query(
      `
        SELECT id, filename, title, rel_path, media_type, has_funscript, funscript_action_count, funscript_avg_speed, is_vr, width, height, duration_ms, size_bytes, modified_ms
        FROM media_items
        ${whereSql}
        ${orderBySql}
        LIMIT $${listParams.length - 1} OFFSET $${listParams.length}
      `,
      listParams
    );

    res.json({
      total,
      page,
      pageSize,
      items: itemsRes.rows.map((m) => ({
        id: m.id as string,
        filename: m.filename as string,
        title: (m.title as string) ?? null,
        relPath: m.rel_path as string,
        mediaType: m.media_type as string,
        hasFunscript: Boolean(m.has_funscript),
        funscriptActionCount: typeof m.funscript_action_count === 'number' ? m.funscript_action_count : null,
        funscriptAvgSpeed: typeof m.funscript_avg_speed === 'number' ? m.funscript_avg_speed : null,
        isVr: Boolean(m.is_vr),
        width: typeof m.width === 'number' ? m.width : null,
        height: typeof m.height === 'number' ? m.height : null,
        durationMs: typeof m.duration_ms === 'number' ? m.duration_ms : null,
        sizeBytes: String(m.size_bytes),
        modifiedMs: String(m.modified_ms),
      })),
    });
  });

  router.get('/media/:id/stream', async (req, res) => {
    const id = req.params.id;

    const transcode = String((req.query as any)?.transcode ?? '').trim().toLowerCase();

    // If a VR app is actually requesting the media stream, treat that as the authoritative
    // "this is playing" signal (DeoVR may prefetch /deovr/video/:id JSON for many items).
    let deovrStateRef: DeovrPlaybackState | null = null;

    try {
      const ua = String(req.get('user-agent') || '').trim();
      const mvFrom = String((req.query as any)?.mvFrom ?? '').trim().toLowerCase();
      // If the desktop initiated the stream URL (e.g. via DeoVR remote control), don't
      // infer DeoVR as the leader. Desktop will publish the authoritative sync state.
      const isDesktopInitiated = mvFrom === 'desktop';
      const isDeoVr = mvFrom === 'deovr' || ua.toLowerCase().includes('deovr');
      if (opts.onVrStream && isDeoVr && !isDesktopInitiated) {
        const sessionId = String((req.query as any)?.sessionId ?? 'default').trim() || 'default';
        const ipAddress = getClientIp(req);
        const fromClientId = `vr:deovr:${ipAddress}`;
        const key = `${sessionId}|${fromClientId}`;

        const now = Date.now();
        let st = deovrPlaybackByKey.get(key);

        // Start / media switch.
        if (!st || st.mediaId !== id) {
          const created: DeovrPlaybackState = {
            sessionId,
            fromClientId,
            ipAddress,
            userAgent: ua || 'Unknown',
            mediaId: id,
            startedAtMs: now,
            lastSeenAtMs: now,
            lastPublishAtMs: 0,
            lastTimeMs: 0,
            paused: false,
            inFlight: 0,
            pauseTimer: null,
            lastDataAtMs: now,
            tickTimer: null,
            idleTimer: null,
          };

          deovrPlaybackByKey.set(key, created);
          st = created;

          const state = created;

          // Periodic tick for long-lived streams (publish time while playing).
          state.tickTimer = setInterval(() => {
            try {
              if (!opts.onVrStream) return;
              if (state.paused) return;
              if ((state.inFlight || 0) <= 0) return;
              const now2 = Date.now();
              state.lastTimeMs = Math.max(0, now2 - (state.startedAtMs || now2));
              if (now2 - (state.lastPublishAtMs || 0) < DEOVR_PUBLISH_MIN_MS) return;
              state.lastPublishAtMs = now2;
              const tMs = Math.max(0, Math.round(state.lastTimeMs || 0));
              Promise.resolve(
                opts.onVrStream({
                  sessionId: state.sessionId,
                  mediaId: state.mediaId,
                  fromClientId: state.fromClientId,
                  userAgent: state.userAgent || 'Unknown',
                  ipAddress: state.ipAddress || 'unknown',
                  timeMs: tMs,
                  paused: false,
                  fps: DEOVR_FPS,
                  frame: Math.max(0, Math.floor((tMs / 1000) * DEOVR_FPS)),
                })
              ).catch(() => {});
            } catch {
              // ignore
            }
          }, DEOVR_TICK_MS);
          state.tickTimer?.unref?.();

          // Idle-based pause inference for single long-lived streams.
          state.idleTimer = setInterval(() => {
            try {
              if (!opts.onVrStream) return;
              if (state.paused) return;
              if ((state.inFlight || 0) <= 0) return;
              const now2 = Date.now();
              const lastData = Number(state.lastDataAtMs) || 0;
              if (!lastData) return;
              if (now2 - lastData < DEOVR_IDLE_PAUSE_MS) return;

              state.paused = true;
              // Freeze time at lastTimeMs (don't advance while paused).
              const tMs = Math.max(0, Math.round(state.lastTimeMs || 0));
              Promise.resolve(
                opts.onVrStream({
                  sessionId: state.sessionId,
                  mediaId: state.mediaId,
                  fromClientId: state.fromClientId,
                  userAgent: state.userAgent || 'Unknown',
                  ipAddress: state.ipAddress || 'unknown',
                  timeMs: tMs,
                  paused: true,
                  fps: DEOVR_FPS,
                  frame: Math.max(0, Math.floor((tMs / 1000) * DEOVR_FPS)),
                })
              ).catch(() => {});
            } catch {
              // ignore
            }
          }, 200);
          state.idleTimer?.unref?.();
        }

        if (!st) return;
        const stateAtRequest: DeovrPlaybackState = st;
        deovrStateRef = stateAtRequest;

        // Any new request means we're active; cancel pending pause.
        if (stateAtRequest.pauseTimer) {
          try {
            clearTimeout(stateAtRequest.pauseTimer);
          } catch {}
          stateAtRequest.pauseTimer = null;
        }

        // Track in-flight requests to allow near-instant pause when the stream stops.
        stateAtRequest.inFlight = Math.max(0, (stateAtRequest.inFlight || 0) + 1);
        const release = () => {
          stateAtRequest.inFlight = Math.max(0, (stateAtRequest.inFlight || 0) - 1);
          if (stateAtRequest.inFlight !== 0) return;

          // Debounce slightly so back-to-back range requests don't flap pause/play.
          stateAtRequest.pauseTimer = setTimeout(() => {
            if (!opts.onVrStream) return;
            if ((stateAtRequest.inFlight || 0) !== 0) return;
            if (stateAtRequest.paused) return;

            stateAtRequest.paused = true;
            const tMs = Math.max(0, Math.round(stateAtRequest.lastTimeMs || 0));
            try {
                Promise.resolve(opts.onVrStream({
                sessionId: stateAtRequest.sessionId,
                mediaId: stateAtRequest.mediaId,
                fromClientId: stateAtRequest.fromClientId,
                userAgent: stateAtRequest.userAgent || 'Unknown',
                ipAddress: stateAtRequest.ipAddress || 'unknown',
                timeMs: tMs,
                paused: true,
                fps: DEOVR_FPS,
                frame: Math.max(0, Math.floor((tMs / 1000) * DEOVR_FPS)),
                })).catch(() => {});
            } catch {
              // ignore
            }
          }, DEOVR_INSTANT_PAUSE_DEBOUNCE_MS);
          stateAtRequest.pauseTimer?.unref?.();
        };
        res.once('close', release);
        res.once('finish', release);

        // Resume from paused: keep time continuity.
        if (stateAtRequest.paused) {
          stateAtRequest.paused = false;
          stateAtRequest.startedAtMs = now - (stateAtRequest.lastTimeMs || 0);
        }

        stateAtRequest.lastSeenAtMs = now;
        stateAtRequest.lastTimeMs = Math.max(0, now - (stateAtRequest.startedAtMs || now));

        const shouldPublish = (now - (stateAtRequest.lastPublishAtMs || 0) >= DEOVR_PUBLISH_MIN_MS) || (lastVrStreamMediaByClient.get(key) !== id);
        if (shouldPublish) {
          stateAtRequest.lastPublishAtMs = now;
          lastVrStreamMediaByClient.set(key, id);
          try {
            Promise.resolve(opts.onVrStream({
              sessionId,
              mediaId: id,
              fromClientId,
              userAgent: ua || 'Unknown',
              ipAddress,
              timeMs: Math.max(0, Math.round(stateAtRequest.lastTimeMs || 0)),
              paused: false,
              fps: DEOVR_FPS,
              frame: Math.max(0, Math.floor(((stateAtRequest.lastTimeMs || 0) / 1000) * DEOVR_FPS)),
            })).catch(() => {});
          } catch {
            // ignore
          }
        }
      }
    } catch {
      // ignore
    }

    const itemRes = await db.pool.query(
      `SELECT rel_path, ext, media_type FROM media_items WHERE id = $1 LIMIT 1`,
      [id]
    );
    const item = itemRes.rows[0];
    if (!item) return res.status(404).json({ error: 'Not found' });

    const abs = path.join(mediaRoot, item.rel_path);
    const ext = String(item.ext || path.extname(abs) || '').toLowerCase();
    const mediaType = String(item.media_type || '').toLowerCase();

    // DeoVR is picky about content types; fall back to explicit mappings.
    const forcedContentType = (() => {
      if (mediaType === 'video') {
        if (ext === '.mp4' || ext === '.m4v') return 'video/mp4';
        if (ext === '.mov') return 'video/quicktime';
        if (ext === '.mkv') return 'video/x-matroska';
        if (ext === '.webm') return 'video/webm';
        if (ext === '.avi') return 'video/x-msvideo';
      }
      if (mediaType === 'image') {
        if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
        if (ext === '.png') return 'image/png';
        if (ext === '.gif') return 'image/gif';
        if (ext === '.webp') return 'image/webp';
        if (ext === '.bmp') return 'image/bmp';
      }
      return null;
    })();

    const lookedUp = mime.lookup(abs) || null;
    const contentType = forcedContentType || (typeof lookedUp === 'string' && lookedUp ? lookedUp : 'application/octet-stream');
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Accept-Ranges', 'bytes');

    // Streaming media for VR players needs very predictable Range behavior.
    // Some clients (notably DeoVR) will mark a video as "unsupported" if they receive an
    // unexpected status/body after a crash/retry (e.g. cached 304, HTML, or inconsistent ranges).
    res.setHeader('Cache-Control', 'no-store');

    let st: import('node:fs').Stats;
    try {
      st = await fs.stat(abs);
    } catch {
      return res.status(404).json({ error: 'Not found' });
    }

    const size = Number(st.size) || 0;
    if (!Number.isFinite(size) || size <= 0) {
      return res.status(404).json({ error: 'Not found' });
    }

    // Optional server-side transcode fallback (used by desktop when it can't decode AV1).
    // Note: Range is not supported here; output is a fragmented MP4 stream.
    if (transcode === 'h264' && mediaType === 'video') {
      res.status(200);
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Disposition', 'inline');
      res.setHeader('Cache-Control', 'no-store');
      res.removeHeader('Accept-Ranges');

      const args = [
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        abs,
        '-map',
        '0:v:0',
        '-map',
        '0:a?',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '23',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '160k',
        '-movflags',
        'frag_keyframe+empty_moov+default_base_moof',
        '-f',
        'mp4',
        'pipe:1',
      ];

      const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      const kill = () => {
        try { proc.kill('SIGKILL'); } catch {}
      };
      res.once('close', kill);
      res.once('finish', kill);
      proc.on('error', () => {
        try { res.status(500).end(); } catch {}
      });
      proc.stderr.on('data', () => {
        // ignore (keep logs quiet)
      });
      proc.stdout.pipe(res);
      return;
    }

    const range = String(req.get('range') || '').trim();
    const isHead = String(req.method || '').toUpperCase() === 'HEAD';

    // Single-range support: bytes=start-end
    const m = /^bytes=(\d+)-(\d*)$/i.exec(range);
    if (m) {
      const start = Math.max(0, Number(m[1]));
      const endRaw = m[2] ? Number(m[2]) : NaN;
      const end = Number.isFinite(endRaw) ? Math.min(size - 1, Math.max(start, endRaw)) : (size - 1);

      if (!(start >= 0 && start < size && end >= start && end < size)) {
        res.status(416);
        res.setHeader('Content-Range', `bytes */${size}`);
        return res.end();
      }

      const chunkSize = end - start + 1;
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
      res.setHeader('Content-Length', String(chunkSize));

      if (isHead) return res.end();

      const stream = fsSync.createReadStream(abs, { start, end });
      if (deovrStateRef) {
        stream.on('data', () => {
          try {
            const now = Date.now();
            deovrStateRef.lastDataAtMs = now;
            if (deovrStateRef.paused) {
              deovrStateRef.paused = false;
              deovrStateRef.startedAtMs = now - (deovrStateRef.lastTimeMs || 0);
            }
          } catch {
            // ignore
          }
        });
      }
      stream.on('error', () => {
        try { res.destroy(); } catch {}
      });
      stream.pipe(res);
      return;
    }

    // No Range: stream whole file.
    res.status(200);
    res.setHeader('Content-Length', String(size));
    if (isHead) return res.end();

    const stream = fsSync.createReadStream(abs);
    if (deovrStateRef) {
      stream.on('data', () => {
        try {
          const now = Date.now();
          deovrStateRef.lastDataAtMs = now;
          if (deovrStateRef.paused) {
            deovrStateRef.paused = false;
            deovrStateRef.startedAtMs = now - (deovrStateRef.lastTimeMs || 0);
          }
        } catch {
          // ignore
        }
      });
    }
    stream.on('error', () => {
      try { res.destroy(); } catch {}
    });
    stream.pipe(res);
    return;
  });

  router.get('/media/:id/thumb', async (req, res) => {
    const id = req.params.id;
    const itemRes = await db.pool.query(
      `SELECT rel_path, media_type, filename FROM media_items WHERE id = $1 LIMIT 1`,
      [id]
    );
    const item = itemRes.rows[0];
    if (!item) return res.status(404).send('Not found');

    // Browser caching:
    // - WebUI appends `?v=${thumbVer}` specifically to bust cache when thumbs are regenerated.
    // - When a version is present, it's safe to cache aggressively.
    // - Without a version, keep caching modest to avoid sticky stale thumbnails.
    try {
      const v = (req.query as any)?.v;
      if (v !== undefined && v !== null && String(v).trim() !== '') {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else {
        res.setHeader('Cache-Control', 'public, max-age=3600');
      }
    } catch {
      res.setHeader('Cache-Control', 'public, max-age=3600');
    }

    const abs = path.join(mediaRoot, item.rel_path);

    if (item.media_type === 'image') {
      // For images, just serve the original for now (browsers handle resizing okay, 
      // or we could use sharp later if needed).
      return res.sendFile(abs);
    }
    
    // For video, generate a thumbnail
    try {
      // 320px width is good for grid
      const thumbPath = await generateThumbnail(abs, 320);
      res.setHeader('Content-Type', 'image/jpeg');
      return res.sendFile(thumbPath);
    } catch (e) {
      // Fallback to a lightweight placeholder instead of failing the UI.
      // (Also avoids repeated expensive retries; generator caches failures briefly.)
      const msg = e instanceof Error ? e.message : String(e);
      const mediaLabel = (typeof item.filename === 'string' && item.filename.trim()) ? String(item.filename).trim() : id;

      // Avoid log spam when we already have a recent failure marker.
      if (!msg.includes('thumbnail previously failed recently')) {
        if (msg.includes('moov atom not found') || msg.includes('Invalid data found when processing input')) {
          console.warn(`Thumb gen failed for ${mediaLabel}: Not able to load preview (invalid/corrupt media)`);
        } else {
          console.warn(`Thumb gen failed for ${mediaLabel}: ${String(msg).split('\n')[0]}`);
        }
      }

      // Signal "preview unavailable" to the placeholder SVG.
      return res.redirect(302, `/thumb/${encodeURIComponent(id)}.svg?err=1`);
    }
  });

  router.get('/media/:id/funscript', async (req, res) => {
    const id = req.params.id;
    const itemRes = await db.pool.query(
      `SELECT rel_path FROM media_items WHERE id = $1 LIMIT 1`,
      [id]
    );
    const item = itemRes.rows[0];
    if (!item) return res.status(404).json({ error: 'Not found' });

    const abs = path.join(mediaRoot, item.rel_path);
    const fun = await loadFunscriptIfExists(abs);
    if (!fun) return res.status(404).json({ error: 'No funscript' });
    res.json(fun);
  });

  router.put('/playback', express.json(), async (req, res) => {
    const body = req.body as {
      clientId?: string;
      mediaId?: string;
      timeMs?: number;
      fps?: number;
      frame?: number;
    };

    if (!body.clientId || !body.mediaId) return res.status(400).json({ error: 'clientId and mediaId required' });
    if (typeof body.timeMs !== 'number' || typeof body.frame !== 'number') {
      return res.status(400).json({ error: 'timeMs and frame required' });
    }

    const fps = typeof body.fps === 'number' && Number.isFinite(body.fps) ? Math.max(1, Math.round(body.fps)) : 30;

    const timeMs = Math.max(0, Math.round(body.timeMs));
    const frame = Math.max(0, Math.round(body.frame));

    const saved = upsertPlaybackState({
      clientId: body.clientId,
      mediaId: body.mediaId,
      timeMs,
      fps,
      frame,
    });

    res.json({
      id: saved.id,
      clientId: saved.clientId,
      mediaId: saved.mediaId,
      timeMs: saved.timeMs,
      fps: saved.fps,
      frame: saved.frame,
      updatedAt: saved.updatedAt,
    });
  });

  router.get('/playback', async (req, res) => {
    const clientId = String(req.query.clientId ?? '').trim();
    const mediaId = String(req.query.mediaId ?? '').trim();
    if (!clientId || !mediaId) return res.status(400).json({ error: 'clientId and mediaId required' });

    const row = getPlaybackState({ clientId, mediaId });
    if (!row) return res.status(404).json({ error: 'Not found' });

    res.json({
      id: row.id,
      clientId: row.clientId,
      mediaId: row.mediaId,
      timeMs: row.timeMs,
      fps: row.fps,
      frame: row.frame,
      updatedAt: row.updatedAt,
    });
  });

  router.get('/media/:id/fileinfo', async (req, res) => {
    const id = req.params.id;
    const itemRes = await db.pool.query(
      `SELECT id, filename, title, rel_path, media_type, has_funscript, funscript_action_count, funscript_avg_speed, is_vr, width, height, duration_ms FROM media_items WHERE id = $1 LIMIT 1`,
      [id]
    );
    const item = itemRes.rows[0];
    if (!item) return res.status(404).json({ error: 'Not found' });

    const abs = path.join(mediaRoot, item.rel_path);
    try {
      const stat = await fs.stat(abs);
      res.json({
        id: item.id,
        filename: item.filename,
        title: (item.title as string) ?? null,
        relPath: item.rel_path,
        mediaType: item.media_type,
        hasFunscript: Boolean(item.has_funscript),
        funscriptActionCount: typeof item.funscript_action_count === 'number' ? item.funscript_action_count : null,
        funscriptAvgSpeed: typeof item.funscript_avg_speed === 'number' ? item.funscript_avg_speed : null,
        isVr: Boolean(item.is_vr),
        width: typeof item.width === 'number' ? item.width : null,
        height: typeof item.height === 'number' ? item.height : null,
        durationMs: typeof item.duration_ms === 'number' ? item.duration_ms : null,
        sizeBytes: stat.size,
        modifiedMs: stat.mtimeMs,
      });
    } catch {
      res.status(404).json({ error: 'Missing on disk' });
    }
  });

  // ffprobe-based metadata (currently used for duration in desktop no-video mode)
  router.get('/media/:id/probe', async (req, res) => {
    const id = req.params.id;
    const itemRes = await db.pool.query(
      `SELECT rel_path, media_type FROM media_items WHERE id = $1 LIMIT 1`,
      [id]
    );
    const item = itemRes.rows[0];
    if (!item) return res.status(404).json({ error: 'Not found' });

    if (String(item.media_type) !== 'video') {
      return res.json({ id, durationMs: null });
    }

    const abs = path.join(mediaRoot, item.rel_path);
    const durationMs = await probeDurationMsWithFfprobe(abs);
    res.json({ id, durationMs });
  });

  return router;
}
