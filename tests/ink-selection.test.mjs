import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deleteDrawingElements, drawingElementsInBox, duplicateDrawingElements, hitSelectionHandle,
  resizeBoundsFromHandle, resizeSelectedElements, rotateSelectedElements, selectionBounds,
  selectionClosureIds, translateSelectedElements,
} from '../web/src/canvas/ink-selection.js';

const rect = (id, x, y, width = 100, height = 60, extra = {}) => ({
  id, type: 'rectangle', x, y, width, height, angle: 0,
  strokeColor: '#155eef', backgroundColor: 'transparent', strokeWidth: 2,
  isDeleted: false, groupIds: [], boundElements: null, ...extra,
});

test('选择闭包带上宿主文字；批量平移/删除不篡改原数组', () => {
  const elements = [
    rect('host', 10, 20),
    { ...rect('label', 20, 30, 40, 20), type: 'text', containerId: 'host', text: '标签', fontSize: 20 },
    rect('other', 300, 20),
  ];
  assert.deepEqual(selectionClosureIds(elements, ['host']), ['host', 'label']);
  const moved = translateSelectedElements(elements, ['host'], 15, -5);
  assert.equal(moved[0].x, 25);
  assert.equal(moved[1].x, 35);
  assert.equal(moved[2], elements[2]);
  assert.equal(elements[0].x, 10);
  assert.deepEqual(deleteDrawingElements(elements, ['host']).map(el => el.id), ['other']);
});

test('框选按可见包围盒相交，多元素选择框覆盖全体', () => {
  const elements = [rect('a', 0, 0), rect('b', 180, 40), rect('c', 500, 500)];
  assert.deepEqual(drawingElementsInBox(elements, { minX: 90, minY: 10, maxX: 200, maxY: 80 }), ['a', 'b']);
  assert.deepEqual(selectionBounds(elements, ['a', 'b']), { minX: 0, minY: 0, maxX: 280, maxY: 100 });
});

test('八向手柄命中与缩放共享一个 bounds 合同', () => {
  const bounds = { minX: 10, minY: 20, maxX: 110, maxY: 80 };
  assert.equal(hitSelectionHandle(bounds, 110, 80, 5), 'se');
  assert.equal(hitSelectionHandle(bounds, 60, -8, 5, 28), 'rotate');
  assert.deepEqual(resizeBoundsFromHandle(bounds, 'nw', 40, 35), { minX: 40, minY: 35, maxX: 110, maxY: 80 });

  const resized = resizeSelectedElements([rect('a', 10, 20)], ['a'], bounds, {
    minX: 10, minY: 20, maxX: 210, maxY: 140,
  });
  assert.deepEqual({ x: resized[0].x, y: resized[0].y, w: resized[0].width, h: resized[0].height },
    { x: 10, y: 20, w: 200, h: 120 });
});

test('多选旋转围绕共同中心，元素自身角度同步推进', () => {
  const elements = [rect('a', 0, 0, 20, 20), rect('b', 80, 0, 20, 20)];
  const rotated = rotateSelectedElements(elements, ['a', 'b'], selectionBounds(elements, ['a', 'b']), Math.PI / 2);
  assert.ok(Math.abs(rotated[0].x - 40) < 1e-9);
  assert.ok(Math.abs(rotated[0].y + 40) < 1e-9);
  assert.ok(Math.abs(rotated[1].x - 40) < 1e-9);
  assert.ok(Math.abs(rotated[1].y - 40) < 1e-9);
  assert.equal(rotated[0].angle, Math.PI / 2);
});

test('复制重映射 id/绑定关系，原件留位、克隆整体偏移', () => {
  const elements = [
    rect('host', 10, 20, 100, 60, { boundElements: [{ id: 'label', type: 'text' }] }),
    { ...rect('label', 20, 30, 40, 20), type: 'text', containerId: 'host', text: '标签' },
  ];
  let n = 0;
  const copied = duplicateDrawingElements(elements, ['host'], { dx: 24, dy: 30, idFactory: () => `copy-${++n}` });
  assert.deepEqual(copied.ids, ['copy-1', 'copy-2']);
  assert.equal(copied.clones[0].x, 34);
  assert.equal(copied.clones[0].boundElements[0].id, 'copy-2');
  assert.equal(copied.clones[1].containerId, 'copy-1');
  assert.equal(elements[0].x, 10);
});
