import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCanvasRepository, SceneError } from '../server/canvas-repository.mjs';
import {
  createDrawingDraftCoordinator, createDrawingDraftStore, drawingDraftClosureFingerprint,
} from '../web/src/canvas/drawing-draft-store.js';

const dirs = [];
test.after(() => dirs.forEach(dir => fs.rmSync(dir, { recursive: true, force: true })));
const fresh = options => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-drawing-'));
  dirs.push(dir);
  return { dir, repo: createCanvasRepository(dir, options) };
};
const file = (id, extra = {}) => ({
  id, mimeType: 'image/png', dataURL: `data:image/png;base64,${id}`, created: 1, ...extra,
});
const image = id => ({ id: `image-${id}`, type: 'image', fileId: id, x: 1, y: 2 });
const rect = (id, x = 0) => ({ id, type: 'rectangle', x, y: 0, width: 20, height: 20 });
const command = (repo, overrides = {}) => ({
  opId: 'draw-1',
  baseToken: repo.read().sceneToken,
  elements: [rect('shape')],
  files: {},
  ...overrides,
});
const bytes = repo => ({
  canvas: fs.existsSync(repo.paths.canvasFile) ? fs.readFileSync(repo.paths.canvasFile) : null,
  files: fs.existsSync(repo.paths.drawingFilesFile) ? fs.readFileSync(repo.paths.drawingFilesFile) : null,
});

test('drawing commit is CAS guarded, idempotent by opId+hash and status owns the same result', () => {
  const { repo } = fresh();
  const firstCommand = command(repo);
  const first = repo.commitDrawing(firstCommand);
  assert.equal(first.status, 'committed');
  assert.deepEqual(first.drawing, [rect('shape')]);
  assert.deepEqual(repo.drawingStatus('draw-1'), first);
  assert.deepEqual(repo.commitDrawing(firstCommand), first);
  assert.throws(
    () => repo.commitDrawing({ ...firstCommand, elements: [rect('different')] }),
    error => error instanceof SceneError && error.code === 'OP_ID_REUSED',
  );
});

test('stale token and missing image reference are byte-zero failures before any asset write', () => {
  const { repo } = fresh();
  const stale = command(repo, {
    opId: 'stale',
    elements: [image('photo')],
    files: { photo: file('photo') },
  });
  repo.mutate(scene => { scene.canvas.notes.push({ id: 'note', x: 1, y: 2 }); });
  const beforeStale = bytes(repo);
  assert.throws(() => repo.commitDrawing(stale), error => error.code === 'SCENE_CONFLICT');
  assert.deepEqual(bytes(repo), beforeStale);

  const beforeMissing = bytes(repo);
  assert.throws(
    () => repo.commitDrawing(command(repo, {
      opId: 'missing', elements: [image('missing')], files: {},
    })),
    error => error.code === 'DRAWING_FILE_MISSING',
  );
  assert.deepEqual(bytes(repo), beforeMissing);
});

test('assets are durable before references; receipt replay keeps full files local and immutable IDs reject content replacement', () => {
  const { repo } = fresh();
  const added = repo.commitDrawing(command(repo, {
    opId: 'asset-add',
    elements: [image('photo')],
    files: { photo: file('photo') },
  }));
  assert.deepEqual(added.fileIds, ['photo']);
  const canonicalFile = repo.readWithDrawingFiles().drawingFiles.photo;

  const metadataClone = command(repo, {
    opId: 'metadata-clone',
    elements: [{ ...image('photo'), x: 9 }],
    files: { photo: file('photo', { created: 99, lastRetrieved: 100 }) },
  });
  repo.commitDrawing(metadataClone);
  assert.deepEqual(repo.readWithDrawingFiles().drawingFiles.photo, canonicalFile,
    'same binary content must preserve the first canonical metadata');

  assert.throws(() => repo.commitDrawing(command(repo, {
    opId: 'asset-replace',
    elements: [image('photo')],
    files: { photo: { ...file('photo'), dataURL: 'data:image/png;base64,changed' } },
  })), error => error.code === 'DRAWING_FILE_IMMUTABLE');
});

test('asset-only crash is a safe orphan and retry completes without duplicate content', () => {
  let failed = false;
  const { repo } = fresh({
    fault(stage) {
      if (!failed && stage === 'drawing:prepared') {
        failed = true;
        throw new Error('prepared unavailable');
      }
    },
  });
  const value = command(repo, {
    opId: 'asset-orphan',
    elements: [image('photo')],
    files: { photo: file('photo') },
  });
  assert.throws(() => repo.commitDrawing(value), /prepared unavailable/);
  assert.equal(fs.existsSync(repo.paths.drawingJournalFile), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(repo.paths.drawingFilesFile)), { photo: file('photo') });
  assert.deepEqual(repo.read().canvas.drawing, []);
  const result = repo.commitDrawing(value);
  assert.equal(result.status, 'committed');
  assert.deepEqual(repo.readWithDrawingFiles().drawingFiles, { photo: file('photo') });
});

for (const stage of ['drawing:canvas', 'drawing:committed']) {
  test(`${stage} failure leaves prepared journal and recovery restores before`, () => {
    let failed = false;
    const { repo } = fresh({
      fault(current) {
        if (!failed && current === stage) {
          failed = true;
          throw new Error(`fault ${stage}`);
        }
      },
    });
    const before = repo.read();
    assert.throws(() => repo.commitDrawing(command(repo, {
      opId: stage,
      elements: [image('photo')],
      files: { photo: file('photo') },
    })), new RegExp(stage));
    const rawJournal = fs.readFileSync(repo.paths.drawingJournalFile, 'utf8');
    assert.equal(rawJournal.includes('base64'), false, 'durable journal must not contain BinaryFiles');
    assert.equal(JSON.parse(rawJournal).phase, 'prepared');
    const recovered = repo.readWithDrawingFiles();
    assert.equal(recovered.sceneToken, before.sceneToken);
    assert.deepEqual(recovered.canvas.drawing, []);
    assert.deepEqual(recovered.drawingFiles, {});
    assert.equal(fs.existsSync(repo.paths.drawingJournalFile), false);
  });
}

test('receipt fault leaves committed journal; status recovers forward before answering', () => {
  let failed = false;
  const { repo } = fresh({
    fault(stage) {
      if (!failed && stage === 'drawing:receipt') {
        failed = true;
        throw new Error('lost receipt response');
      }
    },
  });
  assert.throws(() => repo.commitDrawing(command(repo, {
    opId: 'receipt-window',
    elements: [image('photo')],
    files: { photo: file('photo') },
  })), /lost receipt response/);
  assert.equal(JSON.parse(fs.readFileSync(repo.paths.drawingJournalFile)).phase, 'committed');
  const status = repo.drawingStatus('receipt-window');
  assert.equal(status.status, 'committed');
  assert.deepEqual(status.fileIds, ['photo']);
  assert.equal(fs.existsSync(repo.paths.drawingJournalFile), false);
  assert.deepEqual(repo.readWithDrawingFiles().canvas.drawing, [image('photo')]);
});

test('receipt is authoritative when journal cleanup fails, and later status removes the residue', () => {
  const { repo } = fresh({
    fault(stage) {
      if (stage === 'drawing:cleanup') throw new Error('cleanup unavailable');
    },
  });
  const result = repo.commitDrawing(command(repo, { opId: 'cleanup-window' }));
  assert.equal(result.status, 'committed');
  assert.equal(fs.existsSync(repo.paths.drawingJournalFile), true);
  assert.deepEqual(repo.drawingStatus('cleanup-window'), result);
  assert.equal(fs.existsSync(repo.paths.drawingJournalFile), false);
});

test('prune failure is non-fatal, leaves only an orphan, and a later same-lock graph read retries cleanup', () => {
  let failPrune = false;
  const { repo } = fresh({
    fault(stage) {
      if (failPrune && stage === 'drawing:prune') throw new Error('prune unavailable');
    },
  });
  repo.commitDrawing(command(repo, {
    opId: 'add-for-prune',
    elements: [image('photo')],
    files: { photo: file('photo') },
  }));
  failPrune = true;
  const removed = repo.commitDrawing(command(repo, {
    opId: 'remove-for-prune',
    elements: [rect('shape')],
    files: {},
  }));
  assert.equal(removed.status, 'committed');
  assert.ok(JSON.parse(fs.readFileSync(repo.paths.drawingFilesFile)).photo);
  failPrune = false;
  assert.deepEqual(repo.readWithDrawingFiles().drawingFiles, {});
});

test('corrupt drawing files and journal block graph/commit/status instead of being treated as empty', () => {
  const filesCase = fresh();
  fs.writeFileSync(filesCase.repo.paths.drawingFilesFile, '{"bad":{"id":"bad","dataURL":"https://remote"}}');
  assert.throws(() => filesCase.repo.readWithDrawingFiles(), error => error.code === 'DRAWING_FILES_CORRUPT');
  assert.throws(() => filesCase.repo.commitDrawing(command(filesCase.repo)), error => error.code === 'DRAWING_FILES_CORRUPT');

  const journalCase = fresh();
  fs.writeFileSync(journalCase.repo.paths.drawingJournalFile, '{"kind":"drawing"}');
  for (const operation of [
    () => journalCase.repo.read(),
    () => journalCase.repo.readWithDrawingFiles(),
    () => journalCase.repo.commitDrawing(command(journalCase.repo)),
    () => journalCase.repo.drawingStatus('unknown'),
  ]) assert.throws(operation, error => error.code === 'DRAWING_JOURNAL_CORRUPT');
});

const memoryDraftAdapter = () => {
  let value = null;
  return {
    get: async () => structuredClone(value),
    put: async record => { value = structuredClone(record); },
    deleteIfIdentity: async identity => {
      if (value?.requestId !== identity?.requestId || value?.epoch !== identity?.epoch) return false;
      value = null;
      return true;
    },
    value: () => structuredClone(value),
  };
};

test('draft crash recovery debounces to latest seq and requires exact sceneToken plus closure fingerprint', async () => {
  const adapter = memoryDraftAdapter();
  let timer;
  const store = createDrawingDraftStore({
    adapter,
    debounceMs: 50,
    setTimer: callback => { timer = callback; return 1; },
    clearTimer: () => { timer = null; },
  });
  const closureFingerprint = drawingDraftClosureFingerprint({
    kind: 'selection', targetId: 'shape', originalIds: ['shape'], anchorIndex: 0,
  });
  const baselineSnapshot = { elements: [rect('base')], files: {} };
  store.begin({
    requestId: 'request-a', sceneToken: 'token-a', closureFingerprint, baselineSnapshot,
    mergeDraft: draft => draft,
  });
  assert.equal(store.schedule({ elements: [rect('first')], files: {} }), 1);
  assert.equal(store.schedule({ elements: [rect('latest', 9)], files: {} }), 2);
  await timer();
  await store.idle();
  assert.equal(adapter.value().seq, 2);
  assert.equal(adapter.value().draft.elements[0].x, 9);

  const afterCrash = createDrawingDraftStore({ adapter });
  const restored = await afterCrash.recover({ sceneToken: 'token-a', closureFingerprint, baselineSnapshot });
  assert.equal(restored.status, 'restored');
  assert.equal(restored.record.requestId, 'request-a');
  assert.equal((await afterCrash.recover({
    sceneToken: 'stale-token', closureFingerprint, baselineSnapshot,
  })).status, 'conflict');
  assert.equal((await afterCrash.recover({
    sceneToken: 'token-a', closureFingerprint: 'other', baselineSnapshot,
  })).status, 'conflict');
});

test('draft request guard prevents late A clear/write from deleting or replacing active B', async () => {
  const adapter = memoryDraftAdapter();
  const store = createDrawingDraftStore({ adapter, debounceMs: 0 });
  const baselineSnapshot = { elements: [], files: {} };
  const A = store.begin({
    requestId: 'A', sceneToken: 'token', closureFingerprint: 'A', baselineSnapshot,
    mergeDraft: draft => draft,
  });
  await store.flush({ elements: [rect('A')], files: {} });
  const B = store.begin({
    requestId: 'B', sceneToken: 'token', closureFingerprint: 'B', baselineSnapshot,
    mergeDraft: draft => draft,
  });
  await store.flush({ elements: [rect('B')], files: {} });
  assert.equal(await store.clear(A), false);
  assert.equal(adapter.value().requestId, 'B');
  assert.equal(adapter.value().draft.elements[0].id, 'B');
  assert.equal(await store.clear(B), true);
  assert.equal(adapter.value(), null);
});

test('recovered requestId stays the conditional-delete owner through a successful commit', async () => {
  const adapter = memoryDraftAdapter();
  const beforeCrash = createDrawingDraftStore({ adapter });
  const baselineSnapshot = { elements: [], files: {} };
  beforeCrash.begin({
    requestId: 'recover-me', sceneToken: 'token', closureFingerprint: 'closure', baselineSnapshot,
    mergeDraft: draft => draft,
  });
  await beforeCrash.flush({ elements: [rect('draft')], files: {} });

  const afterCrash = createDrawingDraftStore({ adapter });
  const recovery = await afterCrash.recover({
    sceneToken: 'token', closureFingerprint: 'closure', baselineSnapshot,
  });
  assert.equal(recovery.status, 'restored');
  const recovered = recovery.record;
  const identity = afterCrash.begin({
    requestId: recovered.requestId, sceneToken: recovered.sceneToken,
    closureFingerprint: recovered.closureFingerprint, baselineSnapshot,
    mergeDraft: draft => draft, epoch: recovered.epoch, seq: recovered.seq,
  });
  assert.equal(await afterCrash.clear(identity), true);
  assert.equal(adapter.value(), null);
});

test('current baseline equal to merged fingerprint treats old draft as committed and removes it', async () => {
  const adapter = memoryDraftAdapter();
  const beforeCrash = createDrawingDraftStore({ adapter });
  const baselineSnapshot = { elements: [], files: {} };
  const mergedSnapshot = { elements: [rect('saved')], files: {} };
  beforeCrash.begin({
    requestId: 'saved', sceneToken: 'old-token', closureFingerprint: 'closure', baselineSnapshot,
    mergeDraft: draft => draft,
  });
  await beforeCrash.flush(mergedSnapshot);

  const afterCrash = createDrawingDraftStore({ adapter });
  const recovery = await afterCrash.recover({
    sceneToken: 'new-token', closureFingerprint: 'other', baselineSnapshot: mergedSnapshot,
  });
  assert.equal(recovery.status, 'committed');
  assert.equal(adapter.value(), null);
});

test('draft IndexedDB/quota failure is non-fatal and reports only once', async () => {
  let warnings = 0;
  const store = createDrawingDraftStore({
    adapter: {
      get: async () => null,
      put: async () => { throw new Error('quota'); },
      deleteIfRequest: async () => { throw new Error('unavailable'); },
    },
    onError: () => { warnings++; },
  });
  store.begin({
    requestId: 'A', sceneToken: 'token', closureFingerprint: 'closure',
    baselineSnapshot: { elements: [], files: {} }, mergeDraft: draft => draft,
  });
  await store.flush({ elements: [rect('one')], files: {} });
  await store.flush({ elements: [rect('two')], files: {} });
  await store.clear({ requestId: 'A', epoch: 1 });
  assert.equal(warnings, 1);
});

test('draft coordinator gates hydration, preserves conflicts, conditionally clears success and rebases closing failure locally', async () => {
  const adapter = memoryDraftAdapter();
  const coordinator = createDrawingDraftCoordinator(createDrawingDraftStore({ adapter, debounceMs: 0 }));
  const baselineSnapshot = { elements: [rect('base')], files: {} };
  const identity = coordinator.begin({
    requestId: 'opening', sceneToken: 'scene-1', closureFingerprint: 'closure-1', baselineSnapshot,
    mergeDraft: draft => draft,
  });
  const hydration = { elements: [rect('hydrated')], files: {} };
  assert.equal(coordinator.schedule(hydration), 0, 'onReady 前不得写');
  assert.equal(coordinator.markHydrated(identity), true);
  assert.equal(coordinator.schedule(hydration), 0, '触发 onReady 的同一个 hydration change 不得写');
  await coordinator.idle();
  assert.equal(adapter.value(), null);

  const changed = { elements: [rect('changed')], files: {} };
  assert.equal(coordinator.schedule(changed), 1);
  await coordinator.flush();
  assert.equal(adapter.value().draft.elements[0].id, 'changed');
  const conflict = await coordinator.recover({
    sceneToken: 'scene-2', closureFingerprint: 'closure-1', baselineSnapshot,
  });
  assert.equal(conflict.status, 'conflict');
  assert.equal(adapter.value().requestId, 'opening', '冲突必须保留原 journal');

  const newer = coordinator.begin({
    requestId: 'newer', sceneToken: 'scene-2', closureFingerprint: 'closure-2', baselineSnapshot,
    mergeDraft: draft => draft,
  });
  coordinator.markHydrated(newer);
  coordinator.schedule(hydration);
  await coordinator.flush(changed);
  assert.equal(await coordinator.clear(identity), false, '旧 closing success 不得清新 request');
  assert.equal(adapter.value().requestId, 'newer');

  let mergeCalls = 0;
  const advancedBaseline = { elements: [rect('committed')], files: {} };
  const rebased = await coordinator.rebaseAfterClosingFailure({
    requestId: 'retry', sceneToken: 'scene-3', closureFingerprint: 'advanced-closure',
    baselineSnapshot: advancedBaseline,
    mergeDraft: draft => { mergeCalls++; return draft; },
  }, { elements: [rect('retry-draft')], files: {} });
  assert.equal(rebased.requestId, 'retry');
  assert.equal(adapter.value().sceneToken, 'scene-3');
  assert.equal(adapter.value().closureFingerprint, 'advanced-closure');
  assert.equal(adapter.value().draft.elements[0].id, 'retry-draft');
  const beforeLocalFlush = mergeCalls;
  await coordinator.flush();
  assert.equal(mergeCalls, beforeLocalFlush,
    'pagehide/hidden 对应的无参 flush 只排空本地 journal，不触发提交或重算');
});

test('draft hydration skip only covers the synchronous ready-triggering change in both API/change orders', async () => {
  const adapter = memoryDraftAdapter();
  const coordinator = createDrawingDraftCoordinator(createDrawingDraftStore({ adapter, debounceMs: 0 }));
  const input = requestId => ({
    requestId, sceneToken: 'scene', closureFingerprint: 'closure',
    baselineSnapshot: { elements: [], files: {} },
    mergeDraft: draft => draft,
  });
  const hydration = { elements: [rect('hydration')], files: {} };
  const user = { elements: [rect('user')], files: {} };

  // API 先到：随后同一 onChange stack 内 onReady→onDraftChange，必须只跳过 hydration。
  let identity = coordinator.begin(input('api-first'));
  coordinator.markHydrated(identity);
  assert.equal(coordinator.schedule(hydration), 0);
  assert.equal(coordinator.schedule(user), 1);
  await coordinator.flush();
  assert.equal(adapter.value().draft.elements[0].id, 'user');

  // change 先到：API 后到只触发 onReady，没有同 stack onDraftChange；microtask 后首笔用户 change 必须可写。
  identity = coordinator.begin(input('change-first'));
  coordinator.markHydrated(identity);
  await Promise.resolve();
  assert.equal(coordinator.schedule(user), 1);
  await coordinator.flush();
  assert.equal(adapter.value().requestId, 'change-first');
  assert.equal(adapter.value().draft.elements[0].id, 'user');
});

test('draft late A put and clear cannot overwrite or delete active B across requestId/epoch/seq', async () => {
  let value = null;
  let releaseA;
  let enteredA;
  const aEntered = new Promise(resolve => { enteredA = resolve; });
  const aGate = new Promise(resolve => { releaseA = resolve; });
  const adapter = {
    async get() { return structuredClone(value); },
    async put(record) {
      if (record.requestId === 'A') {
        enteredA();
        await aGate;
      }
      value = structuredClone(record);
    },
    async deleteIfIdentity(identity) {
      if (value?.requestId !== identity?.requestId || value?.epoch !== identity?.epoch) return false;
      value = null;
      return true;
    },
  };
  const store = createDrawingDraftStore({ adapter, debounceMs: 0 });
  const baselineSnapshot = { elements: [], files: {} };
  const A = store.begin({
    requestId: 'A', sceneToken: 'scene-A', closureFingerprint: 'closure-A', baselineSnapshot,
    mergeDraft: draft => draft,
  });
  const writingA = store.flush({ elements: [rect('A')], files: {} });
  await aEntered;
  const B = store.begin({
    requestId: 'B', sceneToken: 'scene-B', closureFingerprint: 'closure-B', baselineSnapshot,
    mergeDraft: draft => draft,
  });
  const writingB = store.flush({ elements: [rect('B')], files: {} });
  const lateClearA = store.clear(A);
  releaseA();
  await Promise.all([writingA, writingB, lateClearA]);
  assert.deepEqual(
    { requestId: value.requestId, epoch: value.epoch, seq: value.seq, id: value.draft.elements[0].id },
    { requestId: 'B', epoch: B.epoch, seq: 1, id: 'B' },
  );
});
