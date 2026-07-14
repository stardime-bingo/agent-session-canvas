import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { drawingBounds, drawingFilesSignature, drawingSnapshot, hitDrawingElement, splitDrawingPlanes } from '../web/src/canvas/drawing.js';
import { loadDrawingFiles, normalizeDrawingFiles, saveDrawingFiles } from '../server/drawing-files.mjs';

const image = id => ({ id: `element-${id}`, type: 'image', fileId: id });
const binary = id => ({ id, mimeType: 'image/png', dataURL: 'data:image/png;base64,c3ludGhldGlj', created: 1 });

test('drawing snapshot keeps referenced images and prunes deleted image files', () => {
  const snapshot = drawingSnapshot([image('used'), { id: 'line', type: 'line' }], {
    used: binary('used'), stale: binary('stale'),
  });

  assert.deepEqual(Object.keys(snapshot.files), ['used']);
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
