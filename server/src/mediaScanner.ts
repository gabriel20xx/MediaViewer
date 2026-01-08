import fs from 'node:fs/promises';
import path from 'node:path';
import { loadFunscriptIfExists } from './funscript.js';
import type { Db } from './db.js';
import { newId } from './ids.js';
import { probeVrWithFfprobe } from './ffprobe.js';
import { probeDurationMsWithFfprobe } from './ffprobe.js';

function mediaTypeFromExt(ext: string): string {
  const e = ext.toLowerCase();
  if ([
    '.mp4', '.mkv', '.webm', '.mov', '.avi', '.m4v'
  ].includes(e)) return 'video';
  if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(e)) return 'image';
  return 'other';
}

async function* walk(dir: string): AsyncGenerator<string> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      yield* walk(full);
    } else if (ent.isFile()) {
      yield full;
    }
  }
}

function isVrFromRelPath(relPath: string): boolean {
  const s = relPath.toLowerCase().replace(/\\/g, '/');

  // Folder hint.
  if (s.includes('/vr/')) return true;

  // Token-based matching to support conventions like "_LR_180".
  const hasToken = (re: RegExp) => re.test(s);

  const hasVrWord = hasToken(/(^|[\/\s._-])vr([\/\s._-]|$)/);
  const hasStereo = hasToken(/(^|[\/\s._-])(lr|rl|sbs|3dh|tb|bt|ou|overunder|3dv)([\/\s._-]|$)/);
  const hasFov =
    hasToken(/(^|[\/\s._-])(180|360)([\/\s._-]|$)/) || s.includes('vr180') || s.includes('vr360');

  // Some libraries use tags like "_LRF_Full_SBS" without an explicit 180/360 token.
  // Treat this as VR if we have strong stereo + LRF signals.
  const hasLrf = hasToken(/(^|[\/\s._-])lrf([\/\s._-]|$)/);
  const hasFull = hasToken(/(^|[\/\s._-])full([\/\s._-]|$)/);
  if (hasLrf && hasFull && hasStereo) return true;

  // Heuristic: VR videos almost always have an FOV token, and frequently stereo.
  // Require a reasonably strong signal to avoid false positives.
  if (hasFov && (hasStereo || hasVrWord)) return true;
  if (hasStereo && hasVrWord) return true;
  return false;
}

function computeFunscriptStats(fun: { actions: Array<{ at: number; pos: number }> } | null): {
  actionCount: number | null;
  avgSpeed: number | null;
} {
  if (!fun || !Array.isArray(fun.actions) || fun.actions.length < 2) {
    return { actionCount: fun && Array.isArray(fun.actions) ? fun.actions.length : null, avgSpeed: null };
  }

  const actions = fun.actions;
  let totalDp = 0;
  let totalDtMs = 0;

  for (let i = 1; i < actions.length; i++) {
    const a = actions[i - 1];
    const b = actions[i];
    const dt = Math.max(0, Math.round(Number(b.at) - Number(a.at)));
    if (dt <= 0) continue;
    const dp = Math.abs(Number(b.pos) - Number(a.pos));
    if (!Number.isFinite(dp)) continue;
    totalDp += dp;
    totalDtMs += dt;
  }

  const avgSpeed = totalDtMs > 0 ? (totalDp / totalDtMs) * 1000 : null; // % per second
  return {
    actionCount: actions.length,
    avgSpeed: typeof avgSpeed === 'number' && Number.isFinite(avgSpeed) ? avgSpeed : null,
  };
}

export async function upsertMediaFromDisk(opts: {
  db: Db;
  mediaRoot: string;
  onProgress?: (scanned: number, message: string) => void;
}): Promise<{ scanned: number; upserted: number; removed: number }>
{
  const { db, mediaRoot, onProgress } = opts;
  let scanned = 0;
  let upserted = 0;
  let removed = 0;

  for await (const absPath of walk(mediaRoot)) {
    scanned++;
    
    // Report progress every 10 files
    if (onProgress && scanned % 10 === 0) {
      onProgress(scanned, `Scanning... ${scanned} files processed`);
    }
    
    const ext = path.extname(absPath);
    if (!ext) continue;

    const relPath = path.relative(mediaRoot, absPath).replace(/\\/g, '/');
    if (relPath.startsWith('..')) continue;

    const stat = await fs.stat(absPath);
    const mediaType = mediaTypeFromExt(ext);

    const filename = path.basename(absPath);
    const title = path.basename(absPath, ext);

    // Skip non-media and funscripts themselves.
    if (ext.toLowerCase() === '.funscript') continue;
    if (mediaType === 'other') continue;

    const fun = await loadFunscriptIfExists(absPath);
    const funStats = computeFunscriptStats(fun);

    let isVr = false;
    let vrFov: number | null = null;
    let vrStereo: string | null = null;
    let vrProjection: string | null = null;

    let width: number | null = null;
    let height: number | null = null;
    let durationMs: number | null = null;

    if (mediaType === 'video') {
      const probe = await probeVrWithFfprobe(absPath);
      if (probe && probe.isVr) {
        isVr = true;
        vrFov = probe.fov ?? null;
        vrStereo = probe.stereo ?? null;
        vrProjection = probe.projection ?? null;
      } else {
        // Fallback: filename/path heuristic (keeps compatibility with common VR naming conventions).
        isVr = isVrFromRelPath(relPath);
      }

      if (probe) {
        width = typeof probe.width === 'number' ? probe.width : null;
        height = typeof probe.height === 'number' ? probe.height : null;
      }

      durationMs = await probeDurationMsWithFfprobe(absPath);
    }

    const sizeBytes = BigInt(stat.size);
    const modifiedMs = BigInt(Math.trunc(stat.mtimeMs));

    await db.pool.query(
      `
        INSERT INTO media_items (
          id, rel_path, filename, title, ext, media_type, size_bytes, modified_ms, duration_ms, width, height, has_funscript, funscript_action_count, funscript_avg_speed, is_vr, vr_fov, vr_stereo, vr_projection, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7::bigint, $8::bigint, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, now()
        )
        ON CONFLICT (rel_path)
        DO UPDATE SET
          filename = EXCLUDED.filename,
          title = EXCLUDED.title,
          ext = EXCLUDED.ext,
          media_type = EXCLUDED.media_type,
          size_bytes = EXCLUDED.size_bytes,
          modified_ms = EXCLUDED.modified_ms,
          duration_ms = COALESCE(EXCLUDED.duration_ms, media_items.duration_ms),
          width = COALESCE(EXCLUDED.width, media_items.width),
          height = COALESCE(EXCLUDED.height, media_items.height),
          has_funscript = EXCLUDED.has_funscript,
          funscript_action_count = EXCLUDED.funscript_action_count,
          funscript_avg_speed = EXCLUDED.funscript_avg_speed,
          is_vr = (EXCLUDED.is_vr OR media_items.is_vr),
          vr_fov = CASE WHEN (EXCLUDED.is_vr OR media_items.is_vr) THEN COALESCE(EXCLUDED.vr_fov, media_items.vr_fov) ELSE NULL END,
          vr_stereo = CASE WHEN (EXCLUDED.is_vr OR media_items.is_vr) THEN COALESCE(EXCLUDED.vr_stereo, media_items.vr_stereo) ELSE NULL END,
          vr_projection = CASE WHEN (EXCLUDED.is_vr OR media_items.is_vr) THEN COALESCE(EXCLUDED.vr_projection, media_items.vr_projection) ELSE NULL END,
          updated_at = now();
      `,
      [
        newId(),
        relPath,
        filename,
        title,
        ext,
        mediaType,
        sizeBytes.toString(),
        modifiedMs.toString(),
        durationMs,
        width,
        height,
        Boolean(fun),
        funStats.actionCount,
        funStats.avgSpeed,
        isVr,
        vrFov,
        vrStereo,
        vrProjection,
      ]
    );

    upserted++;
  }

  // Remove DB entries that are no longer present on disk.
  // We check existence directly rather than relying on the scan set, so we don't accidentally
  // delete entries that were skipped for non-media reasons.
  try {
    const existing = await db.pool.query(
      `SELECT rel_path FROM media_items WHERE rel_path IS NOT NULL AND rel_path <> '' AND media_type IN ('video','image')`
    );

    const rows = Array.isArray(existing.rows) ? existing.rows : [];
    const total = rows.length;
    const missing: string[] = [];

    const existsOnDisk = async (abs: string): Promise<boolean> => {
      try {
        await fs.stat(abs);
        return true;
      } catch (err: any) {
        const code = err && typeof err === 'object' ? String(err.code || '') : '';
        // If we can't access it, don't assume it's missing.
        if (code === 'EACCES' || code === 'EPERM') return true;
        return false;
      }
    };

    let idx = 0;
    let checked = 0;
    const concurrency = 32;

    const worker = async () => {
      for (;;) {
        const i = idx++;
        if (i >= total) return;

        const rel = String(rows[i]?.rel_path || '').trim();
        if (!rel) {
          checked++;
          continue;
        }

        const abs = path.join(mediaRoot, rel);
        const ok = await existsOnDisk(abs);
        if (!ok) missing.push(rel);

        checked++;
        if (onProgress && checked % 200 === 0) {
          onProgress(scanned, `Checking for removed files... (${checked}/${total})`);
        }
      }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, total)) }, () => worker()));

    if (missing.length > 0) {
      if (onProgress) onProgress(scanned, `Removing ${missing.length} missing files from database...`);

      const chunkSize = 200;
      for (let i = 0; i < missing.length; i += chunkSize) {
        const chunk = missing.slice(i, i + chunkSize);
        if (onProgress) onProgress(scanned, `Removing missing files from database... (${Math.min(i + chunk.length, missing.length)}/${missing.length})`);
        const del = await db.pool.query(
          `DELETE FROM media_items WHERE rel_path = ANY($1::text[])`,
          [chunk]
        );
        removed += typeof del.rowCount === 'number' ? del.rowCount : 0;
      }
    }
  } catch {
    // ignore cleanup failures; scan/upsert results are still valid
  }

  return { scanned, upserted, removed };
}
