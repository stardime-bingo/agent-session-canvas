import test from 'node:test';
import assert from 'node:assert/strict';
import { createNodeFromEdge } from '../server/canvas-actions.mjs';

const base = () => ({ edges: [], notes: [], boards: [], drawing: [] });

test('edge drop creates a note and its edge in one canvas transaction', () => {
  const result = createNodeFromEdge(base(), { kind: 'note', from: 'claude:source', x: 200, y: 300 }, 123);
  assert.deepEqual(result.node, { id: 'note:123', x: 200, y: 260, text: '', color: 'yellow' });
  assert.deepEqual(result.edge, { id: 'manual:123', from: 'claude:source', to: 'note:123' });
  assert.equal(result.canvas.notes.length, 1);
  assert.equal(result.canvas.edges.length, 1);
});

test('edge drop creates a board target with the React Flow board prefix', () => {
  const result = createNodeFromEdge(base(), { kind: 'board', from: '/workspace', x: 400, y: 500 }, 456);
  assert.equal(result.node.id, '456');
  assert.equal(result.edge.to, 'board:456');
  assert.equal(result.canvas.boards.length, 1);
  assert.throws(() => createNodeFromEdge(base(), { kind: 'session', from: 'x' }, 1), /便签或画板/);
});
