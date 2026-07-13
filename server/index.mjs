/**
 * [INPUT]: 依赖 scanner 的图数据、launcher 的终端拉起、ai 的摘要/接力、store 的增强仓与静态目录
 * [OUTPUT]: 对外提供 HTTP 服务（:4517）：/api/graph /api/scan /api/launch /api/summarize /api/handoff /api/rename /api/events(SSE) + 前端静态托管
 * [POS]: server 的总入口与路由层，前端画布与本地地形之间唯一的桥
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanAll } from './scanner.mjs';
import { launch } from './launcher.mjs';
import { summarize, makeHandoff, extractDigest, nameSession } from './ai.mjs';
import { runBackfill, backfillStatus, findCandidates } from './backfill.mjs';
import { WEB_DIST, loadEnrich, updateEnrich, appendJsonlVerified, DATA_DIR, readJson, writeJson } from './store.mjs';

const PORT = 4517;

// ============================================================
//  图数据缓存 + SSE 广播：文件变化 → 防抖重扫 → 推送前端
// ============================================================
let graph = scanAll();
const sseClients = new Set();
let autoHandoffChain = Promise.resolve();   // 自动接力单飞队列

// SSE 心跳：让半开死连接暴露出来被清理，30 秒一跳
setInterval(() => {
  for (const res of sseClients) {
    try { res.write(': ping\n\n'); } catch { sseClients.delete(res); }
  }
}, 30000);

// 兜底：任何漏网异常只记日志，daemon 不许整体倒下
process.on('uncaughtException', e => console.error('未捕获异常:', e));
process.on('unhandledRejection', e => console.error('未处理拒绝:', e));

// ============================================================
//  珍贵数据每日备份：enrich(AI 资产)/canvas(你的笔迹)/layout(布局记忆)
//  → data/backups/YYYY-MM-DD/，滚动保留 7 天。扫描缓存可重建，不备。
// ============================================================
function backupPrecious() {
  try {
    const day = new Date().toISOString().slice(0, 10);
    const dir = path.join(DATA_DIR, 'backups', day);
    if (fs.existsSync(dir)) return;
    fs.mkdirSync(dir, { recursive: true });
    for (const f of ['enrich.json', 'canvas.json', 'layout.json']) {
      try { fs.copyFileSync(path.join(DATA_DIR, f), path.join(dir, f)); } catch { /* 尚未产生 */ }
    }
    const root = path.join(DATA_DIR, 'backups');
    for (const d of fs.readdirSync(root).sort().slice(0, -7)) {
      fs.rmSync(path.join(root, d), { recursive: true, force: true });
    }
    console.log('每日备份完成:', day);
  } catch (e) { console.error('备份失败:', e.message); }
}
backupPrecious();
setInterval(backupPrecious, 12 * 3600 * 1000);

// 图签名：会话增删/状态翻转/改名/接力产出才算"有新活动"——
// 纯 mtime/体积增长（用户自己正在干活）不举旗，狼来了的旗没人看
function graphSig(g) {
  let sig = 0;
  for (const s of g.sessions) {
    const str = s.key + (s.title || '') + s.status + (s.hasHandoff ? '1' : '');
    for (let i = 0; i < str.length; i++) sig = (sig * 31 + str.charCodeAt(i)) | 0;
  }
  return `${g.sessions.length}:${sig}`;
}
let lastSig = graphSig(graph);

function refresh() {
  // 扫描永不许炸掉进程：文件系统瞬息万变，失败保留上一份图
  try {
    graph = scanAll();
  } catch (e) {
    console.error('扫描失败，保留旧图:', e.message);
    return;
  }
  const sig = graphSig(graph);
  if (sig === lastSig) return;   // 图没实质变化：静默更新，不打扰前端
  lastSig = sig;
  const msg = `data: ${JSON.stringify({ type: 'graph-updated', scannedAt: graph.scannedAt })}\n\n`;
  for (const res of sseClients) {
    try { res.write(msg); } catch { sseClients.delete(res); }
  }
}

let timer = null;
const debounceRefresh = () => { clearTimeout(timer); timer = setTimeout(refresh, 3000); };

for (const dir of [
  path.join(os.homedir(), '.claude', 'projects'),
  path.join(os.homedir(), '.codex', 'sessions'),
]) {
  try {
    fs.watch(dir, { recursive: true }, debounceRefresh)
      .on('error', e => console.error('watcher 故障:', dir, e.message));
  } catch (e) { console.error('watch 失败:', dir, e.message); }
}

// ============================================================
//  路由表：method+path → handler，一张表消灭 if/else 链
// ============================================================
const findSession = key => graph.sessions.find(s => s.key === key);

const LAYOUT_FILE = path.join(DATA_DIR, 'layout.json');
const CANVAS_FILE = path.join(DATA_DIR, 'canvas.json');   // 用户手绘层：连线与便签，永不被扫描覆盖

const loadCanvas = () => ({ edges: [], notes: [], boards: [], drawing: [], ...readJson(CANVAS_FILE, {}) });

// 布局条目字段合并：x/y/d/w/h 只更新送来的，w/h 支撑街区手动调尺寸
function pickLayout(src, prev) {
  const out = { ...prev };
  for (const k of ['x', 'y', 'd', 'w', 'h']) if (src[k] !== undefined) out[k] = src[k];
  return out;
}

const routes = {
  // 画布手工布局与手绘层随图下发
  'GET /api/graph': async () => ({
    ...graph,
    layout: readJson(LAYOUT_FILE, {}),
    canvas: loadCanvas(),
  }),

  // ---- 手动连线：紫色人笔，同对去重 ----
  'POST /api/edge-add': async body => {
    const canvas = loadCanvas();
    const dup = canvas.edges.find(e =>
      (e.from === body.from && e.to === body.to) || (e.from === body.to && e.to === body.from));
    if (dup) return dup;
    const edge = { id: `manual:${Date.now()}`, from: body.from, to: body.to };
    canvas.edges.push(edge);
    writeJson(CANVAS_FILE, canvas);
    return edge;
  },

  'POST /api/edge-del': async body => {
    const canvas = loadCanvas();
    canvas.edges = canvas.edges.filter(e => e.id !== body.id);
    writeJson(CANVAS_FILE, canvas);
    return { ok: true };
  },

  // ---- 便签：补丁式合并（只更新送来的字段），拖动/打字/换色并发不互相覆盖 ----
  'POST /api/note-set': async body => {
    const canvas = loadCanvas();
    const patch = {};
    for (const k of ['x', 'y', 'text', 'color', 'w', 'h']) if (body[k] !== undefined) patch[k] = body[k];
    const i = canvas.notes.findIndex(n => n.id === body.id);
    let note;
    if (i >= 0) {
      note = canvas.notes[i] = { ...canvas.notes[i], ...patch };
    } else {
      note = { id: body.id || `note:${Date.now()}`, x: 0, y: 0, text: '', color: 'yellow', ...patch };
      canvas.notes.push(note);
    }
    writeJson(CANVAS_FILE, canvas);
    return note;
  },

  'POST /api/note-del': async body => {
    const canvas = loadCanvas();
    canvas.notes = canvas.notes.filter(n => n.id !== body.id);
    writeJson(CANVAS_FILE, canvas);
    return { ok: true };
  },

  // ---- Excalidraw 绘图层：整层元素快照落盘（前端已防抖） ----
  'POST /api/drawing-set': async body => {
    const canvas = loadCanvas();
    canvas.drawing = Array.isArray(body.elements) ? body.elements : [];
    writeJson(CANVAS_FILE, canvas);
    return { ok: true, count: canvas.drawing.length };
  },

  // ---- 自定义画板：用户自建的一等容器，补丁式合并同便签 ----
  'POST /api/board-set': async body => {
    const canvas = loadCanvas();
    const patch = {};
    for (const k of ['x', 'y', 'w', 'h', 'name', 'color']) if (body[k] !== undefined) patch[k] = body[k];
    const i = canvas.boards.findIndex(b => b.id === body.id);
    let board;
    if (i >= 0) {
      board = canvas.boards[i] = { ...canvas.boards[i], ...patch };
    } else {
      board = { id: body.id || `${Date.now()}`, x: 0, y: 0, w: 520, h: 360, name: '新画板', color: 'blue', ...patch };
      canvas.boards.push(board);
    }
    writeJson(CANVAS_FILE, canvas);
    return board;
  },

  'POST /api/board-del': async body => {
    const canvas = loadCanvas();
    canvas.boards = canvas.boards.filter(b => b.id !== body.id);
    writeJson(CANVAS_FILE, canvas);
    // 成员的 layout.d 悬空后自动回落路径街区，无需清理
    return { ok: true };
  },

  'POST /api/layout': async body => {
    const layout = readJson(LAYOUT_FILE, {});
    layout[body.path] = pickLayout(body, layout[body.path]);
    writeJson(LAYOUT_FILE, layout);
    return { ok: true };
  },

  // 拖动一个 = 快照整个街区：兄弟成员不再瀑布补位乱跑
  'POST /api/layout-batch': async body => {
    const layout = readJson(LAYOUT_FILE, {});
    for (const e of body.entries || []) {
      layout[e.path] = pickLayout(e, layout[e.path]);
    }
    writeJson(LAYOUT_FILE, layout);
    return { ok: true, saved: (body.entries || []).length };
  },

  // 自动整理 = 清空手工布局，回到路径亲缘街区算法
  'POST /api/layout-clear': async () => {
    writeJson(LAYOUT_FILE, {});
    refresh();
    return { ok: true };
  },

  // 删除 = 移入 macOS 废纸篓（看板干净，但可反悔），增强数据一并清除
  // 防线一：10 分钟内还在写的会话可能被工具进程持有句柄，默认拒删（force 可破）
  // 防线二：如实上报成败，绝不谎报 ok
  'POST /api/delete': async body => {
    const s = findSession(body.key);
    if (!s) throw new Error('会话不存在: ' + body.key);
    const files = s.runFiles?.length ? s.runFiles : [s.filePath];

    if (!body.force) {
      const now = Date.now();
      const live = files.some(f => { try { return now - fs.statSync(f).mtimeMs < 10 * 60000; } catch { return false; } });
      if (live) throw new Error('LIVE:该会话 10 分钟内仍有写入，可能正被工具进程使用——等它安静下来，或选择强制删除');
    }

    let trashed = 0;
    const failed = [];
    for (const f of files) {
      const dest = path.join(os.homedir(), '.Trash',
        `${s.tool}-${path.basename(f, '.jsonl')}-${Date.now()}.jsonl`);
      try { fs.renameSync(f, dest); trashed++; }
      catch (e) { if (e.code !== 'ENOENT') failed.push(path.basename(f)); else trashed++; }
    }

    if (trashed > 0) {
      updateEnrich(enrich => {
        delete enrich.titles[s.key];
        delete enrich.summaries[s.key];
        delete enrich.handoffs[s.key];
        enrich.lineage = (enrich.lineage || []).filter(r => r.sourceKey !== s.key);
      });
    }
    refresh();
    if (failed.length) throw new Error(`部分删除失败(${failed.length}/${files.length}): ${failed.slice(0, 3).join(', ')}`);
    return { ok: true, trashed };
  },

  // 批量人话化：异步跑，进度轮询，逐条落盘
  'POST /api/backfill': async () => {
    if (backfillStatus().running) return backfillStatus();
    runBackfill().then(refresh).catch(e => console.error('回填失败:', e.message));
    // 返回启动后的实时状态（含 running:true）——前端轮询契约靠它点火
    await new Promise(r => setTimeout(r, 50));
    return backfillStatus();
  },

  'GET /api/backfill-status': async () => backfillStatus(),

  'POST /api/scan': async () => { refresh(); return graph.stats; },

  'GET /api/session': async (_, query) => {
    const s = findSession(query.key);
    if (!s) throw new Error('会话不存在: ' + query.key);
    const enrich = loadEnrich();
    return { ...s, handoff: enrich.handoffs[s.key]?.text || null, digest: extractDigest(s) };
  },

  'POST /api/launch': async body => {
    // 接力开新会话时记下血缘：扫描器会把 15 分钟内诞生的孩子连上绿边
    if (body.sourceKey && body.mode === 'prompt') {
      updateEnrich(enrich => {
        enrich.lineage = [...(enrich.lineage || []), { sourceKey: body.sourceKey, cwd: body.cwd, ts: new Date().toISOString() }].slice(-300);
      });
    }
    return launch(body);
  },

  'POST /api/summarize': async body => {
    const s = findSession(body.key);
    if (!s) throw new Error('会话不存在');
    const result = await summarize(s);
    refresh();
    return result;
  },

  'POST /api/handoff': async body => {
    const s = findSession(body.key);
    if (!s) throw new Error('会话不存在');
    const text = await makeHandoff(s);
    refresh();
    return { text };
  },

  // 手动改名 = 用户主权动作：除看板覆盖层外，按两家原生格式写回本体，
  // Claude Code / Codex 自己的 resume 列表同步可见（AI 命名不写回，只做覆盖层）
  'POST /api/rename': async body => {
    body.title = String(body.title ?? '').trim().slice(0, 200);
    if (!body.title) throw new Error('标题不能为空');
    updateEnrich(enrich => { enrich.titles[body.key] = body.title; });

    const s = findSession(body.key);
    let synced = false;
    try {
      if (s?.tool === 'claude' && fs.existsSync(s.filePath)) {
        // 活跃门禁：10 分钟内还在写的会话不动本体（工具进程可能非 append 模式持有句柄），
        // 看板层已生效，等它安静后再改一次即可同步
        const quiet = Date.now() - fs.statSync(s.filePath).mtimeMs > 10 * 60000;
        if (quiet) {
          fs.appendFileSync(s.filePath,
            JSON.stringify({ type: 'custom-title', customTitle: body.title, sessionId: s.id }) + '\n');
          synced = true;
        }
      } else if (s?.tool === 'codex') {
        // Codex 原生索引：session_index.jsonl 追加日志，last-wins
        appendJsonlVerified(path.join(os.homedir(), '.codex', 'session_index.jsonl'),
          { id: s.id, thread_name: body.title, updated_at: new Date().toISOString() });
        synced = true;
      }
    } catch (e) {
      console.error('改名写回本体失败(看板层已生效):', e.message);
    }
    refresh();
    return { ok: true, synced };
  },

  // 工作区别名：仅看板显示层，不碰真实目录
  'POST /api/ws-rename': async body => {
    updateEnrich(enrich => { enrich.wsTitles[body.path] = body.name; });
    refresh();
    return { ok: true };
  },

  // 单会话 AI 起名：精工档，只补看板层
  'POST /api/name': async body => {
    const s = findSession(body.key);
    if (!s) throw new Error('会话不存在');
    const result = await nameSession(s, 'xhigh');
    refresh();
    return result;
  },

  // ---- SessionEnd hook 专线：体量门槛过滤琐碎会话，异步生成不阻塞钩子 ----
  'POST /api/handoff-auto': async body => {
    const s = findSession(`claude:${body.session_id}`);
    if (!s || s.sizeBytes < 200 * 1024) return { skipped: true };
    if (loadEnrich().handoffs[s.key]) return { skipped: 'exists' };
    // 单飞队列：批量关会话时逐个生成，不许并发烧额度
    autoHandoffChain = autoHandoffChain
      .then(() => makeHandoff(s)).then(refresh)
      .catch(e => console.error('自动接力失败:', e.message));
    return { queued: true };
  },

  'POST /api/reveal': async body => {
    // 只开真实存在的本地路径，URL/scheme 一律拒绝
    if (!body.path?.startsWith('/') || !fs.existsSync(body.path)) throw new Error('路径不存在');
    const { spawn } = await import('node:child_process');
    spawn('open', [body.path], { detached: true, stdio: 'ignore' }).unref();
    return { ok: true };
  },
};

// ============================================================
//  HTTP 骨架：SSE、API、静态文件三类请求各走各的道
// ============================================================
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.json': 'application/json',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.png': 'image/png',
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // CSRF/DNS-rebinding 防御：本工具能拉终端执行命令——
  // Host 必须是本机名（防 rebinding 读数据），跨源 POST 一律拒绝
  const host = req.headers.host || '';
  if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  const origin = req.headers.origin;
  if (req.method === 'POST' && origin && !/^https?:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin)) {
    res.writeHead(403);
    return res.end('forbidden');
  }

  // ---- SSE 长连接 ----
  if (url.pathname === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('data: {"type":"connected"}\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  // ---- API ----
  const handler = routes[`${req.method} ${url.pathname}`];
  if (handler) {
    try {
      let body = {};
      if (req.method === 'POST') {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      }
      const result = await handler(body, Object.fromEntries(url.searchParams));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ---- 静态文件：带扩展名的 miss 返回真 404（不许用 index.html 冒充字体/资源），
  //      SPA 回退只留给无扩展名的路由路径 ----
  let file = path.join(WEB_DIST, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!file.startsWith(WEB_DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    if (path.extname(url.pathname)) {
      res.writeHead(404);
      return res.end('not found');
    }
    file = path.join(WEB_DIST, 'index.html');
  }
  try {
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  } catch {
    res.writeHead(404);
    res.end('前端未构建：请先运行 npm run build');
  }
}).listen(PORT, '127.0.0.1', () => console.log(`AGENT 会话看板 → http://localhost:${PORT}  (${graph.stats.total} 会话 / ${graph.stats.workspaces} 工作区)`));   // 只听本机：这工具能开终端，不许上局域网
