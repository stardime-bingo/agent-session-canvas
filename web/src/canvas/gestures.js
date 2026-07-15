/**
 * [INPUT]: 无外部依赖，只读 Wheel/Keyboard/GestureEvent 形状的普通对象与 EventTarget
 * [OUTPUT]: 对外提供 wheel/缩放键/Safari gesture 路由、锚定缩放/平移数学与幂等 pointer listener 资源
 * [POS]: canvas 的导航手势纯内核——所有缩放/平移只产出 RF viewport，可由 node:test 直接证伪
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

export const panViewport = (vp, dx, dy) => ({ ...vp, x: vp.x + dx, y: vp.y + dy });

// 任意比例缩放也必须锚住光标下的世界点；Safari GestureEvent.scale 增量走这里。
export function scaleViewport(vp, scale, e, rect, { min = 0.1, max = 1.8 } = {}) {
  const zoom = Math.min(max, Math.max(min, vp.zoom * scale));
  if (!Number.isFinite(zoom) || zoom === vp.zoom) return vp;
  const px = e.clientX - rect.left, py = e.clientY - rect.top;
  const ratio = zoom / vp.zoom;
  return { zoom, x: px - (px - vp.x) * ratio, y: py - (py - vp.y) * ratio };
}

// 精确复制 Excal camera keyTest；文字区的 Shift 字符只断传播，mod 组合与非文字区则连默认行为一起阻断。
export function drawingZoomKeyRoute({ code = '', editable = false, shiftKey = false, altKey = false, metaKey = false, ctrlKey = false } = {}) {
  const mod = metaKey || ctrlKey;
  const step = code === 'Equal' || code === 'NumpadAdd'
    || code === 'Minus' || code === 'NumpadSubtract';
  const reset = code === 'Digit0' || code === 'Numpad0';
  const fit = (code === 'Digit1' || code === 'Digit2' || code === 'Digit3')
    && shiftKey && !altKey && !mod;
  const camera = ((step || reset) && (mod || shiftKey)) || fit;
  if (!camera) return 'pass';
  if (!editable || mod) return 'block';
  return 'stop';
}

// 编辑态 wheel 在 root capture 分三路：应用外部功能件放行，Excal UI 仅断传播，绘图面进 RF 相机。
export function drawingWheelRoute({ active = false, externalExcluded = false, excalUi = false } = {}) {
  if (!active) return 'pass';
  if (excalUi) return 'block';
  return externalExcluded ? 'pass' : 'camera';
}

// Excal 一旦挂载就必须封住 document 级 Safari gesture；只有 root 内的稳定绘图面才交 RF。
export function drawingGestureRoute({ mounted = false, insideRoot = false, opening = false, exiting = false, externalExcluded = false, excalUi = false } = {}) {
  if (!mounted) return 'pass';
  if (!insideRoot || opening || exiting || externalExcluded || excalUi) return 'block';
  return 'camera';
}

// Safari GestureEvent 路由：编辑态非 pass 一律阻默认并断传播，只有 camera 额外输出累计 scale 增量。
export function drawingGestureCapture(event, { route = 'pass', phase = 'change', lastScale = 1 } = {}) {
  if (route === 'pass') return { camera: false, scaleDelta: 1, nextScale: lastScale };
  event.preventDefault();
  event.stopPropagation();
  if (route === 'block') return { camera: false, scaleDelta: 1, nextScale: lastScale };
  if (phase === 'end') return { camera: true, scaleDelta: 1, nextScale: 1 };
  const current = Number.isFinite(event.scale) && event.scale > 0 ? event.scale : 1;
  if (phase === 'start') return { camera: true, scaleDelta: 1, nextScale: current };
  const previous = Number.isFinite(lastScale) && lastScale > 0 ? lastScale : 1;
  return { camera: true, scaleDelta: current / previous, nextScale: current };
}

// window pointer session 的四类监听共用一个幂等资源，finish/reset/exit/unmount 都可无条件 cleanup。
export function createPointerListenerResource(target, { onMove, onFinish }) {
  const bindings = [
    ['pointermove', onMove, { capture: true, passive: false }],
    ['pointerup', onFinish, true],
    ['pointercancel', onFinish, true],
    ['blur', onFinish, false],
  ];
  let attached = false;
  return {
    attach() {
      if (attached) return false;
      for (const [type, handler, options] of bindings) target.addEventListener(type, handler, options);
      attached = true;
      return true;
    },
    cleanup() {
      if (!attached) return false;
      for (const [type, handler, options] of bindings) target.removeEventListener(type, handler, options);
      attached = false;
      return true;
    },
  };
}

// 编辑态所有 wheel 入口都只产出 RF viewport：捏合/鼠标滚轮缩放，触控板/Shift 滚轮平移。
export function wheelViewport(vp, e, rect, {
  mode = 'auto', streak = null, now = Date.now(), min = 0.1, max = 1.8,
} = {}) {
  if (e.ctrlKey || e.metaKey) {
    return { kind: 'zoom', device: 'pinch', viewport: zoomViewport(vp, e, rect, { min, max }) };
  }
  const device = mode === 'auto' ? wheelDevice(e, streak, now) : mode;
  if (e.shiftKey) {
    const delta = e.deltaX || e.deltaY;
    return { kind: 'pan', device, viewport: panViewport(vp, -delta, 0) };
  }
  if (device === 'mouse') {
    return { kind: 'zoom', device, viewport: zoomViewport(vp, e, rect, { min, max }) };
  }
  return { kind: 'pan', device, viewport: panViewport(vp, -(e.deltaX || 0), -(e.deltaY || 0)) };
}

export const WHEEL_MODES = {
  auto: { icon: 'wheelAuto', label: '滚轮自动识别', hint: '触控板双指平移，鼠标滚轮缩放' },
  trackpad: { icon: 'trackpad', label: '触控板模式', hint: '滚轮/双指平移，捏合缩放' },
  mouse: { icon: 'mouse', label: '鼠标模式', hint: '滚轮缩放，Shift+滚轮横移' },
};

export const nextWheelMode = m =>
  m === 'auto' ? 'trackpad' : m === 'trackpad' ? 'mouse' : 'auto';
