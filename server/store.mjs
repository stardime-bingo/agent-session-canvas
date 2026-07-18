/**
 * [INPUT]: 依赖 node:fs / node:path 的文件读写能力
 * [OUTPUT]: 对外提供 DATA_DIR、JSON/JSONL 原子原语、内存扫描缓存、增强仓事务更新
 * [POS]: server 的持久层。扫描缓存常驻内存；AI 增强数据跨进程加锁更新，珍贵数据不许被旧快照覆盖
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ============================================================
//  路径常量：所有运行时产物收敛在 data/ 一处
// ============================================================
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 环境变量仅供并行测试实例（与 AGENT_CANVAS_PORT 同族），生产恒为仓内 data/
export const DATA_DIR = process.env.AGENT_CANVAS_DATA_DIR || path.join(ROOT, 'data');
export const WEB_DIST = path.join(ROOT, 'web', 'dist');

const CACHE_FILE = path.join(DATA_DIR, 'scan-cache.json');   // 扫描缓存：mtime 命中即免重读
const ENRICH_FILE = path.join(DATA_DIR, 'enrich.json');      // AI 增强：标题/摘要/接力提示词

fs.mkdirSync(DATA_DIR, { recursive: true });

// ============================================================
//  JSON 读写：原子写入（tmp + rename），崩溃不留半截文件
// ============================================================
export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJson(file, data) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// mkdir 是跨进程原子操作；锁只包住“读最新值→改→原子写”这一小段。
// 进程若崩在锁内，30 秒后的下一位写者会回收僵尸锁。
function withFileLock(file, task) {
  const lock = `${file}.lock`;
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 30000) {
          fs.rmSync(lock, { recursive: true, force: true });
          continue;
        }
      } catch { continue; }
      if (Date.now() >= deadline) throw new Error(`数据锁等待超时: ${path.basename(file)}`);
      sleep(20);
    }
  }
  try { return task(); }
  finally { fs.rmSync(lock, { recursive: true, force: true }); }
}

export function updateJsonLocked(file, fallback, mutate) {
  return withFileLock(file, () => {
    const current = readJson(file, fallback);
    const next = mutate(current) || current;
    writeJson(file, next);
    return next;
  });
}

// 追加后读尾验证 last-wins；同 id 被别的进程抢写时再追加一次夺回用户动作。
export function appendJsonlVerified(file, record, identityKey = 'id') {
  const line = JSON.stringify(record);
  for (let attempt = 0; attempt < 2; attempt++) {
    fs.appendFileSync(file, line + '\n');
    const fd = fs.openSync(file, 'r');
    let text;
    try {
      const size = fs.fstatSync(fd).size;
      const len = Math.min(size, 262144);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      text = buf.toString('utf8');
    } finally { fs.closeSync(fd); }
    const latest = text.split('\n').reverse().find(raw => {
      if (!raw) return false;
      try { return JSON.parse(raw)[identityKey] === record[identityKey]; }
      catch { return false; }
    });
    if (latest) {
      try {
        const parsed = JSON.parse(latest);
        if (Object.keys(record).every(k => parsed[k] === record[k])) return parsed;
      } catch { /* 再追加一次 */ }
    }
  }
  throw new Error(`JSONL 写后校验失败: ${path.basename(file)}`);
}

// ============================================================
//  扫描缓存仓：{ __version, [filePath]: { mtime, size, session } }
//  解析器升级必须递增版本号——否则 mtime 命中的旧条目永远吃不到新逻辑
// ============================================================
const CACHE_VERSION = 5;   // v5: 会话尾部解析覆盖 Codex custom_tool_call 事件
let cacheMemory = null;

export function loadCache() {
  if (cacheMemory) return cacheMemory;
  const disk = readJson(CACHE_FILE, {});
  cacheMemory = disk.__version === CACHE_VERSION ? disk : { __version: CACHE_VERSION };
  return cacheMemory;
}

export function saveCache(cache) {
  cacheMemory = cache;
  // 脏检查：本轮无新解析、无删条目就不落盘——不该存在的写入比写对的写入更该消失
  if (!cache.__dirty) return;
  delete cache.__dirty;
  cache.__version = CACHE_VERSION;
  writeJson(CACHE_FILE, cache);
}

// ============================================================
//  增强数据仓：{ titles, summaries, handoffs } 均以 sessionKey 为键
// ============================================================
export function loadEnrich() {
  const e = readJson(ENRICH_FILE, {});
  return { titles: {}, summaries: {}, handoffs: {}, wsTitles: {}, ...e };
}

export function updateEnrich(mutate) {
  return updateJsonLocked(ENRICH_FILE, {}, raw => {
    const enrich = { titles: {}, summaries: {}, handoffs: {}, wsTitles: {}, ...raw };
    return mutate(enrich) || enrich;
  });
}
