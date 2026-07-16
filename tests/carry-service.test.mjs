import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCanvasRepository, SceneError, sceneToken } from '../server/canvas-repository.mjs';

const dirs = [];
const fresh = options => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-carry-'));
  dirs.push(dir);
  const repo = createCanvasRepository(dir, options);
  repo.mutate(scene => {
    scene.canvas.boards = [{ id: 'b1', x: 10.25, y: 20.5, w: 200, h: 100 }];
    scene.canvas.drawing = [
      { id: 'shape', x: 20.5, y: 30.25, width: 20, height: 20 },
      { id: 'other', x: 400, y: 400, width: 20, height: 20 },
    ];
    scene.layout['district:alpha'] = { x: 5, y: 6, w: 300, h: 200 };
  });
  return { dir, repo };
};
test.after(() => dirs.forEach(dir => fs.rmSync(dir, { recursive: true, force: true })));

const command = (repo, overrides = {}) => ({
  opId: 'op-1', baseToken: repo.read().sceneToken, containerId: 'board:b1',
  from: { x: 10.25, y: 20.5 }, to: { x: 15.75, y: 30.25 }, anchorIds: ['shape'],
  ...overrides,
});
const batchCommand = (repo, overrides = {}) => ({
  opId: 'batch-1',
  baseToken: repo.read().sceneToken,
  layout: { '/member': { d: 'board:b1' } },
  moves: [
    {
      containerId: 'board:b1',
      from: { x: 10.25, y: 20.5 },
      to: { x: 15.75, y: 30.25 },
      anchorIds: ['shape'],
    },
    {
      containerId: 'district:alpha',
      from: { x: 5, y: 6 },
      to: { x: 3, y: 9 },
      anchorIds: ['other'],
    },
  ],
  ...overrides,
});

test('scene token is canonical, opaque and rejects non-finite persisted values', () => {
  assert.equal(
    sceneToken({ canvas: { drawing: [], notes: [], boards: [], edges: [], z: -0 }, layout: { b: 2, a: 1 } }),
    sceneToken({ layout: { a: 1, b: 2 }, canvas: { z: 0, edges: [], boards: [], notes: [], drawing: [] } }),
  );
  assert.throws(() => sceneToken({ canvas: { drawing: [NaN] }, layout: {} }), /non-finite/);
});

test('board carry is one semantic commit, returns full authority and is idempotent by opId', () => {
  const { repo } = fresh();
  const first = repo.carry(command(repo));
  assert.equal(first.status, 'committed');
  assert.equal(first.container.x, 15.75);
  assert.equal(first.drawing.find(e => e.id === 'shape').x, 26);
  assert.equal(first.drawing.find(e => e.id === 'other').x, 400);
  assert.equal(repo.read().sceneToken, first.sceneToken);
  assert.deepEqual(repo.carry({ ...command(repo), baseToken: 'stale' }), first);
  assert.deepEqual(repo.status('op-1'), first);
});

test('two-client CAS conflict and container deletion cause byte-zero change', () => {
  const { repo } = fresh();
  const stale = command(repo);
  repo.mutate(scene => { scene.canvas.notes.push({ id: 'n', x: 1, y: 2 }); });
  const before = repo.read();
  const canvasBytes = fs.readFileSync(repo.paths.canvasFile);
  const layoutBytes = fs.readFileSync(repo.paths.layoutFile);
  assert.throws(() => repo.carry(stale), error =>
    error instanceof SceneError && error.status === 409 && error.code === 'SCENE_CONFLICT');
  assert.deepEqual(fs.readFileSync(repo.paths.canvasFile), canvasBytes);
  assert.deepEqual(fs.readFileSync(repo.paths.layoutFile), layoutBytes);
  assert.equal(repo.read().sceneToken, before.sceneToken);

  const missing = command(repo, { opId: 'op-missing' });
  repo.mutate(scene => { scene.canvas.boards = []; });
  missing.baseToken = repo.read().sceneToken;
  assert.throws(() => repo.carry(missing), error => error.code === 'CONTAINER_MISSING');
});

test('district prepared crash rolls both documents back on next locked entry', () => {
  let failed = false;
  const { repo } = fresh({
    fault(stage) {
      if (!failed && stage === 'carry:layout') {
        failed = true;
        const error = new Error('simulated crash after canvas');
        throw error;
      }
    },
  });
  const before = repo.read();
  const cmd = command(repo, {
    opId: 'district-rollback', containerId: 'district:alpha',
    from: { x: 5, y: 6 }, to: { x: 9.5, y: 12.25 },
  });
  assert.throws(() => repo.carry(cmd, { districtIds: new Set(['district:alpha']) }), /simulated crash/);
  assert.ok(fs.existsSync(repo.paths.journalFile));
  const recovered = repo.read();
  assert.equal(recovered.sceneToken, before.sceneToken);
  assert.equal(recovered.canvas.drawing.find(e => e.id === 'shape').x, 20.5);
  assert.deepEqual(recovered.layout['district:alpha'], before.layout['district:alpha']);
  assert.equal(fs.existsSync(repo.paths.journalFile), false);
});

test('committed journal rolls forward and restores status when receipt write was lost', () => {
  let failed = false;
  const { repo } = fresh({
    fault(stage) {
      if (!failed && stage === 'carry:receipt') {
        failed = true;
        throw new Error('response/receipt window');
      }
    },
  });
  const cmd = command(repo, { opId: 'receipt-window' });
  assert.throws(() => repo.carry(cmd), /receipt window/);
  const journal = JSON.parse(fs.readFileSync(repo.paths.journalFile, 'utf8'));
  assert.equal(journal.phase, 'committed');
  const status = repo.status('receipt-window');
  assert.equal(status.status, 'committed');
  assert.equal(status.opId, 'receipt-window');
  assert.equal(fs.existsSync(repo.paths.journalFile), false);
});

test('reverse anchor order normalizes movedIds across prepared and committed recovery', () => {
  let preparedFailed = false;
  const prepared = fresh({
    fault(stage) {
      if (!preparedFailed && stage === 'carry:canvas') {
        preparedFailed = true;
        throw new Error('reverse prepared crash');
      }
    },
  });
  const preparedBefore = prepared.repo.read();
  assert.throws(() => prepared.repo.carry(command(prepared.repo, {
    opId: 'reverse-prepared', anchorIds: ['other', 'shape'],
  })), /reverse prepared crash/);
  assert.equal(JSON.parse(fs.readFileSync(prepared.repo.paths.journalFile, 'utf8')).phase, 'prepared');
  const preparedRecovered = prepared.repo.read();
  assert.equal(preparedRecovered.sceneToken, preparedBefore.sceneToken);
  assert.deepEqual(
    preparedRecovered.canvas.drawing.map(element => [element.id, element.x, element.y]),
    preparedBefore.canvas.drawing.map(element => [element.id, element.x, element.y]),
  );
  assert.equal(fs.existsSync(prepared.repo.paths.journalFile), false);

  let committedFailed = false;
  const committed = fresh({
    fault(stage) {
      if (!committedFailed && stage === 'carry:receipt') {
        committedFailed = true;
        throw new Error('reverse committed crash');
      }
    },
  });
  assert.throws(() => committed.repo.carry(command(committed.repo, {
    opId: 'reverse-committed', anchorIds: ['other', 'shape'],
  })), /reverse committed crash/);
  const journal = JSON.parse(fs.readFileSync(committed.repo.paths.journalFile, 'utf8'));
  assert.equal(journal.phase, 'committed');
  assert.deepEqual(journal.result.movedIds, ['shape', 'other']);
  const recovered = committed.repo.status('reverse-committed');
  assert.deepEqual(recovered.movedIds, ['shape', 'other']);
  assert.equal(recovered.drawing.find(element => element.id === 'shape').x, 26);
  assert.equal(recovered.drawing.find(element => element.id === 'other').x, 405.5);
  assert.equal(fs.existsSync(committed.repo.paths.journalFile), false);
});

test('corrupt journal blocks graph reads, mutations, carry and status', () => {
  const { repo } = fresh();
  fs.writeFileSync(repo.paths.journalFile, '{"phase":"prepared"}');
  for (const task of [
    () => repo.read(),
    () => repo.mutate(scene => scene),
    () => repo.carry(command(repo)),
    () => repo.status('op'),
  ]) assert.throws(task, error => error.code === 'JOURNAL_CORRUPT');
});

test('shallow-valid journal corruption and mismatched canonical tokens block before recovery writes', () => {
  const makeCommittedJournal = opId => {
    let failed = false;
    const value = fresh({
      fault(stage) {
        if (!failed && stage === 'carry:receipt') {
          failed = true;
          throw new Error('leave committed journal');
        }
      },
    });
    assert.throws(() => value.repo.carry(command(value.repo, { opId })), /leave committed journal/);
    return value;
  };

  const corruptions = [
    ['container', journal => { journal.result.container.x += 1; }],
    ['token', journal => {
      journal.afterToken = '0'.repeat(64);
      journal.result.sceneToken = journal.afterToken;
    }],
    ['moved-empty', journal => { journal.result.movedIds = []; }],
    ['moved-wrong', journal => { journal.result.movedIds = ['other']; }],
    ['result-drawing', journal => { journal.result.drawing[0].x += 1; }],
    ['result-extra', journal => { journal.result.extra = true; }],
    ['before-layout', journal => { journal.phase = 'prepared'; journal.before.layout = []; }],
    ['after-drawing', journal => { journal.after.canvas.drawing = {}; }],
  ];
  for (const [name, damage] of corruptions) {
    const { repo } = makeCommittedJournal(`corrupt-${name}`);
    const journal = JSON.parse(fs.readFileSync(repo.paths.journalFile, 'utf8'));
    damage(journal);
    fs.writeFileSync(repo.paths.journalFile, JSON.stringify(journal));
    const canvasBytes = fs.readFileSync(repo.paths.canvasFile);
    const layoutBytes = fs.readFileSync(repo.paths.layoutFile);
    assert.throws(() => repo.status(`corrupt-${name}`), error => error.code === 'JOURNAL_CORRUPT', name);
    assert.deepEqual(fs.readFileSync(repo.paths.canvasFile), canvasBytes);
    assert.deepEqual(fs.readFileSync(repo.paths.layoutFile), layoutBytes);
  }
});

test('receipt and scene documents reject shallow-valid schema damage without changing scene bytes', () => {
  for (const [name, damage] of [
    ['extra', receipt => { receipt.unexpected = true; }],
    ['result-extra', receipt => { receipt.result.unexpected = true; }],
    ['movedIds', receipt => { receipt.result.movedIds = ['missing']; }],
    ['token', receipt => { receipt.result.sceneToken = 'not-a-token'; }],
  ]) {
    const { repo } = fresh();
    const result = repo.carry(command(repo, { opId: `strict-receipt-${name}` }));
    const receiptPath = path.join(repo.paths.receiptsDir, fs.readdirSync(repo.paths.receiptsDir)[0]);
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    damage(receipt);
    fs.writeFileSync(receiptPath, JSON.stringify(receipt));
    const canvasBytes = fs.readFileSync(repo.paths.canvasFile);
    const layoutBytes = fs.readFileSync(repo.paths.layoutFile);
    assert.throws(() => repo.status(result.opId), error => error.code === 'RECEIPT_CORRUPT', name);
    assert.deepEqual(fs.readFileSync(repo.paths.canvasFile), canvasBytes);
    assert.deepEqual(fs.readFileSync(repo.paths.layoutFile), layoutBytes);
  }

  const { repo } = fresh();
  const canvasBytes = fs.readFileSync(repo.paths.canvasFile);
  fs.writeFileSync(repo.paths.layoutFile, '[]');
  assert.throws(() => repo.read(), error => error.code === 'SCENE_CORRUPT');
  assert.deepEqual(fs.readFileSync(repo.paths.canvasFile), canvasBytes);
});

test('first durable carry write failure leaves scene unchanged', () => {
  let failed = false;
  const { repo } = fresh({
    fault(stage) {
      if (!failed && stage === 'carry:prepared') {
        failed = true;
        throw new Error('disk full');
      }
    },
  });
  const before = repo.read();
  assert.throws(() => repo.carry(command(repo)), /disk full/);
  assert.equal(repo.read().sceneToken, before.sceneToken);
  assert.equal(fs.existsSync(repo.paths.journalFile), false);
});

test('ordinary scene mutation advances token under the same lock and status unknown never replays', () => {
  const { repo } = fresh();
  const before = repo.read().sceneToken;
  const changed = repo.mutate(scene => {
    scene.layout.extra = { x: 1.25, y: 2.5 };
    return 'saved';
  });
  assert.equal(changed.result, 'saved');
  assert.notEqual(changed.sceneToken, before);
  assert.deepEqual(repo.status('never-seen'), { status: 'unknown', opId: 'never-seen' });
  assert.equal(repo.read().sceneToken, changed.sceneToken);
});

test('batch carry replaces layout and moves board plus district anchors in one idempotent receipt', () => {
  const { repo } = fresh();
  const first = repo.batchCarry(batchCommand(repo), { districtIds: new Set(['district:alpha']) });
  assert.equal(first.status, 'committed');
  assert.deepEqual(first.layout, { '/member': { d: 'board:b1' } });
  assert.deepEqual(first.movedIds, ['shape', 'other']);
  assert.equal(first.drawing.find(element => element.id === 'shape').x, 26);
  assert.equal(first.drawing.find(element => element.id === 'other').x, 398);
  assert.equal(repo.read().sceneToken, first.sceneToken);
  assert.deepEqual(repo.batchCarry({ ...batchCommand(repo), baseToken: 'stale' }), first);
  assert.deepEqual(repo.status(first.opId), first);

  const zero = repo.batchCarry(batchCommand(repo, {
    opId: 'batch-zero',
    baseToken: first.sceneToken,
    layout: first.layout,
    moves: [{
      containerId: 'board:b1',
      from: { x: 0, y: 0 },
      to: { x: 0, y: 0 },
      anchorIds: ['shape'],
    }],
  }));
  assert.deepEqual(zero.movedIds, []);
  assert.equal(zero.sceneToken, first.sceneToken);
});

test('batch stale token and missing anchors make byte-zero changes', () => {
  const { repo } = fresh();
  const stale = batchCommand(repo);
  repo.mutate(scene => { scene.canvas.notes.push({ id: 'later', x: 1, y: 2 }); });
  const canvasBytes = fs.readFileSync(repo.paths.canvasFile);
  const layoutBytes = fs.readFileSync(repo.paths.layoutFile);
  assert.throws(() => repo.batchCarry(stale), error =>
    error instanceof SceneError && error.status === 409 && error.code === 'SCENE_CONFLICT');
  assert.deepEqual(fs.readFileSync(repo.paths.canvasFile), canvasBytes);
  assert.deepEqual(fs.readFileSync(repo.paths.layoutFile), layoutBytes);

  const missing = batchCommand(repo, {
    opId: 'batch-missing',
    baseToken: repo.read().sceneToken,
    moves: [{
      containerId: 'board:b1',
      from: { x: 0, y: 0 },
      to: { x: 1, y: 1 },
      anchorIds: ['absent'],
    }],
  });
  assert.throws(() => repo.batchCarry(missing), error => error.code === 'ANCHOR_MISSING');
  assert.deepEqual(fs.readFileSync(repo.paths.canvasFile), canvasBytes);
  assert.deepEqual(fs.readFileSync(repo.paths.layoutFile), layoutBytes);
});

test('batch prepared crash rolls both documents back and committed response loss rolls forward', () => {
  let preparedFailed = false;
  const prepared = fresh({
    fault(stage) {
      if (!preparedFailed && stage === 'batch-carry:layout') {
        preparedFailed = true;
        throw new Error('batch layout crash');
      }
    },
  });
  const before = prepared.repo.read();
  assert.throws(() => prepared.repo.batchCarry(
    batchCommand(prepared.repo, { opId: 'batch-prepared' }),
    { districtIds: new Set(['district:alpha']) },
  ), /batch layout crash/);
  assert.equal(JSON.parse(fs.readFileSync(prepared.repo.paths.journalFile, 'utf8')).phase, 'prepared');
  assert.equal(prepared.repo.read().sceneToken, before.sceneToken);
  assert.equal(fs.existsSync(prepared.repo.paths.journalFile), false);

  let committedFailed = false;
  const committed = fresh({
    fault(stage) {
      if (!committedFailed && stage === 'batch-carry:receipt') {
        committedFailed = true;
        throw new Error('batch response lost');
      }
    },
  });
  assert.throws(() => committed.repo.batchCarry(
    batchCommand(committed.repo, { opId: 'batch-committed' }),
    { districtIds: new Set(['district:alpha']) },
  ), /batch response lost/);
  const journal = JSON.parse(fs.readFileSync(committed.repo.paths.journalFile, 'utf8'));
  assert.equal(journal.phase, 'committed');
  const status = committed.repo.status('batch-committed');
  assert.equal(status.status, 'committed');
  assert.deepEqual(status.layout, { '/member': { d: 'board:b1' } });
  assert.equal(fs.existsSync(committed.repo.paths.journalFile), false);
});

test('batch undo is a new CAS command with reverse moves, not a stale snapshot restore', () => {
  const { repo } = fresh();
  const before = repo.read();
  const forward = repo.batchCarry(
    batchCommand(repo, { opId: 'batch-forward' }),
    { districtIds: new Set(['district:alpha']) },
  );
  const reverseMoves = forward.moves.map(move => ({
    ...move,
    from: move.to,
    to: move.from,
  }));
  const undo = repo.batchCarry({
    opId: 'batch-undo',
    baseToken: forward.sceneToken,
    layout: before.layout,
    moves: reverseMoves,
  }, { districtIds: new Set(['district:alpha']) });
  assert.notEqual(undo.opId, forward.opId);
  assert.deepEqual(undo.layout, before.layout);
  assert.deepEqual(undo.drawing, before.canvas.drawing);
  assert.equal(repo.read().sceneToken, before.sceneToken);
});

test('damaged batch committed journal blocks recovery before any scene write', () => {
  let failed = false;
  const { repo } = fresh({
    fault(stage) {
      if (!failed && stage === 'batch-carry:receipt') {
        failed = true;
        throw new Error('leave batch journal');
      }
    },
  });
  assert.throws(() => repo.batchCarry(
    batchCommand(repo, { opId: 'batch-corrupt' }),
    { districtIds: new Set(['district:alpha']) },
  ), /leave batch journal/);
  const journal = JSON.parse(fs.readFileSync(repo.paths.journalFile, 'utf8'));
  journal.result.layout['/member'].d = 'board:tampered';
  fs.writeFileSync(repo.paths.journalFile, JSON.stringify(journal));
  const canvasBytes = fs.readFileSync(repo.paths.canvasFile);
  const layoutBytes = fs.readFileSync(repo.paths.layoutFile);
  assert.throws(() => repo.status('batch-corrupt'), error => error.code === 'JOURNAL_CORRUPT');
  assert.deepEqual(fs.readFileSync(repo.paths.canvasFile), canvasBytes);
  assert.deepEqual(fs.readFileSync(repo.paths.layoutFile), layoutBytes);
});
