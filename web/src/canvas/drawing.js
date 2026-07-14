/**
 * [INPUT]: Excalidraw 的元素数组与 BinaryFiles 字典
 * [OUTPUT]: 提供已提交绘图的过滤/删除/沉浮/平移纯变换、可排空的串行提交队列、编辑器就绪与几何互斥纯门、
 *           资产快照与稳定签名、命中检测、双平面分流、精确包围盒与容器承载判定
 * [POS]: 绘图的纯数据内核；静态世界层、临时编辑器与普通态动作共用，全部可由 node:test 证伪
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

// ============================================================
//  双平面分流：customData.below = 沉到卡片下面的区域底板；其余为浮层批注
//  存储仍是一份 canvas.drawing，flag 跟着元素走，无 schema 迁移
// ============================================================
export const isBelow = el => !!el?.customData?.below;
export const committedDrawingElements = (elements = []) => elements.filter(el => el && !el.isDeleted);
export const splitDrawingPlanes = (elements = []) => ({
  below: committedDrawingElements(elements).filter(isBelow),
  above: committedDrawingElements(elements).filter(el => !isBelow(el)),
});

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
  const committed = committedDrawingElements(elements);
  const used = new Set(
    committed
      .filter(element => element?.type === 'image' && typeof element.fileId === 'string')
      .map(element => element.fileId),
  );
  const kept = {};
  for (const id of [...used].sort()) if (files?.[id]) kept[id] = files[id];
  return { elements: committed, files: kept };
}

// Excalidraw 的 fileId 对应不可变图片内容；ID 集变化即可判定资产仓需要更新。
export const drawingFilesSignature = files => Object.keys(files || {}).sort().join('|');

// 几何副作用只有在开编辑、绘图编辑、布局事务三把锁都空闲时才允许发生。
export const canvasGeometryAllowed = ({ opening = false, drawing = false, pending = false } = {}) =>
  !opening && !drawing && !pending;

// 全局几何动作不隐藏：已进入绘图时先提交并退出；opening/pending 窗口则明确让位。
export const canvasGeometryPreparation = ({ opening = false, drawing = false, pending = false } = {}) =>
  opening || pending ? 'blocked' : drawing ? 'exit-drawing' : 'ready';

// Excalidraw API 与 initialData 首次 onChange 的先后顺序不稳定。
// 首次凑齐只宣告 ready；只有进入本步前已经 ready 的后续 change 才是用户工具变化。
export function drawingEditorReadyStep(state = {}, eventType) {
  const wasReady = !!state.ready;
  const apiReady = !!state.apiReady || eventType === 'api';
  const hydrated = !!state.hydrated || eventType === 'change';
  const notifyReady = !wasReady && apiReady && hydrated;
  return {
    apiReady,
    hydrated,
    ready: wasReady || notifyReady,
    notifyReady,
    notifyTool: eventType === 'change' && wasReady,
  };
}

// ============================================================
//  committed 串行提交：每个 transform 只在真正轮到队首时，
//  基于上一个成功快照执行。失败不推进基线，也不毒死后续任务。
// ============================================================
export function createDrawingCommitQueue(initialSnapshot = {}, persist) {
  let lastSuccessful = drawingSnapshot(initialSnapshot.elements, initialSnapshot.files);
  let tail = Promise.resolve();
  let pending = 0;

  const submit = transform => {
    pending++;
    const run = tail.then(async () => {
      const base = lastSuccessful;
      const transformed = transform(base);
      if (transformed == null) return base;
      const draft = Array.isArray(transformed)
        ? { elements: transformed, files: base.files }
        : transformed;
      const next = drawingSnapshot(draft.elements, draft.files ?? base.files);
      await persist(next);
      lastSuccessful = next;
      return next;
    });
    tail = run.catch(() => {}).finally(() => { pending--; });
    return run;
  };

  return {
    submit,
    // 排空门返回最后成功的 elements/files 同一快照；单笔失败已在 tail 内隔离，不阻断读取基线。
    whenIdle: () => tail.then(() => lastSuccessful),
    // React props 可在落盘回执后同步新快照；队列忙时的外部值可能是中间态，明确拒绝倒灌。
    sync(snapshot = {}) {
      if (pending) return false;
      lastSuccessful = drawingSnapshot(snapshot.elements, snapshot.files);
      return lastSuccessful;
    },
    snapshot: () => lastSuccessful,
  };
}

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
