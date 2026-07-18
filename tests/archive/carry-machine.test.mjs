import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import {
  applyBatchCarry, applyCarry, computeAnchorIds, createCarryLedger, createCarryState, reduceCarry,
  validateBatchCarryCommand, validateCarryCommand,
} from '../shared/canvas-carry.mjs';
import {
  commitBatchWithReceipt, createBatchCarryBridge, createContainerCarryController,
  createSceneMutationQueue, executeBatchArrange, planBatchCarry,
} from '../web/src/canvas/container-carry.js';

const begin = (anchorIds = ['shape']) => ({
  type: 'BEGIN', txId: 'tx-1', opId: 'op-1', baseToken: 'token-1',
  containerId: 'board:b1', from: { x: 10.25, y: 20.5 }, anchorIds,
});

test('painted ownership prefers the smaller overlap and bound text inherits host', () => {
  const elements = [
    { id: 'host', x: 20, y: 20, width: 20, height: 20, boundElements: [{ id: 'label', type: 'text' }] },
    { id: 'label', type: 'text', containerId: 'host', x: 200, y: 200, width: 30, height: 10 },
    { id: 'outer', x: 2, y: 2, width: 5, height: 5 },
  ];
  const owners = computeAnchorIds(elements, [
    { id: 'large', x: 0, y: 0, w: 100, h: 100 },
    { id: 'small', x: 10, y: 10, w: 40, h: 40 },
  ]);
  assert.deepEqual(owners.get('small'), ['host', 'label']);
  assert.deepEqual(owners.get('large'), ['outer']);
});

test('only true bound text inherits hosts and cross-container arrows stay order independent', () => {
  const elements = [
    {
      id: 'host-a', type: 'rectangle', x: 20, y: 20, width: 20, height: 20,
      boundElements: [{ id: 'label-a', type: 'text' }, { id: 'cross-arrow', type: 'arrow' }],
    },
    { id: 'label-a', type: 'text', containerId: 'host-a', x: 140, y: 140, width: 30, height: 10 },
    {
      id: 'host-b', type: 'ellipse', x: 220, y: 20, width: 20, height: 20,
      boundElements: [{ id: 'label-b', type: 'text' }, { id: 'cross-arrow', type: 'arrow' }],
    },
    { id: 'label-b', type: 'text', containerId: 'host-b', x: 140, y: 160, width: 30, height: 10 },
    {
      id: 'cross-arrow', type: 'arrow', x: 90, y: 25, width: 120, height: 10,
      startBinding: { elementId: 'host-a' }, endBinding: { elementId: 'host-b' },
    },
  ];
  const containers = [
    { id: 'left', x: 0, y: 0, w: 100, h: 100 },
    { id: 'right', x: 200, y: 0, w: 100, h: 100 },
  ];
  for (const order of [elements, [...elements].reverse()]) {
    const owners = computeAnchorIds(order, containers);
    assert.deepEqual(new Set(owners.get('left')), new Set(['host-a', 'label-a']));
    assert.deepEqual(new Set(owners.get('right')), new Set(['host-b', 'label-b']));
    assert.equal([...owners.values()].flat().includes('cross-arrow'), false);
  }
});

test('applyCarry preserves unrelated references and validates finite semantic protocol', () => {
  const a = { id: 'a', x: 1.5, y: 2.25 };
  const b = { id: 'b', x: 8, y: 9 };
  const moved = applyCarry([a, b], ['a'], 0.5, -1.25);
  assert.deepEqual(moved[0], { id: 'a', x: 2, y: 1 });
  assert.equal(moved[1], b);
  assert.deepEqual(validateCarryCommand({
    opId: 'o', baseToken: 't', containerId: 'board:b',
    from: { x: 0, y: 0 }, to: { x: 1.5, y: 2.5 }, anchorIds: ['a'],
  }).anchorIds, ['a']);
  assert.throws(() => validateCarryCommand({
    opId: 'o', baseToken: 't', containerId: 'b', from: { x: 0, y: 0 },
    to: { x: Infinity, y: 1 }, anchorIds: [],
  }), /coordinates/);
});

test('batch protocol applies distinct deltas once and rejects overlapping authority', () => {
  const command = validateBatchCarryCommand({
    opId: 'batch-1',
    baseToken: 'token-1',
    layout: { '/member': { d: 'board:b1' } },
    moves: [
      {
        containerId: 'board:b1',
        from: { x: 0, y: 0 },
        to: { x: 10, y: 5 },
        anchorIds: ['a'],
      },
      {
        containerId: 'district:alpha',
        from: { x: 100, y: 100 },
        to: { x: 80, y: 130 },
        anchorIds: ['b'],
      },
    ],
  });
  assert.deepEqual(applyBatchCarry([
    { id: 'a', x: 1, y: 2 },
    { id: 'b', x: 3, y: 4 },
    { id: 'c', x: 5, y: 6 },
  ], command.moves), [
    { id: 'a', x: 11, y: 7 },
    { id: 'b', x: -17, y: 34 },
    { id: 'c', x: 5, y: 6 },
  ]);
  assert.throws(() => validateBatchCarryCommand({
    ...command,
    moves: [
      command.moves[0],
      { ...command.moves[1], anchorIds: ['a'] },
    ],
  }), /globally unique/);
});

test('batch planning freezes painted ownership once and gives overlaps to the smallest container', () => {
  const node = (id, x, y, w, h) => ({
    id, type: id.startsWith('board:') ? 'board' : 'district',
    position: { x, y }, width: w, height: h, data: { _w: w, _h: h },
  });
  const before = [
    node('district:large', 0, 0, 200, 200),
    node('board:small', 20, 20, 80, 80),
  ];
  const after = [
    node('district:large', 10, 0, 200, 200),
    node('board:small', 20, 50, 80, 80),
  ];
  const moves = planBatchCarry(before, after, {
    elements: [
      { id: 'overlap', x: 30, y: 30, width: 10, height: 10 },
      { id: 'large-only', x: 150, y: 150, width: 10, height: 10 },
    ],
  });
  assert.deepEqual(moves.map(move => [move.containerId, move.anchorIds]), [
    ['district:large', ['large-only']],
    ['board:small', ['overlap']],
  ]);
  assert.equal(new Set(moves.flatMap(move => move.anchorIds)).size, 2);
});

test('batch response loss adopts only a matching receipt and otherwise reports unknown authority', async () => {
  const command = { opId: 'batch-response' };
  const committed = { status: 'committed', opId: command.opId, sceneToken: 'next' };
  assert.equal(await commitBatchWithReceipt(
    command,
    async () => { throw new Error('response lost'); },
    async () => committed,
  ), committed);
  await assert.rejects(
    commitBatchWithReceipt(
      command,
      async () => { throw new Error('response lost'); },
      async () => { throw new Error('status offline'); },
    ),
    error => error.code === 'AUTHORITY_UNKNOWN' && error.authorityUnknown === true,
  );
  await assert.rejects(
    commitBatchWithReceipt(
      command,
      async () => { throw new Error('response lost'); },
      async () => ({ status: 'unknown', opId: command.opId }),
    ),
    error => error.code === 'AUTHORITY_UNKNOWN',
  );
});

test('multi-delta DOM bridge is idempotent and clears only its owned marker styles', () => {
  const cssBefore = globalThis.CSS;
  globalThis.CSS = { escape: value => value };
  const node = () => {
    const classes = new Set();
    const styles = new Map();
    return {
      classList: {
        add: value => classes.add(value),
        remove: value => classes.delete(value),
        contains: value => classes.has(value),
      },
      style: {
        setProperty: (key, value) => styles.set(key, value),
        removeProperty: key => styles.delete(key),
        getPropertyValue: key => styles.get(key),
      },
    };
  };
  const nodes = { a: [node()], b: [node()] };
  const rootClasses = new Set();
  const root = {
    querySelectorAll: selector => nodes[selector.match(/="([^"]+)"/)?.[1]] || [],
    classList: {
      toggle: (value, on) => on ? rootClasses.add(value) : rootClasses.delete(value),
      remove: value => rootClasses.delete(value),
    },
  };
  try {
    const bridge = createBatchCarryBridge(root);
    assert.equal(bridge.present([
      { from: { x: 0, y: 0 }, to: { x: 10, y: 5 }, anchorIds: ['a'] },
      { from: { x: 20, y: 20 }, to: { x: 15, y: 40 }, anchorIds: ['b'] },
    ]), 2);
    assert.equal(nodes.a[0].style.getPropertyValue('--carry-x'), '10px');
    assert.equal(nodes.b[0].style.getPropertyValue('--carry-y'), '20px');
    bridge.clear();
    bridge.clear();
    assert.equal(bridge.count(), 0);
    assert.equal(nodes.a[0].classList.contains('ink-carry-anchor'), false);
  } finally {
    globalThis.CSS = cssBefore;
  }
});

test('arrange uses the shared synchronous bridge+authority executor and no timer/follow chase', async () => {
  const source = fs.readFileSync(new URL('../web/src/App.jsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /followDrawings|containerRects|setTimeout\s*\([^)]*120/);
  assert.match(source, /executeBatchArrange\(\{[\s\S]*presentBatchCarryResult[\s\S]*setGraph[\s\S]*flush:\s*flushSync/);

  const queue = createSceneMutationQueue();
  queue.adoptAuthority('scene-1');
  const order = [];
  const outcome = await executeBatchArrange({
    queue,
    plan: { layout: { a: { x: 1 } }, moves: [] },
    baseToken: 'scene-1',
    opId: 'batch-shared',
    commit: async command => ({
      status: 'committed', opId: command.opId, sceneToken: 'scene-2',
      layout: command.layout, moves: command.moves, movedIds: [], drawing: [],
    }),
    queryStatus: async () => ({ status: 'unknown' }),
    present: result => {
      order.push(`present:${result.sceneToken}`);
      return Promise.resolve({ status: 'ready' });
    },
    install: result => order.push(`install:${result.sceneToken}`),
    flush: callback => {
      order.push('flush:start');
      callback();
      order.push('flush:end');
    },
  });
  assert.deepEqual(order, [
    'flush:start', 'present:scene-2', 'install:scene-2', 'flush:end',
  ]);
  assert.equal(outcome.presentation.status, 'ready');
});

test('direct carry presents only from committed RF node.position in a layout effect', () => {
  const source = fs.readFileSync(new URL('../web/src/canvas/FlowCanvas.jsx', import.meta.url), 'utf8');
  const dragHandler = source.match(/const onNodeDrag = useCallback\([\s\S]*?const onNodeDragStop = useCallback/)?.[0];
  assert.ok(dragHandler);
  assert.doesNotMatch(dragHandler, /carryControllerRef\.current\?\.move|visibleCarryPosition/);
  assert.doesNotMatch(source, /visibleCarryPosition|activationX|activationY/);
  assert.match(
    source,
    /useLayoutEffect\(\(\) => \{[\s\S]*carryMoveRef\.current[\s\S]*controller\.move\(state\.txId, move\.position\)[\s\S]*controller\.drop\(state\.txId, move\.position\)[\s\S]*\}, \[nodes\]\)/,
  );
});

test('state machine owns tx op and target frame identities', () => {
  let state = createCarryState();
  let step = reduceCarry(state, begin());
  state = step.state;
  assert.equal(state.phase, 'DRAGGING');
  assert.equal(step.commands[0].type, 'MARK');
  assert.equal(reduceCarry(state, { type: 'MOVE', txId: 'old', to: { x: 50, y: 50 } }).state, state);
  step = reduceCarry(state, { type: 'MOVE', txId: 'tx-1', to: { x: 12.25, y: 25.5 } });
  state = step.state;
  assert.deepEqual(step.commands, [{ type: 'PRESENT', txId: 'tx-1', dx: 2, dy: 5 }]);
  step = reduceCarry(state, { type: 'DROP', txId: 'tx-1' });
  state = step.state;
  assert.equal(state.phase, 'COMMITTING');
  assert.equal(step.commands[0].command.opId, 'op-1');
  state = reduceCarry(state, { type: 'COMMIT_ACCEPTED', txId: 'tx-1', opId: 'op-1' }).state;
  state = reduceCarry(state, { type: 'COMMIT_OK', txId: 'tx-1', opId: 'op-1', targetFrameId: 7 }).state;
  assert.equal(state.phase, 'AWAITING_FRAME');
  assert.equal(reduceCarry(state, { type: 'TARGET_FRAME_READY', txId: 'tx-1', targetFrameId: 6 }).state, state);
  const ready = reduceCarry(state, { type: 'TARGET_FRAME_READY', txId: 'tx-1', targetFrameId: 7 });
  assert.equal(ready.state.phase, 'IDLE');
  assert.equal(ready.commands[0].type, 'CLEAR');
});

test('zero/cancel/no-anchor/conflict/retry and response query have explicit terminal behavior', () => {
  let state = reduceCarry(createCarryState(), begin()).state;
  assert.equal(reduceCarry(state, { type: 'ZERO_DROP', txId: 'tx-1' }).state.phase, 'IDLE');
  state = reduceCarry(state, { type: 'DROP', txId: 'tx-1', to: { x: 30, y: 30 } }).state;
  let step = reduceCarry(state, { type: 'RESPONSE_UNKNOWN', txId: 'tx-1', opId: 'op-1' });
  assert.equal(step.state.phase, 'QUERYING_OPERATION');
  assert.equal(step.commands[0].type, 'QUERY_STATUS');
  assert.equal(reduceCarry(step.state, { type: 'OP_UNKNOWN', txId: 'tx-1', opId: 'op-1' }).state.phase, 'CONFLICT_STALE');

  state = reduceCarry(createCarryState(), begin([])).state;
  state = reduceCarry(state, { type: 'MOVE', txId: 'tx-1', to: { x: 11, y: 21 } }).state;
  state = reduceCarry(state, { type: 'DROP', txId: 'tx-1' }).state;
  state = reduceCarry(state, { type: 'COMMIT_ACCEPTED', txId: 'tx-1', opId: 'op-1' }).state;
  step = reduceCarry(state, { type: 'COMMIT_OK', txId: 'tx-1', opId: 'op-1' });
  assert.equal(step.state.phase, 'IDLE');
  assert.equal(step.commands[0].type, 'CLEAR');

  state = reduceCarry(createCarryState(), begin()).state;
  state = reduceCarry(state, { type: 'MOVE', txId: 'tx-1', to: { x: 12, y: 22 } }).state;
  state = reduceCarry(state, { type: 'DROP', txId: 'tx-1' }).state;
  state = reduceCarry(state, { type: 'COMMIT_ACCEPTED', txId: 'tx-1', opId: 'op-1' }).state;
  state = reduceCarry(state, { type: 'COMMIT_OK', txId: 'tx-1', targetFrameId: 3 }).state;
  state = reduceCarry(state, { type: 'FINAL_FRAME_ERROR', txId: 'tx-1', targetFrameId: 3 }).state;
  assert.equal(state.phase, 'RETRYABLE_PAINT');
  assert.equal(reduceCarry(state, { type: 'RETRY', txId: 'tx-1' }).commands[0].type, 'RETRY_FRAME');
});

test('ledger is bounded and coalesces MOVE while preserving transitions', () => {
  const ledger = createCarryLedger(4);
  let from = createCarryState();
  let to = reduceCarry(from, begin()).state;
  ledger.append(begin(), from, to);
  from = to;
  for (let i = 0; i < 20; i++) {
    const event = { type: 'MOVE', txId: 'tx-1', to: { x: i, y: i } };
    to = reduceCarry(from, event).state;
    ledger.append(event, from, to);
    from = to;
  }
  assert.equal(ledger.read().length, 2);
  assert.throws(() => ledger.read().push({}), /extensible|read only|object is not extensible/i);
});

test('800-element BEGIN is bounded and MOVE emits one O(1) presentation command', () => {
  const elements = Array.from({ length: 800 }, (_, i) => ({
    id: `e-${i}`, x: i % 40 * 10, y: Math.floor(i / 40) * 10, width: 5, height: 5,
  }));
  const started = performance.now();
  const anchors = computeAnchorIds(elements, [{ id: 'board:b', x: 0, y: 0, w: 500, h: 500 }]).get('board:b');
  const elapsed = performance.now() - started;
  assert.equal(anchors.length, 800);
  assert.ok(elapsed < 50, `ownership took ${elapsed}ms`);
  const state = reduceCarry(createCarryState(), begin(anchors)).state;
  const step = reduceCarry(state, { type: 'MOVE', txId: 'tx-1', to: { x: 20, y: 30 } });
  assert.equal(step.commands.length, 1);
  assert.equal(step.commands[0].type, 'PRESENT');
});

test('scene mutation queue serializes request, response application, and recovery after rejection', async () => {
  const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };
  const firstRequest = deferred();
  const firstRequestStarted = deferred();
  const firstApplyStarted = deferred();
  const firstApply = deferred();
  const secondRequest = deferred();
  const order = [];
  const appliedTokens = [];
  let currentToken = 'scene-0';
  const queue = createSceneMutationQueue();
  const first = queue.enqueue(
    () => {
      order.push('request-1');
      firstRequestStarted.resolve();
      return firstRequest.promise;
    },
    async result => {
      order.push(`apply-1:${result}`);
      firstApplyStarted.resolve();
      await firstApply.promise;
      currentToken = result;
      appliedTokens.push(result);
      order.push('applied-1');
    },
  );
  const second = queue.enqueue(
    () => { order.push('request-2'); return secondRequest.promise; },
    result => {
      currentToken = result;
      appliedTokens.push(result);
      order.push(`apply-2:${result}`);
    },
  );
  await firstRequestStarted.promise;
  assert.deepEqual(order, ['request-1']);
  assert.equal(queue.pendingRef.current, 2);
  secondRequest.resolve('scene-2');
  await Promise.resolve();
  assert.deepEqual(order, ['request-1']);
  firstRequest.resolve('scene-1');
  await firstApplyStarted.promise;
  assert.deepEqual(order, ['request-1', 'apply-1:scene-1']);
  firstApply.resolve();
  await first;
  await second;
  assert.deepEqual(appliedTokens, ['scene-1', 'scene-2']);
  assert.equal(currentToken, 'scene-2');

  const rejected = queue.enqueue(() => {
    order.push('request-3');
    throw new Error('third failed');
  });
  const rejectedAssertion = assert.rejects(rejected, /third failed/);
  const recovered = queue.enqueue(
    () => { order.push('request-4'); return 'scene-3'; },
    result => { currentToken = result; order.push(`apply-4:${result}`); },
  );
  await rejectedAssertion;
  await recovered;
  assert.deepEqual(order, [
    'request-1', 'apply-1:scene-1', 'applied-1', 'request-2', 'apply-2:scene-2',
    'request-3', 'request-4', 'apply-4:scene-3',
  ]);
  assert.equal(currentToken, 'scene-3');
  assert.equal(queue.pendingRef.current, 0);
});

test('unknown authority poisons queued and new writes until a successful graph reload', async () => {
  const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };
  const firstGate = deferred();
  const firstStarted = deferred();
  const requests = [];
  const queue = createSceneMutationQueue();
  queue.adoptAuthority('scene-1');
  const first = queue.enqueue(async () => {
    requests.push('unknown');
    firstStarted.resolve();
    await firstGate.promise;
  });
  const queued = queue.enqueue(async () => {
    requests.push('queued-write');
    return { sceneToken: 'scene-2' };
  });
  const firstRejected = assert.rejects(first, error =>
    error.code === 'AUTHORITY_UNKNOWN' && error.authorityUnknown === true);
  const queuedRejected = assert.rejects(queued, error =>
    error.code === 'AUTHORITY_UNKNOWN' && error.authorityUnknown === true);

  await firstStarted.promise;
  const unknown = new Error('commit and status both unavailable');
  unknown.code = 'AUTHORITY_UNKNOWN';
  unknown.authorityUnknown = true;
  firstGate.reject(unknown);
  await firstRejected;
  await queuedRejected;
  assert.deepEqual(requests, ['unknown']);
  assert.equal(queue.authorityUnknownRef.current, unknown);

  let newWriteCalled = false;
  await assert.rejects(
    queue.enqueue(async () => {
      newWriteCalled = true;
      return { sceneToken: 'scene-2' };
    }),
    error => error.code === 'AUTHORITY_UNKNOWN',
  );
  assert.equal(newWriteCalled, false);
  queue.adoptAuthority('scene-untrusted');
  await assert.rejects(
    queue.enqueue(async () => {
      newWriteCalled = true;
      return { sceneToken: 'scene-3' };
    }),
    error => error.code === 'AUTHORITY_UNKNOWN',
  );
  assert.equal(newWriteCalled, false);

  const reloadApplied = [];
  await assert.rejects(
    queue.reloadAuthority(async () => { throw new Error('graph reload offline'); }),
    /graph reload offline/,
  );
  assert.equal(queue.authorityUnknownRef.current, unknown);
  await assert.rejects(
    queue.reloadAuthority(async () => ({ graph: true })),
    error => error.code === 'AUTHORITY_UNKNOWN',
  );
  assert.equal(queue.authorityUnknownRef.current, unknown);
  await queue.reloadAuthority(
    async () => ({ sceneToken: 'scene-authoritative', graph: true }),
    graph => reloadApplied.push(graph.sceneToken),
  );
  assert.deepEqual(reloadApplied, ['scene-authoritative']);
  assert.equal(queue.authorityUnknownRef.current, null);
  assert.equal(queue.authorityRef.current, 'scene-authoritative');
  const recovered = await queue.enqueue(async () => {
    requests.push('recovered-write');
    return { sceneToken: 'scene-next' };
  });
  assert.equal(recovered.sceneToken, 'scene-next');
  assert.deepEqual(requests, ['unknown', 'recovered-write']);
  assert.equal(queue.pendingRef.current, 0);
});

test('response-loss status cannot regress authority when a later mutation wins the queue first', async () => {
  const queue = createSceneMutationQueue();
  queue.adoptAuthority('scene-1');
  const installed = [];
  const later = await queue.enqueue(
    async () => ({ sceneToken: 'scene-3', kind: 'later-mutation' }),
    result => installed.push(result.sceneToken),
  );
  assert.equal(later.sceneToken, 'scene-3');
  const status = await queue.enqueue(
    async () => ({
      status: 'committed', opId: 'op-lost', sceneToken: 'scene-2',
      movedIds: ['shape'], drawing: [{ id: 'shape' }],
    }),
    result => installed.push(result.sceneToken),
    { baseToken: 'scene-1' },
  );
  assert.deepEqual(status, { status: 'superseded', opId: 'op-lost' });
  assert.deepEqual(installed, ['scene-3']);
  assert.equal(queue.authorityRef.current, 'scene-3');
});

test('response loss wired through controller rejects an old receipt after a later queued mutation', async () => {
  const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };
  const carryResponse = deferred();
  const queue = createSceneMutationQueue();
  queue.adoptAuthority('scene-1');
  const installed = [];
  let opId;
  let statusQueries = 0;
  let frames = 0;
  let conflicts = 0;
  const controller = createContainerCarryController({
    dom: { mark() {}, present() {}, clear() {} },
    commit: command => {
      opId = command.opId;
      return queue.enqueue(() => carryResponse.promise, result => installed.push(result.sceneToken));
    },
    queryStatus: (requestedOpId, baseToken) => {
      statusQueries++;
      return queue.enqueue(
        async () => ({
          status: 'committed', opId: requestedOpId, sceneToken: 'scene-2',
          movedIds: ['shape'], drawing: [{ id: 'shape' }],
        }),
        result => installed.push(result.sceneToken),
        { baseToken },
      );
    },
    requestFrame: () => ++frames,
    retryFrame() {},
    onConflict: () => { conflicts++; },
  });
  const txId = controller.begin({
    queueIdle: true, sceneMutationPending: false, drawingTransaction: false, sceneToken: 'scene-1',
    renderedWorld: { elements: [{ id: 'shape', x: 1, y: 1, width: 2, height: 2 }], revision: 1 },
    renderedRevision: 1, requestedRevision: 1,
    container: { id: 'board:b1', x: 0, y: 0, w: 10, h: 10 },
    containers: [{ id: 'board:b1', x: 0, y: 0, w: 10, h: 10 }], from: { x: 0, y: 0 },
  });
  controller.move(txId, { x: 2, y: 2 });
  controller.drop(txId, { x: 2, y: 2 });
  const later = queue.enqueue(
    async () => ({ sceneToken: 'scene-3', kind: 'later-mutation' }),
    result => installed.push(result.sceneToken),
  );
  carryResponse.reject(new Error('response lost after durable carry'));
  await later;
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(opId);
  assert.equal(statusQueries, 1);
  assert.deepEqual(installed, ['scene-3']);
  assert.equal(queue.authorityRef.current, 'scene-3');
  assert.equal(frames, 0);
  assert.equal(conflicts, 1);
  assert.equal(controller.state().phase, 'CONFLICT_STALE');
});

test('pending scene mutations block BEGIN and cancel makes a late DROP inert', () => {
  let commits = 0;
  let clears = 0;
  const controller = createContainerCarryController({
    dom: {
      mark() {},
      present() {},
      clear() { clears++; },
    },
    commit: async () => { commits++; return { status: 'committed', movedIds: [] }; },
    queryStatus: async () => ({ status: 'unknown' }),
    requestFrame: () => 1,
    retryFrame() {},
  });
  const input = {
    queueIdle: true,
    sceneMutationPending: true,
    drawingTransaction: false,
    sceneToken: 'scene-1',
    renderedWorld: { elements: [{ id: 'shape', x: 20, y: 20, width: 10, height: 10 }], revision: 1 },
    renderedRevision: 1,
    requestedRevision: 1,
    container: { id: 'board:b1', x: 0, y: 0, w: 100, h: 100 },
    containers: [{ id: 'board:b1', x: 0, y: 0, w: 100, h: 100 }],
    from: { x: 0, y: 0 },
  };
  assert.equal(controller.begin(input), null);
  const txId = controller.begin({ ...input, sceneMutationPending: false });
  assert.ok(txId);
  controller.move(txId, { x: 30, y: 20 });
  controller.cancel(txId);
  assert.equal(controller.state().phase, 'IDLE');
  controller.drop(txId, { x: 30, y: 20 });
  assert.equal(controller.state().phase, 'IDLE');
  assert.equal(commits, 0);
  assert.equal(clears, 1);
  assert.deepEqual(controller.events().map(entry => entry.event), ['BEGIN', 'MOVE', 'CANCEL']);
});

test('lost commit response queries once and resumes from the committed receipt without replay', async () => {
  let commits = 0;
  let statusQueries = 0;
  let requestedFrames = 0;
  const receipt = {
    status: 'committed',
    opId: null,
    sceneToken: 'scene-2',
    movedIds: ['shape'],
    drawing: [{ id: 'shape', x: 30, y: 20 }],
    container: { kind: 'board', id: 'board:b1', x: 20, y: 0 },
  };
  const controller = createContainerCarryController({
    dom: { mark() {}, present() {}, clear() {} },
    commit: async command => {
      commits++;
      receipt.opId = command.opId;
      throw new Error('response lost after durable commit');
    },
    queryStatus: async opId => {
      statusQueries++;
      assert.equal(opId, receipt.opId);
      return receipt;
    },
    requestFrame: result => {
      requestedFrames++;
      assert.equal(result, receipt);
      return 9;
    },
    retryFrame() {},
  });
  const txId = controller.begin({
    queueIdle: true,
    sceneMutationPending: false,
    drawingTransaction: false,
    sceneToken: 'scene-1',
    renderedWorld: { elements: [{ id: 'shape', x: 20, y: 20, width: 10, height: 10 }], revision: 1 },
    renderedRevision: 1,
    requestedRevision: 1,
    container: { id: 'board:b1', x: 0, y: 0, w: 100, h: 100 },
    containers: [{ id: 'board:b1', x: 0, y: 0, w: 100, h: 100 }],
    from: { x: 0, y: 0 },
  });
  controller.move(txId, { x: 20, y: 0 });
  controller.drop(txId, { x: 20, y: 0 });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(commits, 1);
  assert.equal(statusQueries, 1);
  assert.equal(requestedFrames, 1);
  assert.equal(controller.state().phase, 'AWAITING_FRAME');
  assert.deepEqual(controller.events().map(entry => entry.event), [
    'BEGIN', 'MOVE', 'DROP', 'RESPONSE_UNKNOWN', 'STATUS_ACCEPTED', 'STATUS_COMMITTED',
  ]);
  controller.frameReady(txId, 9);
  assert.equal(controller.state().phase, 'IDLE');
});

test('late async success or rejection after disposal cannot allocate a frame or conflict a replacement', async () => {
  const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };
  const makeInput = () => ({
    queueIdle: true,
    sceneMutationPending: false,
    drawingTransaction: false,
    sceneToken: 'scene-1',
    renderedWorld: { elements: [{ id: 'shape', x: 20, y: 20, width: 10, height: 10 }], revision: 1 },
    renderedRevision: 1,
    requestedRevision: 1,
    container: { id: 'board:b1', x: 0, y: 0, w: 100, h: 100 },
    containers: [{ id: 'board:b1', x: 0, y: 0, w: 100, h: 100 }],
    from: { x: 0, y: 0 },
  });
  let frames = 0;
  let conflicts = 0;
  const lateSuccess = deferred();
  const first = createContainerCarryController({
    dom: { mark() {}, present() {}, clear() {} },
    commit: () => lateSuccess.promise,
    queryStatus: async () => ({ status: 'unknown' }),
    requestFrame: () => ++frames,
    retryFrame() {},
    onConflict: () => { conflicts++; },
  });
  const firstTx = first.begin(makeInput());
  first.move(firstTx, { x: 20, y: 10 });
  first.drop(firstTx, { x: 20, y: 10 });
  const firstOp = first.state().opId;
  first.dispose();

  const replacementFailure = deferred();
  const second = createContainerCarryController({
    dom: { mark() {}, present() {}, clear() {} },
    commit: () => replacementFailure.promise,
    queryStatus: async () => ({ status: 'unknown' }),
    requestFrame: () => ++frames,
    retryFrame() {},
    onConflict: () => { conflicts++; },
  });
  const secondTx = second.begin(makeInput());
  second.move(secondTx, { x: 30, y: 10 });
  second.drop(secondTx, { x: 30, y: 10 });
  second.dispose();

  lateSuccess.resolve({
    status: 'committed', opId: firstOp, sceneToken: 'scene-2',
    movedIds: ['shape'], drawing: [{ id: 'shape' }],
  });
  const stale = new Error('late stale rejection');
  stale.status = 409;
  replacementFailure.reject(stale);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(frames, 0);
  assert.equal(conflicts, 0);
});

test('late status success and rejection after disposal have no frame, conflict, ledger, or DOM side effects', async () => {
  const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };
  for (const outcome of ['resolve', 'reject']) {
    const status = deferred();
    let opId;
    let frames = 0;
    let conflicts = 0;
    let clears = 0;
    const controller = createContainerCarryController({
      dom: { mark() {}, present() {}, clear() { clears++; } },
      commit: async command => { opId = command.opId; throw new Error('response lost'); },
      queryStatus: () => status.promise,
      requestFrame: () => ++frames,
      retryFrame() {},
      onConflict: () => { conflicts++; },
    });
    const txId = controller.begin({
      queueIdle: true, sceneMutationPending: false, drawingTransaction: false, sceneToken: 'scene-1',
      renderedWorld: { elements: [{ id: 'shape', x: 1, y: 1, width: 2, height: 2 }], revision: 1 },
      renderedRevision: 1, requestedRevision: 1,
      container: { id: 'board:b1', x: 0, y: 0, w: 10, h: 10 },
      containers: [{ id: 'board:b1', x: 0, y: 0, w: 10, h: 10 }], from: { x: 0, y: 0 },
    });
    controller.move(txId, { x: 2, y: 2 });
    controller.drop(txId, { x: 2, y: 2 });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(controller.state().phase, 'QUERYING_OPERATION');
    controller.dispose();
    const ledgerLength = controller.events().length;
    if (outcome === 'resolve') {
      status.resolve({
        status: 'committed', opId, sceneToken: 'scene-2',
        movedIds: ['shape'], drawing: [{ id: 'shape' }],
      });
    } else status.reject(new Error('late status failure'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(frames, 0, outcome);
    assert.equal(conflicts, 0, outcome);
    assert.equal(controller.events().length, ledgerLength, outcome);
    assert.equal(clears, 1, outcome);
  }
});

test('result opId is validated before frame allocation and disposal clears its owned pending frame', async () => {
  let requested = 0;
  const cleared = [];
  let pendingOwner = null;
  let conflicts = 0;
  let resultOpId = 'wrong-op';
  const controller = createContainerCarryController({
    dom: { mark() {}, present() {}, clear() {} },
    commit: async () => ({
      status: 'committed', opId: resultOpId, sceneToken: 'scene-2',
      movedIds: ['shape'], drawing: [{ id: 'shape' }],
    }),
    queryStatus: async () => ({ status: 'unknown' }),
    requestFrame: () => ++requested,
    clearFrameOwner: (txId, frameId) => { cleared.push({ txId, frameId }); },
    retryFrame() {},
    onConflict: () => { conflicts++; },
  });
  const input = {
    queueIdle: true, sceneMutationPending: false, drawingTransaction: false, sceneToken: 'scene-1',
    renderedWorld: { elements: [{ id: 'shape', x: 1, y: 1, width: 2, height: 2 }], revision: 1 },
    renderedRevision: 1, requestedRevision: 1,
    container: { id: 'board:b1', x: 0, y: 0, w: 10, h: 10 },
    containers: [{ id: 'board:b1', x: 0, y: 0, w: 10, h: 10 }], from: { x: 0, y: 0 },
  };
  let txId = controller.begin(input);
  controller.move(txId, { x: 2, y: 2 });
  controller.drop(txId, { x: 2, y: 2 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requested, 0);
  assert.equal(conflicts, 1);

  resultOpId = null;
  const owner = createContainerCarryController({
    dom: { mark() {}, present() {}, clear() {} },
    commit: async command => ({
      status: 'committed', opId: command.opId, sceneToken: 'scene-2',
      movedIds: ['shape'], drawing: [{ id: 'shape' }],
    }),
    queryStatus: async () => ({ status: 'unknown' }),
    requestFrame: (_result, ownerTxId) => {
      pendingOwner = { txId: ownerTxId, frameId: ++requested };
      return pendingOwner.frameId;
    },
    clearFrameOwner: (ownerTxId, frameId) => {
      cleared.push({ txId: ownerTxId, frameId });
      if (pendingOwner?.txId === ownerTxId && pendingOwner.frameId === frameId) pendingOwner = null;
    },
    retryFrame() {},
  });
  txId = owner.begin(input);
  owner.move(txId, { x: 2, y: 2 });
  owner.drop(txId, { x: 2, y: 2 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(owner.state().phase, 'AWAITING_FRAME');
  pendingOwner = { txId: 'replacement', frameId: 999 };
  owner.dispose();
  assert.deepEqual(cleared, [{ txId, frameId: requested }]);
  assert.deepEqual(pendingOwner, { txId: 'replacement', frameId: 999 });
});
