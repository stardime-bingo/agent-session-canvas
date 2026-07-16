/**
 * Production-build, read-only carry acceptance server.
 * It binds only 127.0.0.1:4518, exposes static output, and rejects every /api request.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { build } from 'vite';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = path.join(repo, 'tests/fixtures/carry-acceptance');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-carry-4518-'));
const dist = path.join(temporary, 'dist');

await build({
  root: fixture,
  publicDir: false,
  plugins: [react()],
  clearScreen: false,
  logLevel: 'warn',
  build: { outDir: dist, emptyOutDir: true },
});

const index = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
if (/<script(?![^>]*\bsrc=)|<style\b|react-refresh|\/@fs|@vite\/client/i.test(index)) {
  throw new Error('carry acceptance build is not static/CSP-safe');
}

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};
const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1:4518');
  response.setHeader('Content-Security-Policy', "script-src 'self'; object-src 'none'; base-uri 'none'");
  response.setHeader('Cache-Control', 'no-store');
  if (url.pathname.startsWith('/api')) {
    response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('carry acceptance fixture has no API');
    return;
  }
  if (url.pathname === '/favicon.ico') {
    response.writeHead(204);
    response.end();
    return;
  }
  let relative;
  try { relative = decodeURIComponent(url.pathname === '/' ? 'index.html' : url.pathname.slice(1)); }
  catch { response.writeHead(400); response.end('bad path'); return; }
  const file = path.resolve(dist, relative);
  if (!(file === path.join(dist, 'index.html') || file.startsWith(`${dist}${path.sep}`))
    || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('not found');
    return;
  }
  response.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(response);
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(4518, '127.0.0.1', resolve);
});
console.log(JSON.stringify({ ready: true, url: 'http://127.0.0.1:4518', dist }));

let closing = false;
const close = () => {
  if (closing) return;
  closing = true;
  server.close(() => {
    fs.rmSync(temporary, { recursive: true, force: true });
    process.exit(0);
  });
};
process.on('SIGINT', close);
process.on('SIGTERM', close);
