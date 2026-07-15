/**
 * [INPUT]: 依赖 Vite 产物 web/dist/assets
 * [OUTPUT]: 递归验证 Excal 字体子集 worker 静态闭包完整且不进入 prod/main，主编辑器也不静态加载大型 worker 专属块
 * [POS]: npm build 的硬闸门；禁止用关闭 Worker、console 过滤或 fallback 冒充修复
 * [PROTOCOL]: 变更时更新此头部，然后检查 vite.config.mjs/CLAUDE.md
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assetsDir = path.join(repo, 'web/dist/assets');
const files = fs.readdirSync(assetsDir).filter(file => file.endsWith('.js'));
const source = new Map(files.map(file => [file, fs.readFileSync(path.join(assetsDir, file), 'utf8')]));
const bytes = file => fs.statSync(path.join(assetsDir, file)).size;

const staticImports = code => {
  const imports = [];
  const pattern = /(?:from\s*|import\s*)["']\.\/([^"']+)["']/g;
  for (const match of code.matchAll(pattern)) imports.push(match[1]);
  return [...new Set(imports)];
};

const workerEntry = files.find(file => file.startsWith('excal-subset-worker') && /self\.onmessage/.test(source.get(file)));
assert.ok(workerEntry, 'missing grouped Excal subset worker entry');

const closure = new Set();
const visit = file => {
  assert.ok(source.has(file), `missing static worker dependency: ${file}`);
  if (closure.has(file)) return;
  closure.add(file);
  for (const dependency of staticImports(source.get(file))) visit(dependency);
};
visit(workerEntry);

const forbiddenNames = [...closure].filter(file => /^prod-|^DrawLayer-|^index-/.test(file));
assert.deepEqual(forbiddenNames, [], `worker closure reaches main chunks: ${forbiddenNames.join(', ')}`);
for (const file of closure) {
  const code = source.get(file);
  // 1.8MB wasm 会以 base64 嵌入，任意英文片段都可能偶然命中；只对可审阅的 JS 壳做词法门。
  if (bytes(file) < 100_000) {
    assert.doesNotMatch(code, /\bdocument\s*\.|createRoot\(|react-flow/i, `worker closure contains browser-main code: ${file}`);
  }
}

const workerCore = [...closure].find(file => bytes(file) > 1_000_000 && /WebAssembly/.test(source.get(file)));
assert.ok(workerCore, 'worker closure is missing its isolated WebAssembly font-subset core');

const prodEntry = files.find(file => /^prod-.*\.js$/.test(file));
assert.ok(prodEntry, 'missing Excal prod entry');
const prodStatic = staticImports(source.get(prodEntry));
const eagerWorkerCore = prodStatic.filter(file => source.has(file) && bytes(file) > 100_000 && closure.has(file));
assert.deepEqual(eagerWorkerCore, [], `Excal prod eagerly imports worker-only core: ${eagerWorkerCore.join(', ')}`);
const groupedProdDeps = prodStatic.filter(file => file.startsWith('excal-subset-worker'));
for (const file of groupedProdDeps) {
  assert.ok(bytes(file) < 64_000, `Excal prod grouped dependency is unexpectedly large: ${file} (${bytes(file)}B)`);
}

console.log(JSON.stringify({
  workerEntry,
  workerCore,
  closure: [...closure].map(file => ({ file, bytes: bytes(file) })),
  prodEntry,
  groupedProdDeps: groupedProdDeps.map(file => ({ file, bytes: bytes(file) })),
}));
