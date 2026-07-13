/**
 * [INPUT]: 依赖 node:child_process 的 spawn、node:fs 写临时脚本、store 的 DATA_DIR
 * [OUTPUT]: 对外提供 launch({tool, cwd, mode, sessionId, prompt}) → 拉起终端新窗口运行对应 CLI
 * [POS]: server 的行动层——画布点击到终端开火的最后一公里，Ghostty 优先、Terminal.app 兜底
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DATA_DIR, readJson } from './store.mjs';

const LAUNCH_DIR = path.join(DATA_DIR, 'launch');
fs.mkdirSync(LAUNCH_DIR, { recursive: true });

// ============================================================
//  命令构造：mode × tool 一张表，不写分支树
//  prompt 走临时文件注入，彻底绕开 shell 引号地狱
// ============================================================
const COMMANDS = {
  'claude:new':    () => `claude`,
  'claude:resume': ({ sessionId }) => `claude --resume ${q(sessionId)}`,
  'claude:prompt': ({ promptFile }) => `claude "$(cat ${q(promptFile)})"`,
  'codex:new':     () => `codex`,
  'codex:resume':  ({ sessionId }) => `codex resume ${q(sessionId)}`,
  'codex:prompt':  ({ promptFile }) => `codex "$(cat ${q(promptFile)})"`,
};

const q = s => `'${String(s).replace(/'/g, `'\\''`)}'`;
const SESSION_ID_RE = /^[0-9a-f-]{8,64}$/i;   // 会话 id 白名单：进 shell 脚本的东西必须先验明正身

// ============================================================
//  终端后端：写 .command 脚本 → 交给终端执行
//  data/config.json 可设 { "terminal": "terminal" } 切换到 Terminal.app
// ============================================================
function openInTerminal(script) {
  const cfg = readJson(path.join(DATA_DIR, 'config.json'), {});
  if (cfg.terminal === 'terminal') {
    return spawn('osascript', [
      '-e', `tell application "Terminal" to do script "${script}"`,
      '-e', 'tell application "Terminal" to activate',
    ], { detached: true, stdio: 'ignore' }).unref();
  }
  spawn('open', ['-na', 'Ghostty.app', '--args', '-e', script],
    { detached: true, stdio: 'ignore' }).unref();
}

export function launch({ tool, cwd, mode = 'new', sessionId, prompt }) {
  const build = COMMANDS[`${tool}:${mode}`];
  if (!build) throw new Error(`不支持的组合: ${tool}:${mode}`);
  if (!cwd || !fs.existsSync(cwd)) throw new Error(`工作区不存在: ${cwd}`);
  if (mode === 'resume' && !SESSION_ID_RE.test(sessionId || '')) throw new Error('非法会话 id');

  // 顺手清扫：超过 24h 的旧启动脚本与提示词文件不许堆积（含明文 prompt）
  const dayAgo = Date.now() - 24 * 3600 * 1000;
  for (const f of fs.readdirSync(LAUNCH_DIR)) {
    const p = path.join(LAUNCH_DIR, f);
    try { if (fs.statSync(p).mtimeMs < dayAgo) fs.rmSync(p); } catch { /* 竞态忽略 */ }
  }

  const ts = Date.now();
  let promptFile = null;
  if (mode === 'prompt') {
    promptFile = path.join(LAUNCH_DIR, `prompt-${ts}.txt`);
    fs.writeFileSync(promptFile, prompt || '');
  }

  const cmd = build({ sessionId, promptFile });
  const script = path.join(LAUNCH_DIR, `launch-${ts}.command`);
  fs.writeFileSync(script, `#!/bin/zsh\ncd ${q(cwd)}\n${cmd}\n`, { mode: 0o755 });

  openInTerminal(script);

  // 用完即焚：脚本开窗即耗尽使命，90 秒后连同明文 prompt 一起自删
  const burn = setTimeout(() => {
    fs.rmSync(script, { force: true });
    if (promptFile) fs.rmSync(promptFile, { force: true });
  }, 90000);
  burn.unref?.();

  return { ok: true, command: cmd, cwd };
}
