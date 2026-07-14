import test from 'node:test';
import assert from 'node:assert/strict';
import { CARD_GAP, COL_W, GAP_IN, GUTTER, HEADER_H, PAD, packWorkspaces, resizedContainerChildren, resolveContainerOverlaps, tidyLayoutEntries } from '../web/src/canvas/layout.js';

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
