import express, { type Express, type Request } from 'express';
import type { Db } from './db.js';
import path from 'node:path';
import { probeDurationMsWithFfprobe } from './ffprobe.js';

export type VrSyncNotify = (info: {
  sessionId: string;
  mediaId: string;
  fromClientId: string;
  timeMs: number;
  paused: boolean;
  fps: number;
  frame: number;
}) => Promise<void>;

type VrIntegrationContext = {
  mediaRoot: string;
};

function baseUrl(req: Request): string {
  const host = req.get('host');
  const proto = req.protocol;
  return `${proto}://${host}`;
}

function parseVideoIdFromHereSphereEventId(idField: unknown): string | null {
  const raw = typeof idField === 'string' ? idField.trim() : '';
  if (!raw) return null;
  try {
    const u = new URL(raw);
    const m = u.pathname.match(/\/heresphere\/video\/([^/]+)$/);
    if (m?.[1]) return decodeURIComponent(m[1]);
  } catch {
    // fall through
  }
  const m = raw.match(/\/heresphere\/video\/([^/?#]+)/);
  if (m?.[1]) return decodeURIComponent(m[1]);
  return null;
}

function stablePositiveInt(input: string): number {
  // Deterministic 32-bit hash (FNV-1a) -> positive int.
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 1) || 1;
}

function inferVrFov(filename: string): 180 | 360 {
  const s = filename.toLowerCase();
  if (/(^|[\s._-])180([\s._-]|$)/.test(s) || s.includes('vr180')) return 180;
  if (/(^|[\s._-])360([\s._-]|$)/.test(s) || s.includes('vr360')) return 360;
  return 360;
}

function inferStereo(filename: string): 'sbs' | 'tb' | 'mono' {
  const s = filename.toLowerCase();
  // Token-based matching to avoid accidental substring hits.
  if (/(^|[\s._-])(sbs|lr|rl|3dh)([\s._-]|$)/.test(s)) return 'sbs';
  if (/(^|[\s._-])(tb|bt|ou|overunder|3dv)([\s._-]|$)/.test(s)) return 'tb';
  return 'mono';
}

function svgThumb(title: string, footer: string) {
  const safe = title.replace(/[&<>\"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
  const safeFooter = footer.replace(/[&<>\"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
  <rect x="0" y="0" width="640" height="360" fill="#111827"/>
  <rect x="24" y="24" width="592" height="312" rx="16" fill="#0b1220" stroke="#1f2937"/>
  <text x="48" y="96" fill="#e5e7eb" font-size="22" font-family="system-ui,Segoe UI,Roboto,Helvetica,Arial">MediaViewer</text>
  <text x="48" y="136" fill="#9ca3af" font-size="16" font-family="system-ui,Segoe UI,Roboto,Helvetica,Arial">${safe}</text>
  <text x="48" y="312" fill="#6b7280" font-size="14" font-family="system-ui,Segoe UI,Roboto,Helvetica,Arial">${safeFooter}</text>
</svg>`;
}

function svgThumbError(message: string) {
  const safeMsg = message.replace(/[&<>\"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
  <rect x="0" y="0" width="640" height="360" fill="#111827"/>
  <rect x="24" y="24" width="592" height="312" rx="16" fill="#0b1220" stroke="#1f2937"/>
  <text x="320" y="190" fill="#e5e7eb" font-size="18" text-anchor="middle" font-family="system-ui,Segoe UI,Roboto,Helvetica,Arial">${safeMsg}</text>
</svg>`;
}

async function listVrVideos(db: Db, limit: number) {
  const res = await db.pool.query(
    `
      SELECT id, filename, rel_path, has_funscript
      FROM media_items
      WHERE media_type='video' AND is_vr = TRUE
      ORDER BY modified_ms DESC
      LIMIT $1
    `,
    [limit]
  );
  return res.rows.map((r) => ({
    id: r.id as string,
    filename: r.filename as string,
    relPath: r.rel_path as string,
    hasFunscript: Boolean(r.has_funscript),
  }));
}

async function getVideoById(db: Db, id: string) {
  const res = await db.pool.query(
    `SELECT id, filename, rel_path, has_funscript, vr_fov, vr_stereo, vr_projection FROM media_items WHERE id=$1 AND media_type='video' LIMIT 1`,
    [id]
  );
  const r = res.rows[0];
  if (!r) return null;
  return {
    id: r.id as string,
    filename: r.filename as string,
    relPath: r.rel_path as string,
    hasFunscript: Boolean(r.has_funscript),
    vrFov: (typeof r.vr_fov === 'number' ? (r.vr_fov as number) : r.vr_fov ? Number(r.vr_fov) : null) as number | null,
    vrStereo: (r.vr_stereo ? String(r.vr_stereo) : null) as string | null,
    vrProjection: (r.vr_projection ? String(r.vr_projection) : null) as string | null,
  };
}

export function registerVrIntegrations(
  app: Express,
  db: Db,
  opts?: {
    onVrSync?: VrSyncNotify;
    ctx?: VrIntegrationContext;
  }
) {
  const mediaRoot = opts?.ctx?.mediaRoot || process.env.MEDIA_ROOT || '';

  async function safeVideoLengthMsById(id: string): Promise<number> {
    if (!mediaRoot) return 0;
    try {
      const res = await db.pool.query(
        `SELECT rel_path FROM media_items WHERE id=$1 AND media_type='video' LIMIT 1`,
        [id]
      );
      const r = res.rows[0];
      if (!r?.rel_path) return 0;
      const abs = path.join(mediaRoot, String(r.rel_path));
      const durationMs = await probeDurationMsWithFfprobe(abs);
      if (!durationMs || !Number.isFinite(durationMs)) return 0;
      return Math.max(0, Math.round(durationMs));
    } catch {
      return 0;
    }
  }

  async function safeVideoLengthSecondsById(id: string): Promise<number> {
    const ms = await safeVideoLengthMsById(id);
    if (!ms) return 0;
    return Math.max(0, Math.round(ms / 1000));
  }
  // Simple on-the-fly thumbnail image endpoint.
  app.get('/thumb/:id.svg', async (req, res) => {
    const id = String(req.params.id ?? '').trim();
    const item = await getVideoById(db, id);
    const title = item?.filename || id;
    const err = String((req.query as any)?.err ?? '').trim();
    const footer = err ? 'Not able to load preview' : 'No thumbnail';
    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    if (err) {
      res.send(svgThumbError("Thumbnail couldn't be loaded"));
      return;
    }
    res.send(svgThumb(title, footer));
  });

  // --- DeoVR integration ---
  // DeoVR will request /deovr for a “Selection Scene” style listing.
  app.all(['/deovr', '/deovr/'], async (req, res) => {
    const base = baseUrl(req);
    const vids = await listVrVideos(db, 1000);

    const sessionId = String((req.query as any)?.sessionId ?? '').trim();
    const sessionQs = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : '';

    res.json({
      scenes: [
        {
          name: 'Library',
          list: vids.map((v) => ({
            title: v.filename,
            // DeoVR docs (Selection Scene shortened format): seconds
            videoLength: 0,
            // Prefer the real thumbnail endpoint (jpeg) for app compatibility.
            thumbnailUrl: `${base}/api/media/${encodeURIComponent(v.id)}/thumb`,
            video_url: `${base}/deovr/video/${encodeURIComponent(v.id)}${sessionQs}`,
          })),
        },
      ],
      authorized: '0',
    });
  });

  // Per-video deeplink JSON for DeoVR (deovr://https://host/deovr/video/:id)
  app.all('/deovr/video/:id', async (req, res) => {
    const base = baseUrl(req);
    const id = String(req.params.id ?? '').trim();
    const item = await getVideoById(db, id);
    if (!item) return res.status(404).json({ error: 'Not found' });

    // Signal to sync listeners (desktop) that a VR player selected this media.
    // DeoVR doesn't send websocket sync updates, so this is a server-side hint.
    const sessionId = String(req.query.sessionId ?? 'default').trim() || 'default';
    try {
      await opts?.onVrSync?.({
        sessionId,
        mediaId: id,
        fromClientId: 'vr:deovr',
        timeMs: 0,
        paused: false,
        fps: 30,
        frame: 0,
      });
    } catch {
      // ignore
    }

    const stereo = (item.vrStereo === 'sbs' || item.vrStereo === 'tb' || item.vrStereo === 'mono')
      ? (item.vrStereo as any)
      : inferStereo(item.filename);
    const fov = item.vrFov === 180 || item.vrFov === 360 ? (item.vrFov as 180 | 360) : inferVrFov(item.filename);

    // DeoVR expects videoLength in seconds (required for some features; safe to return 0 if unknown).
    const videoLength = await safeVideoLengthSecondsById(id);

    res.json({
      encodings: [
        {
          name: 'h264',
          videoSources: [
            {
              resolution: 1080,
              url: `${base}/api/media/${encodeURIComponent(id)}/stream`,
            },
          ],
        },
      ],
      title: item.filename,
      id: stablePositiveInt(id),
      videoLength,
      is3d: true,
      screenType: fov === 180 ? 'dome' : 'sphere',
      stereoMode: stereo === 'sbs' ? 'sbs' : stereo === 'tb' ? 'tb' : 'off',
      // Required when playing from a Selection Scene list.
      thumbnailUrl: `${base}/api/media/${encodeURIComponent(id)}/thumb`,
    });
  });

  // Optional auth endpoint (HereSphere spec). We don't require auth, so always grant access.
  app.all('/heresphere/auth', async (_req, res) => {
    res.setHeader('HereSphere-JSON-Version', '1');
    res.json({
      'auth-token': 'local',
      access: 1,
    });
  });

  // Optional scan endpoint to reduce /heresphere/video GET storms.
  app.all('/heresphere/scan', async (req, res) => {
    const base = baseUrl(req);
    const vids = await listVrVideos(db, 1000);

    res.setHeader('HereSphere-JSON-Version', '1');
    res.json({
      scanData: vids.map((v) => ({
        link: `${base}/heresphere/video/${encodeURIComponent(v.id)}`,
        title: v.filename,
        duration: 0,
        tags: [],
      })),
    });
  });

  // HereSphere playback event receiver.
  // If eventServer is set to `${base}/heresphere/event`, HereSphere will POST playback events here.
  app.post('/heresphere/event', express.json({ limit: '256kb' }), async (req, res) => {
    const sessionId = String((req.query as any)?.sessionId ?? 'default').trim() || 'default';
    const body = (req.body || {}) as any;

    const mediaId = parseVideoIdFromHereSphereEventId(body.id);
    const timeMs = Number.isFinite(Number(body.time)) ? Math.max(0, Math.round(Number(body.time))) : 0;
    const evt = Number.isFinite(Number(body.event)) ? Number(body.event) : null;

    const paused = evt === 2 || evt === 0 || evt === 3;
    const fps = 30;
    const frame = Math.max(0, Math.floor((timeMs / 1000) * fps));

    const connectionKey = typeof body.connectionKey === 'string' ? body.connectionKey.trim() : '';
    const fromClientId = connectionKey ? `vr:heresphere:${connectionKey}` : 'vr:heresphere';

    if (mediaId) {
      try {
        await opts?.onVrSync?.({
          sessionId,
          mediaId,
          fromClientId,
          timeMs,
          paused,
          fps,
          frame,
        });
      } catch {
        // ignore
      }
    }

    res.status(204).end();
  });

  // --- HereSphere integration ---
  // Exposes a simple Web Stream library. Some clients prefer a version header.
  app.all(['/heresphere', '/heresphere/'], async (req, res) => {
    const base = baseUrl(req);
    const vids = await listVrVideos(db, 1000);

    const sessionId = String((req.query as any)?.sessionId ?? '').trim();
    const sessionQs = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : '';

    res.setHeader('HereSphere-JSON-Version', '1');
    res.json({
      access: 1,
      library: [
        {
          name: 'Library',
          list: vids.map((v) => `${base}/heresphere/video/${encodeURIComponent(v.id)}${sessionQs}`),
        },
      ],
    });
  });

  app.all('/heresphere/video/:id', async (req, res) => {
    const base = baseUrl(req);
    const id = String(req.params.id ?? '').trim();
    const item = await getVideoById(db, id);
    if (!item) return res.status(404).json({ access: 0, error: 'Not found' });

    // Signal to sync listeners (desktop) that a VR player selected this media.
    const sessionId = String((req.query as any)?.sessionId ?? 'default').trim() || 'default';
    const sessionQs = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : '';
    try {
      await opts?.onVrSync?.({
        sessionId,
        mediaId: id,
        fromClientId: 'vr:heresphere',
        timeMs: 0,
        paused: false,
        fps: 30,
        frame: 0,
      });
    } catch {
      // ignore
    }

    const stereo = (item.vrStereo === 'sbs' || item.vrStereo === 'tb' || item.vrStereo === 'mono')
      ? (item.vrStereo as any)
      : inferStereo(item.filename);
    const fov = item.vrFov === 180 || item.vrFov === 360 ? (item.vrFov as 180 | 360) : inferVrFov(item.filename);
    const scripts = item.hasFunscript
      ? [
          {
            name: `${item.filename}.funscript`,
            url: `${base}/api/media/${encodeURIComponent(id)}/funscript`,
          },
        ]
      : [];

    const duration = await safeVideoLengthMsById(id);

    res.setHeader('HereSphere-JSON-Version', '1');
    res.json({
      access: 1,
      title: item.filename,
      description: item.relPath,
      thumbnailImage: `${base}/api/media/${encodeURIComponent(id)}/thumb`,

      // Send playback events to our server so we can sync desktop reliably.
      eventServer: `${base}/heresphere/event${sessionQs}`,

      duration,

      projection: 'equirectangular',
      stereo: stereo === 'mono' ? 'mono' : stereo,
      fov: fov,

      scripts,
      media: [
        {
          name: 'Stream',
          sources: [
            {
              url: `${base}/api/media/${encodeURIComponent(id)}/stream`,
            },
          ],
        },
      ],
    });
  });
}
