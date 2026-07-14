/**
 * [INPUT]: Excalidraw 的元素数组与 BinaryFiles 字典
 * [OUTPUT]: 提供绘图资产快照与稳定签名、命中检测 hitDrawingElement、双平面分流 splitDrawingPlanes(customData.below)、
 *           精确包围盒 drawingBounds(含旋转/折线)、容器承载判定 anchoredDrawingIds(中心落内即跟随)
 * [POS]: DrawLayer 的纯数据内核；沉层垫在卡片之下、浮层批注在上，全部可由 node:test 证伪
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

// ============================================================
//  双平面分流：customData.below = 沉到卡片下面的区域底板；其余为浮层批注
//  存储仍是一份 canvas.drawing，flag 跟着元素走，无 schema 迁移
// ============================================================
export const isBelow = el => !!el?.customData?.below;
export const splitDrawingPlanes = (elements = []) => ({
  below: elements.filter(isBelow),
  above: elements.filter(el => !isBelow(el)),
});

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

// ============================================================
//  容器承载律（FigJam/Miro 共识）：墨迹中心落在容器矩形内，就跟容器走；
//  绑定标签跟宿主形状，不独立判定。纯函数，可由 node:test 证伪
// ============================================================
export function anchoredDrawingIds(elements = [], rect) {
  const ids = new Set();
  for (const el of elements) {
    if (!el || el.isDeleted || el.containerId) continue;
    const b = drawingBounds([el]);
    if (!b) continue;
    const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
    if (cx >= rect.x && cx <= rect.x + rect.w && cy >= rect.y && cy <= rect.y + rect.h) ids.add(el.id);
  }
  for (const el of elements) if (el?.containerId && ids.has(el.containerId)) ids.add(el.id);
  return [...ids];
}

export function drawingSnapshot(elements = [], files = {}) {
  const used = new Set(
    elements
      .filter(element => element?.type === 'image' && typeof element.fileId === 'string')
      .map(element => element.fileId),
  );
  const kept = {};
  for (const id of [...used].sort()) if (files?.[id]) kept[id] = files[id];
  return { elements, files: kept };
}

// Excalidraw 的 fileId 对应不可变图片内容；ID 集变化即可判定资产仓需要更新。
export const drawingFilesSignature = files => Object.keys(files || {}).sort().join('|');

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

function hitOne(el, fx, fy, t) {
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
    return filled ? r <= 1 + band : Math.abs(r - 1) <= band;
  }

  // 空心矩形只认描边带；实心矩形、文字、图片与其余类型=全域
  if (el.type === 'rectangle' && !filled) {
    return !(px > x0 + t && px < x1 - t && py > y0 + t && py < y1 - t);
  }
  return true;
}

export function hitDrawingElement(elements = [], fx, fy, tolerance = 8) {
  for (let i = elements.length - 1; i >= 0; i--) {
    const el = elements[i];
    if (!el || el.isDeleted || el.locked) continue;
    if (hitOne(el, fx, fy, tolerance)) return el;
  }
  return null;
}
