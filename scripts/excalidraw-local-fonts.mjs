/**
 * [INPUT]: 锁定的 @excalidraw/excalidraw 0.18.1 生产字体模块
 * [OUTPUT]: Vite build 前把唯一 esm.sh 字体 fallback 收口为同源根，并提供真实字体子集 worker 的固定分组
 * [POS]: 生产 web 与 4518 共用的离线字体构建边界；保留上游 Worker，不做运行时改写
 * [PROTOCOL]: 变更时更新此头部，然后检查 vite.config.mjs/verify-subset-worker-build.mjs/CLAUDE.md
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const EXCALIDRAW_FONT_LOCK = Object.freeze({
  version: '0.18.1',
  moduleSuffix: '/node_modules/@excalidraw/excalidraw/dist/prod/chunk-K2UTITRG.js',
  sha256: '72b54e8e9b3c17c69f1dd5e40203bfaed62313bc611b86ecb8a1625a12562e51',
  remoteSource: '`https://esm.sh/${M.PKG_NAME?`${M.PKG_NAME}@${M.PKG_VERSION}`:"@excalidraw/excalidraw"}/dist/prod/`',
  localSource: 'window.location.origin+"/"',
});

export const EXCALIDRAW_SUBSET_WORKER_GROUPS = Object.freeze([Object.freeze({
  name: 'excal-subset-worker',
  test: /node_modules[\\/]@excalidraw[\\/]excalidraw[\\/]dist[\\/](?:prod|dev)[\\/]subset-(?:worker|shared)\.chunk\.js$/,
  priority: 100,
  minSize: 0,
  includeDependenciesRecursively: true,
  entriesAware: true,
  entriesAwareMergeThreshold: 0,
})]);

const sha256 = source => crypto.createHash('sha256').update(source).digest('hex');
const countExact = (source, needle) => source.split(needle).length - 1;
const normalizedId = id => String(id).split('?', 1)[0].replaceAll('\\', '/');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function excalidrawLocalFonts({
  packageVersion = JSON.parse(fs.readFileSync(
    path.join(repo, 'node_modules/@excalidraw/excalidraw/package.json'),
    'utf8',
  )).version,
  lock = EXCALIDRAW_FONT_LOCK,
} = {}) {
  let transformed = 0;
  const assertVersion = () => {
    if (packageVersion !== lock.version) {
      throw new Error(`Excalidraw font boundary version drift: expected ${lock.version}, got ${packageVersion}`);
    }
  };
  return {
    name: 'excalidraw-local-fonts',
    apply: 'build',
    enforce: 'pre',
    buildStart() {
      assertVersion();
    },
    transform(code, id) {
      if (!normalizedId(id).endsWith(lock.moduleSuffix)) return null;
      assertVersion();
      transformed++;
      if (transformed !== 1) {
        throw new Error(`Excalidraw font boundary matched ${transformed} modules; expected exactly one`);
      }
      const actualHash = sha256(code);
      if (actualHash !== lock.sha256) {
        throw new Error(`Excalidraw font boundary SHA drift: expected ${lock.sha256}, got ${actualHash}`);
      }
      const hits = countExact(code, lock.remoteSource);
      if (hits !== 1) {
        throw new Error(`Excalidraw remote font fallback matches ${hits}; expected exactly one`);
      }
      return {
        code: code.replace(lock.remoteSource, lock.localSource),
        map: null,
      };
    },
    buildEnd(error) {
      if (!error && transformed !== 1) {
        throw new Error(`Excalidraw font boundary transformed ${transformed} modules; expected exactly one`);
      }
    },
  };
}
