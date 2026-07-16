import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCanvasRepository, SceneError } from '../server/canvas-repository.mjs';
import { commitDrawingWithReceipt } from '../web/src/api.js';
import { createDrawingCommitQueue, drawingFilesDelta } from '../web/src/canvas/drawing.js';

const binary = (id, data = 'YQ==', extra = {}) => ({
  id, mimeType: 'image/png', dataURL: `data:image/png;base64,${data}`, created: 1, ...extra,
});
const image = id => ({ id: `element-${id}`, type: 'image', fileId: id, x: 0, y: 0 });
const makeDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'drawing-files-'));
const seed = dir => {
  fs.writeFileSync(path.join(dir, 'canvas.json'), JSON.stringify({
    edges: [], notes: [], boards: [], drawing: [],
  }));
  fs.writeFileSync(path.join(dir, 'layout.json'), '{}');
  fs.writeFileSync(path.join(dir, 'drawing-files.json'), '{}');
};
const invariant = dir => {
  const canvas = JSON.parse(fs.readFileSync(path.join(dir, 'canvas.json')));
  const files = JSON.parse(fs.readFileSync(path.join(dir, 'drawing-files.json')));
  for (const element of canvas.drawing) {
    if (element.type === 'image' && !element.isDeleted) assert.ok(files[element.fileId]);
  }
};

test('BinaryFiles delta 精确覆盖规范字段，平移/删除不重传 base64', () => {
  const a = binary('a');
  assert.deepEqual(drawingFilesDelta({ a }, { a: { ...a } }), {});
  assert.deepEqual(Object.keys(drawingFilesDelta({ a }, { a, b: binary('b') })), ['b']);
  assert.deepEqual(Object.keys(drawingFilesDelta({ a }, { a: { ...a, lastRetrieved: 2 } })), ['a']);
  assert.deepEqual(drawingFilesDelta({ a }, {}), {});
});

test('drawing commit 资产先写引用后写；同 ID 保留首份 canonical 且内容变化零写拒绝', () => {
  const dir = makeDir(); seed(dir);
  const repo = createCanvasRepository(dir);
  let token = repo.readWithDrawingFiles().sceneToken;
  const first = repo.commitDrawing({
    opId: 'one', baseToken: token, elements: [image('a')], files: { a: binary('a') },
  });
  token = first.sceneToken;
  const metadata = repo.commitDrawing({
    opId: 'meta', baseToken: token, elements: [image('a')],
    files: { a: binary('a', 'YQ==', { lastRetrieved: 2 }) },
  });
  assert.equal(metadata.status, 'committed');
  assert.deepEqual(repo.readWithDrawingFiles().drawingFiles.a, binary('a'));
  const before = [fs.readFileSync(repo.paths.canvasFile), fs.readFileSync(repo.paths.drawingFilesFile)];
  assert.throws(() => repo.commitDrawing({
    opId: 'bad', baseToken: metadata.sceneToken, elements: [image('a')],
    files: { a: binary('a', 'Yg==') },
  }), error => error instanceof SceneError && error.code === 'DRAWING_FILE_IMMUTABLE');
  assert.deepEqual(fs.readFileSync(repo.paths.canvasFile), before[0]);
  assert.deepEqual(fs.readFileSync(repo.paths.drawingFilesFile), before[1]);
});

test('committed queue 把 previousSuccessful 交给 persist，几何提交与同内容 clone 都是零 base64 delta', async () => {
  const photo = binary('photo');
  const calls = [];
  const queue = createDrawingCommitQueue({
    elements: [image('photo')],
    files: { photo },
  }, async (next, previousSuccessful) => {
    calls.push({ next, previousSuccessful, delta: drawingFilesDelta(previousSuccessful.files, next.files) });
  });
  await queue.submit(base => ({
    elements: [{ ...base.elements[0], x: 10 }],
    files: { photo: { ...base.files.photo } },
  }));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].delta, {});
  assert.equal(calls[0].previousSuccessful.elements[0].x, 0);
  assert.equal(calls[0].next.elements[0].x, 10);
});

test('committed queue 把本笔 persist receipt 与对应 snapshot 一起交给 closing', async () => {
  const queue = createDrawingCommitQueue({ elements: [], files: {} }, async next => ({
    status: 'committed',
    opId: next.elements[0].id,
    sceneToken: `token-${next.elements[0].id}`,
  }));
  const committed = await queue.submitWithReceipt(() => ({
    elements: [{ id: 'shape', type: 'rectangle' }],
    files: {},
  }));
  assert.equal(committed.snapshot.elements[0].id, 'shape');
  assert.equal(committed.receipt.sceneToken, 'token-shape');
  assert.equal(queue.snapshot(), committed.snapshot);
});

test('drawing response loss queries receipt; only dual uncertainty poisons authority', async () => {
  const responseLost = Object.assign(new Error('network'), { status: 500 });
  const committed = { status: 'committed', opId: 'op', sceneToken: 'next' };
  assert.deepEqual(await commitDrawingWithReceipt(
    { opId: 'op' },
    async () => { throw responseLost; },
    async () => committed,
  ), committed);

  await assert.rejects(commitDrawingWithReceipt(
    { opId: 'op' },
    async () => { throw responseLost; },
    async () => { throw new Error('status network'); },
  ), error => error.code === 'AUTHORITY_UNKNOWN' && error.authorityUnknown);

  await assert.rejects(commitDrawingWithReceipt(
    { opId: 'op' },
    async () => { throw responseLost; },
    async () => ({ status: 'unknown', opId: 'op' }),
  ), error => error.code === 'DRAWING_NOT_COMMITTED' && !error.authorityUnknown);

  let queried = false;
  await assert.rejects(commitDrawingWithReceipt(
    { opId: 'op' },
    async () => { throw Object.assign(new Error('conflict'), { status: 409 }); },
    async () => { queried = true; },
  ), error => error.status === 409);
  assert.equal(queried, false);
});

test('缺引用与非法 delta typed error 且两个持久文件 byte-zero', () => {
  const dir = makeDir(); seed(dir);
  const repo = createCanvasRepository(dir);
  const token = repo.read().sceneToken;
  const before = [fs.readFileSync(repo.paths.canvasFile), fs.readFileSync(repo.paths.drawingFilesFile)];
  assert.throws(() => repo.commitDrawing({
    opId: 'missing', baseToken: token, elements: [image('missing')], files: {},
  }), error => error.code === 'DRAWING_FILE_MISSING');
  assert.throws(() => repo.commitDrawing({
    opId: 'invalid', baseToken: token, elements: [], files: { bad: { id: 'bad', dataURL: 'nope' } },
  }), error => error.code === 'INVALID_DRAWING_COMMIT');
  assert.deepEqual(fs.readFileSync(repo.paths.canvasFile), before[0]);
  assert.deepEqual(fs.readFileSync(repo.paths.drawingFilesFile), before[1]);
});

test('drawing 各故障窗恢复后只允许 before+孤儿或 after+完整引用', () => {
  for (const stage of ['drawing:assets', 'drawing:prepared', 'drawing:canvas', 'drawing:committed', 'drawing:receipt', 'drawing:prune']) {
    const dir = makeDir(); seed(dir);
    const repo = createCanvasRepository(dir, { fault: at => { if (at === stage) throw new Error(stage); } });
    const token = repo.read().sceneToken;
    try {
      repo.commitDrawing({
        opId: `op-${stage}`, baseToken: token, elements: [image('a')], files: { a: binary('a') },
      });
    } catch { /* injected */ }
    createCanvasRepository(dir).readWithDrawingFiles();
    invariant(dir);
  }
});

test('response loss 由 receipt/status 确认；journal token 篡改在写前阻断恢复', () => {
  const dir = makeDir(); seed(dir);
  const repo = createCanvasRepository(dir);
  const result = repo.commitDrawing({
    opId: 'lost-response', baseToken: repo.read().sceneToken,
    elements: [image('a')], files: { a: binary('a') },
  });
  assert.deepEqual(repo.drawingStatus('lost-response'), result);

  const tamperedDir = makeDir(); seed(tamperedDir);
  const crashing = createCanvasRepository(tamperedDir, {
    fault: stage => { if (stage === 'drawing:canvas') throw new Error('stop'); },
  });
  assert.throws(() => crashing.commitDrawing({
    opId: 'tamper', baseToken: crashing.read().sceneToken,
    elements: [image('a')], files: { a: binary('a') },
  }));
  const journal = JSON.parse(fs.readFileSync(crashing.paths.drawingJournalFile));
  journal.baseToken = '0'.repeat(64);
  fs.writeFileSync(crashing.paths.drawingJournalFile, JSON.stringify(journal));
  const canvasBefore = fs.readFileSync(crashing.paths.canvasFile);
  assert.throws(() => createCanvasRepository(tamperedDir).read(), error =>
    error.code === 'DRAWING_JOURNAL_CORRUPT');
  assert.deepEqual(fs.readFileSync(crashing.paths.canvasFile), canvasBefore);
});
