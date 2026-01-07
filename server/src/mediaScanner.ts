import fs from 'node:fs/promises';
import path from 'node:path';
import { loadFunscriptIfExists } from './funscript.js';
import type { Db } from './db.js';
import { newId } from './ids.js';

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
  const s = relPath.toLowerCase();
  if (s.includes('/vr/')) return true;
  // Common VR hints in filenames.
  if (s.includes(' sbs ') || s.includes(' tb ')) return true;
  if (s.includes('sbs') || s.includes('tb')) return true;
  if (s.includes('180') || s.includes('360')) return true;
  // crude word-boundary-ish match for "vr"
  const normalized = s.replace(/[^a-z0-9]+/g, ' ');
  if (normalized.includes(' vr ')) return true;
  return false;
}

export async function upsertMediaFromDisk(opts: {
  db: Db;
  mediaRoot: string;
}): Promise<{ scanned: number; upserted: number }>
{
  const { db, mediaRoot } = opts;
  let scanned = 0;
  let upserted = 0;

  for await (const absPath of walk(mediaRoot)) {
    scanned++;
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

    const isVr = mediaType === 'video' ? isVrFromRelPath(relPath) : false;

    const sizeBytes = BigInt(stat.size);
    const modifiedMs = BigInt(Math.trunc(stat.mtimeMs));

    await db.pool.query(
      `
        INSERT INTO media_items (
          id, rel_path, filename, ext, media_type, size_bytes, modified_ms, has_funscript, is_vr, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6::bigint, $7::bigint, $8, $9, now()
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
      ]
    );

    upserted++;
  }

  return { scanned, upserted };
}
