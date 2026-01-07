import type express from 'express';
import type { Db } from './db.js';

function baseUrl(req: express.Request): string {
  const host = req.get('host');
  const proto = req.protocol;
  return `${proto}://${host}`;
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

function svgThumb(title: string) {
  const safe = title.replace(/[&<>\"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">
  <rect x="0" y="0" width="640" height="360" fill="#111827"/>
  <rect x="24" y="24" width="592" height="312" rx="16" fill="#0b1220" stroke="#1f2937"/>
  <text x="48" y="96" fill="#e5e7eb" font-size="22" font-family="system-ui,Segoe UI,Roboto,Helvetica,Arial">MediaViewer</text>
  <text x="48" y="136" fill="#9ca3af" font-size="16" font-family="system-ui,Segoe UI,Roboto,Helvetica,Arial">${safe}</text>
  <text x="48" y="312" fill="#6b7280" font-size="14" font-family="system-ui,Segoe UI,Roboto,Helvetica,Arial">No thumbnail</text>
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
    `SELECT id, filename, rel_path, has_funscript FROM media_items WHERE id=$1 AND media_type='video' LIMIT 1`,
    [id]
  );
  const r = res.rows[0];
  if (!r) return null;
  return {
    id: r.id as string,
    filename: r.filename as string,
    relPath: r.rel_path as string,
    hasFunscript: Boolean(r.has_funscript),
  };
}

export function registerVrIntegrations(app: express.Express, db: Db) {
  // Simple on-the-fly thumbnail image endpoint.
  app.get('/thumb/:id.svg', async (req, res) => {
    const id = String(req.params.id ?? '').trim();
    const item = await getVideoById(db, id);
    const title = item?.filename || id;
    res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(svgThumb(title));
  });

  // --- DeoVR integration ---
  // DeoVR will request /deovr for a “Selection Scene” style listing.
  app.all(['/deovr', '/deovr/'], async (req, res) => {
    const base = baseUrl(req);
    const vids = await listVrVideos(db, 1000);

    res.json({
      scenes: [
        {
          name: 'Library',
          list: vids.map((v) => ({
            title: v.filename,
            videoLength: 0,
            thumbnailUrl: `${base}/thumb/${v.id}.svg`,
            video_url: `${base}/deovr/video/${encodeURIComponent(v.id)}`,
          })),
        },
      ],
      authorized: '0',
    });
  });

  // Per-video deeplink JSON for DeoVR (deovr://https://host/deovr/video/:id)
  app.get('/deovr/video/:id', async (req, res) => {
    const base = baseUrl(req);
    const id = String(req.params.id ?? '').trim();
    const item = await getVideoById(db, id);
    if (!item) return res.status(404).json({ error: 'Not found' });

    const stereo = inferStereo(item.filename);
    const fov = inferVrFov(item.filename);

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
      is3d: true,
      screenType: fov === 180 ? 'dome' : 'sphere',
      stereoMode: stereo === 'sbs' ? 'sbs' : stereo === 'tb' ? 'tb' : 'off',
      thumbnailUrl: `${base}/thumb/${encodeURIComponent(id)}.svg`,
      videoPreview: `${base}/api/media/${encodeURIComponent(id)}/stream`,
    });
  });

  // --- HereSphere integration ---
  // Exposes a simple Web Stream library. Some clients prefer a version header.
  app.all(['/heresphere', '/heresphere/'], async (req, res) => {
    const base = baseUrl(req);
    const vids = await listVrVideos(db, 1000);

    res.setHeader('HereSphere-JSON-Version', '1');
    res.json({
      access: 1,
      library: [
        {
          name: 'Library',
          list: vids.map((v) => `${base}/heresphere/video/${encodeURIComponent(v.id)}`),
        },
      ],
    });
  });

  app.all('/heresphere/video/:id', async (req, res) => {
    const base = baseUrl(req);
    const id = String(req.params.id ?? '').trim();
    const item = await getVideoById(db, id);
    if (!item) return res.status(404).json({ access: 0, error: 'Not found' });

    const stereo = inferStereo(item.filename);
    const fov = inferVrFov(item.filename);
    const scripts = item.hasFunscript
      ? [
          {
            name: `${item.filename}.funscript`,
            url: `${base}/api/media/${encodeURIComponent(id)}/funscript`,
          },
        ]
      : [];

    res.setHeader('HereSphere-JSON-Version', '1');
    res.json({
      access: 1,
      title: item.filename,
      description: item.relPath,
      thumbnailImage: `${base}/thumb/${encodeURIComponent(id)}.svg`,

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
