import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const preloadPath = path.resolve(__dirname, '../dist/preload.js');

// Read the compiled preload.js
let content = fs.readFileSync(preloadPath, 'utf-8');

// Remove the export statement that TypeScript adds
content = content.replace(/\nexport \{\};?\s*$/, '');

// Write back
fs.writeFileSync(preloadPath, content, 'utf-8');

console.log('Cleaned preload.js: removed export statement');
