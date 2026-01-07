import fs from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const src = path.join(root, 'src', 'renderer.html');
const destDir = path.join(root, 'dist');
const dest = path.join(destDir, 'renderer.html');

await fs.mkdir(destDir, { recursive: true });
await fs.copyFile(src, dest);

console.log(`Copied ${path.relative(root, src)} -> ${path.relative(root, dest)}`);
