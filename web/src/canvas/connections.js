/**
 * [INPUT]: 依赖 React Flow 连接结束事件/状态与画布根 DOM
 * [OUTPUT]: 对外提供落空连线判定 connectionDrop、屏幕恒定连接点尺寸 syncHandleHitArea
 * [POS]: canvas 的连接交互纯内核——让 FlowCanvas 不再用脆弱 event.target 等值判断，也不被缩放吃掉命中区
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

export function connectionDrop(event, state) {
  if (!state || state.isValid || !state.fromNode || state.toNode) return null;
  const point = event?.changedTouches?.[0] || event;
  const x = point?.clientX, y = point?.clientY;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const target = event?.target;
  if (!target?.closest?.('.canvas-root') || target.closest('.island, .ctx-menu')) return null;
  return { x, y, from: state.fromNode.id };
}

export function syncHandleHitArea(root, zoom) {
  if (!root) return;
  const z = Math.max(0.1, Number.isFinite(zoom) ? zoom : 1);
  const screenHit = Math.min(28, Math.max(12, 56 * z));
  root.style.setProperty('--handle-hit', `${screenHit / z}px`);
  root.style.setProperty('--handle-hit-hover', `${28 / z}px`);
  root.style.setProperty('--handle-dot-hover', `${14 / z}px`);
  root.style.setProperty('--handle-border-hover', `${2 / z}px`);
}
