import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import os from 'node:os';

// Use a writable cache directory by default (important for Docker images running as non-root).
export const CACHE_DIR = process.env.MV_THUMB_CACHE_DIR
    ? String(process.env.MV_THUMB_CACHE_DIR)
    : path.join(os.tmpdir(), 'mediaviewer', 'thumbs');

async function ensureCacheDir(): Promise<void> {
    await fs.mkdir(CACHE_DIR, { recursive: true });
}

type FfmpegResult = { code: number | null; stderr: string };

function runFfmpeg(ffmpegPath: string, args: string[]): Promise<FfmpegResult> {
    return new Promise((resolve, reject) => {
        const p = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        p.stderr?.on('data', (d) => {
            stderr += d?.toString?.('utf8') ?? String(d);
        });
        p.on('error', reject);
        p.on('close', (code) => resolve({ code, stderr }));
    });
}

function trimStderr(s: string, max = 2000): string {
    const t = String(s || '').trim();
    if (t.length <= max) return t;
    return t.slice(0, max) + '\n…(truncated)…';
}

export async function generateThumbnail(
    inputPath: string,
    width: number,
    timeOffsetSeconds: number = 30
): Promise<string> {
    await ensureCacheDir();

    // Generate a unique filename based on input path + params
    const hash = createHash('md5').update(`${inputPath}:${width}:${timeOffsetSeconds}`).digest('hex');
    const outPath = path.join(CACHE_DIR, `${hash}.jpg`);
    const failPath = path.join(CACHE_DIR, `${hash}.fail.json`);

    // Check if it already exists
    try {
        const stats = await fs.stat(outPath);
        if (stats.size > 0) return outPath;
    } catch { }

        // If we recently failed for this exact request, don't keep hammering ffmpeg.
        try {
            const fail = JSON.parse(await fs.readFile(failPath, 'utf8')) as { ts?: number };
            const ts = typeof fail?.ts === 'number' ? fail.ts : 0;
            if (ts > 0 && Date.now() - ts < 15 * 60 * 1000) {
                throw new Error('ffmpeg thumbnail previously failed recently');
            }
        } catch (e: any) {
            // Ignore missing/invalid fail marker.
            if (e?.code === 'ENOENT') {
                // ok
            }
        }

    // Run ffmpeg to extract a frame
    // ffmpeg -ss 5 -i "input.mp4" -vf "scale=320:-1:flags=lanczos" -vframes 1 -q:v 2 "output.jpg" -y
    const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';

        const tmpPath = path.join(CACHE_DIR, `${hash}.tmp.jpg`);

        const attempts: Array<{ name: string; args: string[] }> = [
            // Fast seek (may fail if time is beyond duration on some files)
            {
                name: 'fast-seek',
                args: ['-hide_banner', '-loglevel', 'error', '-ss', String(timeOffsetSeconds), '-i', inputPath, '-vf', `scale=${width}:-2`, '-vframes', '1', '-q:v', '5', '-y', tmpPath],
            },
            // Accurate seek by placing -ss after -i
            {
                name: 'accurate-seek',
                args: ['-hide_banner', '-loglevel', 'error', '-i', inputPath, '-ss', String(timeOffsetSeconds), '-vf', `scale=${width}:-2`, '-vframes', '1', '-q:v', '5', '-y', tmpPath],
            },
            // Final fallback: first frame
            {
                name: 'first-frame',
                args: ['-hide_banner', '-loglevel', 'error', '-i', inputPath, '-vf', `scale=${width}:-2`, '-vframes', '1', '-q:v', '5', '-y', tmpPath],
            },
        ];

        let last: FfmpegResult | null = null;
        for (const a of attempts) {
            last = await runFfmpeg(ffmpegPath, a.args);
            if (last.code === 0) {
                await fs.rename(tmpPath, outPath).catch(async () => {
                    // If rename fails (e.g., across devices), fall back to copy+unlink.
                    const buf = await fs.readFile(tmpPath);
                    await fs.writeFile(outPath, buf);
                    await fs.unlink(tmpPath).catch(() => {});
                });
                return outPath;
            }
        }

        const stderr = trimStderr(last?.stderr || '');
        try {
            await fs.writeFile(
                failPath,
                JSON.stringify({ ts: Date.now(), code: last?.code ?? null, stderr }, null, 2),
                'utf8'
            );
        } catch {
            // ignore
        }

        throw new Error(`ffmpeg exited with code ${last?.code ?? 'unknown'}${stderr ? `\n${stderr}` : ''}`);
}
