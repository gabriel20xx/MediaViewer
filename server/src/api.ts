import path from 'node:path';
import fs from 'node:fs/promises';
import express from 'express';
import mime from 'mime-types';
import { upsertMediaFromDisk } from './mediaScanner.js';
import { loadFunscriptIfExists } from './funscript.js';
import type { Db } from './db.js';
import { newId } from './ids.js';
import { getSyncPlaybackState, upsertSyncPlaybackState } from './syncState.js';
import { probeDurationMsWithFfprobe } from './ffprobe.js';

import { generateThumbnail } from './thumbnails/generator.js';

// Global scan progress tracker
let scanProgress = { isScanning: false, scanned: 0, total: 0, message: '' };


export function buildApiRouter(opts: {
  db: Db;
  mediaRoot: string;
}) {
  const { db, mediaRoot } = opts;
  const router = express.Router();

  router.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  router.post('/scan', async (_req, res) => {
    if (scanProgress.isScanning) {
      return res.status(409).json({ error: 'Scan already in progress' });
    }
    
    scanProgress = { isScanning: true, scanned: 0, total: 0, message: 'Starting scan...' };
    
    // Start scan in background
    upsertMediaFromDisk({ 
      db, 
      mediaRoot,
      onProgress: (scanned, message) => {
        scanProgress = { isScanning: true, scanned, total: 0, message };
      }
    })
      .then((result) => {
        scanProgress = { isScanning: false, scanned: result.scanned, total: result.scanned, message: `Complete: ${result.scanned} files scanned, ${result.upserted} updated` };
      })
      .catch((err) => {
        scanProgress = { isScanning: false, scanned: 0, total: 0, message: `Error: ${err.message}` };
      });
    
    res.json({ ok: true, message: 'Scan started' });
  });

  router.get('/scan/progress', async (_req, res) => {
    res.json(scanProgress);
  });

  router.get('/sync', async (req, res) => {
    const sessionId = String(req.query.sessionId ?? 'default').trim() || 'default';
    const state = await getSyncPlaybackState(db, sessionId);
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

    const saved = await upsertSyncPlaybackState(db, {
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
      whereClauses.push(`filename ILIKE '%' || ${add(q)} || '%'`);
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

    const whereSql = whereClauses.length ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const totalRes = await db.pool.query(
      `SELECT COUNT(*)::bigint AS total FROM media_items ${whereSql}`,
      params
    );
    const total = Number(totalRes.rows[0]?.total ?? 0);

    const listParams = [...params, pageSize, offset];

    const itemsRes = await db.pool.query(
      `
        SELECT id, filename, rel_path, media_type, has_funscript, is_vr, size_bytes, modified_ms
        FROM media_items
        ${whereSql}
        ORDER BY modified_ms DESC
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
        relPath: m.rel_path as string,
        mediaType: m.media_type as string,
        hasFunscript: Boolean(m.has_funscript),
        isVr: Boolean(m.is_vr),
        sizeBytes: String(m.size_bytes),
        modifiedMs: String(m.modified_ms),
      })),
    });
  });

  router.get('/media/:id/stream', async (req, res) => {
    const id = req.params.id;
    const itemRes = await db.pool.query(
      `SELECT rel_path FROM media_items WHERE id = $1 LIMIT 1`,
      [id]
    );
    const item = itemRes.rows[0];
    if (!item) return res.status(404).json({ error: 'Not found' });

    const abs = path.join(mediaRoot, item.rel_path);
    const contentType = mime.lookup(abs) || 'application/octet-stream';
    res.setHeader('Content-Type', contentType);

    // Use express's built-in static sender by delegating to res.sendFile (supports range).
    return res.sendFile(abs);
  });

  router.get('/media/:id/thumb', async (req, res) => {
    const id = req.params.id;
    const itemRes = await db.pool.query(
      `SELECT rel_path, media_type FROM media_items WHERE id = $1 LIMIT 1`,
      [id]
    );
    const item = itemRes.rows[0];
    if (!item) return res.status(404).send('Not found');

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
      // Fallback to error or empty
      console.error('Thumb gen failed:', e);
      return res.status(500).send('Thumbnail generation failed');
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

    const savedRes = await db.pool.query(
      `
        INSERT INTO playback_states (id, client_id, media_id, time_ms, fps, frame, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, now())
        ON CONFLICT (client_id, media_id)
        DO UPDATE SET
          time_ms = EXCLUDED.time_ms,
          fps = EXCLUDED.fps,
          frame = EXCLUDED.frame,
          updated_at = now()
        RETURNING id, client_id, media_id, time_ms, fps, frame, updated_at
      `,
      [newId(), body.clientId, body.mediaId, timeMs, fps, frame]
    );
    const saved = savedRes.rows[0];

    res.json({
      id: saved.id,
      clientId: saved.client_id,
      mediaId: saved.media_id,
      timeMs: saved.time_ms,
      fps: saved.fps,
      frame: saved.frame,
      updatedAt: saved.updated_at,
    });
  });

  router.get('/playback', async (req, res) => {
    const clientId = String(req.query.clientId ?? '').trim();
    const mediaId = String(req.query.mediaId ?? '').trim();
    if (!clientId || !mediaId) return res.status(400).json({ error: 'clientId and mediaId required' });

    const rowRes = await db.pool.query(
      `SELECT id, client_id, media_id, time_ms, fps, frame, updated_at FROM playback_states WHERE client_id=$1 AND media_id=$2 LIMIT 1`,
      [clientId, mediaId]
    );
    const row = rowRes.rows[0];

    if (!row) return res.status(404).json({ error: 'Not found' });

    res.json({
      id: row.id,
      clientId: row.client_id,
      mediaId: row.media_id,
      timeMs: row.time_ms,
      fps: row.fps,
      frame: row.frame,
      updatedAt: row.updated_at,
    });
  });

  router.get('/media/:id/fileinfo', async (req, res) => {
    const id = req.params.id;
    const itemRes = await db.pool.query(
      `SELECT id, filename, rel_path, media_type, has_funscript, is_vr FROM media_items WHERE id = $1 LIMIT 1`,
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
        relPath: item.rel_path,
        mediaType: item.media_type,
        hasFunscript: Boolean(item.has_funscript),
        isVr: Boolean(item.is_vr),
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
