/**
 * [INPUT]: 无外部依赖，只读 WheelEvent 形状的普通对象
 * [OUTPUT]: 对外提供设备判定 wheelDevice、光标锚定缩放 zoomViewport、模式文案 WHEEL_MODES 与 nextWheelMode
 * [POS]: canvas 的滚轮手势纯内核——鼠标滚轮=缩放、触控板=平移的判定与数学，可由 node:test 直接证伪
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

// 手势连续性窗口：一段滚动流内判定不许摇摆——触控板惯性衰减到整数增量时尤其如此
const STREAK_MS = 150;

// ============================================================
//  设备判定：强信号优先，弱信号兜底
//  鼠标强信号：行滚动模式(Firefox 滚轮) / wheelDelta 恒为 120 倍数(Chrome·Safari 棘轮)
//  触控板强信号：二维增量(双指天然斜着动) / 亚像素增量(玻璃板才有的精度)
// ============================================================
export function wheelDevice(e, streak = null, now = Date.now()) {
  if (streak && now - streak.t < STREAK_MS) return streak.device;
  if (e.deltaMode !== 0) return 'mouse';
  if (e.deltaX !== 0) return 'trackpad';
  const wd = Math.abs(e.wheelDeltaY || 0);
  if (wd >= 120 && wd % 120 === 0) return 'mouse';
  if (!Number.isInteger(e.deltaY)) return 'trackpad';
  if (Math.abs(e.deltaY) >= 100) return 'mouse';
  return 'trackpad';   // 小整数增量：触控板轻扫远比鼠标慢滚常见
}

// ============================================================
//  光标锚定缩放：光标下的画布点在缩放前后必须钉在原地
//  系数沿用 d3-zoom 惯例：像素模式 0.002/px，行模式 0.05/行
// ============================================================
export function zoomViewport(vp, e, rect, { min = 0.1, max = 1.8 } = {}) {
  const k = e.deltaMode === 1 ? 0.05 : 0.002;
  const zoom = Math.min(max, Math.max(min, vp.zoom * 2 ** (-e.deltaY * k)));
  if (zoom === vp.zoom) return vp;
  const px = e.clientX - rect.left, py = e.clientY - rect.top;
  const r = zoom / vp.zoom;
  return { zoom, x: px - (px - vp.x) * r, y: py - (py - vp.y) * r };
}

export const WHEEL_MODES = {
  auto: { icon: 'wheelAuto', label: '滚轮自动识别', hint: '触控板双指平移，鼠标滚轮缩放' },
  trackpad: { icon: 'trackpad', label: '触控板模式', hint: '滚轮/双指平移，捏合缩放' },
  mouse: { icon: 'mouse', label: '鼠标模式', hint: '滚轮缩放，Shift+滚轮横移' },
};

export const nextWheelMode = m =>
  m === 'auto' ? 'trackpad' : m === 'trackpad' ? 'mouse' : 'auto';
