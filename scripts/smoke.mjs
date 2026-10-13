#!/usr/bin/env node
// Smoke test — serves the project exactly like a static host (Vercel/Amplify
// style) and verifies:
//   1. index.html and every locally referenced asset resolve (200)
//   2. the full ES-module import graph resolves on disk
//   3. no legacy backend references (php/mysql/localhost/API_BASE) remain
//   4. pinned CDN + model URLs respond (skipped cleanly when offline)

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, normalize } from 'node:path';

const ROOT = decodeURIComponent(new URL('..', import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1');
const PORT = 8765;
let failures = 0;

const fail = (msg) => { failures += 1; console.error(`FAIL  ${msg}`); };
const ok = (msg) => console.log(`ok    ${msg}`);
const skip = (msg) => console.log(`skip  ${msg}`);

const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.mp3': 'audio/mpeg', '.svg': 'image/svg+xml', '.png': 'image/png',
};

const server = createServer(async (req, res) => {
  try {
    const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let path = normalize(join(ROOT, url === '/' ? 'index.html' : url));
    if (!path.startsWith(normalize(ROOT))) { res.writeHead(403).end(); return; }
    const info = await stat(path);
    if (info.isDirectory()) path = join(path, 'index.html');
    const body = await readFile(path);
    res.writeHead(200, { 'content-type': MIME[extname(path)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
});

await new Promise((r) => server.listen(PORT, '127.0.0.1', r));
const base = `http://127.0.0.1:${PORT}`;

async function get(path) {
  const res = await fetch(base + path);
  return { status: res.status, text: await res.text() };
}

// ---------------------------------------------------------------- 1. index
const index = await get('/');
if (index.status !== 200) fail(`index.html → HTTP ${index.status}`);
else ok('index.html served');

// every local src/href in index.html must resolve
const refs = [...index.text.matchAll(/(?:src|href)="([^"]+)"/g)]
  .map((m) => m[1])
  .filter((u) => !/^(https?:|data:|#|mailto:)/.test(u));

for (const ref of refs) {
  const { status } = await get('/' + ref.replace(/^\.?\//, ''));
  if (status !== 200) fail(`asset ${ref} → HTTP ${status}`);
  else ok(`asset ${ref}`);
}

// ------------------------------------------------------- 2. import graph
const seen = new Set();
async function crawl(entry) {
  if (seen.has(entry)) return;
  seen.add(entry);
  let text;
  try {
    const r = await get('/' + entry);
    if (r.status !== 200) { fail(`module ${entry} → HTTP ${r.status}`); return; }
    text = r.text;
  } catch (e) { fail(`module ${entry}: ${e.message}`); return; }
  const imports = [...text.matchAll(/from\s+['"](\.[^'"]+)['"]|import\(['"](\.[^'"]+)['"]\)/g)]
    .map((m) => m[1] || m[2]);
  for (const imp of imports) {
    const target = normalize(join(entry, '..', imp)).replace(/\\/g, '/');
    await crawl(target);
  }
}
await crawl('js/main.js');
ok(`ES module graph resolved (${seen.size} modules)`);

// --------------------------------------------------- 3. legacy code scan
const banned = [
  { re: /\.php\b/, label: 'PHP endpoint reference' },
  { re: /API_BASE/, label: 'legacy API_BASE' },
  { re: /https?:\/\/(localhost|127\.0\.0\.1)/i, label: 'hard-coded localhost URL' },
  { re: /mysql|mysqli/i, label: 'MySQL reference' },
  { re: /upload_song|fetchSongs|fetchContacts/, label: 'legacy backend function' },
];
for (const file of seen) {
  const { text } = await get('/' + file);
  for (const b of banned) {
    if (b.re.test(text)) fail(`${file}: ${b.label} found`);
  }
}
const html = await get('/');
for (const b of banned) {
  if (b.re.test(html.text)) fail(`index.html: ${b.label} found`);
}
if (failures === 0) ok('no legacy backend references in app code');

// ------------------------------------------------- 4. external asset URLs
const urls = [
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.0/vision_bundle.mjs',
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.1.0/wasm/vision_wasm_internal.js',
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task',
  'https://cdn.jsdelivr.net/npm/@techstark/opencv-js@4.10.0-release.1/dist/opencv.js',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
];
let online = true;
for (const url of urls) {
  try {
    const res = await fetch(url, { method: 'HEAD' });
    if (res.status >= 400) fail(`external ${url} → HTTP ${res.status}`);
    else ok(`external ${url} → ${res.status}`);
  } catch (e) {
    online = false;
    skip(`external ${url} (network unavailable: ${e.message})`);
  }
}
if (!online) skip('external URL verification requires internet access');

server.close();
console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll smoke checks passed');
process.exit(failures ? 1 : 0);
