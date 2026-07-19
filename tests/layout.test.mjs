import test from 'node:test';
import assert from 'node:assert/strict';
import { arrangedSceneGeometry, arrangeFlowBlocks, buildGraph, CARD_GAP, COL_W, GAP_IN, GUTTER, HEADER_H, PAD, packWorkspaces, resizedContainerChildren, resolveContainerOverlaps, tidyLayoutEntries } from '../web/src/canvas/layout.js';
import { createBatchCarryBridge, planBatchCarry } from '../web/src/canvas/container-carry.js';

const ws = (path, count = 1) => ({ path, visibleKeys: Array.from({ length: count }, (_, i) => `${path}:${i}`) });
const heightOf = item => HEADER_H + item.visibleKeys.length * (62 + CARD_GAP) + 8;
const overlap = (a, b) =>
  a.x < b.x + COL_W + GAP_IN && a.x + COL_W + GAP_IN > b.x &&
  a.y < b.y + b.h + GAP_IN && a.y + a.h + GAP_IN > b.y;

test('saved workspaces stay collision-free when an earlier workspace gains sessions', () => {
  const items = [ws('/alpha', 8), ws('/beta', 2)];
  const layout = {
    '/alpha': { x: PAD.l, y: PAD.t, d: 'district' },
    '/beta': { x: PAD.l, y: 300, d: 'district' },
  };
  const placed = packWorkspaces(items, layout, 'district', heightOf);

  assert.equal(placed[0].y, PAD.t);
  assert.equal(overlap(placed[0], placed[1]), false);
  assert.equal(placed[1].y, placed[0].y + placed[0].h + GAP_IN);
});

test('a newly discovered workspace uses a free column instead of covering saved workspaces', () => {
  const items = [ws('/saved-a', 3), ws('/saved-b', 3), ws('/incoming', 2)];
  const layout = {
    '/saved-a': { x: PAD.l, y: PAD.t, d: 'district' },
    '/saved-b': { x: PAD.l, y: 420, d: 'district' },
  };
  const placed = packWorkspaces(items, layout, 'district', heightOf);
  const incoming = placed.find(item => item.ws.path === '/incoming');

  assert.equal(incoming.x, PAD.l + COL_W + GAP_IN);
  assert.equal(incoming.y, PAD.t);
  assert.equal(placed.some(item => item !== incoming && overlap(item, incoming)), false);
});

test('automatic arrangement is deterministic and has no workspace collisions', () => {
  const items = [ws('/a', 1), ws('/b', 8), ws('/c', 4), ws('/d', 2), ws('/e', 6)];
  const first = packWorkspaces(items, {}, 'district', heightOf);
  const second = packWorkspaces(items, {}, 'district', heightOf);

  assert.deepEqual(first, second);
  for (let i = 0; i < first.length; i++) {
    for (let j = i + 1; j < first.length; j++) assert.equal(overlap(first[i], first[j]), false);
  }
});

test('automatic arrangement sorts by activity and aligns workspaces into readable rows', () => {
  const items = [
    { ...ws('/old-tall', 8), lastActivity: '2026-07-01T00:00:00.000Z' },
    { ...ws('/new-short', 1), lastActivity: '2026-07-19T00:00:00.000Z' },
    { ...ws('/middle', 3), lastActivity: '2026-07-18T00:00:00.000Z' },
    { ...ws('/older', 2), lastActivity: '2026-07-10T00:00:00.000Z' },
  ];
  const placed = packWorkspaces(items, {}, 'district', heightOf);

  assert.deepEqual(placed.slice(0, 2).map(item => item.ws.path), ['/new-short', '/middle']);
  assert.equal(placed[0].y, PAD.t);
  assert.equal(placed[1].y, PAD.t);
  assert.equal(placed[2].y, PAD.t + Math.max(placed[0].h, placed[1].h) + GAP_IN);
  assert.equal(placed[3].y, placed[2].y);
});

test('outer automatic districts use balanced lanes instead of tall shelf rows', () => {
  const blocks = [
    { key: 'tall', w: 600, h: 1000 },
    { key: 'short-a', w: 500, h: 220 },
    { key: 'short-b', w: 500, h: 220 },
    { key: 'short-c', w: 500, h: 220 },
  ];
  arrangeFlowBlocks(blocks);

  assert.deepEqual(blocks.map(block => ({ key: block.key, x: block.x, y: block.y })), [
    { key: 'tall', x: 0, y: 0 },
    { key: 'short-a', x: 600 + GUTTER, y: 0 },
    { key: 'short-b', x: 600 + GUTTER, y: 220 + GUTTER },
    { key: 'short-c', x: 600 + GUTTER, y: 2 * (220 + GUTTER) },
  ]);
});

test('membership-only tidy entries reflow as incoming geometry without producing NaN', () => {
  const items = [ws('/manual-member', 2)];
  const placed = packWorkspaces(items, {
    '/manual-member': { d: 'district' },
  }, 'district', heightOf);

  assert.equal(placed.length, 1);
  assert.equal(placed[0].x, PAD.l);
  assert.equal(placed[0].y, PAD.t);
  assert.ok(Number.isFinite(placed[0].x) && Number.isFinite(placed[0].y));
});

test('a growing saved district pushes later containers away without changing their horizontal intent', () => {
  const blocks = [
    { key: 'large', x: 0, y: 0, w: 900, h: 700 },
    { key: 'later', x: 600, y: 500, w: 500, h: 300 },
    { key: 'side', x: 1200, y: 500, w: 400, h: 300 },
  ];
  resolveContainerOverlaps(blocks);

  assert.equal(blocks[0].y, 0);
  assert.equal(blocks[1].x, 600);
  assert.equal(blocks[1].y, 700 + GUTTER);
  assert.equal(blocks[2].y, 500);
});

test('automatic terrain avoids fixed manual containers without moving the manual anchor', () => {
  const blocks = [
    { key: 'manual-board', x: 0, y: 0, w: 700, h: 420, fixed: true },
    { key: 'auto-district', x: 0, y: 0, w: 600, h: 300 },
  ];
  resolveContainerOverlaps(blocks);

  assert.deepEqual(blocks[0], { key: 'manual-board', x: 0, y: 0, w: 700, h: 420, fixed: true });
  assert.equal(blocks[1].x, 0);
  assert.equal(blocks[1].y, 420 + GUTTER);
});

test('tidy resets geometry but preserves manual district and board membership', () => {
  const layout = {
    '/auto': { x: 20, y: 30 },
    '/district-member': { x: 120, y: 230, d: 'BINGO-Space / Claude_Code' },
    '/board-member': { x: 18, y: 68, d: 'board:demo' },
    'district:BINGO-Space / AI-code': { x: 900, y: 400, w: 1200, h: 800 },
  };

  assert.deepEqual(tidyLayoutEntries(layout), [
    { path: '/district-member', d: 'BINGO-Space / Claude_Code' },
    { path: '/board-member', d: 'board:demo' },
  ]);
});

test('container resize persists React Flow child compensation so absolute positions stay fixed', () => {
  const afterResize = [
    { id: 'board:demo', type: 'board', position: { x: 80, y: 70 } },
    { id: '/alpha', type: 'workspace', parentId: 'board:demo', position: { x: 40, y: 60 } },
    { id: '/outside', type: 'workspace', parentId: 'district:elsewhere', position: { x: 10, y: 20 } },
  ];

  assert.deepEqual(resizedContainerChildren(afterResize, 'board:demo'), [
    { path: '/alpha', x: 40, y: 60, d: 'board:demo' },
  ]);
  assert.equal(80 + 40, 120); // resize 前 parent.x=100, child.x=20，绝对 x 同为 120
});

test('production tidy preserves a manual board and moves automatic terrain around it', () => {
  const workspaces = [{
    path: '/Users/test/A/X',
    visibleKeys: ['session:1'],
    lastActivity: '2026-07-17T00:00:00.000Z',
  }];
  const sessions = { 'session:1': { cwd: '/Users/test/A/X' } };
  const boards = [{ id: 'b1', x: 0, y: 0, w: 520, h: 360 }];
  const currentLayout = { 'district:A / X': { x: 2000, y: 0 } };
  const targetLayout = {};
  const before = buildGraph(workspaces, sessions, currentLayout, boards, [], new Set(), false);
  const after = buildGraph(workspaces, sessions, targetLayout, boards, [], new Set(), false);
  const boardBefore = before.nodes.find(node => node.id === 'board:b1');
  const boardAfter = after.nodes.find(node => node.id === 'board:b1');
  const districtBefore = before.nodes.find(node => node.id === 'district:A / X');
  const districtAfter = after.nodes.find(node => node.id === 'district:A / X');
  assert.deepEqual(boardBefore.position, { x: 0, y: 0 });
  assert.deepEqual(boardAfter.position, { x: 0, y: 0 });
  assert.deepEqual(districtBefore.position, { x: 2000, y: 0 });
  assert.ok(districtAfter.position.y > boardAfter.height);

  const moves = planBatchCarry(before.nodes, after.nodes,
    [{ id: 'board-ink', x: 20, y: 20, width: 10, height: 10 }]);
  assert.equal(moves.some(move => move.containerId === 'board:b1'), false);
  assert.deepEqual(moves.find(move => move.containerId === 'district:A / X'), {
    containerId: 'district:A / X',
    from: { x: 2000, y: 0 },
    to: { ...districtAfter.position },
    anchorIds: [],
  });
});

test('explicit intelligent tidy includes boards in balanced lanes and compacts oversized geometry', () => {
  const workspaces = [{
    path: '/Users/test/A/X', visibleKeys: ['session:1'],
    lastActivity: '2026-07-19T00:00:00.000Z',
  }];
  const sessions = { 'session:1': { cwd: '/Users/test/A/X' } };
  const boards = [{ id: 'b1', x: 4000, y: 3000, w: 1600, h: 1200 }];
  const arranged = buildGraph(
    workspaces, sessions, {}, boards, [], new Set(), false,
    { reflowBoards: true },
  );
  const district = arranged.nodes.find(node => node.type === 'district');
  const board = arranged.nodes.find(node => node.id === 'board:b1');

  assert.deepEqual(district.position, { x: 0, y: 0 });
  assert.equal(board.position.y, 0);
  assert.ok(board.position.x > district.position.x + district.width);
  assert.deepEqual({ w: board.width, h: board.height }, { w: 520, h: 360 });
  const geometry = arrangedSceneGeometry(arranged.nodes, { '/Users/test/A/X': { d: 'A / X' } });
  assert.deepEqual(geometry.layout['district:A / X'], {
    x: district.position.x, y: district.position.y, w: district.width, h: district.height,
  });
  assert.deepEqual(geometry.boards.get('b1'), {
    x: board.position.x, y: board.position.y, w: board.width, h: board.height,
  });
});

test('整理桥先以逆向 delta 钉回旧像素，release 后只撤位移不提前撤动画类', () => {
  const properties = new Map();
  const classes = new Set();
  const node = {
    classList: { add: value => classes.add(value), remove: value => classes.delete(value) },
    style: {
      setProperty: (key, value) => properties.set(key, value),
      removeProperty: key => properties.delete(key),
    },
  };
  const rootClasses = new Set();
  const root = {
    querySelectorAll: selector => selector.includes('ink-a') ? [node] : [],
    classList: { toggle: (value, on) => on ? rootClasses.add(value) : rootClasses.delete(value), remove: value => rootClasses.delete(value) },
  };
  const bridge = createBatchCarryBridge(root);
  assert.equal(bridge.present([{ from: { x: 10, y: 20 }, to: { x: 70, y: 5 }, anchorIds: ['ink-a'] }]), 1);
  assert.equal(properties.get('--carry-x'), '-60px');
  assert.equal(properties.get('--carry-y'), '15px');
  assert.ok(classes.has('ink-carry-anchor'));
  bridge.release();
  assert.equal(properties.size, 0);
  assert.ok(classes.has('ink-carry-anchor'));
  bridge.clear();
  assert.equal(classes.size, 0);
  assert.equal(rootClasses.size, 0);
});
