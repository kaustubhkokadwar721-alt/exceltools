// Node fallback launcher for the ExcelTools offline build. Use this if Python is
// not available:  node serve.mjs
// Everything runs locally; a local http:// origin is needed for Web Workers,
// WebAssembly and the offline service worker (a bare file:// will not do).
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('.', import.meta.url));
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png',
};

const server = http.createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const abs = normalize(join(dir, p));
    if (!abs.startsWith(dir)) { res.writeHead(403); return res.end(); }
    const body = await readFile(abs);
    res.writeHead(200, { 'Content-Type': MIME[extname(abs)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('Not found');
  }
});

function listen(port, tries = 25) {
  server.once('error', (e) => {
    if (e.code === 'EADDRINUSE' && tries > 0) listen(port + 1, tries - 1);
    else throw e;
  });
  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}/`;
    console.log(`ExcelTools is running at ${url}`);
    console.log('Leave this window open while you use it. Press Ctrl+C to stop.');
  });
}

listen(Number(process.env.PORT || 8000));
