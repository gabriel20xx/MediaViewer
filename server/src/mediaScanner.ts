import fs from 'node:fs/promises';
import path from 'node:path';
import { loadFunscriptIfExists } from './funscript.js';
import type { Db } from './db.js';
import { newId } from './ids.js';
import { probeVrWithFfprobe } from './ffprobe.js';

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

  // Heuristic: VR videos almost always have an FOV token, and frequently stereo.
  // Require a reasonably strong signal to avoid false positives.
  if (hasFov && (hasStereo || hasVrWord)) return true;
  if (hasStereo && hasVrWord) return true;
  return false;
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

    // Skip non-media and funscripts themselves.
    if (ext.toLowerCase() === '.funscript') continue;
    if (mediaType === 'other') continue;

    const fun = await loadFunscriptIfExists(absPath);

    let isVr = false;
    let vrFov: number | null = null;
    let vrStereo: string | null = null;
    let vrProjection: string | null = null;

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
    }

    const sizeBytes = BigInt(stat.size);
    const modifiedMs = BigInt(Math.trunc(stat.mtimeMs));

    await db.pool.query(
      `
        INSERT INTO media_items (
          id, rel_path, filename, ext, media_type, size_bytes, modified_ms, has_funscript, is_vr, vr_fov, vr_stereo, vr_projection, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6::bigint, $7::bigint, $8, $9, $10, $11, $12, now()
        )
        ON CONFLICT (rel_path)
        DO UPDATE SET
          filename = EXCLUDED.filename,
          ext = EXCLUDED.ext,
          media_type = EXCLUDED.media_type,
          size_bytes = EXCLUDED.size_bytes,
          modified_ms = EXCLUDED.modified_ms,
          has_funscript = EXCLUDED.has_funscript,
          is_vr = EXCLUDED.is_vr,
          vr_fov = EXCLUDED.vr_fov,
          vr_stereo = EXCLUDED.vr_stereo,
          vr_projection = EXCLUDED.vr_projection,
          updated_at = now();
      `,
      [
        newId(),
        relPath,
        path.basename(absPath),
        ext,
        mediaType,
        sizeBytes.toString(),
        modifiedMs.toString(),
        Boolean(fun),
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
