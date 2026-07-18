/**
 * [INPUT]: web/src/scene-store.js 客户端场景真相源（persist 由测试注入）
 * [OUTPUT]: 同步 mutate/订阅、coalesce undo、redo、防抖冲刷与失败退避、LWW 采纳、files delta 回归
 * [POS]: tests 的场景心脏证伪层——交互路径零等待、磁盘失败永不阻塞输入是本仓的宪法
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSceneStore, sceneFilesDelta, emptySceneDoc } from '../web/src/scene-store.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const makeStore = (overrides = {}) => {
  const calls = { scenes: [], files: [] };
  const store = createSceneStore(emptySceneDoc(), {
    persistScene: overrides.persistScene || (async scene => { calls.scenes.push(scene); return { rev: calls.scenes.length }; }),
    persistFiles: overrides.persistFiles || (async files => { calls.files.push(files); return { added: Object.keys(files).length }; }),
  });
  return { store, calls };
};

test('mutate 同步可见、seq 单调、监听即时触发', () => {
  const { store } = makeStore();
  let notified = 0;
  store.subscribe(() => notified++);
  const before = store.get().seq;
  store.mutate(doc => ({ ...doc, notes: [{ id: 'n1', x: 0, y: 0 }] }));
  assert.equal(store.get().notes.length, 1);
  assert.equal(store.get().seq, before + 1);
  assert.ok(notified >= 1);
});

test('同步状态快照引用稳定，dirty 纯状态变化也会通知 React 订阅者', () => {
  const { store } = makeStore();
  const saved = store.status();
  assert.equal(store.status(), saved);
  const seen = [];
  store.subscribe(() => seen.push(store.status().status));
  store.mutate(doc => ({ ...doc, notes: [{ id: 'sync' }] }));
  assert.equal(store.status().status, 'dirty');
  assert.notEqual(store.status(), saved);
  assert.ok(seen.includes('dirty'));
});

test('coalesce 同键连续 mutate 合并为一步 undo；endCoalescing 开新步', () => {
  const { store } = makeStore();
  store.mutate(doc => ({ ...doc, notes: [{ id: 'n1', text: 'a' }] }), { coalesce: 'type:n1' });
  store.mutate(doc => ({ ...doc, notes: [{ id: 'n1', text: 'ab' }] }), { coalesce: 'type:n1' });
  store.mutate(doc => ({ ...doc, notes: [{ id: 'n1', text: 'abc' }] }), { coalesce: 'type:n1' });
  assert.equal(store.get().notes[0].text, 'abc');
  store.undo();
  assert.equal(store.get().notes.length, 0);   // 一步回到起点
  store.redo();
  assert.equal(store.get().notes[0].text, 'abc');
  store.endCoalescing();
  store.mutate(doc => ({ ...doc, notes: [{ ...doc.notes[0], text: 'abcd' }] }), { coalesce: 'type:n1' });
  store.undo();
  assert.equal(store.get().notes[0].text, 'abc');   // 新步只撤到上一段
});

test('undo/redo 往返，新 mutate 清空 redo 栈', () => {
  const { store } = makeStore();
  store.mutate(doc => ({ ...doc, boards: [{ id: 'b1' }] }));
  store.mutate(doc => ({ ...doc, boards: [{ id: 'b1' }, { id: 'b2' }] }));
  store.undo();
  assert.equal(store.get().boards.length, 1);
  assert.ok(store.canRedo());
  store.mutate(doc => ({ ...doc, notes: [{ id: 'n' }] }));
  assert.equal(store.canRedo(), false);
});

test('防抖冲刷：一阵连续 mutate 只落一次盘，files delta 先于场景', async () => {
  const { store, calls } = makeStore();
  store.mutate(doc => ({ ...doc, drawingFiles: { f1: { id: 'f1', dataURL: 'data:x' } }, drawing: [{ id: 'e', type: 'image', fileId: 'f1' }] }));
  store.mutate(doc => ({ ...doc, notes: [{ id: 'n' }] }));
  store.mutate(doc => ({ ...doc, notes: [{ id: 'n', x: 5 }] }));
  await sleep(450);
  assert.equal(calls.scenes.length, 1);
  assert.equal(calls.files.length, 1);
  assert.deepEqual(Object.keys(calls.files[0]), ['f1']);
  assert.equal(calls.scenes[0].canvas.notes[0].x, 5);
  assert.equal(store.status().status, 'saved');
});

test('冲刷失败不阻塞 mutate，退避后自动重试成功', async () => {
  let failures = 2;
  const scenes = [];
  const { store } = makeStore({
    persistScene: async scene => {
      if (failures-- > 0) throw new Error('daemon 正在重启');
      scenes.push(scene);
      return { rev: 1 };
    },
  });
  store.mutate(doc => ({ ...doc, notes: [{ id: 'n1' }] }));
  await sleep(400);
  assert.equal(store.status().status, 'error');
  store.mutate(doc => ({ ...doc, notes: [{ id: 'n1' }, { id: 'n2' }] }));   // 失败期输入照常
  assert.equal(store.get().notes.length, 2);
  await sleep(3400);   // 1s + 2s 退避后第三次成功
  assert.equal(store.status().status, 'saved');
  assert.equal(scenes.at(-1).canvas.notes.length, 2);
});

test('冲刷进行中追加的改动会被追赶冲刷，最终快照为准', async () => {
  let resolveFirst;
  const scenes = [];
  const { store } = makeStore({
    persistScene: scene => new Promise(resolve => {
      scenes.push(scene);
      if (scenes.length === 1) resolveFirst = () => resolve({ rev: 1 });
      else resolve({ rev: scenes.length });
    }),
  });
  store.mutate(doc => ({ ...doc, notes: [{ id: 'a' }] }));
  await sleep(350);            // 第一次冲刷在飞
  store.mutate(doc => ({ ...doc, notes: [{ id: 'a' }, { id: 'b' }] }));
  resolveFirst();
  await sleep(120);
  assert.equal(scenes.length, 2);
  assert.equal(scenes.at(-1).canvas.notes.length, 2);
});

test('adoptRemote：本地干净即采纳，本地有脏改动则本地胜（LWW）', async () => {
  const { store } = makeStore();
  const adopted = store.adoptRemote({ ...emptySceneDoc(), notes: [{ id: 'remote' }] });
  assert.equal(adopted, true);
  assert.equal(store.get().notes[0].id, 'remote');
  store.mutate(doc => ({ ...doc, notes: [{ id: 'local' }] }));
  const rejected = store.adoptRemote({ ...emptySceneDoc(), notes: [{ id: 'remote2' }] });
  assert.equal(rejected, false);
  assert.equal(store.get().notes[0].id, 'local');
  await store.flushNow();
});

test('sceneFilesDelta 只挑基线没有的新 ID', () => {
  assert.deepEqual(
    Object.keys(sceneFilesDelta({ a: 1 }, { a: 1, b: 2, c: 3 })),
    ['b', 'c'],
  );
  assert.deepEqual(sceneFilesDelta({ a: 1 }, { a: 1 }), {});
});
