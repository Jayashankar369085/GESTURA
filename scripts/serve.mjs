#!/usr/bin/env node
// Minimal static file server for local development (no dependencies).
// Usage: node scripts/serve.mjs [port]   (default 8080)
// Camera access requires a secure context: http://localhost counts as secure.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';

const PORT = Number(process.argv[2] || process.env.PORT || 8080);
const ROOT = decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.task': 'application/octet-stream',
  '.wasm': 'application/wasm',
};

createServer(async (req, res) => {
  try {
    const url = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    let path = normalize(join(ROOT, url === '/' ? 'index.html' : url));
    if (!path.startsWith(normalize(ROOT))) { res.writeHead(403).end('forbidden'); return; }
    const info = await stat(path);
    if (info.isDirectory()) path = join(path, 'index.html');
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': MIME[extname(path)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('404 not found');
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Apex Drive dev server → http://localhost:${PORT}`);
});
