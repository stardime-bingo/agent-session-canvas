/**
 * [INPUT]: 无外部依赖，只读 WheelEvent 形状的普通对象
 * [OUTPUT]: 鼠标/触控板逐事件判定、光标锚定缩放、编辑态统一 wheel 相机数学与三态偏好
 * [POS]: canvas 的导航手势纯内核——所有缩放/平移只产出 RF viewport，可由 node:test 直接证伪
 * [PROTOCOL]: 变更时更新此头部，然后检查 web/CLAUDE.md
 */

const STREAK_MS = 150;

export function wheelDevice(event, streak = null, now = Date.now()) {
  if (streak && now - streak.t < STREAK_MS) return streak.device;
  if (event.deltaMode !== 0) return 'mouse';
  if (event.deltaX !== 0) return 'trackpad';
  const wheelDelta = Math.abs(event.wheelDeltaY || 0);
  if (wheelDelta >= 120 && wheelDelta % 120 === 0) return 'mouse';
  if (!Number.isInteger(event.deltaY)) return 'trackpad';
  if (Math.abs(event.deltaY) >= 100) return 'mouse';
  return 'trackpad';
}

export function zoomViewport(viewport, event, rect, { min = 0.1, max = 1.8 } = {}) {
  const factor = event.deltaMode === 1 ? 0.05 : 0.002;
  const zoom = Math.min(max, Math.max(min, viewport.zoom * 2 ** (-event.deltaY * factor)));
  if (zoom === viewport.zoom) return viewport;
  const pointerX = event.clientX - rect.left;
  const pointerY = event.clientY - rect.top;
  const ratio = zoom / viewport.zoom;
  return {
    zoom,
    x: pointerX - (pointerX - viewport.x) * ratio,
    y: pointerY - (pointerY - viewport.y) * ratio,
  };
}

const panViewport = (viewport, dx, dy) => ({ ...viewport, x: viewport.x + dx, y: viewport.y + dy });

export function wheelViewport(viewport, event, rect, {
  mode = 'auto', streak = null, now = Date.now(), min = 0.1, max = 1.8,
} = {}) {
  if (event.ctrlKey || event.metaKey) {
    return { kind: 'zoom', device: 'pinch', viewport: zoomViewport(viewport, event, rect, { min, max }) };
  }
  const device = mode === 'auto' ? wheelDevice(event, streak, now) : mode;
  if (event.shiftKey) {
    const delta = event.deltaX || event.deltaY;
    return { kind: 'pan', device, viewport: panViewport(viewport, -delta, 0) };
  }
  if (device === 'mouse') {
    return { kind: 'zoom', device, viewport: zoomViewport(viewport, event, rect, { min, max }) };
  }
  return {
    kind: 'pan', device,
    viewport: panViewport(viewport, -(event.deltaX || 0), -(event.deltaY || 0)),
  };
}

export const WHEEL_MODES = Object.freeze({
  auto: { icon: 'wheelAuto', label: '滚轮自动识别', hint: '触控板双指平移，鼠标滚轮缩放' },
  trackpad: { icon: 'trackpad', label: '触控板模式', hint: '滚轮/双指平移，捏合缩放' },
  mouse: { icon: 'mouse', label: '鼠标模式', hint: '滚轮缩放，Shift+滚轮横移' },
});

export const nextWheelMode = mode =>
  mode === 'auto' ? 'trackpad' : mode === 'trackpad' ? 'mouse' : 'auto';
