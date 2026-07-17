/**
 * Production-build, read-only acceptance server.
 * It binds only 127.0.0.1:4518, builds one allowlisted synthetic fixture, serves
 * that temporary dist only, and rejects every write/API/repository path.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import react from '@vitejs/plugin-react';
import { build } from 'vite';
import {
  EXCALIDRAW_SUBSET_WORKER_GROUPS, excalidrawLocalFonts,
} from './excalidraw-local-fonts.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = Object.freeze({
  carry: path.join(repo, 'tests/fixtures/carry-acceptance'),
  canvas: path.join(repo, 'tests/fixtures/canvas-acceptance'),
  prod: path.join(repo, 'web'),
});
const PROD_BOOTSTRAP = "window.EXCALIDRAW_ASSET_PATH = '/';";
const FORBIDDEN_SEGMENTS = new Set(['api', 'data', '@fs', '.git']);
const DOCUMENT_CSP = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "form-action 'none'",
  "object-src 'none'",
  "base-uri 'none'",
].join('; ');
const SUBSET_WORKER_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'",
  "connect-src 'self'",
  "worker-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
].join('; ');

export function productionDocumentCsp(index) {
  const inlineScripts = [...index.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
    .map(match => match[1]);
  if (inlineScripts.length !== 1 || inlineScripts[0] !== PROD_BOOTSTRAP) {
    throw new Error(`production index inline bootstrap drift: expected exactly ${JSON.stringify(PROD_BOOTSTRAP)}`);
  }
  const hash = crypto.createHash('sha256').update(inlineScripts[0], 'utf8').digest('base64');
  return [
    "default-src 'none'",
    `script-src 'self' 'sha256-${hash}' 'wasm-unsafe-eval'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "worker-src 'self' blob:",
    "connect-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'none'",
    "object-src 'none'",
    "base-uri 'none'",
  ].join('; ');
}

export function acceptanceCspFor(relative, subsetWorkerEntries = new Set()) {
  return subsetWorkerEntries.has(relative) ? SUBSET_WORKER_CSP : DOCUMENT_CSP;
}

export function findSubsetWorkerEntries(dist) {
  const assets = path.join(dist, 'assets');
  if (!fs.existsSync(assets)) return new Set();
  return new Set(fs.readdirSync(assets)
    .filter(file => file.endsWith('.js') && file.includes('subset-worker'))
    .filter(file => /self\.onmessage/.test(fs.readFileSync(path.join(assets, file), 'utf8')))
    .map(file => `assets/${file}`));
}

export function mergeStaticAssets(source, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) {
      mergeStaticAssets(from, to);
    } else if (fs.existsSync(to)) {
      if (!fs.readFileSync(from).equals(fs.readFileSync(to))) {
        throw new Error(`static asset hash collision: ${entry.name}`);
      }
    } else {
      fs.copyFileSync(from, to);
    }
  }
}

export function selectAcceptanceFixture(argv = []) {
  const selectors = argv.filter(value => value.startsWith('--fixture='));
  if (selectors.length > 1) throw new Error('acceptance fixture must be selected exactly once');
  const name = selectors.length ? selectors[0].slice('--fixture='.length) : 'carry';
  if (!Object.hasOwn(FIXTURES, name)) {
    throw new Error(`unsupported acceptance fixture: ${name || '(empty)'}`);
  }
  return name;
}

export function classifyAcceptanceRequest(method = 'GET', requestUrl = '/') {
  if (method !== 'GET' && method !== 'HEAD') return { status: 405, reason: 'read-only' };
  const rawPath = String(requestUrl).split(/[?#]/, 1)[0] || '/';
  let pathname;
  try { pathname = decodeURIComponent(rawPath); }
  catch { return { status: 400, reason: 'bad path encoding' }; }
  if (!pathname.startsWith('/') || pathname.startsWith('//')
    || pathname.includes('\\') || pathname.includes('\0')) {
    return { status: 403, reason: 'absolute path required' };
  }
  const segments = pathname.split('/').filter(Boolean);
  if (segments.includes('..') || segments.some(segment => FORBIDDEN_SEGMENTS.has(segment))) {
    return { status: 403, reason: 'forbidden path' };
  }
  if (pathname === '/favicon.ico') return { status: 204 };
  const relative = pathname === '/' ? 'index.html' : segments.join('/');
  if (relative !== 'index.html'
    && !relative.startsWith('assets/')
    && !relative.startsWith('fonts/')) {
    return { status: 404, reason: 'not found' };
  }
  return { status: 200, relative };
}

async function main() {
  const fixtureName = selectAcceptanceFixture(process.argv.slice(2));
  const fixture = FIXTURES[fixtureName];
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), `agent-${fixtureName}-4518-`));
  const dist = path.join(temporary, 'dist');
  const interactionDist = path.join(temporary, 'interaction-dist');
  let server;
  let buildWorkerEntries = null;

  try {
    const buildStatic = (root, outDir) => build({
      root,
      configFile: false,
      publicDir: false,
      plugins: [excalidrawLocalFonts(), react()],
      clearScreen: false,
      logLevel: 'warn',
      build: {
        outDir,
        emptyOutDir: true,
        rolldownOptions: {
          output: {
            codeSplitting: { groups: EXCALIDRAW_SUBSET_WORKER_GROUPS },
          },
        },
      },
    });
    await buildStatic(fixture, dist);
    if (fixtureName === 'prod') {
      await buildStatic(FIXTURES.canvas, interactionDist);
      const prod = findSubsetWorkerEntries(dist);
      const interaction = findSubsetWorkerEntries(interactionDist);
      if (prod.size !== 1 || interaction.size !== 1) {
        throw new Error(`expected one real subset worker per prod build, found prod=${prod.size} interaction=${interaction.size}`);
      }
      buildWorkerEntries = { prod: [...prod], interaction: [...interaction] };
      mergeStaticAssets(path.join(interactionDist, 'assets'), path.join(dist, 'assets'));
    }
    const fonts = path.join(repo, 'web/public/fonts');
    if (!fs.existsSync(fonts)) {
      throw new Error('missing prepared Excalidraw fonts; run npm run build first');
    }
    fs.cpSync(fonts, path.join(dist, 'fonts'), { recursive: true });

    const index = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
    const interactionIndex = fixtureName === 'prod'
      ? fs.readFileSync(path.join(interactionDist, 'index.html'), 'utf8')
      : null;
    if (fixtureName !== 'prod'
      && /<script(?![^>]*\bsrc=)|<style\b|react-refresh|\/@fs|@vite\/client/i.test(index)) {
      throw new Error(`${fixtureName} acceptance build is not static/CSP-safe`);
    }
    if (fixtureName === 'prod'
      && (/<style\b|react-refresh|\/@fs|@vite\/client/i.test(index)
        || /<script(?![^>]*\bsrc=)|<style\b|react-refresh|\/@fs|@vite\/client/i.test(interactionIndex))) {
      throw new Error('prod acceptance build is not static/CSP-safe');
    }
    const prodCsp = fixtureName === 'prod' ? productionDocumentCsp(index) : null;
    const subsetWorkerEntries = findSubsetWorkerEntries(dist);
    if (fixtureName === 'canvas' && subsetWorkerEntries.size !== 1) {
      throw new Error(`expected one real canvas subset worker entry, found ${subsetWorkerEntries.size}`);
    }
    const mime = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.svg': 'image/svg+xml',
      '.woff2': 'font/woff2',
    };
    const realDist = fs.realpathSync(dist);
    server = http.createServer((request, response) => {
      const route = classifyAcceptanceRequest(request.method, request.url);
      const requestUrl = new URL(request.url, 'http://127.0.0.1:4518');
      const interactionDocument = fixtureName === 'prod'
        && route.relative === 'index.html'
        && requestUrl.searchParams.get('mode') === 'interaction';
      response.setHeader(
        'Content-Security-Policy',
        interactionDocument
          ? DOCUMENT_CSP
          : (fixtureName === 'prod' && route.relative === 'index.html'
            ? prodCsp
            : acceptanceCspFor(route.relative, subsetWorkerEntries)),
      );
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      if (route.status !== 200) {
        if (route.status === 405) response.setHeader('Allow', 'GET, HEAD');
        response.writeHead(route.status, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end(route.reason || '');
        return;
      }
      const file = path.resolve(dist, route.relative);
      let valid = false;
      try {
        const realFile = fs.realpathSync(file);
        valid = realFile.startsWith(`${realDist}${path.sep}`)
          && fs.statSync(realFile).isFile();
      } catch { /* missing output stays 404 */ }
      if (!valid) {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        response.end('not found');
        return;
      }
      response.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' });
      if (request.method === 'HEAD') response.end();
      else if (interactionDocument) response.end(interactionIndex);
      else fs.createReadStream(file).pipe(response);
    });

    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(4518, '127.0.0.1', resolve);
    });
    console.log(JSON.stringify({
      ready: true,
      fixture: fixtureName,
      url: 'http://127.0.0.1:4518',
      dist,
      ...(buildWorkerEntries ? { workers: buildWorkerEntries } : {}),
    }));

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
  } catch (error) {
    if (server?.listening) server.close();
    fs.rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
  main().catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
