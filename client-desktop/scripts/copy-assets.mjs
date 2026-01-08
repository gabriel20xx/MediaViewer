import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const root = process.cwd();
const src = path.join(root, 'src', 'renderer.html');
const destDir = path.join(root, 'dist');
const dest = path.join(destDir, 'renderer.html');

await fs.mkdir(destDir, { recursive: true });
await fs.copyFile(src, dest);

// Inject a strict CSP with hashes for inline <style>/<script> blocks.
// This prevents Electron's "Insecure Content-Security-Policy" warning while keeping
// our single-file renderer approach.
try {
	let html = await fs.readFile(dest, 'utf8');

	const scriptHashes = [];

	for (const match of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
		const content = match[1] ?? '';
		// Skip empty script tags
		if (!content.trim()) continue;
		const hash = crypto.createHash('sha256').update(content, 'utf8').digest('base64');
		scriptHashes.push(`'sha256-${hash}'`);
	}

	const csp = [
		"default-src 'self'",
		"base-uri 'self'",
		"form-action 'none'",
		"object-src 'none'",
		"img-src 'self' data: blob: http: https:",
		"media-src 'self' blob: data: http: https:",
		"connect-src 'self' http: https: ws: wss:",
		`script-src 'self' ${scriptHashes.join(' ')}`.trimEnd(),
		// Allow inline styles because the renderer uses element.style updates and style attributes.
		// Keep scripts strict via hashes.
		"style-src 'self' 'unsafe-inline'",
	].join('; ');

	const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${csp}" />`;

	// Remove any existing CSP meta tags.
	html = html.replace(/\s*<meta\s+http-equiv=["']Content-Security-Policy["'][^>]*>\s*/gi, '\n');

	// Insert CSP meta after the viewport tag if present, otherwise after <head>.
	if (html.includes('name="viewport"')) {
		html = html.replace(
			/(<meta\s+name=["']viewport["'][^>]*>)/i,
			`$1\n    ${cspMeta}`
		);
	} else {
		html = html.replace(/<head>/i, `<head>\n    ${cspMeta}`);
	}

	await fs.writeFile(dest, html, 'utf8');
	console.log('Injected CSP into renderer.html');
} catch (err) {
	console.warn('Failed to inject CSP into renderer.html:', err);
}

console.log(`Copied ${path.relative(root, src)} -> ${path.relative(root, dest)}`);
