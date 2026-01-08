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
}): Promise<{ scanned: number; upserted: number }>
{
  const { db, mediaRoot, onProgress } = opts;
  let scanned = 0;
  let upserted = 0;

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
          duration_ms = EXCLUDED.duration_ms,
          width = EXCLUDED.width,
          height = EXCLUDED.height,
          has_funscript = EXCLUDED.has_funscript,
          funscript_action_count = EXCLUDED.funscript_action_count,
          funscript_avg_speed = EXCLUDED.funscript_avg_speed,
          is_vr = EXCLUDED.is_vr,
          vr_fov = EXCLUDED.vr_fov,
          vr_stereo = EXCLUDED.vr_stereo,
          vr_projection = EXCLUDED.vr_projection,
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

  return { scanned, upserted };
}
