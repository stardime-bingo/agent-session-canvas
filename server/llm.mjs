/**
 * [INPUT]: 依赖 node:child_process 调用 codex/claude/deepseek 三家 CLI，依赖 store 的 DATA_DIR 与 config.json
 * [OUTPUT]: 对外提供 runLLM(prompt, {effort}) → 按序尝试后端直到成功，返回 {text, backend}
 * [POS]: server 的模型路由层——ai.mjs 只管说什么，这里管找谁说；额度用尽自动降级
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { DATA_DIR, readJson } from './store.mjs';

// ============================================================
//  模型阵容（2026-07 最新）：
//  codex → gpt-5.6-sol · claude → sonnet-5 · deepseek → v4-flash
//  推理档位：单次精工 xhigh（Max 微降一档），批量回填 high
// ============================================================
const DEEPSEEK_CLI = path.join(os.homedir(), '.claude/skills/bingo-llm-gen/scripts/chat.py');

function exec(cmd, args, { input, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args,
      { cwd: DATA_DIR, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => err ? reject(new Error(`${cmd}: ${(stderr || err.message).slice(0, 300)}`)) : resolve(stdout));
    if (input != null) {
      child.stdin.on('error', () => {});   // CLI 秒退时的 EPIPE 不许炸穿 daemon
      child.stdin.write(input);
      child.stdin.end();
    }
  });
}

// headless claude 会在 ~/.claude/projects 落真实会话文件（视图已滤，但磁盘会堆积）——用完即扫
const CLAUDE_NOISE_DIR = path.join(os.homedir(), '.claude', 'projects', DATA_DIR.replace(/[^A-Za-z0-9]/g, '-'));
function sweepClaudeNoise() {
  try {
    for (const f of fs.readdirSync(CLAUDE_NOISE_DIR)) {
      if (f.endsWith('.jsonl')) fs.rmSync(path.join(CLAUDE_NOISE_DIR, f), { force: true });
    }
  } catch { /* 目录不存在即无噪可扫 */ }
}

const BACKENDS = {
  // codex exec：--ephemeral 不落盘会话（不污染看板），-o 拿最终消息
  async codex(prompt, effort) {
    const out = path.join(DATA_DIR, `codex-out-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.txt`);
    try {
      await exec('codex', [
        'exec', '-m', 'gpt-5.6-sol', '-c', `model_reasoning_effort="${effort === 'max' ? 'xhigh' : effort}"`,
        '-s', 'read-only', '--skip-git-repo-check', '--ephemeral', '-o', out, '-',
      ], { input: prompt, timeoutMs: 300000 });
      const text = fs.readFileSync(out, 'utf8').trim();
      if (!text) throw new Error('codex 返回空');
      return text;
    } finally {
      fs.rmSync(out, { force: true });
    }
  },

  async claude(prompt, effort) {
    try {
      const text = await exec('claude',
        ['-p', '--model', 'claude-sonnet-5', '--effort', effort],
        { input: prompt, timeoutMs: 300000 });
      if (!text.trim()) throw new Error('claude 返回空');
      return text.trim();
    } finally {
      sweepClaudeNoise();
    }
  },

  // DeepSeek V4 官方直连（廉价梯队），走 bingo-llm-gen 的统一脚本
  async deepseek(prompt, effort) {
    const text = await exec('python3',
      [DEEPSEEK_CLI, '-p', prompt, '-f', 'deepseek', '-m', 'deepseek-v4-flash',
        '--no-stream', '--thinking', '--reasoning-effort', effort],
      { timeoutMs: 300000 });
    if (!text.trim()) throw new Error('deepseek 返回空');
    return text.trim();
  },
};

// ============================================================
//  主入口：按 config 顺序尝试，谁活着用谁——额度耗尽自然落到下一家
//  data/config.json 可覆盖: { "llm": { "order": [...], "effortSingle", "effortBatch" } }
// ============================================================
export function llmConfig() {
  const cfg = readJson(path.join(DATA_DIR, 'config.json'), {});
  return { order: ['codex', 'claude'], effortSingle: 'xhigh', effortBatch: 'high', ...(cfg.llm || {}) };
}

export async function runLLM(prompt, { effort } = {}) {
  const cfg = llmConfig();
  const lvl = effort || cfg.effortSingle;
  const errors = [];
  for (const name of cfg.order) {
    if (!BACKENDS[name]) continue;
    try {
      return { text: await BACKENDS[name](prompt, lvl), backend: name };
    } catch (e) {
      errors.push(`${name} → ${e.message}`);
    }
  }
  throw new Error('全部后端失败:\n' + errors.join('\n'));
}
