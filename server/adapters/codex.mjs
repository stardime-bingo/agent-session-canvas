/**
 * [INPUT]: 依赖 node:fs/os/path；读取 ~/.codex/sessions/ 会话 rollout JSONL 与 session_index.jsonl 官方索引
 * [OUTPUT]: 对外提供 scanCodex(cache) → 统一 Session 模型数组
 * [POS]: adapters 的 Codex 适配器，与 claude.mjs 平级，输出同构数据供 scanner 聚合
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { headLines, tailText, cleanPrompt, classifyStatus } from './shared.mjs';

const CODEX_DIR = path.join(os.homedir(), '.codex');
const SESSIONS_DIR = path.join(CODEX_DIR, 'sessions');
const ARCHIVED_DIR = path.join(CODEX_DIR, 'archived_sessions');
const INDEX_FILE = path.join(CODEX_DIR, 'session_index.jsonl');

const FILE_RE = /^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;

// ============================================================
//  官方索引：append 日志，同 id 多条取最后一条（last-wins）
// ============================================================
function loadIndex() {
  const map = {};
  try {
    for (const line of fs.readFileSync(INDEX_FILE, 'utf8').split('\n')) {
      if (!line) continue;
      try {
        const d = JSON.parse(line);
        if (d.id) map[d.id] = d;
      } catch { /* 坏行跳过 */ }
    }
  } catch { /* 无索引不致命 */ }
  return map;
}

// ============================================================
//  递归收集 rollout 文件：sessions/YYYY/MM/DD/ + archived_sessions/
// ============================================================
function collectFiles(dir, archived, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) collectFiles(p, archived, out);
    else if (FILE_RE.test(e.name)) out.push({ file: p, archived });
  }
}

// ============================================================
//  单文件解析：首行即 session_meta（含 cwd），首 64KB 找第一条用户消息
// ============================================================
function parseSession(file, stat, archived) {
  const id = path.basename(file).match(FILE_RE)[1];
  const s = {
    key: `codex:${id}`, tool: 'codex', id,
    cwd: null, gitBranch: null, title: null, firstPrompt: null,
    createdAt: null, updatedAt: stat.mtime.toISOString(),
    sizeBytes: stat.size, turns: Math.max(1, Math.round(stat.size / 2500)),
    status: 'active', filePath: file,
  };

  for (const line of headLines(file, 65536)) {
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    const p = d.payload || {};
    if (d.type === 'session_meta') {
      s.cwd = p.cwd || null;
      s.createdAt = p.timestamp || d.timestamp || null;
      // thread_source 直接标明血统：user=人开的 subagent=分身 automation=定时自动化
      // 旧版 CLI 无 thread_source，子代理藏在 source.subagent 里
      const spawn = p.source?.subagent?.thread_spawn;
      if (p.thread_source === 'subagent' || p.source?.subagent) {
        s.kind = 'subagent';
        s.parentThreadId = spawn?.parent_thread_id || null;   // 分身记住主人，供派生规模统计
      }
      if (p.thread_source === 'automation') s.kind = 'automation';
    }
    if (!s.firstPrompt && d.type === 'response_item' && p.type === 'message' && p.role === 'user') {
      const cleaned = cleanPrompt((p.content || []).map(c => c.text || '').join(' '));
      if (cleaned) s.firstPrompt = cleaned;
    }
    if (s.cwd && s.firstPrompt) break;
  }

  const tail = tailText(file, 4096);
  const dead = /stream (error|disconnected)|rate limit|context window .*exceeded/i.test(tail);
  s.status = classifyStatus({ dead, mtime: stat.mtime, tiny: stat.size < 8192, archived });
  return s;
}

// ============================================================
//  主扫描：索引给标题，文件给地形，mtime 命中缓存则跳过解析
// ============================================================
export function scanCodex(cache) {
  const index = loadIndex();
  const files = [];
  collectFiles(SESSIONS_DIR, false, files);
  collectFiles(ARCHIVED_DIR, true, files);

  const sessions = [];
  for (const { file, archived } of files) {
    // TOCTOU 防御：codex 归档轮转随时在删文件，单文件失败不许拖垮全扫
    let session;
    try {
      const stat = fs.statSync(file);
      const hit = cache[file];
      if (hit && hit.mtime === stat.mtimeMs && hit.size === stat.size) {
        session = hit.session;
      } else {
        session = parseSession(file, stat, archived);
        cache[file] = { mtime: stat.mtimeMs, size: stat.size, session };
        cache.__dirty = true;
      }
    } catch { continue; }

    const merged = { ...session };
    const native = index[session.id]?.thread_name;
    if (native) {
      // 索引里的名字是 Codex 本体的（含用户在 CLI 里的改名）——主权归 user，AI 不许覆盖
      merged.title = native;
      merged.titleSource = 'user';
    }
    sessions.push(merged);
  }
  return sessions;
}
