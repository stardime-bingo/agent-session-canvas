/**
 * [INPUT]: 无外部依赖的纯函数内核；元素结构沿用既有 canvas.drawing 模式（Excalidraw 兼容子集，零迁移）
 * [OUTPUT]: 对外提供墨迹几何与工具纯函数——freedraw 平滑路径、形状/箭头路径、元素创建与拖画更新、
 *           样式常量、文字度量、工具语义表
 * [POS]: canvas 的自研墨迹模型。画的一笔直接成为场景文档元素，渲染层照着画——没有第二种表征
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

export const INK_COLORS = ['#1e1e1e', '#e2611f', '#155eef', '#12b76a', '#d92d20', '#7c3aed'];
export const INK_FILLS = ['transparent', '#ffd8c2', '#dbeafe', '#d3f8df', '#fde0e0', '#ece4fd', '#fef3c7'];
export const INK_WIDTHS = [1.5, 2.5, 5];
export const INK_FONT = "var(--sans, -apple-system, 'PingFang SC', sans-serif)";
export const INK_TOOLS = Object.freeze(['select', 'freedraw', 'rectangle', 'ellipse', 'diamond', 'arrow', 'line', 'text']);

const uid = () => (globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`).slice(0, 21);

// ---- freedraw：中点二次贝塞尔平滑——一条不抖的线就是全部秘密 ----
export function freedrawPath(points = []) {
  if (points.length < 2) {
    const [p] = points;
    return p ? `M ${p[0]} ${p[1]} l 0.01 0` : '';
  }
  let d = `M ${points[0][0]} ${points[0][1]}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[i + 1];
    d += ` Q ${x1} ${y1} ${(x1 + x2) / 2} ${(y1 + y2) / 2}`;
  }
  const last = points[points.length - 1];
  return `${d} L ${last[0]} ${last[1]}`;
}

// ---- 箭头：主干折线 + 端头两撇（跟随末段方向），单 path 完成 ----
export function arrowPath(points = [], headLength = 12) {
  if (points.length < 2) return '';
  const d = points.map(([x, y], i) => `${i ? 'L' : 'M'} ${x} ${y}`).join(' ');
  const [x2, y2] = points[points.length - 1];
  const [x1, y1] = points[points.length - 2];
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const spread = Math.PI / 7;
  const hx1 = x2 - headLength * Math.cos(angle - spread);
  const hy1 = y2 - headLength * Math.sin(angle - spread);
  const hx2 = x2 - headLength * Math.cos(angle + spread);
  const hy2 = y2 - headLength * Math.sin(angle + spread);
  return `${d} M ${hx1} ${hy1} L ${x2} ${y2} L ${hx2} ${hy2}`;
}

export const diamondPath = (w, h) => `M ${w / 2} 0 L ${w} ${h / 2} L ${w / 2} ${h} L 0 ${h / 2} Z`;

// ---- 文字度量：单行宽度近似（CJK 全宽/拉丁半宽），不追像素级——框只是命中与选择用 ----
export function measureInkText(text = '', fontSize = 20) {
  const lines = String(text).split('\n');
  const lineWidth = line => [...line].reduce((w, ch) => w + (ch.codePointAt(0) > 0x2e80 ? 1 : 0.55), 0);
  const widest = Math.max(0.5, ...lines.map(lineWidth));
  return { width: Math.ceil(widest * fontSize), height: Math.ceil(lines.length * fontSize * 1.3) };
}

// ---- 元素创建：落笔即元素——它从诞生的第一毫秒起就活在场景文档里 ----
const base = (type, x, y, style) => ({
  id: uid(), type, x, y, width: 0, height: 0, angle: 0,
  strokeColor: style.strokeColor, backgroundColor: style.backgroundColor,
  fillStyle: 'solid', strokeWidth: style.strokeWidth, strokeStyle: 'solid',
  roughness: 0, opacity: style.opacity ?? 100, roundness: null,
  seed: 1, version: 1, versionNonce: 1, index: null, isDeleted: false,
  groupIds: [], frameId: null, boundElements: null, updated: Date.now(), link: null, locked: false,
  ...(style.below ? { customData: { below: true } } : {}),
});

export function createInkElement(tool, x, y, style = {}) {
  const s = { strokeColor: '#1e1e1e', backgroundColor: 'transparent', strokeWidth: 2.5, ...style };
  if (tool === 'freedraw') return { ...base('freedraw', x, y, s), points: [[0, 0]], pressures: [], simulatePressure: true, lastCommittedPoint: null };
  if (tool === 'arrow' || tool === 'line') return { ...base(tool, x, y, s), points: [[0, 0], [0, 0]], lastCommittedPoint: null, startBinding: null, endBinding: null, startArrowhead: null, endArrowhead: tool === 'arrow' ? 'arrow' : null };
  if (tool === 'text') {
    const fontSize = s.fontSize || 20;
    const metrics = measureInkText('', fontSize);
    return { ...base('text', x, y, s), ...metrics, text: '', fontSize, fontFamily: 1, textAlign: 'left', verticalAlign: 'top', containerId: null, originalText: '', autoResize: true, lineHeight: 1.3 };
  }
  return base(tool, x, y, s);   // rectangle / ellipse / diamond
}

// ---- 拖画更新：一路 mutate 一路成形。形状允许反向拖（负延伸归一化到 x/y/w/h） ----
export function updateInkElementDrag(element, fx, fy) {
  if (element.type === 'freedraw') {
    const px = fx - element.x, py = fy - element.y;
    const points = element.points;
    const [lx, ly] = points[points.length - 1] || [0, 0];
    if (Math.hypot(px - lx, py - ly) < 0.75) return element;   // 亚像素抖动不进文档
    return { ...element, points: [...points, [px, py]], width: Math.max(element.width, px), height: Math.max(element.height, py) };
  }
  if (element.type === 'arrow' || element.type === 'line') {
    const points = [...element.points];
    points[points.length - 1] = [fx - element.x, fy - element.y];
    return { ...element, points, width: Math.abs(fx - element.x), height: Math.abs(fy - element.y) };
  }
  return normalizeBox(element, fx, fy);
}

function normalizeBox(element, fx, fy) {
  const originX = element._ox ?? element.x;
  const originY = element._oy ?? element.y;
  return {
    ...element, _ox: originX, _oy: originY,
    x: Math.min(originX, fx), y: Math.min(originY, fy),
    width: Math.abs(fx - originX), height: Math.abs(fy - originY),
  };
}

// 收笔定稿：去掉拖画期的私有锚字段；太小的意外形状判废
export function finishInkElement(element) {
  const { _ox, _oy, ...clean } = element;
  const tiny = (element.type === 'rectangle' || element.type === 'ellipse' || element.type === 'diamond')
    ? (element.width < 4 && element.height < 4)
    : element.type === 'freedraw'
      ? element.points.length < 2
      : (element.type === 'line' || element.type === 'arrow')
        ? Math.hypot(...element.points[element.points.length - 1]) < 4
        : false;
  return { element: clean, discard: tiny };
}

export const upsertInkElement = (elements = [], element) => {
  const index = elements.findIndex(el => el.id === element.id);
  if (index < 0) return [...elements, element];
  const next = [...elements];
  next[index] = element;
  return next;
};
