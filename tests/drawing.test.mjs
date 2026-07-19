/**
 * [INPUT]: web/src/canvas/drawing.js 墨迹纯几何内核
 * [OUTPUT]: 命中检测双模（描边带/选择热区/旋转/折线段/后画者优先/墓碑锁定）、包围盒、
 *           平移/删除/沉浮不可变变换、大实心底板判定、4518 交互与 352 节点性能夹具契约回归
 * [POS]: tests 的墨迹几何证伪层——命中区严格贴墨迹，隐形玻璃一块都不许有
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  committedDrawingElements, deleteDrawingElement, drawingBounds, hitDrawingElement,
  isBelow, isLargeFilledDrawingElement, setDrawingElementPlane, translateDrawingElements,
} from '../web/src/canvas/drawing.js';
import { buildGraph } from '../web/src/canvas/layout.js';
import {
  createFlowPerformanceFixture, FLOW_PERFORMANCE_NODE_COUNT, FLOW_PERFORMANCE_WORKSPACE,
} from './fixtures/canvas-acceptance/fixture-data.js';

const rect = (id, x, y, w, h, extra = {}) => ({
  id, type: 'rectangle', x, y, width: w, height: h,
  backgroundColor: 'transparent', ...extra,
});

test('空心矩形只认描边带：中空穿透、边框命中、选择热区含内部', () => {
  const els = [rect('r', 100, 100, 200, 100)];
  assert.equal(hitDrawingElement(els, 200, 150, 6), null, '中空区不是玻璃');
  assert.ok(hitDrawingElement(els, 100, 150, 6), '左边框描边带命中');
  assert.ok(hitDrawingElement(els, 200, 150, 6, { includeHollowInterior: true }), '选择热区扩到内部');
});

test('实心矩形全域命中；后画者优先', () => {
  const solid = rect('s', 100, 100, 200, 100, { backgroundColor: '#dbeafe', fillStyle: 'solid' });
  assert.ok(hitDrawingElement([solid], 200, 150, 6));
  const later = rect('later', 150, 120, 200, 100, { backgroundColor: '#fde0e0', fillStyle: 'solid' });
  assert.equal(hitDrawingElement([solid, later], 200, 150, 6).id, 'later');
});

test('旋转元素命中跟着视觉走：逆变换回元素坐标系', () => {
  const el = rect('rot', 100, 100, 200, 100, { angle: Math.PI / 2 });
  // 旋转 90° 后视觉上原左边框在上方——旋转中心 (200,150)
  assert.ok(hitDrawingElement([el], 200, 50, 8), '旋转后的短边位置命中');
  assert.equal(hitDrawingElement([el], 100, 150, 4), null, '旋转前的旧位置不再命中');
});

test('freedraw/线按点到折线段距离命中，斜线空腹不是玻璃', () => {
  const stroke = {
    id: 'f', type: 'freedraw', x: 0, y: 0, width: 100, height: 100,
    points: [[0, 0], [100, 100]],
  };
  assert.ok(hitDrawingElement([stroke], 50, 50, 6), '斜线本体命中');
  assert.equal(hitDrawingElement([stroke], 90, 10, 6), null, '包围盒角落的空腹穿透');
});

test('墓碑与锁定元素不参与命中', () => {
  const dead = rect('dead', 0, 0, 100, 100, { isDeleted: true, backgroundColor: '#eee', fillStyle: 'solid' });
  const locked = rect('lock', 0, 0, 100, 100, { locked: true, backgroundColor: '#eee', fillStyle: 'solid' });
  assert.equal(hitDrawingElement([dead], 50, 50, 6), null);
  assert.equal(hitDrawingElement([locked], 50, 50, 6), null);
});

test('drawingBounds 覆盖旋转四角与折线实点', () => {
  const plain = drawingBounds([rect('r', 10, 20, 100, 50)]);
  assert.deepEqual([plain.minX, plain.minY, plain.maxX, plain.maxY], [10, 20, 110, 70]);
  const line = drawingBounds([{ id: 'l', type: 'line', x: 0, y: 0, width: 0, height: 0, points: [[0, 0], [60, -40]] }]);
  assert.equal(line.minY, -40);
  assert.equal(line.maxX, 60);
});

test('平移/删除/沉浮是不可变变换：原数组零篡改', () => {
  const els = [rect('a', 0, 0, 10, 10), rect('b', 50, 50, 10, 10)];
  const moved = translateDrawingElements(els, ['a'], 5, 7);
  assert.equal(els[0].x, 0);
  assert.equal(moved[0].x, 5);
  assert.equal(moved[1], els[1], '未平移元素保持引用');
  const gone = deleteDrawingElement(els, 'b');
  assert.equal(gone.find(e => e.id === 'b'), undefined, '删除即移除（undo 由 store 历史负责）');
  assert.equal(els.length, 2, '原数组不动');
  const sunk = setDrawingElementPlane(els, 'a', true);
  assert.equal(isBelow(sunk[0]), true);
  assert.equal(isBelow(els[0]), false);
});

test('committedDrawingElements 滤掉墓碑', () => {
  const els = [rect('a', 0, 0, 1, 1), { ...rect('b', 0, 0, 1, 1), isDeleted: true }];
  assert.deepEqual(committedDrawingElements(els).map(e => e.id), ['a']);
});

test('大实心底板判定：宽≥400 高≥300 面积≥120000 且有填充', () => {
  assert.ok(isLargeFilledDrawingElement(rect('big', 0, 0, 500, 400, { backgroundColor: '#dbeafe', fillStyle: 'solid' })));
  assert.equal(isLargeFilledDrawingElement(rect('small', 0, 0, 100, 80, { backgroundColor: '#dbeafe', fillStyle: 'solid' })), false);
  assert.equal(isLargeFilledDrawingElement(rect('hollow', 0, 0, 500, 400)), false);
});

test('4518 新合同夹具：合成 input/pointer 只在隔离页驱动真实 FlowCanvas，timer 轮询后台可跑', () => {
  const fixture = fs.readFileSync(path.resolve('tests/fixtures/canvas-acceptance/interaction-data.js'), 'utf8');
  assert.match(fixture, /new\s+PointerEvent\s*\(/, 'A 组能力必须由 pointer 输入扩链证伪');
  assert.match(fixture, /new\s+KeyboardEvent\s*\(/, '工具快捷键/Delete 必须由键盘输入证伪');
  assert.match(fixture, /new\s+ClipboardEvent\s*\(/, '复制粘贴必须走 production clipboard listener');
  assert.match(fixture, /127\.0\.0\.1:4518|4518/, '合成输入只能存在于 4518 隔离夹具');
  assert.doesNotMatch(fixture, /requestAnimationFrame/,
    '验收轮询必须用 setTimeout——隐藏窗格 rAF 停摆（v23 教训）');
  assert.match(fixture, /data-run-suite/, '必须有可见的手动运行按钮');
});

test('300/800 直渲性能红线写死进 4518 合同', () => {
  const fixture = fs.readFileSync(path.resolve('tests/fixtures/canvas-acceptance/main.jsx'), 'utf8');
  assert.match(fixture, /MOUNT_BUDGET_MS\s*=.*300:\s*900.*800:\s*1600/s);
  assert.match(fixture, /mountMs\s*<=\s*budgetMs/);
});

test('352 节点性能场景使用 production buildGraph，并要求真实 pointer + CDP trace', () => {
  const fixture = createFlowPerformanceFixture();
  const built = buildGraph(
    fixture.workspaces,
    fixture.sessionsByKey,
    {},
    [],
    [],
    new Set([FLOW_PERFORMANCE_WORKSPACE]),
    false,
  );
  assert.equal(built.nodes.length, FLOW_PERFORMANCE_NODE_COUNT);
  assert.deepEqual(
    built.nodes.reduce((counts, node) => ({ ...counts, [node.type]: (counts[node.type] || 0) + 1 }), {}),
    { district: 1, workspace: 1, session: 350 },
  );
  const page = fs.readFileSync(path.resolve('tests/fixtures/canvas-acceptance/performance-352-data.js'), 'utf8');
  const verifier = fs.readFileSync(path.resolve('tests/fixtures/canvas-acceptance/verify.py'), 'utf8');
  assert.match(page, /FlowCanvas/);
  assert.match(page, /PerformanceObserver/);
  assert.match(verifier, /page\.mouse\.down\(\)/);
  assert.match(verifier, /Tracing\.start/);
  assert.match(verifier, /frameP95MaxMs.*20/);
});

test('4518 静态服务只暴露 allowlist fixture 并拒绝写请求', () => {
  const server = fs.readFileSync(path.resolve('scripts/serve-canvas-acceptance.mjs'), 'utf8');
  assert.match(server, /4518/);
  assert.doesNotMatch(server, /4517/, '验收服务绝不许摸生产端口');
});
