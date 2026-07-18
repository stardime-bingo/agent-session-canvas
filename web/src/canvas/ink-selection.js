/**
 * [INPUT]: drawing 元素数组、选择 id、框选/缩放/旋转的 flow 坐标
 * [OUTPUT]: 墨迹选择纯内核——闭包选择、框选、批量删除/变换、八向缩放、旋转与复制重映射
 * [POS]: InkTools/InkLayer 共用的选择语义真相源；不碰 DOM、不碰 store，node:test 可直接证伪
 * [PROTOCOL]: 变更时更新此头部，然后检查 web/CLAUDE.md
 */
import { committedDrawingElements, drawingBounds } from './drawing.js';

const normalizeBounds = bounds => bounds && ({
  minX: Math.min(bounds.minX, bounds.maxX),
  minY: Math.min(bounds.minY, bounds.maxY),
  maxX: Math.max(bounds.minX, bounds.maxX),
  maxY: Math.max(bounds.minY, bounds.maxY),
});

export function selectionClosureIds(elements = [], ids = []) {
  const selected = new Set(ids);
  let grew = true;
  while (grew) {
    grew = false;
    for (const el of committedDrawingElements(elements)) {
      if (selected.has(el.id)) continue;
      if (el.containerId && selected.has(el.containerId)) {
        selected.add(el.id);
        grew = true;
      }
    }
  }
  return [...selected];
}

export function selectionBounds(elements = [], ids = []) {
  const selected = new Set(selectionClosureIds(elements, ids));
  return drawingBounds(committedDrawingElements(elements).filter(el => selected.has(el.id)));
}

export function drawingElementsInBox(elements = [], bounds) {
  const box = normalizeBounds(bounds);
  if (!box) return [];
  return committedDrawingElements(elements)
    .filter(el => !el.locked)
    .filter(el => {
      const b = drawingBounds([el]);
      return b && b.maxX >= box.minX && b.minX <= box.maxX && b.maxY >= box.minY && b.minY <= box.maxY;
    })
    .map(el => el.id);
}

export function deleteDrawingElements(elements = [], ids = []) {
  const remove = new Set(selectionClosureIds(elements, ids));
  return committedDrawingElements(elements).filter(el => !remove.has(el.id));
}

export function setDrawingElementsPlane(elements = [], ids = [], below) {
  const selected = new Set(selectionClosureIds(elements, ids));
  return committedDrawingElements(elements).map(el => selected.has(el.id)
    ? { ...el, customData: { ...el.customData, below } }
    : el);
}

export function translateSelectedElements(elements = [], ids = [], dx = 0, dy = 0) {
  if (!dx && !dy) return elements;
  const selected = new Set(selectionClosureIds(elements, ids));
  return committedDrawingElements(elements).map(el => selected.has(el.id)
    ? { ...el, x: el.x + dx, y: el.y + dy }
    : el);
}

const mapPoint = (x, y, from, to) => {
  const fw = Math.max(from.maxX - from.minX, 0.001);
  const fh = Math.max(from.maxY - from.minY, 0.001);
  return [
    to.minX + ((x - from.minX) / fw) * (to.maxX - to.minX),
    to.minY + ((y - from.minY) / fh) * (to.maxY - to.minY),
  ];
};

export function resizeSelectedElements(elements = [], ids = [], fromBounds, toBounds) {
  const from = normalizeBounds(fromBounds);
  const to = normalizeBounds(toBounds);
  if (!from || !to) return elements;
  const selected = new Set(selectionClosureIds(elements, ids));
  const sx = (to.maxX - to.minX) / Math.max(from.maxX - from.minX, 0.001);
  const sy = (to.maxY - to.minY) / Math.max(from.maxY - from.minY, 0.001);
  return committedDrawingElements(elements).map(el => {
    if (!selected.has(el.id)) return el;
    const [x, y] = mapPoint(el.x, el.y, from, to);
    const next = {
      ...el,
      x, y,
      width: Math.max(0.5, Math.abs((el.width || 0) * sx)),
      height: Math.max(0.5, Math.abs((el.height || 0) * sy)),
    };
    if (el.points?.length) next.points = el.points.map(([px, py]) => [px * sx, py * sy]);
    if (el.type === 'text') next.fontSize = Math.max(8, (el.fontSize || 20) * Math.sqrt(Math.abs(sx * sy)));
    return next;
  });
}

export const RESIZE_HANDLES = Object.freeze(['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']);

export function selectionHandlePoints(bounds, rotateOffset = 28) {
  const b = normalizeBounds(bounds);
  if (!b) return {};
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  return {
    nw: [b.minX, b.minY], n: [cx, b.minY], ne: [b.maxX, b.minY],
    e: [b.maxX, cy], se: [b.maxX, b.maxY], s: [cx, b.maxY],
    sw: [b.minX, b.maxY], w: [b.minX, cy], rotate: [cx, b.minY - rotateOffset],
  };
}

export function hitSelectionHandle(bounds, x, y, tolerance = 9, rotateOffset = 28) {
  const points = selectionHandlePoints(bounds, rotateOffset);
  return [...RESIZE_HANDLES, 'rotate'].find(handle => {
    const point = points[handle];
    return point && Math.hypot(x - point[0], y - point[1]) <= tolerance;
  }) || null;
}

export function resizeBoundsFromHandle(bounds, handle, x, y, minSize = 8) {
  const b = normalizeBounds(bounds);
  if (!b || !RESIZE_HANDLES.includes(handle)) return b;
  const next = { ...b };
  if (handle.includes('w')) next.minX = Math.min(x, b.maxX - minSize);
  if (handle.includes('e')) next.maxX = Math.max(x, b.minX + minSize);
  if (handle.includes('n')) next.minY = Math.min(y, b.maxY - minSize);
  if (handle.includes('s')) next.maxY = Math.max(y, b.minY + minSize);
  return next;
}

export function rotateSelectedElements(elements = [], ids = [], bounds, delta) {
  if (!delta) return elements;
  const b = normalizeBounds(bounds);
  if (!b) return elements;
  const selected = new Set(selectionClosureIds(elements, ids));
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  const cos = Math.cos(delta), sin = Math.sin(delta);
  return committedDrawingElements(elements).map(el => {
    if (!selected.has(el.id)) return el;
    const own = drawingBounds([el]);
    const ex = own ? (own.minX + own.maxX) / 2 : el.x + (el.width || 0) / 2;
    const ey = own ? (own.minY + own.maxY) / 2 : el.y + (el.height || 0) / 2;
    const dx = ex - cx, dy = ey - cy;
    const nx = cx + dx * cos - dy * sin;
    const ny = cy + dx * sin + dy * cos;
    return { ...el, x: el.x + nx - ex, y: el.y + ny - ey, angle: (el.angle || 0) + delta };
  });
}

const defaultId = () => (globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`).slice(0, 21);

export function duplicateDrawingElements(elements = [], ids = [], { dx = 24, dy = 24, idFactory = defaultId } = {}) {
  const alive = committedDrawingElements(elements);
  const selected = new Set(selectionClosureIds(alive, ids));
  const source = alive.filter(el => selected.has(el.id));
  const idMap = new Map(source.map(el => [el.id, idFactory(el.id)]));
  const clones = source.map(el => ({
    ...structuredClone(el),
    id: idMap.get(el.id),
    x: el.x + dx,
    y: el.y + dy,
    ...(el.containerId ? { containerId: idMap.get(el.containerId) || el.containerId } : {}),
    ...(Array.isArray(el.boundElements) ? {
      boundElements: el.boundElements.map(item => ({ ...item, id: idMap.get(item.id) || item.id })),
    } : {}),
    updated: Date.now(),
  }));
  return { elements: [...alive, ...clones], ids: clones.map(el => el.id), clones };
}
