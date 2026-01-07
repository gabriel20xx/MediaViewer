import fs from 'node:fs/promises';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { loadFunscriptIfExists } from './funscript.js';

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

export async function upsertMediaFromDisk(opts: {
  prisma: PrismaClient;
  mediaRoot: string;
}): Promise<{ scanned: number; upserted: number }>
{
  const { prisma, mediaRoot } = opts;
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

    await prisma.mediaItem.upsert({
      where: { relPath },
      create: {
        relPath,
        filename: path.basename(absPath),
        ext,
        mediaType,
        sizeBytes: BigInt(stat.size),
        modifiedMs: BigInt(stat.mtimeMs),
        hasFunscript: Boolean(fun),
      },
      update: {
        filename: path.basename(absPath),
        ext,
        mediaType,
        sizeBytes: BigInt(stat.size),
        modifiedMs: BigInt(stat.mtimeMs),
        hasFunscript: Boolean(fun),
      },
    });

    upserted++;
  }

  return { scanned, upserted };
}
