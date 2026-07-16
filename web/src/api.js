/**
 * [INPUT]: 依赖浏览器 fetch / EventSource，对接 server/index.mjs 的 API 契约
 * [OUTPUT]: 对外提供 graph/session/contextPage(终端框倒序分页)/AI/布局/direct+batch carry/绘图 CAS+receipt/落空连线原子创建 API 与 subscribeEvents
 * [POS]: web 的数据访问唯一通道，组件不直接碰 fetch
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

async function call(path, opts) {
  const res = await fetch(path, opts);
  let data;
  try { data = await res.json(); }
  catch { throw new Error(`${res.status} ${res.statusText}`); }   // HTML 错误页不许变成 JSON 天书
  if (!res.ok) {
    const error = new Error(data.error || res.statusText);
    error.status = res.status;
    error.code = data.code;
    error.sceneToken = data.sceneToken;
    throw error;
  }
  return data;
}

const post = (path, body) => call(path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export async function commitDrawingWithReceipt(command, commit, queryStatus) {
  try {
    return await commit(command);
  } catch (error) {
    if (error?.status === 409 || (error?.status >= 400 && error?.status < 500)) throw error;
    let status;
    try {
      status = await queryStatus(command.opId);
    } catch {
      const unknown = new Error('无法确认绘图是否已落盘，请先刷新');
      unknown.code = 'AUTHORITY_UNKNOWN';
      unknown.authorityUnknown = true;
      unknown.cause = error;
      throw unknown;
    }
    if (status?.status === 'committed' && status.opId === command.opId) return status;
    const notCommitted = new Error('绘图尚未落盘，请重试');
    notCommitted.code = 'DRAWING_NOT_COMMITTED';
    notCommitted.cause = error;
    throw notCommitted;
  }
}

export const api = {
  graph: () => call('/api/graph'),
  session: key => call(`/api/session?key=${encodeURIComponent(key)}`),
  contextPage: (key, before) => call(`/api/context-page?key=${encodeURIComponent(key)}${before ? `&before=${before}` : ''}`),
  rescan: () => post('/api/scan', {}),
  launch: p => post('/api/launch', p),
  summarize: key => post('/api/summarize', { key }),
  handoff: key => post('/api/handoff', { key }),
  rename: (key, title) => post('/api/rename', { key, title }),
  aiName: key => post('/api/name', { key }),
  wsRename: (path, name) => post('/api/ws-rename', { path, name }),
  reveal: path => post('/api/reveal', { path }),
  layout: (path, x, y, d) => post('/api/layout', { path, x, y, d }),
  layoutBatch: (entries, replace = false) => post('/api/layout-batch', { entries, replace }),
  addEdge: (from, to) => post('/api/edge-add', { from, to }),
  delEdge: id => post('/api/edge-del', { id }),
  setNote: note => post('/api/note-set', note),
  delNote: id => post('/api/note-del', { id }),
  setBoard: board => post('/api/board-set', board),
  delBoard: id => post('/api/board-del', { id }),
  setDrawing: command => post('/api/drawing-set', command),
  drawingCommitStatus: opId => call(`/api/drawing-commit-status?opId=${encodeURIComponent(opId)}`),
  containerCarry: command => post('/api/container-carry', command),
  containerBatchCarry: command => post('/api/container-batch-carry', command),
  containerCarryStatus: opId => call(`/api/container-carry-status?opId=${encodeURIComponent(opId)}`),
  createFromEdge: payload => post('/api/node-from-edge', payload),
  del: (key, force) => post('/api/delete', { key, force }),
  backfill: () => post('/api/backfill', {}),
  backfillStatus: () => call('/api/backfill-status'),
};

export function subscribeEvents(onUpdate, onLive) {
  const es = new EventSource('/api/events');
  es.onopen = () => onLive?.(true);
  es.onerror = () => onLive?.(false);   // 断连时顶栏绿灯不再撒谎（EventSource 会自动重连）
  es.onmessage = e => {
    try {
      const d = JSON.parse(e.data);
      if (d.type === 'graph-updated') onUpdate(d);
    } catch { /* 忽略坏消息 */ }
  };
  return () => es.close();
}
