/**
 * [INPUT]: 依赖 node:fs/os/path；读取 ~/.claude/projects/ 会话 JSONL 与可选 v0 仪表盘的 aliases/summaries 存量资产
 * [OUTPUT]: 对外提供 scanClaude(cache) → 统一 Session 模型数组
 * [POS]: adapters 的 Claude Code 适配器，与 codex.mjs 平级，输出同构数据供 scanner 聚合
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { headLines, tailText, cleanPrompt, classifyStatus } from './shared.mjs';

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const V0_DIR = process.env.AGENT_CANVAS_V0_DIR
  || path.join(os.homedir(), 'BINGO-Space', 'Claude_Code', '_session-dashboard');

// ============================================================
//  v0 存量资产：aliases（人工命名）+ summaries（历史摘要）
//  一次性读入内存，扫描时按 sessionId 合并
// ============================================================
function loadV0Assets() {
  const aliases = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(V0_DIR, 'aliases.json'), 'utf8')); }
    catch { return {}; }
  })();
  const summaries = {};
  const dir = path.join(V0_DIR, 'summaries');
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try { summaries[f.slice(0, -5)] = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); }
      catch { /* 坏文件跳过 */ }
    }
  }
  return { aliases, summaries };
}

// ============================================================
//  单文件解析：只读首 64KB + 尾 8KB，30MB 大文件也秒级返回
// ============================================================
function parseSession(file, stat) {
  const id = path.basename(file, '.jsonl');
  const s = {
    key: `claude:${id}`, tool: 'claude', id,
    cwd: null, gitBranch: null, title: null, firstPrompt: null,
    createdAt: null, updatedAt: stat.mtime.toISOString(),
    sizeBytes: stat.size, turns: 0, status: 'active', filePath: file,
  };

  let lineCount = 0;
  for (const line of headLines(file, 65536)) {
    lineCount++;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.isSidechain === true) s.kind = 'subagent';   // 子智能体分线，不是人开的会话
    if (!s.cwd && d.cwd) s.cwd = d.cwd;
    if (d.gitBranch) s.gitBranch = d.gitBranch;
    if (!s.createdAt && d.timestamp) s.createdAt = d.timestamp;
    if (!s.firstPrompt && d.type === 'user') {
      const c = d.message?.content;
      const text = typeof c === 'string' ? c
        : Array.isArray(c) ? c.filter(x => x.type === 'text').map(x => x.text).join(' ') : '';
      const cleaned = cleanPrompt(text);
      if (cleaned) s.firstPrompt = cleaned;
    }
    if (d.type === 'user' || d.type === 'assistant') s.turns++;
  }

  // 文件小于 64KB 时 headLines 已读全量，turns 是精确值；否则按体积估算
  if (stat.size > 65536) s.turns = Math.round(stat.size / 1800);

  // ---- 尾部真相：用户改名(customTitle)与最后提示词都 append 在文件尾，头部窗口读不到 ----
  const tail = tailText(file, 8192);
  let lastPrompt = null;
  for (const line of tail.split('\n').slice(1)) {
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.type === 'custom-title' && d.customTitle) { s.title = d.customTitle; s.titleSource = 'user'; }
    if (d.type === 'last-prompt' && d.lastPrompt) lastPrompt = cleanPrompt(d.lastPrompt);
  }
  if (!s.firstPrompt && lastPrompt) s.firstPrompt = lastPrompt;

  const dead = /API Error|E015|Prompt is too long|context.*overflow/i.test(tail);
  s.status = classifyStatus({ dead, mtime: stat.mtime, tiny: stat.size <= 65536 && lineCount < 10 });
  return s;
}

// ============================================================
//  主扫描：遍历全部项目目录，mtime 命中缓存则跳过解析
// ============================================================
export function scanClaude(cache) {
  if (!fs.existsSync(PROJECTS_DIR)) return [];
  const { aliases, summaries } = loadV0Assets();
  const sessions = [];

  for (const proj of fs.readdirSync(PROJECTS_DIR)) {
    const projDir = path.join(PROJECTS_DIR, proj);
    let files;
    try { files = fs.readdirSync(projDir); } catch { continue; }

    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const file = path.join(projDir, f);
      // TOCTOU 防御：readdir 与 stat 之间文件可能被删（归档/删除/清理），单文件失败不许拖垮全扫
      let session;
      try {
        const stat = fs.statSync(file);
        const hit = cache[file];
        if (hit && hit.mtime === stat.mtimeMs && hit.size === stat.size) {
          session = hit.session;
        } else {
          session = parseSession(file, stat);
          cache[file] = { mtime: stat.mtimeMs, size: stat.size, session };
          cache.__dirty = true;
        }
      } catch { continue; }

      // ---- 标题优先级：用户命名(alias/customTitle) > 文件内推断 > v0 摘要标题 ----
      const merged = { ...session };
      const v0sum = summaries[session.id];
      if (aliases[session.id]) {
        merged.title = aliases[session.id];
        merged.titleSource = 'user';
      } else {
        merged.title = session.title || v0sum?.title || null;
      }
      if (v0sum) merged.summary = v0sum;
      sessions.push(merged);
    }
  }
  return sessions;
}
