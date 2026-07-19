/**
 * [INPUT]: web/src/scene-recovery.js 纯 localStorage 恢复合同
 * [OUTPUT]: 大场景恢复不内嵌图片正文、fileIds/writer 隔离、clientSeq 条件清理、按服务端时间选新弃旧
 * [POS]: keepalive 64KB 上限的同步本地兜底证伪层；IndexedDB 资产链由 4519 浏览器验收
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clearSceneRecovery,
  readLatestSceneRecovery,
  saveSceneRecovery,
  sceneRecoveryKey,
} from '../web/src/scene-recovery.js';

const memoryStorage = () => {
  const values = new Map();
  return {
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
};

test('pagehide 恢复快照保留最终场景但不复制大图片正文', () => {
  const storage = memoryStorage();
  const doc = {
    seq: 7,
    layout: { a: { x: 1, y: 2 } },
    edges: [],
    notes: [{ id: 'n', text: '大'.repeat(30_000) }],
    boards: [],
    drawing: [{ id: 'image', type: 'image', fileId: 'img_large' }],
    drawingFiles: { img_large: { id: 'img_large', dataURL: `data:image/png;base64,${'A'.repeat(90_000)}` } },
  };
  const saved = saveSceneRecovery(doc, 'writer-large', storage);
  assert.ok(saved);
  assert.deepEqual(saved.fileIds, ['img_large']);
  const raw = storage.getItem(sceneRecoveryKey('writer-large'));
  assert.ok(raw.length > 30_000);
  assert.ok(raw.length < 70_000);
  assert.doesNotMatch(raw, /data:image\/png/);
  assert.equal(readLatestSceneRecovery(0, storage).scene.notes[0].text.length, 30_000);
});

test('恢复记录按图片引用隔离，并且旧在飞回执不能清掉较新的 clientSeq', () => {
  const storage = memoryStorage();
  const saved = saveSceneRecovery({
    seq: 9, layout: {}, edges: [], notes: [], boards: [],
    drawing: [
      { id: 'a', type: 'image', fileId: 'img_a' },
      { id: 'b', type: 'image', fileId: 'img_b', isDeleted: true },
      { id: 'c', type: 'image', fileId: 'img_a' },
    ],
  }, 'writer-files', storage);
  assert.deepEqual(saved.fileIds, ['img_a']);
  assert.equal(clearSceneRecovery(saved.key, { clientSeq: 8 }, storage), false);
  assert.ok(storage.getItem(saved.key));
  assert.equal(clearSceneRecovery(saved.key, { savedAt: saved.savedAt - 1 }, storage), false);
  assert.ok(storage.getItem(saved.key));
  const newerSameMillisecond = JSON.parse(storage.getItem(saved.key));
  newerSameMillisecond.clientSeq = 10;
  storage.setItem(saved.key, JSON.stringify(newerSameMillisecond));
  assert.equal(clearSceneRecovery(saved.key, { clientSeq: 9, savedAt: saved.savedAt }, storage), false);
  assert.equal(clearSceneRecovery(saved.key, { clientSeq: 10, savedAt: saved.savedAt }, storage), true);
  assert.equal(storage.getItem(saved.key), null);
});

test('只回放比服务端更新的最新恢复记录，过期和坏记录会被清掉', () => {
  const storage = memoryStorage();
  const now = Date.now;
  let clock = 1000;
  Date.now = () => clock;
  try {
    saveSceneRecovery({ seq: 2, layout: {}, edges: [], notes: [{ id: 'old' }], boards: [], drawing: [] }, 'old', storage);
    clock = 2000;
    saveSceneRecovery({ seq: 3, layout: {}, edges: [], notes: [{ id: 'new' }], boards: [], drawing: [] }, 'new', storage);
    storage.setItem(`${sceneRecoveryKey('bad')}`, '{');
    const latest = readLatestSceneRecovery(1500, storage);
    assert.equal(latest.writerId, 'new');
    assert.equal(latest.scene.notes[0].id, 'new');
    assert.equal(storage.getItem(sceneRecoveryKey('old')), null);
    assert.equal(storage.getItem(sceneRecoveryKey('bad')), null);
  } finally {
    Date.now = now;
  }
});
