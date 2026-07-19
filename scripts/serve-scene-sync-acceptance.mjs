/**
 * [INPUT]: AGENT_CANVAS_SYNC_PORT 与 AGENT_CANVAS_SYNC_DATA_DIR（验收器提供的临时目录）
 * [OUTPUT]: 仅本机临时 scene daemon：真实 createScene LWW/SSE + production SceneStore 浏览器夹具
 * [POS]: 双标签、daemon 重启与 pagehide 隔离验收；不扫描会话、不读取仓内 data、不接触 4517/launchd
 * [PROTOCOL]: 变更时更新此头部，然后检查 scene-sync-acceptance/README、server/CLAUDE.md
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { build } from 'vite';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = path.join(repo, 'tests/fixtures/scene-sync-acceptance');
const port = Number(process.env.AGENT_CANVAS_SYNC_PORT || 4519);
const suppliedDataDir = process.env.AGENT_CANVAS_SYNC_DATA_DIR;
const ownedDataDir = !suppliedDataDir;
const dataDir = suppliedDataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'agent-scene-sync-data-'));
const buildRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-scene-sync-build-'));
const dist = path.join(buildRoot, 'dist');
const WRITE_DELAY_MS = 150;

process.env.AGENT_CANVAS_DATA_DIR = dataDir;
const { createScene } = await import('../server/scene.mjs');
const scene = createScene(dataDir);
const clients = new Set();

await build({
  root: fixture,
  configFile: false,
  publicDir: false,
  plugins: [react()],
  clearScreen: false,
  logLevel: 'warn',
  build: { outDir: dist, emptyOutDir: true },
});

const graph = () => {
  const snapshot = scene.read();
  return {
    sessions: [], workspaces: {}, edges: [],
    stats: { total: 0, workspaces: 0, byTool: {}, byStatus: {}, hidden: { subagent: 0, empty: 0 } },
    scannedAt: '2026-07-19T00:00:00.000Z',
    layout: snapshot.layout,
    rev: snapshot.rev,
    canvas: { ...snapshot.canvas, drawingFiles: snapshot.drawingFiles },
  };
};

const broadcast = event => {
  const line = `data: ${JSON.stringify(event)}\n\n`;
  for (const response of clients) {
    try { response.write(line); } catch { clients.delete(response); }
  }
};

const readBody = async request => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "form-action 'none'",
  "object-src 'none'",
  "base-uri 'none'",
].join('; ');

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${port}`);
  const host = request.headers.host || '';
  if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) {
    response.writeHead(403);
    response.end('forbidden');
    return;
  }
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');

  if (request.method === 'GET' && url.pathname === '/health') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ ok: true, port, dataDir, rev: scene.rev }));
    return;
  }
  if (request.method === 'GET' && url.pathname === '/favicon.ico') {
    response.writeHead(204);
    response.end();
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/events') {
    response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    response.write('data: {"type":"connected"}\n\n');
    clients.add(response);
    request.on('close', () => clients.delete(response));
    return;
  }
  if (request.method === 'GET' && url.pathname === '/api/graph') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(graph()));
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/scene') {
    try {
      const body = await readBody(request);
      await new Promise(resolve => setTimeout(resolve, WRITE_DELAY_MS));
      const result = scene.write({ layout: body.layout, canvas: body.canvas });
      broadcast({ type: 'scene-updated', rev: result.rev, writerId: body.writerId || null });
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }
  if (request.method === 'POST' && url.pathname === '/api/drawing-files') {
    try {
      const body = await readBody(request);
      const result = scene.addFiles(body.files);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(500, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: error.message }));
    }
    return;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' });
    response.end('read-only static surface');
    return;
  }

  const segments = url.pathname.split('/').filter(Boolean);
  const relative = url.pathname === '/' ? 'index.html' : segments.join('/');
  if (segments.includes('..') || (!relative.startsWith('assets/') && relative !== 'index.html')) {
    response.writeHead(404);
    response.end('not found');
    return;
  }
  const file = path.resolve(dist, relative);
  if (!file.startsWith(`${path.resolve(dist)}${path.sep}`) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    response.writeHead(404);
    response.end('not found');
    return;
  }
  if (relative === 'index.html') response.setHeader('Content-Security-Policy', CSP);
  response.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  if (request.method === 'HEAD') response.end();
  else fs.createReadStream(file).pipe(response);
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, '127.0.0.1', resolve);
});
console.log(JSON.stringify({ ready: true, port, dataDir, dist, writeDelayMs: WRITE_DELAY_MS }));

let closing = false;
const close = () => {
  if (closing) return;
  closing = true;
  for (const response of clients) response.end();
  server.close(() => {
    fs.rmSync(buildRoot, { recursive: true, force: true });
    if (ownedDataDir) fs.rmSync(dataDir, { recursive: true, force: true });
    process.exit(0);
  });
};
process.on('SIGINT', close);
process.on('SIGTERM', close);
