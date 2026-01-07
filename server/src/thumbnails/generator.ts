import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';

// Use a temp directory for cached thumbnails
export const CACHE_DIR = path.join(process.cwd(), 'cache', 'thumbs');

// Ensure cache dir exists
(async () => {
    try {
        await fs.mkdir(CACHE_DIR, { recursive: true });
    } catch { }
})();

export async function generateThumbnail(
    inputPath: string,
    width: number,
    timeOffsetSeconds: number = 10
): Promise<string> {
    // Generate a unique filename based on input path + params
    const hash = createHash('md5').update(`${inputPath}:${width}:${timeOffsetSeconds}`).digest('hex');
    const outPath = path.join(CACHE_DIR, `${hash}.jpg`);

    // Check if it already exists
    try {
        const stats = await fs.stat(outPath);
        if (stats.size > 0) return outPath;
    } catch { }

    // Run ffmpeg to extract a frame
    // ffmpeg -ss 5 -i "input.mp4" -vf "scale=320:-1:flags=lanczos" -vframes 1 -q:v 2 "output.jpg" -y
    const ffprobePath = process.env.FFPROBE_PATH || 'ffprobe'; // Not used here, need ffmpeg
    const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';

    return new Promise((resolve, reject) => {
        const args = [
            '-ss', String(timeOffsetSeconds),
            '-i', inputPath,
            '-vf', `scale=${width}:-2`, // -2 ensures even height, good for encoding
            '-vframes', '1',
            '-q:v', '5', // Quality (1-31, lower is better)
            '-y',
            outPath
        ];

        const p = spawn(ffmpegPath, args, { stdio: 'ignore' });

        p.on('close', (code) => {
            if (code === 0) {
                resolve(outPath);
            } else {
                reject(new Error(`ffmpeg exited with code ${code}`));
            }
        });

        p.on('error', (err) => {
            reject(err);
        });
    });
}
