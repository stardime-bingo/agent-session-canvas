/**
 * [INPUT]: 依赖 adapters/claude、adapters/codex 的统一 Session 输出，依赖 store 的缓存与增强数据、node:os 当前用户名
 * [OUTPUT]: 对外提供 scanAll() → { sessions, workspaces, edges, stats }；可 CLI 直跑输出统计
 * [POS]: server 的扫描编排核心。三层噪音过滤 + 自动化聚合成任务卡 + 三种关联边(worktree/family/handoff)
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanClaude } from './adapters/claude.mjs';
import { scanCodex } from './adapters/codex.mjs';
import { loadCache, saveCache, loadEnrich, DATA_DIR } from './store.mjs';

// ============================================================
//  worktree 识别：路径含 worktree 标记则归属父工作区
// ============================================================
const WORKTREE_RE = /^(.*?)[/\\](?:\.claude-worktrees|\.claude[/\\]worktrees|\.loop[/\\](?:v2[/\\])?worktrees|worktrees)[/\\]([^/\\]+)/;

function splitWorktree(cwd) {
  const m = cwd.match(WORKTREE_RE);
  return m ? { parent: m[1], branch: m[2] } : null;
}

// ============================================================
//  自动化聚合：同一 cwd + 同名的 automation 会话是同一个任务的
//  多次运行实例——折叠成一张任务卡（最新一次代表，记次数与全部文件）
// ============================================================
function collapseAutomation(sessions) {
  const groups = new Map();
  const rest = [];
  for (const s of sessions) {
    if (s.kind !== 'automation') { rest.push(s); continue; }
    const gk = `${s.cwd}|${s.title || s.firstPrompt || '?'}`;
    const g = groups.get(gk);
    if (!g || s.updatedAt > g.updatedAt) {
      groups.set(gk, { ...s, runs: (g?.runs || 0) + 1, runFiles: [...(g?.runFiles || []), s.filePath] });
    } else {
      g.runs++;
      g.runFiles.push(s.filePath);
    }
  }
  return [...rest, ...groups.values()];
}

// ============================================================
//  项目族亲缘：名字归一化后互为包含即同族（stardimeAGENT ↔
//  stardime-UI-test）。族内连星形到最活跃 hub，避免 n² 边爆炸
// ============================================================
const normName = n => n.toLowerCase().replace(/[-_\s\d]+/g, '');

// 泛化名不许当亲缘证据：这些词根是"桥"，会把不相干的项目连成一族
const GENERIC = new Set([
  'workspace', 'newchat', 'code', 'codex', 'claude', 'claudecode', 'claudecode',
  'test', 'demo', 'main', 'temp', 'tmp', 'untitled', os.userInfo().username.toLowerCase(), 'bingospace', 'aicode',
]);
const isJunkName = n => /^(users-|https?-|files-mentioned)/.test(n.toLowerCase());

function familyEdges(wsList) {
  const eligible = wsList.filter(w => {
    const n = normName(w.name);
    return n.length >= 5 && !GENERIC.has(n) && !isJunkName(w.name) && !w.parent;
  });

  const parent = new Map(eligible.map(w => [w.path, w.path]));
  const find = x => parent.get(x) === x ? x : find(parent.get(x));

  for (let i = 0; i < eligible.length; i++) {
    for (let j = i + 1; j < eligible.length; j++) {
      const a = normName(eligible[i].name), b = normName(eligible[j].name);
      if (a.includes(b) || b.includes(a)) parent.set(find(eligible[i].path), find(eligible[j].path));
    }
  }

  const clans = new Map();
  for (const w of eligible) {
    const root = find(w.path);
    if (!clans.has(root)) clans.set(root, []);
    clans.get(root).push(w);
  }

  const edges = [];
  for (let members of clans.values()) {
    if (members.length < 2) continue;
    // 族大到离谱基本是垃圾桥：只留 hub + 最近活跃的 7 个
    members = members.sort((a, b) => b.lastActivity.localeCompare(a.lastActivity)).slice(0, 8);
    const [hub, ...kids] = members;
    for (const w of kids) edges.push({ from: hub.path, to: w.path, type: 'family' });
  }
  return edges;
}

// ============================================================
//  接力血缘：launch 时记录的 lineage（谁的接力开了新会话），
//  匹配同 cwd 且 15 分钟内诞生的会话 → 会话级绿色边
// ============================================================
export function handoffEdges(lineage, sessions) {
  const edges = new Map();   // 以 id 去重：同 source 多次点击不产重复边
  for (const rec of lineage || []) {
    const targetTool = rec.tool || rec.sourceKey.split(':')[0];   // 旧记录没有 tool 时保持同工具接力语义
    const child = sessions
      .filter(s => s.cwd === rec.cwd && s.key !== rec.sourceKey && s.tool === targetTool &&
        s.createdAt > rec.ts && new Date(s.createdAt) - new Date(rec.ts) < 15 * 60000)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (child) {
      const id = `${rec.sourceKey}→${child.key}`;
      edges.set(id, { from: rec.sourceKey, to: child.key, type: 'handoff' });
    }
  }
  return [...edges.values()];
}

// ============================================================
//  主扫描：过滤 → 聚合 → 增强覆盖 → 工作区聚合 → 三种边
// ============================================================
export function scanAll() {
  const cache = loadCache();
  const enrich = loadEnrich();

  const raw = [...scanClaude(cache), ...scanCodex(cache)];

  // 缓存瘦身：已消失的文件条目不许永久滞留（归档轮转/删除后遗）
  for (const k of Object.keys(cache)) {
    if (k.startsWith('/') && !fs.existsSync(k)) { delete cache[k]; cache.__dirty = true; }
  }
  saveCache(cache);

  // ---- 分身虽滤，功不可没：先统计每个会话派过多少子智能体，再过滤 ----
  const spawnCounts = {};
  for (const s of raw) {
    if (s.kind === 'subagent' && s.parentThreadId) {
      spawnCounts[s.parentThreadId] = (spawnCounts[s.parentThreadId] || 0) + 1;
    }
  }

  const hidden = { selfNoise: 0, subagent: 0, empty: 0 };
  let sessions = raw.filter(s => {
    if (s.cwd === DATA_DIR) { hidden.selfNoise++; return false; }
    if (s.kind === 'subagent') { hidden.subagent++; return false; }
    if (!s.title && !s.firstPrompt) { hidden.empty++; return false; }
    return true;
  });
  for (const s of sessions) {
    if (spawnCounts[s.id]) s.subagents = spawnCounts[s.id];
  }

  const beforeCollapse = sessions.length;
  sessions = collapseAutomation(sessions);
  hidden.automationRuns = beforeCollapse - sessions.length;

  for (const s of sessions) {
    // 标题主权：用户亲手起的名（customTitle/alias）神圣不可侵犯，AI 命名只能补空位
    if (enrich.titles[s.key] && s.titleSource !== 'user') s.title = enrich.titles[s.key];
    if (enrich.summaries[s.key]) s.summary = enrich.summaries[s.key];
    if (enrich.handoffs[s.key]) s.hasHandoff = true;
    if (!s.title) s.title = s.firstPrompt;
  }

  const workspaces = {};
  for (const s of sessions) {
    const cwd = s.cwd || '(未知工作区)';
    const wt = s.cwd ? splitWorktree(s.cwd) : null;
    const ws = workspaces[cwd] ??= {
      path: cwd,
      name: enrich.wsTitles[cwd] || path.basename(cwd) || cwd,   // 用户起的工作区别名优先

      parent: wt?.parent || null,
      sessionKeys: [],
      tools: {},
      lastActivity: '1970-01-01',
    };
    ws.sessionKeys.push(s.key);
    ws.tools[s.tool] = (ws.tools[s.tool] || 0) + 1;
    if (s.updatedAt > ws.lastActivity) ws.lastActivity = s.updatedAt;
  }

  const wsList = Object.values(workspaces);
  const edges = [
    ...wsList.filter(w => w.parent && workspaces[w.parent])
      .map(w => ({ from: w.parent, to: w.path, type: 'worktree' })),
    ...familyEdges(wsList),
    ...handoffEdges(enrich.lineage, sessions),
  ];

  const stats = { total: sessions.length, byTool: {}, byStatus: {} };
  for (const s of sessions) {
    stats.byTool[s.tool] = (stats.byTool[s.tool] || 0) + 1;
    stats.byStatus[s.status] = (stats.byStatus[s.status] || 0) + 1;
  }
  stats.workspaces = wsList.length;
  stats.hidden = hidden;

  return { sessions, workspaces, edges, stats, scannedAt: new Date().toISOString() };
}

// ============================================================
//  CLI 入口：node server/scanner.mjs → 打印统计摘要
// ============================================================
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const t0 = Date.now();
  const { stats, edges } = scanAll();
  const byType = {};
  for (const e of edges) byType[e.type] = (byType[e.type] || 0) + 1;
  console.log(JSON.stringify({ ...stats, edges: byType, ms: Date.now() - t0 }, null, 2));
}
