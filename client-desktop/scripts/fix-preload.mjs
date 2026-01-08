import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const candidates = [
	path.resolve(__dirname, '../dist/preload.js'),
	path.resolve(__dirname, '../dist/preload.cjs'),
];

const preloadPath = candidates.find((p) => fs.existsSync(p));

if (!preloadPath) {
	console.log('No preload file found to clean');
	process.exit(0);
}

// Read the compiled preload.js
let content = fs.readFileSync(preloadPath, 'utf-8');

// Remove the export statement that TypeScript adds
content = content.replace(/\nexport \{\};?\s*$/, '');

// Write back
fs.writeFileSync(preloadPath, content, 'utf-8');

console.log('Cleaned preload.js: removed export statement');
