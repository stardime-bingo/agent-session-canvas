/**
 * [INPUT]: Excalidraw 的元素数组与 BinaryFiles 字典
 * [OUTPUT]: 提供已提交绘图的过滤/删除/沉浮/平移纯变换、整理的单步墨迹撤销票据、包含 Excalidraw `.Island` 的唯一功能件命中排除表、首次新建大底板共享判定/落笔退场状态机/自动沉层、目标关系闭包/局部编辑事务/全量合并、
 *           可返回本笔 receipt、稳定排空且按成功代际守卫撤销的串行提交队列、屏幕override/外部props/队列三真相同步门、opening request 身份门/已对齐 resuming 相机事务与分期退出策略/可渲染输入盾呈现策略/IME 周期状态机/隐藏 opening 取消/退出回执/closing 收口步、编辑器就绪与几何互斥纯门、资产 delta/快照/普通贴墨迹与显式待选封闭形状全域双模命中/已 paint 帧真相与有界重试、双平面固定 z-order 槽内 hole 分组签名与 ready/in-flight 工作路由/包围盒与承载判定
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

// 签名不序列化元素或大 dataURL：本地几何标量捕获应用内同 version 变换，
// version/nonce 捕获 Excal 编辑；不看 JS 引用身份，避免 API/JSON 同内容回读让全场变脏。
export function drawingPlaneSignature(elements = [], files = {}) {
  const elementEntries = [];
  const imageFileIds = [];
  const seenFiles = new Set();
  for (const element of elements) {
    elementEntries.push({
      id: element?.id,
      index: element?.index,
      version: element?.version,
      versionNonce: element?.versionNonce,
      type: element?.type,
      x: element?.x,
      y: element?.y,
      width: element?.width,
      height: element?.height,
      angle: element?.angle,
      below: isBelow(element),
      fileId: element?.fileId,
    });
    if (element?.type !== 'image' || typeof element.fileId !== 'string' || seenFiles.has(element.fileId)) continue;
    seenFiles.add(element.fileId);
    imageFileIds.push(element.fileId);
  }
  const fileEntries = imageFileIds.map(id => {
    const file = files?.[id];
    return {
      id,
      dataURL: file?.dataURL,
      mimeType: file?.mimeType,
      created: file?.created,
      lastRetrieved: file?.lastRetrieved,
    };
  });
  return { elements: elementEntries, files: fileEntries };
}

const sameSignatureEntries = (left = [], right = [], keys = []) => {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    const a = left[index], b = right[index];
    for (const key of keys) if (a[key] !== b[key]) return false;
  }
  return true;
};

const ELEMENT_SIGNATURE_KEYS = [
  'id', 'index', 'version', 'versionNonce', 'type',
  'x', 'y', 'width', 'height', 'angle', 'below', 'fileId',
];
const FILE_SIGNATURE_KEYS = ['id', 'dataURL', 'mimeType', 'created', 'lastRetrieved'];

export function drawingPlaneSignaturesEqual(left, right) {
  if (left === right) return true;
  if (!left || !right) return false;
  return sameSignatureEntries(left.elements, right.elements, ELEMENT_SIGNATURE_KEYS)
    && sameSignatureEntries(left.files, right.files, FILE_SIGNATURE_KEYS);
}

export function drawingPlaneDirtyPlan(previous = {}, next = {}) {
  const below = !drawingPlaneSignaturesEqual(previous.below, next.below);
  const above = !drawingPlaneSignaturesEqual(previous.above, next.above);
  return { below, above, count: Number(below) + Number(above) };
}

export const DRAWING_PLANE_GROUP_SIZE = 48;

// 先按完整 committed 平面确定槽位，再只在槽内 hole-punch；临时隐藏不能让后续 z-order 槽左移。
export function drawingPlaneGroups(elements = [], files = {}, groupSize = DRAWING_PLANE_GROUP_SIZE, excludedIds = []) {
  const hidden = excludedIds instanceof Set ? excludedIds : new Set(excludedIds || []);
  const groups = [];
  for (let offset = 0; offset < elements.length; offset += groupSize) {
    const groupElements = elements.slice(offset, offset + groupSize).filter(element => !hidden.has(element.id));
    groups.push({
      index: groups.length,
      elements: groupElements,
      signature: drawingPlaneSignature(groupElements, files),
    });
  }
  return groups;
}

export function drawingFontSignature(elements = []) {
  const glyphsByFamily = new Map();
  for (const element of committedDrawingElements(elements)) {
    if (element.type !== 'text') continue;
    const family = String(element.fontFamily ?? '');
    const glyphs = glyphsByFamily.get(family) || new Set();
    for (const glyph of String(element.originalText ?? element.text ?? '')) glyphs.add(glyph);
    glyphsByFamily.set(family, glyphs);
  }
  return [...glyphsByFamily.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([fontFamily, glyphs]) => ({ fontFamily, glyphs: [...glyphs].sort().join('') }));
}

export function drawingFontSignaturesEqual(left = [], right = []) {
  return sameSignatureEntries(left || [], right || [], ['fontFamily', 'glyphs']);
}

export function drawingFontWorkRoute(readySignature, inFlightSignature, nextSignature, hasText) {
  if (drawingFontSignaturesEqual(readySignature, nextSignature)) return 'ready';
  if (!hasText) return 'clear';
  if (drawingFontSignaturesEqual(inFlightSignature, nextSignature)) return 'join';
  return 'export';
}

export function drawingPlaneWorkRoute(readySignature, inFlightSignature, nextSignature, hasElements) {
  if (drawingPlaneSignaturesEqual(readySignature, nextSignature)) return 'ready';
  if (!hasElements) return 'clear';
  if (drawingPlaneSignaturesEqual(inFlightSignature, nextSignature)) return 'join';
  return 'export';
}

export function drawingPlaneGroupPlan(readyGroups = [], inFlightGroups = [], nextGroups = []) {
  return nextGroups.map(group => {
    const ready = readyGroups[group.index] || null;
    const inFlight = inFlightGroups[group.index] || null;
    return {
      ...group,
      ready,
      inFlight,
      route: drawingPlaneWorkRoute(ready?.signature, inFlight?.signature, group.signature, !!group.elements.length),
    };
  });
}

export const drawingPlaneSettledInFlight = (current, settledPromise) => (
  current?.promise === settledPromise ? null : current
);

// persisted props 在 override 期只是 pending input；只有真正成为 active world 时才分配
// 大于当前输入的 revision，避免 closing 撤桥后回落到较旧的预分配世界。
const EMPTY_DRAWING_EXCLUDED_IDS = Object.freeze([]);
export function drawingWorldInputStep({
  persistedWorld = null,
  activeWorld = null,
  override = null,
  elements,
  files,
  excludedIds = EMPTY_DRAWING_EXCLUDED_IDS,
  revision = 0,
} = {}) {
  let nextPersisted = persistedWorld;
  if (!nextPersisted
    || nextPersisted.elements !== elements
    || nextPersisted.files !== files
    || nextPersisted.excludedIds !== excludedIds) {
    nextPersisted = { elements, files, excludedIds, revision: null };
  }
  let nextRevision = Math.max(
    0,
    Number.isFinite(revision) ? revision : 0,
    Number.isFinite(activeWorld?.revision) ? activeWorld.revision : 0,
    Number.isFinite(override?.revision) ? override.revision : 0,
  );
  if (override) return { persistedWorld: nextPersisted, world: override, revision: nextRevision };
  if (activeWorld !== nextPersisted || !Number.isFinite(nextPersisted.revision)) {
    nextPersisted = { ...nextPersisted, revision: ++nextRevision };
  }
  return { persistedWorld: nextPersisted, world: nextPersisted, revision: nextRevision };
}

// 像素、命中与小地图共用的唯一帧真相：只有当前 requested revision 的 DOM-ready
// 事件能换帧；cold 不暴露命中，warm 失败则继续服务上一已显示帧。
const EMPTY_DRAWING_FRAME = Object.freeze({
  requestedRevision: -1,
  renderedWorld: null,
  phase: 'idle',
  attempt: 0,
  error: null,
});

export function drawingFrameTruthStep(state = EMPTY_DRAWING_FRAME, event = {}) {
  if (event.type === 'request') {
    if (!Number.isFinite(event.revision) || event.revision <= state.requestedRevision) return state;
    return {
      ...state,
      requestedRevision: event.revision,
      phase: state.renderedWorld ? 'updating' : 'cold',
      attempt: 0,
      error: null,
    };
  }
  if (event.revision !== state.requestedRevision) return state;
  if (event.type === 'ready') {
    if (!event.world || event.world.revision !== event.revision) return state;
    return {
      requestedRevision: state.requestedRevision,
      renderedWorld: event.world,
      phase: 'ready',
      attempt: event.attempt || 1,
      error: null,
    };
  }
  if (event.type === 'error') {
    return {
      ...state,
      phase: event.willRetry ? 'retrying' : (state.renderedWorld ? 'stale' : 'failed'),
      attempt: event.attempt || state.attempt,
      error: event.error || null,
    };
  }
  return state;
}

export const drawingFrameHitElements = frame => frame?.renderedWorld?.elements || [];

export const DRAWING_FRAME_MAX_ATTEMPTS = 3;
export function drawingFrameRetryDecision(failedAttempt, maxAttempts = DRAWING_FRAME_MAX_ATTEMPTS) {
  const max = Math.max(1, Math.trunc(maxAttempts) || DRAWING_FRAME_MAX_ATTEMPTS);
  const attempt = Math.min(max, Math.max(1, Math.trunc(failedAttempt) || 1));
  if (attempt >= max) return { retry: false, nextAttempt: max, delayMs: 0 };
  return { retry: true, nextAttempt: attempt + 1, delayMs: 40 * (2 ** (attempt - 1)) };
}

// 点击/右键/悬停共用的唯一功能件边界：功能件永远优先于覆盖它的墨迹。
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

// 每次整理是一笔独立事务：只从本次终点逆回本次起点，不携带上一次整理的历史。
export function createDrawingArrangeUndoTicket(snapshot = {}, moves = []) {
  return {
    snapshot,
    undoMoves: moves.map(({ rect, dx = 0, dy = 0 }) => ({
      rect: { x: rect.x + dx, y: rect.y + dy, w: rect.w, h: rect.h },
      dx: dx ? -dx : 0,
      dy: dy ? -dy : 0,
    })),
  };
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

const normalizedDrawingFile = (id, file = {}) => ({
  id,
  mimeType: typeof file.mimeType === 'string' ? file.mimeType : 'application/octet-stream',
  dataURL: file.dataURL,
  created: Number.isFinite(file.created) ? file.created : 0,
  ...(Number.isFinite(file.lastRetrieved) ? { lastRetrieved: file.lastRetrieved } : {}),
});

// BinaryFiles 只按服务端持久化的规范字段比较；对象换引用但内容相同时绝不重传 base64。
export function drawingFilesDelta(previous = {}, next = {}) {
  const delta = {};
  for (const id of Object.keys(next).sort()) {
    const file = normalizedDrawingFile(id, next[id]);
    const before = previous[id] && normalizedDrawingFile(id, previous[id]);
    if (!before || JSON.stringify(before) !== JSON.stringify(file)) delta[id] = file;
  }
  return delta;
}

// ============================================================
//  局部编辑事务：committed 世界持续在场，Excalidraw 只拿目标关系闭包。
//  关系按无向图递归闭合：绑定宿主/文字、箭头端点、画框成员与嵌套分组必须同进同出。
// ============================================================
const elementReferenceIds = element => {
  const ids = [];
  if (typeof element?.containerId === 'string') ids.push(element.containerId);
  if (typeof element?.frameId === 'string') ids.push(element.frameId);
  for (const bound of element?.boundElements || []) if (typeof bound?.id === 'string') ids.push(bound.id);
  for (const id of element?.boundElementIds || []) if (typeof id === 'string') ids.push(id);
  for (const binding of [element?.startBinding, element?.endBinding]) {
    if (typeof binding?.elementId === 'string') ids.push(binding.elementId);
  }
  return ids;
};

export function drawingTransactionClosure(elements = [], targetId) {
  const committed = committedDrawingElements(elements);
  if (!targetId || !committed.some(element => element.id === targetId)) return [];

  const byId = new Map(committed.map(element => [element.id, element]));
  const neighbors = new Map(committed.map(element => [element.id, new Set()]));
  const groups = new Map();
  for (const element of committed) {
    for (const refId of elementReferenceIds(element)) {
      if (!byId.has(refId)) continue;
      neighbors.get(element.id).add(refId);
      neighbors.get(refId).add(element.id);
    }
    for (const groupId of element.groupIds || []) {
      if (typeof groupId !== 'string') continue;
      if (!groups.has(groupId)) groups.set(groupId, []);
      groups.get(groupId).push(element.id);
    }
  }
  for (const members of groups.values()) {
    for (const id of members) for (const peerId of members) if (peerId !== id) neighbors.get(id).add(peerId);
  }

  const included = new Set([targetId]);
  const queue = [targetId];
  while (queue.length) {
    const id = queue.shift();
    for (const neighborId of neighbors.get(id) || []) {
      if (included.has(neighborId)) continue;
      included.add(neighborId);
      queue.push(neighborId);
    }
  }
  return committed.filter(element => included.has(element.id));
}

export function createDrawingTransaction(snapshot = {}, targetId = null) {
  const base = drawingSnapshot(snapshot.elements, snapshot.files);
  if (!targetId) return {
    kind: 'new', targetId: null, originalIds: [], anchorIndex: base.elements.length, elements: [], files: {},
  };
  const elements = drawingTransactionClosure(base.elements, targetId);
  if (!elements.length) return null;
  const originalIds = elements.map(element => element.id);
  const originalSet = new Set(originalIds);
  return {
    kind: 'selection', targetId, originalIds,
    anchorIndex: base.elements.findIndex(element => originalSet.has(element.id)),
    ...drawingSnapshot(elements, base.files),
  };
}

export function drawingTransactionVisibleElements(elements = [], originalIds = []) {
  const hidden = new Set(originalIds);
  return committedDrawingElements(elements).filter(element => !hidden.has(element.id));
}

// full merge 已成功持久化、但静态帧尚未交接时，事务必须接管本轮新生 ID。
// 否则帧导出失败后继续编辑并删除新元素，重试会把已落入 base 的幽灵重新带回来。
export function advanceDrawingTransaction(transaction, draftSnapshot = {}) {
  if (!transaction) return null;
  const draft = drawingSnapshot(draftSnapshot.elements, draftSnapshot.files);
  const originalIds = [];
  const seen = new Set();
  for (const id of [...(transaction.originalIds || []), ...draft.elements.map(element => element.id)]) {
    if (seen.has(id)) continue;
    seen.add(id);
    originalIds.push(id);
  }
  return { ...transaction, originalIds, elements: draft.elements, files: draft.files };
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
export function autoSinkLargeNewDrawingDraft(baseSnapshot = {}, transaction, draftSnapshot = {}) {
  const snapshot = drawingSnapshot(draftSnapshot.elements, draftSnapshot.files);
  if (transaction?.kind !== 'new' || (transaction.originalIds || []).length) return { snapshot, sunkIds: [] };
  const baseIds = new Set(committedDrawingElements(baseSnapshot.elements).map(element => element.id));
  const sunkIds = [];
  for (const element of snapshot.elements) {
    if (baseIds.has(element.id) || element.customData?.below || !isLargeFilledDrawingElement(element)) continue;
    sunkIds.push(element.id);
  }
  if (!sunkIds.length) return { snapshot, sunkIds };
  const hosts = new Set(sunkIds);
  return {
    sunkIds,
    snapshot: {
      elements: snapshot.elements.map(element => (hosts.has(element.id) || hosts.has(element.containerId))
        ? { ...element, customData: { ...element.customData, below: true } }
        : element),
      files: snapshot.files,
    },
  };
}

const AUTO_EXIT_IDLE = Object.freeze({ phase: 'idle' });

const autoExitCandidate = state => {
  const beforeIds = new Set(state.beforeIds || []);
  const elements = committedDrawingElements(state.elements);
  const prepared = autoSinkLargeNewDrawingDraft(
    { elements: elements.filter(element => beforeIds.has(element.id)), files: {} },
    { kind: 'new', originalIds: [] },
    { elements, files: {} },
  );
  const sunk = new Set(prepared.sunkIds);
  return elements.find(element => !beforeIds.has(element.id)
    && sunk.has(element.id) && element.type === state.tool) || null;
};

// DrawLayer 只识别一次“本手势新生的大底板已稳定”；提交、沉层与撤销仍只归 FlowCanvas。
// capture pointerup 早于 Excal 最终 change，因此稳定两帧；第三帧是 50ms 内的硬收口。
export function drawingAutoExitGestureStep(state = AUTO_EXIT_IDLE, event = {}) {
  if (event.type === 'begin') {
    if (!event.enabled || !AUTO_BELOW_TYPES.has(event.tool)) return { state: AUTO_EXIT_IDLE, action: 'none' };
    return {
      state: {
        phase: 'tracking', token: event.token, pointerId: event.pointerId, tool: event.tool,
        beforeIds: [...(event.beforeIds || [])], elements: event.elements || [],
        changeVersion: event.changeVersion || 0, stableFrames: 0, frames: 0,
      },
      action: 'none',
    };
  }
  if (event.type === 'cancel') {
    if (event.token != null && state.token !== event.token) return { state, action: 'none' };
    return { state: AUTO_EXIT_IDLE, action: 'none' };
  }
  if (state.phase === 'idle' || state.phase === 'fired' || state.phase === 'complete') {
    return { state, action: 'none' };
  }
  if (event.token !== state.token) return { state, action: 'none' };
  if (event.type === 'change') {
    const changed = event.changeVersion !== state.changeVersion;
    return {
      state: {
        ...state,
        elements: event.elements || [],
        changeVersion: event.changeVersion,
        stableFrames: state.phase === 'released' && changed ? 0 : state.stableFrames,
      },
      action: 'none',
    };
  }
  if (event.type === 'release') {
    if (state.phase !== 'tracking' || event.pointerId !== state.pointerId) return { state, action: 'none' };
    return { state: { ...state, phase: 'released', stableFrames: 0, frames: 0 }, action: 'schedule' };
  }
  if (event.type !== 'frame' || state.phase !== 'released') return { state, action: 'none' };

  const next = { ...state, stableFrames: state.stableFrames + 1, frames: state.frames + 1 };
  if (next.stableFrames < 2 && next.frames < 3) return { state: next, action: 'wait' };
  const candidate = autoExitCandidate(next);
  if (!candidate) return { state: { ...next, phase: 'complete' }, action: 'complete' };
  return { state: { ...next, phase: 'fired' }, action: 'signal', elementId: candidate.id };
}

export function mergeDrawingTransaction(baseSnapshot = {}, transaction, draftSnapshot = {}) {
  const base = drawingSnapshot(baseSnapshot.elements, baseSnapshot.files);
  if (!transaction) return base;
  const prepared = autoSinkLargeNewDrawingDraft(base, transaction, draftSnapshot).snapshot;
  const originalIds = new Set(transaction.originalIds || []);
  const draftElements = prepared.elements;
  const draftById = new Map(draftElements.map(element => [element.id, element]));
  const survivingOriginals = draftElements.filter(element => originalIds.has(element.id));
  const survivingIds = new Set(survivingOriginals.map(element => element.id));
  const newElements = draftElements.filter(element => !originalIds.has(element.id));
  const newIds = new Set(newElements.map(element => element.id));
  const baselineOrder = (transaction.elements || [])
    .filter(element => survivingIds.has(element.id))
    .map(element => element.id);
  const draftOrder = survivingOriginals.map(element => element.id);
  const explicitlyReordered = baselineOrder.length === draftOrder.length
    && baselineOrder.some((id, index) => id !== draftOrder[index]);

  let ownedIndex = 0;
  let elements = [];
  for (const element of base.elements) {
    if (newIds.has(element.id)) continue; // 重试先移除上一轮已插入的新 ID。
    if (!originalIds.has(element.id)) {
      elements.push(element);
      continue;
    }
    if (!survivingIds.has(element.id)) continue;
    elements.push(explicitlyReordered ? survivingOriginals[ownedIndex++] : draftById.get(element.id));
  }

  if (newElements.length && survivingOriginals.length) {
    const beforeFirst = [];
    const after = new Map();
    let previousOriginalId = null;
    for (const element of draftElements) {
      if (survivingIds.has(element.id)) {
        previousOriginalId = element.id;
      } else if (!originalIds.has(element.id)) {
        if (previousOriginalId) {
          const siblings = after.get(previousOriginalId) || [];
          siblings.push(element);
          after.set(previousOriginalId, siblings);
        } else {
          beforeFirst.push(element);
        }
      }
    }
    const firstOriginalId = survivingOriginals[0].id;
    const withNew = [];
    for (const element of elements) {
      if (element.id === firstOriginalId) withNew.push(...beforeFirst);
      withNew.push(element, ...(after.get(element.id) || []));
    }
    elements = withNew;
  } else if (newElements.length) {
    const anchorIndex = Math.max(0, Math.min(transaction.anchorIndex ?? elements.length, elements.length));
    elements.splice(anchorIndex, 0, ...newElements);
  }
  return drawingSnapshot(elements, { ...base.files, ...prepared.files });
}

// Excalidraw 的 fileId 对应不可变图片内容；ID 集变化即可判定资产仓需要更新。
export const drawingFilesSignature = files => Object.keys(files || {}).sort().join('|');

// opening 的布尔状态可被下一次请求重新置真；只有对象身份才能拒绝上一代迟到的 then/catch。
export const drawingOpeningRequestCurrent = (currentRequest, request) => !!request && currentRequest === request;

const LIVE_CAMERA = Object.freeze({ phase: 'live', token: null });

// camera token 与 opening token 完全独立；resuming 只表示本尾部已成功 align、仅等双 rAF；迟到帧返回同一 state 引用。
export function drawingCameraStep(state = LIVE_CAMERA, event = {}) {
  const current = state.token === event.token && !!event.token;
  if (event.type === 'navigate') {
    if (!event.token) return state;
    if (state.phase === 'live') return { phase: 'freezing', token: event.token };
    if (state.phase === 'resuming' || state.phase === 'suspended') return { phase: 'suspended', token: event.token };
    return state;
  }
  if (event.type === 'preview-ready') {
    return current && state.phase === 'freezing' ? { phase: 'suspended', token: event.token } : state;
  }
  if (event.type === 'preview-error') {
    return current && state.phase === 'freezing' ? LIVE_CAMERA : state;
  }
  if (event.type === 'resume-aligned') {
    return state.phase === 'suspended' && event.token ? { phase: 'resuming', token: event.token } : state;
  }
  if (event.type === 'resume-ready') {
    return current && state.phase === 'resuming' ? LIVE_CAMERA : state;
  }
  if (event.type === 'resume-error') {
    return current && state.phase === 'resuming' ? LIVE_CAMERA : state;
  }
  if (event.type === 'reset') return LIVE_CAMERA;
  return state;
}

// 退出只在尚未对齐的 suspended 补 align；已 ready preview 可填 closing 的洞，freezing 副本必须丢弃。
export function drawingCameraExitPolicy(state = LIVE_CAMERA) {
  const phase = state?.phase || 'live';
  return {
    align: phase === 'suspended',
    keepPreview: phase === 'suspended' || phase === 'resuming',
  };
}

// cameraStateRef 不参与 React render；输入盾只能由同 commit 可见的 live/preview 表征推导。
export function drawingCameraPresentation({ active = false, visible = false, hasPreview = false } = {}) {
  return { showShield: !!active && !visible && !!hasPreview };
}

const IDLE_COMPOSITION = Object.freeze({ cycle: 0, active: false, blocked: false, notified: false });

// IME 周期状态机：首次 freeze blocked 只通知一次，同周期后续导航只阻断，end 令迟到回调失效。
export function drawingCompositionStep(state = IDLE_COMPOSITION, event = {}) {
  if (event.type === 'start') {
    return { state: { cycle: state.cycle + 1, active: true, blocked: false, notified: false }, action: 'none' };
  }
  if (event.type === 'end') {
    return { state: { cycle: state.cycle + 1, active: false, blocked: false, notified: false }, action: 'none' };
  }
  if (event.type === 'navigate') {
    return { state, action: state.active && state.blocked ? 'block' : 'continue' };
  }
  if (event.type === 'blocked') {
    if (!state.active || event.cycle !== state.cycle) return { state, action: 'ignore' };
    const notify = !state.notified;
    return {
      state: { ...state, blocked: true, notified: true },
      action: notify ? 'notify' : 'block',
    };
  }
  return { state, action: 'none' };
}

// 尚未显现、不可交互的 opening draft 没有用户改动主权：退出必须在 flush/submit 前直接取消。
export function drawingExitAction({ opening = false, visible = false, hasOpeningResolver = false } = {}) {
  if (!opening || visible) return { type: 'commit' };
  return {
    type: 'cancel-opening',
    opening: false,
    openingPromise: null,
    openingResolver: null,
    resolveOpeningWith: hasOpeningResolver ? false : null,
  };
}

// 退出失败必须说真话：submit reject 才是未落盘；submit 已成功后只可能是静态画面交接失败。
export function drawingExitFailureNotice({ persisted = false, errorMessage = '未知错误' } = {}) {
  return persisted
    ? {
        stage: 'after-persist',
        message: `绘图已保存，但画面交接失败；编辑现场已保留，可重试退出：${errorMessage}`,
      }
    : {
        stage: 'before-persist',
        message: `绘图未落盘，已保留编辑现场：${errorMessage}`,
      };
}

// closing full SVG 已进入 DOM 后必须顺手收掉可能被 early-exit 覆盖的 opening 门。
export function drawingClosingHandoffStep({ hasOpeningResolver = false } = {}) {
  return {
    opening: false,
    openingPromise: null,
    openingResolver: null,
    resolveOpeningWith: hasOpeningResolver ? false : null,
  };
}

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

  const submitWithReceipt = transform => {
    pending++;
    const run = tail.then(async () => {
      const base = lastSuccessful;
      const transformed = transform(base);
      if (transformed == null) return { snapshot: base, receipt: null };
      const draft = Array.isArray(transformed)
        ? { elements: transformed, files: base.files }
        : transformed;
      const next = drawingSnapshot(draft.elements, draft.files ?? base.files);
      const receipt = await persist(next, base);
      lastSuccessful = next;
      return { snapshot: next, receipt };
    });
    tail = run.catch(() => {}).finally(() => { pending--; });
    return run;
  };
  const submit = transform => submitWithReceipt(transform).then(result => result.snapshot);

  // 真排空必须追赶等待创建后追加的 tail；额外一个 microtask 让同轮 promise reaction 先完成追加。
  const whenIdle = async () => {
    while (true) {
      const observedTail = tail;
      await observedTail;
      await Promise.resolve();
      if (tail === observedTail && pending === 0) return lastSuccessful;
    }
  };

  return {
    submit,
    submitWithReceipt,
    // 撤销在真正轮到队首时按成功快照对象身份判代；后续失败不换代，后续成功必使旧撤销失效。
    guardedRestore(expectedSnapshot, previousSnapshot) {
      let restored = false;
      return submit(base => {
        if (base !== expectedSnapshot) return null;
        restored = true;
        return previousSnapshot;
      }).then(snapshot => ({ snapshot, restored }));
    },
    // 排空门返回最后成功的 elements/files 同一快照；单笔失败已在 tail 内隔离，不阻断读取基线。
    whenIdle,
    // React 函数式 updater 的最终同步门：快照同代但仍有 pending 也不算 idle。
    isIdleAt: snapshot => pending === 0 && lastSuccessful === snapshot,
    // React props 可在落盘回执后同步新快照；队列忙时的外部值可能是中间态，明确拒绝倒灌。
    sync(snapshot = {}) {
      if (snapshot.elements === lastSuccessful.elements && snapshot.files === lastSuccessful.files) return lastSuccessful;
      if (pending) return false;
      lastSuccessful = drawingSnapshot(snapshot.elements, snapshot.files);
      return lastSuccessful;
    },
    snapshot: () => lastSuccessful,
  };
}

// 屏幕仍由 override 托管时，只有 idle 且外部 props 已用同一 elements/files 回声追上，才可同步并撤桥。
// props 尚未追上时必须 hold，否则会把旧磁盘回读倒灌进 committed 队列。
export function drawingWorldSyncStep({ idle = false, worldOverride = null, queueSnapshot = null, elements, files } = {}) {
  if (!idle) return { type: 'hold' };
  if (!worldOverride) return { type: 'sync', clearOverride: null };
  const overrideCaughtUp = worldOverride.elements === elements && worldOverride.files === files;
  const queueCaughtUp = queueSnapshot
    && queueSnapshot.elements === elements && queueSnapshot.files === files;
  if (overrideCaughtUp || queueCaughtUp) {
    return { type: 'sync', clearOverride: worldOverride };
  }
  return { type: 'hold' };
}

// guarded restore 已换代才生成 pre-commit 静态世界；若队列已被后续成功推进，保留更新代 override 原引用。
export function drawingRestoredWorldOverride({ queueIdle = false, editorIdle = false, currentSnapshot, restoredSnapshot, currentOverride = null, revision = 0 } = {}) {
  if (!queueIdle || !editorIdle || !restoredSnapshot || currentSnapshot !== restoredSnapshot) return currentOverride;
  return { elements: restoredSnapshot.elements, files: restoredSnapshot.files, revision };
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
