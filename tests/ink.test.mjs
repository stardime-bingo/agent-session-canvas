/**
 * [INPUT]: web/src/canvas/ink.js 自研墨迹模型纯函数
 * [OUTPUT]: freedraw 平滑路径、箭头端头、拖画更新（含反向拖归一化/亚像素节流）、
 *           收笔定稿判废、文字度量、upsert 回归
 * [POS]: tests 的墨迹模型证伪层——落笔即元素、拖画即更新、收笔即定稿
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  arrowPath, createInkElement, finishInkElement, freedrawPath, measureInkText,
  updateInkElementDrag, upsertInkElement,
} from '../web/src/canvas/ink.js';

test('freedrawPath：单点出可见微线，多点出中点二次贝塞尔', () => {
  assert.match(freedrawPath([[10, 10]]), /^M 10 10 l 0\.01 0$/);
  const d = freedrawPath([[0, 0], [10, 0], [20, 10]]);
  assert.match(d, /^M 0 0 Q 10 0 15 5 L 20 10$/);
});

test('arrowPath：主干折线 + 末端两撇跟随方向', () => {
  const d = arrowPath([[0, 0], [100, 0]], 10);
  assert.match(d, /^M 0 0 L 100 0 M /);
  assert.ok(d.split('M').length === 3, '第二个 M 起笔画端头');
});

test('createInkElement：各类工具带正确骨架，below 样式随创建落 customData', () => {
  const pen = createInkElement('freedraw', 5, 6, { strokeColor: '#111' });
  assert.equal(pen.type, 'freedraw');
  assert.deepEqual(pen.points, [[0, 0]]);
  const text = createInkElement('text', 0, 0, {});
  assert.equal(text.type, 'text');
  assert.ok(text.fontSize > 0);
  const sunk = createInkElement('rectangle', 0, 0, { below: true });
  assert.equal(sunk.customData.below, true);
});

test('updateInkElementDrag：freedraw 增点带亚像素节流；矩形反向拖归一化 x/y/w/h', () => {
  let pen = createInkElement('freedraw', 100, 100, {});
  pen = updateInkElementDrag(pen, 110, 108);
  assert.equal(pen.points.length, 2);
  const throttled = updateInkElementDrag(pen, 110.2, 108.2);
  assert.equal(throttled.points.length, 2, '亚像素抖动不进文档');

  let box = createInkElement('rectangle', 100, 100, {});
  box = updateInkElementDrag(box, 40, 60);   // 向左上反拖
  assert.deepEqual([box.x, box.y, box.width, box.height], [40, 60, 60, 40]);
  box = updateInkElementDrag(box, 160, 180); // 再向右下
  assert.deepEqual([box.x, box.y], [100, 100]);
});

test('finishInkElement：私有锚字段剥除、意外小形状判废', () => {
  let box = createInkElement('rectangle', 100, 100, {});
  box = updateInkElementDrag(box, 102, 101);
  const tiny = finishInkElement(box);
  assert.equal(tiny.discard, true);
  box = updateInkElementDrag(box, 200, 180);
  const done = finishInkElement(box);
  assert.equal(done.discard, false);
  assert.equal('_ox' in done.element, false, '定稿元素不携带拖画私有字段');
});

test('measureInkText：CJK 全宽、多行取最宽', () => {
  const single = measureInkText('哥', 20);
  assert.equal(single.width, 20);
  const multi = measureInkText('abc\n哥的重要笔记', 20);
  assert.ok(multi.height > single.height);
  assert.ok(multi.width >= 6 * 20);
});

test('upsertInkElement：同 id 原位替换，新 id 追加', () => {
  const a = createInkElement('rectangle', 0, 0, {});
  const b = createInkElement('rectangle', 10, 10, {});
  const list = upsertInkElement([a], b);
  assert.equal(list.length, 2);
  const replaced = upsertInkElement(list, { ...a, x: 99 });
  assert.equal(replaced.length, 2);
  assert.equal(replaced[0].x, 99);
});
