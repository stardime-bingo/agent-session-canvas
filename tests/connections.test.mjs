import test from 'node:test';
import assert from 'node:assert/strict';
import { connectionDrop, syncHandleHitArea } from '../web/src/canvas/connections.js';

const target = ({ inCanvas = true, inUi = false } = {}) => ({
  closest(selector) {
    if (selector === '.canvas-root') return inCanvas ? {} : null;
    if (selector === '.island, .ctx-menu') return inUi ? {} : null;
    return null;
  },
});

test('connection drop opens creation choice on canvas container backgrounds', () => {
  const state = { isValid: false, fromNode: { id: 'session:a' }, toNode: null };
  assert.deepEqual(connectionDrop({ clientX: 420, clientY: 260, target: target() }, state), {
    x: 420, y: 260, from: 'session:a',
  });
  assert.equal(connectionDrop({ clientX: 420, clientY: 260, target: target({ inUi: true }) }, state), null);
  assert.equal(connectionDrop({ clientX: 420, clientY: 260, target: target() }, { ...state, toNode: { id: 'session:b' } }), null);
});

test('connection handles stay easy at work zoom and avoid overlap noise in overview', () => {
  const values = new Map();
  const root = { style: { setProperty: (key, value) => values.set(key, value) } };
  syncHandleHitArea(root, 0.1);
  assert.equal(values.get('--handle-hit'), '120px');
  assert.equal(values.get('--handle-hit-hover'), '280px');
  syncHandleHitArea(root, 1);
  assert.equal(values.get('--handle-hit'), '28px');
  assert.equal(values.get('--handle-dot-hover'), '14px');
});
