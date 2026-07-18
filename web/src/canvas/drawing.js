/**
 * [INPUT]: 无外部依赖的纯函数内核
 * [OUTPUT]: 对外提供墨迹纯几何——命中检测双模（描边带/选择热区/旋转逆变换/后画者优先）、
 *           精确包围盒、平移/删除/沉浮不可变变换、大实心底板判定与功能件排除清单
 * [POS]: canvas 的墨迹几何真相源；InkLayer/InkTools/FlowCanvas/MiniMapInk 共用，node:test 直接证伪
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

export const isBelow = el => !!el?.customData?.below;
export const committedDrawingElements = (elements = []) => elements.filter(el => el && !el.isDeleted);

export const DRAWING_HIT_BLOCK = '.container-drag-handle, .react-flow__resize-control, .react-flow__handle, .nodrag, .Island, button, input, textarea, [contenteditable]';

// 普通看板态不挂 Excalidraw：所有主权动作都是已提交数组上的不可变变换。
// 宿主形状与它的绑定文字同生共死、同层移动，不留幽灵标签。
export function deleteDrawingElement(elements = [], id) {
  return committedDrawingElements(elements).filter(el => el.id !== id && el.containerId !== id);
}

export function setDrawingElementPlane(elements = [], id, below) {
  return committedDrawingElements(elements).map(el => (el.id === id || el.containerId === id)
    ? { ...el, customData: { ...el.customData, below } }
    : el);
}

export function translateDrawingElements(elements = [], ids = [], dx = 0, dy = 0) {
  const move = new Set(ids);
  return committedDrawingElements(elements).map(el => move.has(el.id)
    ? { ...el, x: el.x + dx, y: el.y + dy }
    : el);
}

// ============================================================
//  精确包围盒：静态导出的沉层画布要钉在正确的 flow 坐标上——
//  旋转元素按四角实算，线/手绘按 points 实算，近似即错位
// ============================================================
export function drawingBounds(elements = []) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const eat = (x, y) => {
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  };
  for (const el of elements) {
    if (!el || el.isDeleted) continue;
    const pts = (el.type === 'line' || el.type === 'arrow' || el.type === 'freedraw') && el.points?.length
      ? el.points
      : [[0, 0], [el.width || 0, 0], [0, el.height || 0], [el.width || 0, el.height || 0]];
    const cx = el.x + (el.width || 0) / 2, cy = el.y + (el.height || 0) / 2;
    const cos = Math.cos(el.angle || 0), sin = Math.sin(el.angle || 0);
    for (const [px, py] of pts) {
      const ax = el.x + px, ay = el.y + py;
      if (!el.angle) { eat(ax, ay); continue; }
      const dx = ax - cx, dy = ay - cy;
      eat(cx + dx * cos - dy * sin, cy + dx * sin + dy * cos);
    }
  }
  return minX === Infinity ? null : { minX, minY, maxX, maxY };
}

const AUTO_BELOW_TYPES = new Set(['rectangle', 'ellipse', 'diamond']);
const AUTO_BELOW_MIN_WIDTH = 400;
const AUTO_BELOW_MIN_HEIGHT = 300;
const AUTO_BELOW_MIN_AREA = 120000;

export function isLargeFilledDrawingElement(element) {
  if (!AUTO_BELOW_TYPES.has(element?.type)) return false;
  if (!element.backgroundColor || element.backgroundColor === 'transparent') return false;
  const width = Math.abs(Number(element.width) || 0);
  const height = Math.abs(Number(element.height) || 0);
  return width >= AUTO_BELOW_MIN_WIDTH
    && height >= AUTO_BELOW_MIN_HEIGHT
    && width * height >= AUTO_BELOW_MIN_AREA;
}

// 只在第一次 new 事务提交时识别“大块实心底板”。一旦事务 rebase，用户后续手动浮起就是新真相。
// ============================================================
//  命中检测：flow 坐标点落在哪个绘图元素上（后画者优先）
//  好品味：命中区严格贴着墨迹——空心形状只认描边带、线/箭头/手绘只认线段、
//  旋转元素跟着视觉走；隐形玻璃（包围盒空腹）一块都不许有
// ============================================================
const segDist = (px, py, ax, ay, bx, by) => {
  const vx = bx - ax, vy = by - ay;
  const len2 = vx * vx + vy * vy;
  const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / len2)) : 0;
  return Math.hypot(px - (ax + vx * t), py - (ay + vy * t));
};

function hitOne(el, fx, fy, t, includeHollowInterior) {
  // 进元素坐标系：旋转绕包围盒中心逆转回来（Excalidraw 语义），再平移到元素原点
  let px = fx, py = fy;
  if (el.angle) {
    const cx = el.x + (el.width || 0) / 2, cy = el.y + (el.height || 0) / 2;
    const cos = Math.cos(-el.angle), sin = Math.sin(-el.angle);
    const dx = fx - cx, dy = fy - cy;
    px = cx + dx * cos - dy * sin;
    py = cy + dx * sin + dy * cos;
  }
  px -= el.x; py -= el.y;

  // 线性元素：点到折线段距离——斜线的"空腹"不是玻璃
  if (el.type === 'line' || el.type === 'arrow' || el.type === 'freedraw') {
    const pts = el.points?.length > 1 ? el.points : [[0, 0], [el.width || 0, el.height || 0]];
    for (let i = 1; i < pts.length; i++) {
      if (segDist(px, py, pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]) <= t) return true;
    }
    return false;
  }

  const x0 = Math.min(0, el.width || 0), x1 = Math.max(0, el.width || 0);
  const y0 = Math.min(0, el.height || 0), y1 = Math.max(0, el.height || 0);
  if (px < x0 - t || px > x1 + t || py < y0 - t || py > y1 + t) return false;

  const filled = el.backgroundColor && el.backgroundColor !== 'transparent';

  if (el.type === 'ellipse' || el.type === 'diamond') {
    const rx = Math.max((x1 - x0) / 2, 1), ry = Math.max((y1 - y0) / 2, 1);
    const nx = (px - (x0 + x1) / 2) / rx, ny = (py - (y0 + y1) / 2) / ry;
    const r = el.type === 'ellipse' ? Math.hypot(nx, ny) : Math.abs(nx) + Math.abs(ny);
    const band = t / Math.min(rx, ry);
    return filled || includeHollowInterior ? r <= 1 + band : Math.abs(r - 1) <= band;
  }

  // 空心矩形只认描边带；实心矩形、文字、图片与其余类型=全域
  if (el.type === 'rectangle' && !filled && !includeHollowInterior) {
    return !(px > x0 + t && px < x1 - t && py > y0 + t && py < y1 - t);
  }
  return true;
}

export function hitDrawingElement(elements = [], fx, fy, tolerance = 8, { includeHollowInterior = false } = {}) {
  for (let i = elements.length - 1; i >= 0; i--) {
    const el = elements[i];
    if (!el || el.isDeleted || el.locked) continue;
    if (hitOne(el, fx, fy, tolerance, includeHollowInterior)) return el;
  }
  return null;
}

