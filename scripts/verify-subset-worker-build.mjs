/**
 * [INPUT]: 依赖 Vite 产物 web/dist/index.html + assets
 * [OUTPUT]: 递归验证 app main、Excal prod 与字体子集 worker 三个静态闭包完整，worker core 不进入 main/prod
 * [POS]: npm build 的硬闸门；允许小型共享 bridge，禁止大型 worker core 被主线程静态拉入
 * [PROTOCOL]: 变更时更新此头部，然后检查 vite.config.mjs/CLAUDE.md
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const staticImports = code => {
  const imports = [];
  const pattern = /(?:from\s*|import\s*)["']\.\/([^"']+)["']/g;
  for (const match of code.matchAll(pattern)) imports.push(match[1]);
  return [...new Set(imports)];
};

export function collectStaticClosure(entry, source, label = entry) {
  const closure = new Set();
  const visit = file => {
    assert.ok(source.has(file), `missing static ${label} dependency: ${file}`);
    if (closure.has(file)) return;
    closure.add(file);
    for (const dependency of staticImports(source.get(file))) visit(dependency);
  };
  visit(entry);
  return closure;
}

export function assertWorkerCoreIsolation({ workerEntry, prodEntry, appEntry, workerCore, workerClosure, prodClosure, appClosure }) {
  assert.ok(workerClosure.has(workerCore), 'worker closure is missing its isolated core');
  assert.equal(workerClosure.has(prodEntry), false, 'worker closure reaches Excal prod entry');
  assert.equal(workerClosure.has(appEntry), false, 'worker closure reaches app main entry');
  assert.equal(prodClosure.has(workerCore), false, 'Excal prod closure eagerly imports worker-only core');
  assert.equal(appClosure.has(workerCore), false, 'app main closure eagerly imports worker-only core');
}

export function assertSharedChunkBudget(
  files,
  bytes,
  label,
  { perChunkBytes = 64_000, totalBytes = 128_000 } = {},
) {
  const sizes = files.map(file => ({ file, bytes: bytes(file) }));
  for (const entry of sizes) {
    assert.ok(entry.bytes <= perChunkBytes,
      `${label} shared chunk exceeds ${perChunkBytes}B: ${entry.file} (${entry.bytes}B)`);
  }
  const total = sizes.reduce((sum, entry) => sum + entry.bytes, 0);
  assert.ok(total <= totalBytes, `${label} shared chunks exceed ${totalBytes}B total: ${total}B`);
  return sizes;
}

const unique = (values, label) => {
  assert.equal(values.length, 1, `expected one ${label}, found ${values.join(', ') || 'none'}`);
  return values[0];
};
const intersection = (left, right) => [...left].filter(file => right.has(file));

function main() {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dist = path.join(repo, 'web/dist');
  const assetsDir = path.join(dist, 'assets');
  const files = fs.readdirSync(assetsDir).filter(file => file.endsWith('.js'));
  const source = new Map(files.map(file => [file, fs.readFileSync(path.join(assetsDir, file), 'utf8')]));
  const bytes = file => fs.statSync(path.join(assetsDir, file)).size;
  for (const [file, code] of source) {
    assert.doesNotMatch(code, /https:\/\/esm\.sh\//,
      `build output retains remote Excalidraw font fallback: ${file}`);
  }

  const workerEntry = unique(
    files.filter(file => file.startsWith('excal-subset-worker') && /self\.onmessage/.test(source.get(file))),
    'Excal subset worker entry',
  );
  const prodEntry = unique(files.filter(file => /^prod-.*\.js$/.test(file)), 'Excal prod entry');
  const index = fs.readFileSync(path.join(dist, 'index.html'), 'utf8');
  const moduleEntries = [...index.matchAll(/<script\b(?=[^>]*\btype=["']module["'])(?=[^>]*\bsrc=["'][^"']*\/assets\/([^"']+\.js)["'])[^>]*>/g)]
    .map(match => match[1]);
  const appEntry = unique(moduleEntries, 'app module entry');

  const workerClosure = collectStaticClosure(workerEntry, source, 'worker');
  const prodClosure = collectStaticClosure(prodEntry, source, 'prod');
  const appClosure = collectStaticClosure(appEntry, source, 'app');
  const workerCores = [...workerClosure]
    .filter(file => bytes(file) > 1_000_000 && /WebAssembly/.test(source.get(file)));
  const workerCore = unique(workerCores, 'isolated WebAssembly font-subset core');

  assertWorkerCoreIsolation({
    workerEntry, prodEntry, appEntry, workerCore, workerClosure, prodClosure, appClosure,
  });

  for (const file of workerClosure) {
    const code = source.get(file);
    if (bytes(file) < 100_000) {
      assert.doesNotMatch(code, /\bdocument\s*\.|createRoot\(|react-flow/i,
        `worker closure contains browser-main code: ${file}`);
    }
  }
  const groupedProdDeps = staticImports(source.get(prodEntry))
    .filter(file => file.startsWith('excal-subset-worker'));
  for (const file of groupedProdDeps) {
    assert.ok(bytes(file) < 64_000,
      `Excal prod grouped dependency is unexpectedly large: ${file} (${bytes(file)}B)`);
  }
  const appWorkerShared = intersection(appClosure, workerClosure)
    .filter(file => file !== workerCore && file !== workerEntry);
  const prodWorkerShared = intersection(prodClosure, workerClosure)
    .filter(file => file !== workerCore && file !== workerEntry);
  const sharedBudgets = {
    appWorker: assertSharedChunkBudget(appWorkerShared, bytes, 'app/worker'),
    prodWorker: assertSharedChunkBudget(prodWorkerShared, bytes, 'prod/worker'),
  };

  const describe = closure => [...closure].map(file => ({ file, bytes: bytes(file) }));
  console.log(JSON.stringify({
    appEntry,
    prodEntry,
    workerEntry,
    workerCore,
    closures: {
      app: describe(appClosure),
      prod: describe(prodClosure),
      worker: describe(workerClosure),
    },
    intersections: {
      appProd: intersection(appClosure, prodClosure),
      appWorker: intersection(appClosure, workerClosure),
      prodWorker: intersection(prodClosure, workerClosure),
    },
    sharedBudgets,
    groupedProdDeps: groupedProdDeps.map(file => ({ file, bytes: bytes(file) })),
  }));
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) main();
