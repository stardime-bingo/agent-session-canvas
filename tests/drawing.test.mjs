import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  anchoredDrawingIds, canvasGeometryAllowed, canvasGeometryPreparation, committedDrawingElements, createDrawingCommitQueue, deleteDrawingElement, drawingBounds,
  drawingEditorReadyStep,
  drawingFilesSignature, drawingSnapshot, hitDrawingElement, setDrawingElementPlane, splitDrawingPlanes,
  translateDrawingElements,
} from '../web/src/canvas/drawing.js';
import { loadDrawingFiles, normalizeDrawingFiles, saveDrawingFiles } from '../server/drawing-files.mjs';

const image = id => ({ id: `element-${id}`, type: 'image', fileId: id });
const binary = id => ({ id, mimeType: 'image/png', dataURL: 'data:image/png;base64,c3ludGhldGlj', created: 1 });

const driveEditorHandshake = events => {
  let state = {};
  const notifications = [];
  for (const [eventType, tool] of events) {
    state = drawingEditorReadyStep(state, eventType);
    if (state.notifyReady) notifications.push('ready');
    if (state.notifyTool) notifications.push(`tool:${tool}`);
  }
  return { state, notifications };
};

test('空画布 api→change：首次默认 selection 只完成 ready，后续 freedraw 才回传工具', () => {
  const { state, notifications } = driveEditorHandshake([
    ['api'], ['change', 'selection'], ['api'], ['change', 'freedraw'],
  ]);
  assert.equal(state.ready, true);
  assert.deepEqual(notifications, ['ready', 'tool:freedraw']);
});

test('非空画布 change→api：首次水合 selection 不回灌，重复事件不重发 ready', () => {
  const { state, notifications } = driveEditorHandshake([
    ['change', 'selection'], ['api'], ['api'], ['change', 'freedraw'],
  ]);
  assert.deepEqual(
    { apiReady: state.apiReady, hydrated: state.hydrated, ready: state.ready },
    { apiReady: true, hydrated: true, ready: true },
  );
  assert.deepEqual(notifications, ['ready', 'tool:freedraw']);
});

test('画布几何门：opening/drawing/pending 任一把锁在场都拒绝副作用', () => {
  assert.equal(canvasGeometryAllowed(), true);
  assert.equal(canvasGeometryAllowed({ opening: true }), false);
  assert.equal(canvasGeometryAllowed({ drawing: true }), false);
  assert.equal(canvasGeometryAllowed({ pending: true }), false);
  assert.equal(canvasGeometryAllowed({ opening: true, drawing: true, pending: true }), false);
});

test('全局几何准备：opening/pending 让位，active drawing 先退出，空闲直接继续', () => {
  assert.equal(canvasGeometryPreparation(), 'ready');
  assert.equal(canvasGeometryPreparation({ drawing: true }), 'exit-drawing');
  assert.equal(canvasGeometryPreparation({ opening: true }), 'blocked');
  assert.equal(canvasGeometryPreparation({ pending: true }), 'blocked');
  assert.equal(canvasGeometryPreparation({ opening: true, drawing: true }), 'blocked');
});

test('deferred opening 期间拖动与整理 callback 均为零次，解门后才可执行', async () => {
  let opening = true;
  let releaseOpening;
  const opened = new Promise(resolve => { releaseOpening = resolve; }).then(() => { opening = false; });
  let geometryEffects = 0;
  const guardedGeometry = () => {
    if (canvasGeometryAllowed({ opening })) geometryEffects++;
  };

  guardedGeometry();   // drag
  guardedGeometry();   // arrange
  assert.equal(geometryEffects, 0);
  releaseOpening();
  await opened;
  guardedGeometry();
  guardedGeometry();
  assert.equal(geometryEffects, 2);
});

test('drawing snapshot keeps referenced images and prunes deleted image files', () => {
  const snapshot = drawingSnapshot([image('used'), { ...image('deleted'), isDeleted: true }, { id: 'line', type: 'line' }], {
    used: binary('used'), deleted: binary('deleted'), stale: binary('stale'),
  });

  assert.deepEqual(Object.keys(snapshot.files), ['used']);
  assert.deepEqual(snapshot.elements.map(e => e.id), ['element-used', 'line']);
  assert.equal(drawingFilesSignature(snapshot.files), 'used');
  assert.equal(drawingFilesSignature({ stale: binary('stale'), used: binary('used') }), 'stale|used');
});

test('drawing image store round-trips valid files and rejects malformed entries', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-canvas-drawing-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const saved = saveDrawingFiles(dir, {
    good_id: binary('good_id'),
    '../escape': binary('../escape'),
    broken: { id: 'broken', dataURL: 'https://example.com/not-local-data' },
  });

  assert.deepEqual(Object.keys(saved), ['good_id']);
  assert.deepEqual(loadDrawingFiles(dir), saved);
  assert.deepEqual(normalizeDrawingFiles([]), {});
});

// ============================================================
//  普通模式的绘图命中：描边带可选中，空心内部穿透，后画者优先
// ============================================================
const rect = (id, x, y, w, h, extra = {}) => ({
  id, type: 'rectangle', x, y, width: w, height: h,
  backgroundColor: 'transparent', isDeleted: false, locked: false, ...extra,
});

test('空心矩形只认描边带：边缘命中，中空区域穿透给底下的卡片', () => {
  const els = [rect('frame', 100, 100, 400, 200)];
  assert.equal(hitDrawingElement(els, 100, 200, 8)?.id, 'frame');   // 左边缘
  assert.equal(hitDrawingElement(els, 300, 104, 8)?.id, 'frame');   // 上边缘带内
  assert.equal(hitDrawingElement(els, 300, 200, 8), null);          // 正中空心
  assert.equal(hitDrawingElement(els, 50, 50, 8), null);            // 界外
});

test('实心/填充元素与文字全域命中；已删除与锁定跳过；后画者优先', () => {
  const solid = rect('solid', 0, 0, 100, 100, { backgroundColor: '#ffd43b' });
  const text = { id: 'txt', type: 'text', x: 20, y: 20, width: 60, height: 24, isDeleted: false, locked: false };
  const dead = rect('dead', 0, 0, 100, 100, { isDeleted: true });
  const locked = rect('lock', 0, 0, 100, 100, { locked: true });
  assert.equal(hitDrawingElement([solid], 50, 50, 8)?.id, 'solid');            // 有填充=实心，全域命中
  assert.equal(hitDrawingElement([solid, text], 40, 30, 8)?.id, 'txt');        // 后画者优先
  assert.equal(hitDrawingElement([dead, locked], 50, 50, 8), null);            // 墓碑与锁定不挡路
});

test('容差随缩放语义：小容差下边缘带收窄，负宽高元素照常命中', () => {
  const els = [rect('frame', 100, 100, 400, 200)];
  assert.equal(hitDrawingElement(els, 300, 112, 2), null);                     // 带宽 2px 时 12px 深处已是空心
  const flipped = [rect('flip', 500, 300, -400, -200)];                        // 反向拖出的形状
  assert.equal(hitDrawingElement(flipped, 100, 200, 8)?.id, 'flip');
});

test('斜线与箭头只认墨迹线段：空腹穿透，线上命中（含 freedraw 折线）', () => {
  const arrow = { id: 'a', type: 'arrow', x: 0, y: 0, width: 300, height: 300, points: [[0, 0], [300, 300]], isDeleted: false, locked: false };
  assert.equal(hitDrawingElement([arrow], 150, 150, 8)?.id, 'a');   // 对角墨迹上
  assert.equal(hitDrawingElement([arrow], 250, 50, 8), null);       // 包围盒内右上空腹——不是玻璃
  const free = { id: 'f', type: 'freedraw', x: 10, y: 10, width: 100, height: 4, points: [[0, 0], [50, 2], [100, 0]], isDeleted: false, locked: false };
  assert.equal(hitDrawingElement([free], 60, 13, 8)?.id, 'f');
});

test('旋转元素命中跟着视觉走：旋转 90° 的扁矩形描边带命中，旧包围盒右端穿透', () => {
  const r = rect('rot', 100, 100, 200, 20, { angle: Math.PI / 2 });
  assert.equal(hitDrawingElement([r], 200, 12, 8)?.id, 'rot');      // 旋转后竖条顶端描边带
  assert.equal(hitDrawingElement([r], 290, 110, 8), null);          // 旋转前的横条右端已无墨迹
});

test('容器承载律：中心落在容器内的墨迹跟随，绑定标签随宿主，界外与墓碑不跟', () => {
  const rect = { x: 100, y: 100, w: 400, h: 300 };
  const els = [
    { id: 'in', type: 'rectangle', x: 150, y: 150, width: 100, height: 60 },            // 中心 (200,180) 在内
    { id: 'label', type: 'text', x: 160, y: 160, width: 60, height: 20, containerId: 'in' },
    { id: 'edge-out', type: 'rectangle', x: 450, y: 350, width: 200, height: 200 },     // 中心 (550,450) 在外
    { id: 'dead', type: 'rectangle', x: 200, y: 200, width: 10, height: 10, isDeleted: true },
    { id: 'arrow-in', type: 'arrow', x: 120, y: 120, width: 0, height: 0, points: [[0, 0], [100, 100]] },  // 中心 (170,170) 在内
  ];
  const ids = anchoredDrawingIds(els, rect).sort();
  assert.deepEqual(ids, ['arrow-in', 'in', 'label']);
  assert.deepEqual(anchoredDrawingIds([], rect), []);
});

test('双平面分流：customData.below 沉层与浮层各归各，顺序保留', () => {
  const els = [
    rect('zone', 0, 0, 500, 300, { customData: { below: true } }),
    rect('note1', 10, 10, 50, 50),
    rect('zone2', 600, 0, 200, 200, { customData: { below: true } }),
    rect('note2', 70, 10, 50, 50),
  ];
  const { below, above } = splitDrawingPlanes(els);
  assert.deepEqual(below.map(e => e.id), ['zone', 'zone2']);
  assert.deepEqual(above.map(e => e.id), ['note1', 'note2']);
  assert.deepEqual(splitDrawingPlanes([]).below, []);
});

test('已提交快照过滤墓碑，删除宿主时连带绑定文字', () => {
  const els = [
    rect('host', 0, 0, 100, 80),
    { id: 'label', type: 'text', x: 10, y: 10, width: 50, height: 20, containerId: 'host' },
    rect('keep', 200, 0, 50, 50),
    rect('dead', 300, 0, 50, 50, { isDeleted: true }),
  ];
  assert.deepEqual(committedDrawingElements(els).map(e => e.id), ['host', 'label', 'keep']);
  assert.deepEqual(deleteDrawingElement(els, 'host').map(e => e.id), ['keep']);
  assert.deepEqual(splitDrawingPlanes(els).above.map(e => e.id), ['host', 'label', 'keep']);
});

test('沉浮变换带着绑定文字，批量平移每个元素只移一次', () => {
  const els = [
    rect('host', 10, 20, 100, 80),
    { id: 'label', type: 'text', x: 20, y: 30, width: 50, height: 20, containerId: 'host' },
    rect('stay', 300, 40, 50, 50),
  ];
  const sunk = setDrawingElementPlane(els, 'host', true);
  assert.equal(sunk.find(e => e.id === 'host').customData.below, true);
  assert.equal(sunk.find(e => e.id === 'label').customData.below, true);
  const moved = translateDrawingElements(sunk, ['host', 'host', 'label'], 7, -3);
  assert.deepEqual(moved.map(e => [e.id, e.x, e.y]), [
    ['host', 17, 17], ['label', 27, 27], ['stay', 300, 40],
  ]);
  assert.deepEqual(els.map(e => [e.id, e.x, e.y]), [
    ['host', 10, 20], ['label', 20, 30], ['stay', 300, 40],
  ]);
});

test('committed 队列等前一笔成功才基于新快照执行，已删图片不复活', async () => {
  let releaseFirst;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  const calls = [];
  const host = rect('host', 10, 20, 100, 80);
  const queue = createDrawingCommitQueue({
    elements: [image('photo'), host],
    files: { photo: binary('photo') },
  }, snapshot => {
    calls.push(snapshot);
    return calls.length === 1 ? firstGate : Promise.resolve();
  });

  const first = queue.submit(base => ({
    elements: deleteDrawingElement(base.elements, 'element-photo'),
    files: base.files,
  }));
  const second = queue.submit(base => ({
    elements: translateDrawingElements(setDrawingElementPlane(base.elements, 'host', true), ['host'], 7, -3),
    files: base.files,
  }));

  await Promise.resolve();
  assert.equal(calls.length, 1, '第二笔不得在第一笔 resolve 前启动');
  assert.deepEqual(calls[0].elements.map(e => e.id), ['host']);
  assert.deepEqual(calls[0].files, {});

  releaseFirst();
  await first;
  const final = await second;
  assert.equal(calls.length, 2);
  assert.deepEqual(final.elements.map(e => e.id), ['host']);
  assert.deepEqual(final.files, {});
  assert.equal(final.elements[0].customData.below, true);
  assert.deepEqual([final.elements[0].x, final.elements[0].y], [17, 17]);
});

test('committed 队列单笔 reject 不推进基线也不毒死后续提交', async () => {
  let attempt = 0;
  const queue = createDrawingCommitQueue({
    elements: [rect('host', 10, 20, 100, 80)],
    files: {},
  }, () => {
    attempt++;
    return attempt === 1 ? Promise.reject(new Error('synthetic failure')) : Promise.resolve();
  });

  const failed = queue.submit(base => ({
    elements: deleteDrawingElement(base.elements, 'host'),
    files: base.files,
  }));
  const recovered = queue.submit(base => ({
    elements: translateDrawingElements(base.elements, ['host'], 5, 6),
    files: base.files,
  }));

  await assert.rejects(failed, /synthetic failure/);
  const final = await recovered;
  assert.equal(attempt, 2);
  assert.deepEqual(final.elements.map(e => [e.id, e.x, e.y]), [['host', 15, 26]]);
});

test('编辑事务门等待 pending 删除落盘，再以无旧图片与文件的同一快照水合', async () => {
  let releaseDelete;
  const deleteGate = new Promise(resolve => { releaseDelete = resolve; });
  const host = rect('host', 10, 20, 100, 80);
  const queue = createDrawingCommitQueue({
    elements: [image('photo'), host],
    files: { photo: binary('photo') },
  }, () => deleteGate);

  const deleting = queue.submit(base => ({
    elements: deleteDrawingElement(base.elements, 'element-photo'),
    files: base.files,
  }));
  let opened = false;
  const seedPromise = queue.whenIdle().then(seed => { opened = true; return seed; });

  await Promise.resolve();
  assert.equal(opened, false, 'pending 普通态提交结束前不得打开编辑器');
  releaseDelete();
  await deleting;
  const seed = await seedPromise;
  assert.deepEqual(seed.elements.map(e => e.id), ['host']);
  assert.deepEqual(seed.files, {});

  const edited = {
    elements: [...seed.elements, rect('new-ink', 200, 50, 40, 40)],
    files: seed.files,
  };
  assert.notEqual(queue.sync(edited), false, '编辑器 flush 快照应在 idle 时接管基线');
  const final = await queue.submit(base => ({
    elements: translateDrawingElements(base.elements, ['host'], 5, 6),
    files: base.files,
  }));
  assert.deepEqual(final.elements.map(e => [e.id, e.x, e.y]), [
    ['host', 15, 26], ['new-ink', 200, 50],
  ]);
  assert.deepEqual(final.files, {});
});

test('pending 期间拒绝 sync；pending 失败后排空种子仍是上次成功的 elements/files', async () => {
  let rejectPending;
  const pendingGate = new Promise((_, reject) => { rejectPending = reject; });
  const host = rect('host', 10, 20, 100, 80);
  const initial = {
    elements: [image('photo'), host],
    files: { photo: binary('photo') },
  };
  const queue = createDrawingCommitQueue(initial, () => pendingGate);
  const pending = queue.submit(base => ({
    elements: deleteDrawingElement(base.elements, 'element-photo'),
    files: base.files,
  }));

  assert.equal(queue.sync({ elements: [rect('stale', 0, 0, 1, 1)], files: {} }), false);
  let drained = false;
  const seedPromise = queue.whenIdle().then(seed => { drained = true; return seed; });
  await Promise.resolve();
  assert.equal(drained, false);

  rejectPending(new Error('synthetic pending failure'));
  await assert.rejects(pending, /synthetic pending failure/);
  const seed = await seedPromise;
  assert.deepEqual(seed.elements.map(e => e.id), ['element-photo', 'host']);
  assert.deepEqual(seed.files, { photo: binary('photo') });
});

test('精确包围盒：旋转矩形按四角实算，折线按 points 实算，负宽高照常', () => {
  // 旋转 90° 的 200x20 扁矩形，中心 (200,110) → 视觉竖条 (190,10)-(210,210)
  const rot = drawingBounds([rect('r', 100, 100, 200, 20, { angle: Math.PI / 2 })]);
  assert.ok(Math.abs(rot.minX - 190) < 1e-6 && Math.abs(rot.maxX - 210) < 1e-6);
  assert.ok(Math.abs(rot.minY - 10) < 1e-6 && Math.abs(rot.maxY - 210) < 1e-6);
  const line = drawingBounds([{ id: 'l', type: 'line', x: 50, y: 60, width: 0, height: 0, points: [[0, 0], [100, -40], [200, 30]] }]);
  assert.deepEqual([line.minX, line.minY, line.maxX, line.maxY], [50, 20, 250, 90]);
  const flip = drawingBounds([rect('f', 500, 300, -400, -200)]);
  assert.deepEqual([flip.minX, flip.minY, flip.maxX, flip.maxY], [100, 100, 500, 300]);
  assert.equal(drawingBounds([]), null);
});

test('空心椭圆四角穿透、描边带命中；实心椭圆腹地命中而角落仍穿透', () => {
  const e = { id: 'e', type: 'ellipse', x: 0, y: 0, width: 200, height: 100, backgroundColor: 'transparent', isDeleted: false, locked: false };
  assert.equal(hitDrawingElement([e], 8, 8, 8), null);              // 包围盒角落在椭圆外
  assert.equal(hitDrawingElement([e], 100, 3, 8)?.id, 'e');         // 顶点描边带
  assert.equal(hitDrawingElement([e], 100, 50, 8), null);           // 空心圆心穿透
  const s = { ...e, id: 's', backgroundColor: '#ffd43b' };
  assert.equal(hitDrawingElement([s], 100, 50, 8)?.id, 's');        // 实心腹地命中
  assert.equal(hitDrawingElement([s], 8, 8, 8), null);              // 实心也不吞角落
});
