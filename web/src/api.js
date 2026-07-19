/**
 * [INPUT]: 依赖浏览器 fetch / EventSource，对接 server/index.mjs 的 API 契约
 * [OUTPUT]: 对外提供 graph/session/contextPage(终端框倒序分页)/AI/launch/putScene 场景快照/putDrawingFiles 图片资产 API 与 subscribeEvents
 * [POS]: web 的数据访问唯一通道，组件不直接碰 fetch
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

// 本标签页的写者身份：SSE 回声带着它回来，自己写的自己不重采纳
export const WRITER_ID = globalThis.crypto?.randomUUID?.() || `w-${Date.now()}-${Math.random()}`;

async function call(path, opts) {
  const res = await fetch(path, opts);
  let data;
  try { data = await res.json(); }
  catch { throw new Error(`${res.status} ${res.statusText}`); }   // HTML 错误页不许变成 JSON 天书
  if (!res.ok) {
    const error = new Error(data.error || res.statusText);
    error.status = res.status;
    error.code = data.code;
    throw error;
  }
  return data;
}

const post = (path, body, extra = {}) => call(path, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
  ...extra,
});

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
  // 场景快照唯一写入口；keepalive 供 pagehide 兜底（body 超 keepalive 限额时浏览器自动降级为普通请求失败，由重试兜住）
  putScene: (scene, { keepalive = false } = {}) =>
    post('/api/scene', { writerId: WRITER_ID, ...scene }, keepalive ? { keepalive: true } : {}),
  putDrawingFiles: (files, { keepalive = false } = {}) =>
    post('/api/drawing-files', { files }, keepalive ? { keepalive: true } : {}),
  del: (key, force) => post('/api/delete', { key, force }),
  backfill: () => post('/api/backfill', {}),
  backfillStatus: () => call('/api/backfill-status'),
};

export function subscribeEvents(onEvent, onLive) {
  const es = new EventSource('/api/events');
  es.onopen = () => onLive?.(true);
  es.onerror = () => onLive?.(false);   // 断连时顶栏绿灯不再撒谎（EventSource 会自动重连）
  es.onmessage = e => {
    try {
      const d = JSON.parse(e.data);
      if (d.type === 'graph-updated' || d.type === 'scene-updated') onEvent(d);
    } catch { /* 忽略坏消息 */ }
  };
  return () => es.close();
}
