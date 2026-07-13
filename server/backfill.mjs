/**
 * [INPUT]: 依赖 scanner 的会话清单、ai 的 nameSession、store 的增强仓
 * [OUTPUT]: 对外提供 runBackfill()/backfillStatus()；CLI 直跑（--dry 只数不跑）
 * [POS]: server 的批量人话化流水线——只管近 30 天，把机器标题翻译成人能扫一眼就懂的名字
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import { fileURLToPath } from 'node:url';
import { scanAll } from './scanner.mjs';
import { nameSession } from './ai.mjs';

const WINDOW_MS = 30 * 24 * 3600 * 1000;   // 铁律：历史不管，只管近 30 天
const CONCURRENCY = 3;

// ============================================================
//  候选判定：s.title === s.firstPrompt 即"机器标题"——
//  说明没有人工命名、没有 AI 命名、没有工具自带标题，只剩指令原文
// ============================================================
export function findCandidates() {
  const { sessions } = scanAll();
  const cutoff = Date.now() - WINDOW_MS;
  return sessions
    .filter(s => new Date(s.updatedAt).getTime() > cutoff)
    .filter(s => s.title && s.title === s.firstPrompt)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

// ============================================================
//  执行态：单例运行，进度可查，逐条落盘（中断不丢已完成的）
// ============================================================
const state = { running: false, done: 0, failed: 0, total: 0, current: null, byBackend: {} };
export const backfillStatus = () => ({ ...state });

export async function runBackfill(onProgress) {
  if (state.running) return state;
  const candidates = findCandidates();
  Object.assign(state, { running: true, done: 0, failed: 0, total: candidates.length, byBackend: {} });

  const queue = [...candidates];
  const worker = async () => {
    for (let s = queue.shift(); s; s = queue.shift()) {
      state.current = s.key;
      try {
        const { backend } = await nameSession(s);
        state.byBackend[backend] = (state.byBackend[backend] || 0) + 1;
        state.done++;
      } catch (e) {
        state.failed++;
        console.error(`✗ ${s.key}: ${e.message.slice(0, 150)}`);
      }
      console.log(`[${state.done + state.failed}/${state.total}] ${s.key}`);
      onProgress?.(state);
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  state.running = false;
  state.current = null;
  return state;
}

// ============================================================
//  CLI 入口：node server/backfill.mjs [--dry]
// ============================================================
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const candidates = findCandidates();
  console.log(`近 30 天机器标题会话: ${candidates.length} 个`);
  if (process.argv.includes('--dry')) {
    for (const s of candidates.slice(0, 15)) {
      console.log(` - [${s.tool}] ${(s.title || '').slice(0, 50).replace(/\n/g, ' ')}`);
    }
  } else {
    runBackfill().then(st => console.log('完成:', JSON.stringify(st)));
  }
}
