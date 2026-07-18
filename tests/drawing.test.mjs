import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  advanceDrawingTransaction, anchoredDrawingIds, autoSinkLargeNewDrawingDraft, canvasGeometryAllowed, canvasGeometryPreparation, committedDrawingElements, createDrawingArrangeUndoTicket, createDrawingCommitQueue, deleteDrawingElement, DRAWING_HIT_BLOCK, drawingBounds, drawingCameraExitPolicy, drawingCameraPresentation, drawingCameraStep, drawingCompositionStep,
  createDrawingTransaction, drawingEditorReadyStep, drawingTransactionClosure, drawingTransactionVisibleElements,
  drawingAutoExitGestureStep, drawingClosingHandoffStep, drawingExitAction, drawingExitFailureNotice, drawingFilesSignature, drawingFontSignature, drawingFontSignaturesEqual, drawingFontWorkRoute, drawingFrameHitElements, drawingFrameRetryDecision, drawingFrameTruthStep, drawingOpeningRequestCurrent, drawingPlaneDirtyPlan, drawingPlaneGroupPlan, drawingPlaneGroups, drawingPlaneSignature, drawingPlaneSignaturesEqual, drawingPlaneSettledInFlight, drawingPlaneWorkRoute, drawingRestoredWorldOverride, drawingSnapshot, drawingWorldInputStep, drawingWorldSyncStep, hitDrawingElement, isLargeFilledDrawingElement, setDrawingElementPlane, splitDrawingPlanes,
  mergeDrawingTransaction, translateDrawingElements,
} from '../web/src/canvas/drawing.js';
import {
  acceptanceCspFor, classifyAcceptanceRequest, selectAcceptanceFixture,
} from '../scripts/serve-canvas-acceptance.mjs';
import {
  assertSharedChunkBudget, assertWorkerCoreIsolation, collectStaticClosure,
} from '../scripts/verify-subset-worker-build.mjs';
import {
  EXCALIDRAW_FONT_LOCK, excalidrawLocalFonts,
} from '../scripts/excalidraw-local-fonts.mjs';
import { loadDrawingFiles, normalizeDrawingFiles, saveDrawingFiles } from '../server/drawing-files.mjs';
import { createCanvasAcceptanceElements, mutateBelowPlane } from './fixtures/canvas-acceptance/fixture-data.js';

const image = id => ({ id: `element-${id}`, type: 'image', fileId: id });
const binary = id => ({ id, mimeType: 'image/png', dataURL: 'data:image/png;base64,c3ludGhldGlj', created: 1 });

const readNamedFunction = (source, name) => {
  const start = source.indexOf(`function ${name}`);
  assert.ok(start >= 0, `缺少具名纯 helper ${name}`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index++) {
    if (source[index] === '{') depth++;
    if (source[index] !== '}') continue;
    depth--;
    if (depth === 0) {
      return Function(`"use strict"; return (${source.slice(start, index + 1)});`)();
    }
  }
  throw new Error(`无法读取具名纯 helper ${name}`);
};

const driveEditorHandshake = events => {
  let state = {};
  const notifications = [];
  for (const [eventType, tool] of events) {
    state = drawingEditorReadyStep(state, eventType);
    if (state.notifyReady) notifications.push('ready');
    if (state.notifyTool) notifications.push(`tool:${tool}`);
  }
  return { state, notifications };
};

test('空画布 api→change：首次默认 selection 只完成 ready，后续 freedraw 才回传工具', () => {
  const { state, notifications } = driveEditorHandshake([
    ['api'], ['change', 'selection'], ['api'], ['change', 'freedraw'],
  ]);
  assert.equal(state.ready, true);
  assert.deepEqual(notifications, ['ready', 'tool:freedraw']);
});

test('非空画布 change→api：首次水合 selection 不回灌，重复事件不重发 ready', () => {
  const { state, notifications } = driveEditorHandshake([
    ['change', 'selection'], ['api'], ['api'], ['change', 'freedraw'],
  ]);
  assert.deepEqual(
    { apiReady: state.apiReady, hydrated: state.hydrated, ready: state.ready },
    { apiReady: true, hydrated: true, ready: true },
  );
  assert.deepEqual(notifications, ['ready', 'tool:freedraw']);
});

test('画布几何门：opening/drawing/pending 任一把锁在场都拒绝副作用', () => {
  assert.equal(canvasGeometryAllowed(), true);
  assert.equal(canvasGeometryAllowed({ opening: true }), false);
  assert.equal(canvasGeometryAllowed({ drawing: true }), false);
  assert.equal(canvasGeometryAllowed({ pending: true }), false);
  assert.equal(canvasGeometryAllowed({ opening: true, drawing: true, pending: true }), false);
});

test('全局几何准备：opening/pending 让位，active drawing 先退出，空闲直接继续', () => {
  assert.equal(canvasGeometryPreparation(), 'ready');
  assert.equal(canvasGeometryPreparation({ drawing: true }), 'exit-drawing');
  assert.equal(canvasGeometryPreparation({ opening: true }), 'blocked');
  assert.equal(canvasGeometryPreparation({ pending: true }), 'blocked');
  assert.equal(canvasGeometryPreparation({ opening: true, drawing: true }), 'blocked');
});

test('deferred opening 期间拖动与整理 callback 均为零次，解门后才可执行', async () => {
  let opening = true;
  let releaseOpening;
  const opened = new Promise(resolve => { releaseOpening = resolve; }).then(() => { opening = false; });
  let geometryEffects = 0;
  const guardedGeometry = () => {
    if (canvasGeometryAllowed({ opening })) geometryEffects++;
  };

  guardedGeometry();   // drag
  guardedGeometry();   // arrange
  assert.equal(geometryEffects, 0);
  releaseOpening();
  await opened;
  guardedGeometry();
  guardedGeometry();
  assert.equal(geometryEffects, 2);
});

test('drawing snapshot keeps referenced images and prunes deleted image files', () => {
  const snapshot = drawingSnapshot([image('used'), { ...image('deleted'), isDeleted: true }, { id: 'line', type: 'line' }], {
    used: binary('used'), deleted: binary('deleted'), stale: binary('stale'),
  });

  assert.deepEqual(Object.keys(snapshot.files), ['used']);
  assert.deepEqual(snapshot.elements.map(e => e.id), ['element-used', 'line']);
  assert.equal(drawingFilesSignature(snapshot.files), 'used');
  assert.equal(drawingFilesSignature({ stale: binary('stale'), used: binary('used') }), 'stale|used');
});

test('选择事务闭包递归覆盖容器、绑定、箭头、画框与嵌套分组，顺序仍跟完整世界一致', () => {
  const els = [
    rect('unrelated', -100, -100, 10, 10),
    { ...rect('host', 0, 0, 100, 80), boundElements: [{ id: 'label', type: 'text' }, { id: 'arrow', type: 'arrow' }] },
    { id: 'label', type: 'text', x: 10, y: 10, width: 40, height: 20, containerId: 'host' },
    { id: 'arrow', type: 'arrow', x: 100, y: 40, width: 100, height: 0, points: [[0, 0], [100, 0]], startBinding: { elementId: 'host' }, endBinding: { elementId: 'peer' } },
    { ...rect('peer', 200, 0, 80, 80), frameId: 'frame', groupIds: ['inner', 'outer'] },
    { ...rect('group-mate', 300, 0, 40, 40), groupIds: ['outer'] },
    { id: 'frame', type: 'frame', x: 180, y: -20, width: 180, height: 140 },
  ];

  assert.deepEqual(
    drawingTransactionClosure(els, 'label').map(el => el.id),
    ['host', 'label', 'arrow', 'peer', 'group-mate', 'frame'],
  );
  assert.deepEqual(drawingTransactionClosure(els, 'missing'), []);
});

test('selection/new 事务只携带局部副本；committed 世界只排除 originalIds', () => {
  const base = {
    elements: [
      rect('before', -100, 0, 20, 20),
      { ...image('photo'), x: 0, y: 0, width: 100, height: 80, boundElements: [{ id: 'caption', type: 'text' }] },
      { id: 'caption', type: 'text', x: 10, y: 10, width: 60, height: 20, containerId: 'element-photo' },
      rect('after', 200, 0, 20, 20),
    ],
    files: { photo: binary('photo'), stale: binary('stale') },
  };
  const selection = createDrawingTransaction(base, 'element-photo');
  assert.equal(selection.kind, 'selection');
  assert.deepEqual(selection.originalIds, ['element-photo', 'caption']);
  assert.deepEqual(selection.elements.map(el => el.id), ['element-photo', 'caption']);
  assert.deepEqual(Object.keys(selection.files), ['photo']);
  assert.equal(selection.anchorIndex, 1);
  const visible = drawingTransactionVisibleElements(base.elements, selection.originalIds);
  assert.deepEqual(visible.map(el => el.id), ['before', 'after']);
  assert.equal(visible[0], base.elements[0]);
  assert.equal(visible[1], base.elements[3]);

  const fresh = createDrawingTransaction(base);
  assert.deepEqual(fresh, {
    kind: 'new', targetId: null, originalIds: [], anchorIndex: 4, elements: [], files: {},
  });
  assert.equal(createDrawingTransaction(base, 'missing'), null);
});

test('selection merge 在原槽替换/删除局部元素，新增元素随事务插入且不改无关对象引用与顺序', () => {
  const before = rect('before', -100, 0, 20, 20);
  const host = { ...rect('host', 0, 0, 100, 80), boundElements: [{ id: 'label', type: 'text' }] };
  const between = rect('between', 130, 0, 20, 20);
  const label = { id: 'label', type: 'text', x: 10, y: 10, width: 40, height: 20, containerId: 'host' };
  const after = rect('after', 200, 0, 20, 20);
  const base = { elements: [before, host, between, label, after], files: {} };
  const tx = createDrawingTransaction(base, 'host');
  const editedHost = { ...host, x: 25 };
  const added = rect('added-in-edit', 70, 100, 30, 30);

  const merged = mergeDrawingTransaction(base, tx, { elements: [editedHost, added], files: {} });
  assert.deepEqual(merged.elements.map(el => el.id), ['before', 'host', 'added-in-edit', 'between', 'after']);
  assert.equal(merged.elements[0], before);
  assert.equal(merged.elements[3], between);
  assert.equal(merged.elements[4], after);
  assert.equal(merged.elements[1].x, 25);
  assert.equal(merged.elements.some(el => el.id === 'label'), false, 'draft 中消失的 original 元素就是删除');

  const retried = mergeDrawingTransaction(merged, tx, { elements: [editedHost, added], files: {} });
  assert.deepEqual(retried.elements.map(el => el.id), ['before', 'host', 'added-in-edit', 'between', 'after'], '交接失败重试不重复插入 draft 新元素');
});

test('非连续 selection 闭包保留全局 z-order；删除/新增/显式重排与重试均确定', () => {
  const host = { ...rect('host', 0, 0, 100, 80), boundElements: [{ id: 'label', type: 'text' }] };
  const cover = rect('cover', 20, 10, 40, 40);
  const label = { id: 'label', type: 'text', x: 10, y: 10, width: 40, height: 20, containerId: 'host' };
  const base = { elements: [host, cover, label], files: {} };
  const tx = createDrawingTransaction(base, 'host');
  const ids = snapshot => snapshot.elements.map(element => element.id);

  assert.deepEqual(ids(mergeDrawingTransaction(base, tx, { elements: [host, label], files: {} })),
    ['host', 'cover', 'label'], '未显式重排不能把非连续闭包压成连续块');
  assert.deepEqual(ids(mergeDrawingTransaction(base, tx, { elements: [host], files: {} })),
    ['host', 'cover'], 'draft 缺失 original 就删除原槽');

  const added = rect('new', 60, 30, 20, 20);
  const withNew = mergeDrawingTransaction(base, tx, { elements: [host, added, label], files: {} });
  assert.deepEqual(ids(withNew), ['host', 'new', 'cover', 'label'], 'new ID 跟随最近前置 surviving original');
  assert.deepEqual(ids(mergeDrawingTransaction(withNew, tx, { elements: [host, added, label], files: {} })),
    ['host', 'new', 'cover', 'label'], '同一 draft 重试不得重复插入');

  const reordered = mergeDrawingTransaction(base, tx, { elements: [label, host], files: {} });
  assert.deepEqual(ids(reordered), ['label', 'cover', 'host'], '显式重排只填 owned slots，无关 cover 保持原槽');
  assert.deepEqual(ids(mergeDrawingTransaction(reordered, tx, { elements: [label, host], files: {} })),
    ['label', 'cover', 'host'], '显式重排重试同样幂等');
});

test('new merge 追加到世界末尾；base+draft 文件只合并一次并由最终全量快照裁剪', () => {
  const base = {
    elements: [image('kept'), rect('base', 0, 0, 20, 20)],
    files: { kept: binary('kept'), stale: binary('stale') },
  };
  const tx = createDrawingTransaction(base);
  const merged = mergeDrawingTransaction(base, tx, {
    elements: [image('new'), rect('ink', 30, 0, 20, 20)],
    files: { new: binary('new'), orphan: binary('orphan') },
  });

  assert.deepEqual(merged.elements.map(el => el.id), ['element-kept', 'base', 'element-new', 'ink']);
  assert.deepEqual(Object.keys(merged.files), ['kept', 'new']);
});

test('首次 new 事务只把达阈值的实心区域形状及其绑定文字自动沉底', () => {
  const base = { elements: [rect('existing', 0, 0, 800, 600, { backgroundColor: '#fff' })], files: {} };
  const tx = createDrawingTransaction(base);
  const draft = {
    elements: [
      rect('threshold', 0, 0, 400, 300, { backgroundColor: '#ffd43b', angle: Math.PI / 4 }),
      { id: 'label', type: 'text', x: 20, y: 20, width: 80, height: 20, containerId: 'threshold' },
      { ...rect('ellipse', 0, 0, -500, -350, { backgroundColor: '#74c0fc' }), type: 'ellipse' },
      { ...rect('diamond', 0, 0, 600, 400, { backgroundColor: '#b2f2bb' }), type: 'diamond', customData: { below: true } },
      { id: 'independent-arrow', type: 'arrow', x: 0, y: 0, width: 600, height: 0, points: [[0, 0], [600, 0]] },
    ],
    files: {},
  };

  const prepared = autoSinkLargeNewDrawingDraft(base, tx, draft);
  assert.deepEqual(prepared.sunkIds, ['threshold', 'ellipse']);
  assert.equal(prepared.snapshot.elements.find(el => el.id === 'threshold').customData.below, true);
  assert.equal(prepared.snapshot.elements.find(el => el.id === 'label').customData.below, true);
  assert.equal(prepared.snapshot.elements.find(el => el.id === 'ellipse').customData.below, true);
  assert.equal(prepared.snapshot.elements.find(el => el.id === 'diamond').customData.below, true);
  assert.equal(prepared.snapshot.elements.find(el => el.id === 'independent-arrow').customData?.below, undefined);
  assert.equal(base.elements[0].customData?.below, undefined, 'base 中已有大形状不能被追溯改层');
});

test('自动沉底拒绝小边、透明填充、非区域类型、selection 与已 rebase 的 new 事务', () => {
  const base = { elements: [], files: {} };
  const tx = createDrawingTransaction(base);
  const draft = {
    elements: [
      rect('narrow', 0, 0, 399, 301, { backgroundColor: '#fff' }),
      rect('short', 0, 0, 401, 299, { backgroundColor: '#fff' }),
      rect('transparent', 0, 0, 500, 400),
      { id: 'line', type: 'line', x: 0, y: 0, width: 500, height: 400, backgroundColor: '#fff', points: [[0, 0], [500, 400]] },
      { id: 'freedraw', type: 'freedraw', x: 0, y: 0, width: 500, height: 400, backgroundColor: '#fff', points: [[0, 0], [500, 400]] },
      { id: 'text', type: 'text', x: 0, y: 0, width: 500, height: 400, backgroundColor: '#fff' },
      { id: 'image', type: 'image', fileId: 'photo', x: 0, y: 0, width: 500, height: 400, backgroundColor: '#fff' },
    ],
    files: { photo: binary('photo') },
  };
  assert.deepEqual(autoSinkLargeNewDrawingDraft(base, tx, draft).sunkIds, []);

  const eligible = { elements: [rect('zone', 0, 0, 500, 400, { backgroundColor: '#fff' })], files: {} };
  assert.deepEqual(autoSinkLargeNewDrawingDraft(base, { ...tx, kind: 'selection' }, eligible).sunkIds, []);
  assert.deepEqual(autoSinkLargeNewDrawingDraft(base, { ...tx, originalIds: ['zone'] }, eligible).sunkIds, []);
});

test('大实心底板谓词与提交阈值共用一把尺，负尺寸按绝对值判定', () => {
  assert.equal(isLargeFilledDrawingElement(rect('threshold', 0, 0, 400, 300, { backgroundColor: '#fff' })), true);
  assert.equal(isLargeFilledDrawingElement({ ...rect('ellipse', 0, 0, -400, -300, { backgroundColor: '#fff' }), type: 'ellipse' }), true);
  assert.equal(isLargeFilledDrawingElement({ ...rect('diamond', 0, 0, 600, 300, { backgroundColor: '#fff' }), type: 'diamond' }), true);
  assert.equal(isLargeFilledDrawingElement(rect('narrow', 0, 0, 399, 400, { backgroundColor: '#fff' })), false);
  assert.equal(isLargeFilledDrawingElement(rect('short', 0, 0, 500, 299, { backgroundColor: '#fff' })), false);
  assert.equal(isLargeFilledDrawingElement(rect('hollow', 0, 0, 500, 400)), false);
  assert.equal(isLargeFilledDrawingElement(rect('transparent', 0, 0, 500, 400, { backgroundColor: 'transparent' })), false);
  assert.equal(isLargeFilledDrawingElement({ ...rect('line', 0, 0, 500, 400, { backgroundColor: '#fff' }), type: 'line' }), false);
});

const autoExitStep = (state, event) => drawingAutoExitGestureStep(state, event);

test('自动退场手势：pointerup 早于最终 onChange，稳定两帧后只 signal 一次', () => {
  const zone = rect('zone', 0, 0, 600, 400, { backgroundColor: '#fff' });
  let result = autoExitStep(undefined, {
    type: 'begin', enabled: true, token: 1, pointerId: 7, tool: 'rectangle',
    beforeIds: [], elements: [], changeVersion: 0,
  });
  result = autoExitStep(result.state, { type: 'release', token: 1, pointerId: 7 });
  assert.equal(result.action, 'schedule');
  result = autoExitStep(result.state, { type: 'change', token: 1, elements: [zone], changeVersion: 1 });
  result = autoExitStep(result.state, { type: 'frame', token: 1 });
  assert.equal(result.action, 'wait');
  result = autoExitStep(result.state, { type: 'frame', token: 1 });
  assert.deepEqual({ action: result.action, elementId: result.elementId }, { action: 'signal', elementId: 'zone' });
  assert.equal(autoExitStep(result.state, { type: 'frame', token: 1 }).action, 'none');
});

test('自动退场手势：最终 onChange 早于 pointerup 时走两帧兜底，版本变化重置稳定计数', () => {
  const zone = rect('zone', 0, 0, 600, 400, { backgroundColor: '#fff' });
  let result = autoExitStep(undefined, {
    type: 'begin', enabled: true, token: 2, pointerId: 8, tool: 'rectangle',
    beforeIds: [], elements: [], changeVersion: 0,
  });
  result = autoExitStep(result.state, { type: 'change', token: 2, elements: [zone], changeVersion: 1 });
  result = autoExitStep(result.state, { type: 'release', token: 2, pointerId: 8 });
  result = autoExitStep(result.state, { type: 'frame', token: 2 });
  result = autoExitStep(result.state, { type: 'change', token: 2, elements: [{ ...zone, version: 2 }], changeVersion: 2 });
  result = autoExitStep(result.state, { type: 'frame', token: 2 });
  assert.equal(result.action, 'wait');
  result = autoExitStep(result.state, { type: 'frame', token: 2 });
  assert.equal(result.action, 'signal');
});

test('自动退场手势拒绝 selection/旧大形状/新小形状，cancel 与新 token 令迟到事件失效', () => {
  const oldZone = rect('old-zone', 0, 0, 800, 600, { backgroundColor: '#fff' });
  const small = rect('small', 0, 0, 200, 120, { backgroundColor: '#fff' });
  assert.equal(autoExitStep(undefined, {
    type: 'begin', enabled: false, token: 3, pointerId: 9, tool: 'rectangle', beforeIds: [], elements: [], changeVersion: 0,
  }).action, 'none');
  assert.equal(autoExitStep(undefined, {
    type: 'begin', enabled: true, token: 3, pointerId: 9, tool: 'selection', beforeIds: [], elements: [], changeVersion: 0,
  }).action, 'none');

  let result = autoExitStep(undefined, {
    type: 'begin', enabled: true, token: 4, pointerId: 10, tool: 'rectangle',
    beforeIds: ['old-zone'], elements: [oldZone], changeVersion: 0,
  });
  result = autoExitStep(result.state, { type: 'change', token: 4, elements: [oldZone, small], changeVersion: 1 });
  result = autoExitStep(result.state, { type: 'release', token: 4, pointerId: 10 });
  result = autoExitStep(result.state, { type: 'frame', token: 4 });
  result = autoExitStep(result.state, { type: 'frame', token: 4 });
  assert.equal(result.action, 'complete');

  result = autoExitStep(undefined, {
    type: 'begin', enabled: true, token: 5, pointerId: 11, tool: 'rectangle', beforeIds: [], elements: [], changeVersion: 0,
  });
  result = autoExitStep(result.state, { type: 'cancel', token: 5 });
  assert.equal(autoExitStep(result.state, { type: 'change', token: 5, elements: [oldZone], changeVersion: 2 }).action, 'none');
  const next = autoExitStep(result.state, {
    type: 'begin', enabled: true, token: 6, pointerId: 12, tool: 'ellipse', beforeIds: [], elements: [], changeVersion: 2,
  });
  assert.equal(autoExitStep(next.state, { type: 'release', token: 5, pointerId: 11 }).action, 'none');
});

test('common merge 首次自动沉底；rebase 后用户手动浮起必须保持选择', () => {
  const base = { elements: [rect('unrelated', -100, 0, 20, 20)], files: {} };
  const tx = createDrawingTransaction(base);
  const draft = { elements: [rect('zone', 0, 0, 800, 600, { backgroundColor: '#fff' })], files: {} };
  const prepared = autoSinkLargeNewDrawingDraft(base, tx, draft);
  const firstMerged = mergeDrawingTransaction(base, tx, draft);
  assert.equal(firstMerged.elements.find(el => el.id === 'zone').customData.below, true);

  const rebased = advanceDrawingTransaction(tx, prepared.snapshot);
  assert.deepEqual(rebased.originalIds, ['zone'], 'new 事务只能接管局部 draft，不能吞进 full world 旧元素');
  const floated = { elements: setDrawingElementPlane(prepared.snapshot.elements, 'zone', false), files: {} };
  const retried = mergeDrawingTransaction(firstMerged, rebased, floated);
  assert.equal(retried.elements.find(el => el.id === 'zone').customData.below, false);
  assert.ok(retried.elements.some(el => el.id === 'unrelated'));
});

test('new 事务首次持久化后 rebase 所有新生 ID；帧失败后删掉一笔再 merge 不得幽灵复活', () => {
  const base = { elements: [rect('base', 0, 0, 20, 20)], files: {} };
  const tx = createDrawingTransaction(base);
  const firstDraft = { elements: [rect('new-a', 30, 0, 20, 20), rect('new-b', 60, 0, 20, 20)], files: {} };
  const firstMerged = mergeDrawingTransaction(base, tx, firstDraft);
  const rebased = advanceDrawingTransaction(tx, firstDraft);

  assert.deepEqual(rebased.originalIds, ['new-a', 'new-b']);
  assert.equal(rebased.anchorIndex, tx.anchorIndex);
  const retried = mergeDrawingTransaction(firstMerged, rebased, {
    elements: [rect('new-a', 35, 0, 20, 20)], files: {},
  });
  assert.deepEqual(retried.elements.map(el => el.id), ['base', 'new-a']);
});

test('selection 事务 rebase 保留旧闭包并接管新生 ID；帧失败后删除新生元素不会从 merged base 复活', () => {
  const host = { ...rect('host', 0, 0, 100, 80), boundElements: [{ id: 'label', type: 'text' }] };
  const label = { id: 'label', type: 'text', x: 10, y: 10, width: 40, height: 20, containerId: 'host' };
  const after = rect('after', 200, 0, 20, 20);
  const base = { elements: [host, label, after], files: {} };
  const tx = createDrawingTransaction(base, 'host');
  const firstDraft = { elements: [{ ...host, x: 10 }, rect('new-a', 40, 100, 20, 20), rect('new-b', 70, 100, 20, 20)], files: {} };
  const firstMerged = mergeDrawingTransaction(base, tx, firstDraft);
  const rebased = advanceDrawingTransaction(tx, firstDraft);

  assert.deepEqual(rebased.originalIds, ['host', 'label', 'new-a', 'new-b']);
  const retried = mergeDrawingTransaction(firstMerged, rebased, {
    elements: [{ ...host, x: 20 }, rect('new-a', 45, 100, 20, 20)], files: {},
  });
  assert.deepEqual(retried.elements.map(el => el.id), ['host', 'new-a', 'after']);
  assert.equal(retried.elements[0].x, 20);
});

test('退出失败回执区分提交前失败与已保存后的画面交接失败', () => {
  const beforePersist = drawingExitFailureNotice({ persisted: false, errorMessage: 'synthetic commit reject' });
  assert.equal(beforePersist.stage, 'before-persist');
  assert.match(beforePersist.message, /未落盘/);
  assert.doesNotMatch(beforePersist.message, /已保存/);

  const afterPersist = drawingExitFailureNotice({ persisted: true, errorMessage: 'synthetic svg reject' });
  assert.equal(afterPersist.stage, 'after-persist');
  assert.match(afterPersist.message, /已保存/);
  assert.match(afterPersist.message, /画面交接失败/);
  assert.match(afterPersist.message, /可重试退出/);
  assert.doesNotMatch(afterPersist.message, /未落盘/);
});

test('隐藏 opening draft 直接取消：持久化与 closing 均为零并收口 opening resolver', () => {
  const cancel = drawingExitAction({ opening: true, visible: false, hasOpeningResolver: true });
  assert.deepEqual(cancel, {
    type: 'cancel-opening',
    opening: false,
    openingPromise: null,
    openingResolver: null,
    resolveOpeningWith: false,
  });
  assert.deepEqual(drawingExitAction({ opening: true, visible: true }), { type: 'commit' });
  assert.deepEqual(drawingExitAction({ opening: false, visible: false }), { type: 'commit' });

  let persistenceCalls = 0;
  let closingCalls = 0;
  const openingResults = [];
  const state = { opening: true, openingPromise: Promise.resolve(), openingResolver: value => openingResults.push(value) };
  const action = drawingExitAction({
    opening: state.opening, visible: false, hasOpeningResolver: !!state.openingResolver,
  });
  if (action.type === 'cancel-opening') {
    const resolveOpening = state.openingResolver;
    state.opening = action.opening;
    state.openingPromise = action.openingPromise;
    state.openingResolver = action.openingResolver;
    if (action.resolveOpeningWith !== null) resolveOpening?.(action.resolveOpeningWith);
  } else {
    persistenceCalls++;
    closingCalls++;
  }

  assert.equal(persistenceCalls, 0);
  assert.equal(closingCalls, 0);
  assert.deepEqual(state, { opening: false, openingPromise: null, openingResolver: null });
  assert.deepEqual(openingResults, [false]);
});

test('camera token 状态机：迟到 preview/失败回 live/resume 被新手势抢占', () => {
  const freeze1 = {};
  const stale = {};
  let state = drawingCameraStep(undefined, { type: 'navigate', token: freeze1 });
  assert.deepEqual(state, { phase: 'freezing', token: freeze1 });
  assert.equal(drawingCameraStep(state, { type: 'preview-ready', token: stale }), state);
  assert.deepEqual(drawingCameraStep(state, { type: 'preview-error', token: freeze1 }), { phase: 'live', token: null });

  const freeze2 = {};
  state = drawingCameraStep(undefined, { type: 'navigate', token: freeze2 });
  state = drawingCameraStep(state, { type: 'preview-ready', token: freeze2 });
  assert.deepEqual(state, { phase: 'suspended', token: freeze2 });
  const resume1 = {};
  state = drawingCameraStep(state, { type: 'resume-aligned', token: resume1 });
  assert.deepEqual(state, { phase: 'resuming', token: resume1 });
  const gesture2 = {};
  state = drawingCameraStep(state, { type: 'navigate', token: gesture2 });
  assert.deepEqual(state, { phase: 'suspended', token: gesture2 });
  assert.equal(drawingCameraStep(state, { type: 'resume-ready', token: resume1 }), state, '迟到 resume 不得显现 live');
  const resume2 = {};
  state = drawingCameraStep(state, { type: 'resume-aligned', token: resume2 });
  state = drawingCameraStep(state, { type: 'resume-ready', token: resume2 });
  assert.deepEqual(state, { phase: 'live', token: null });

  const freeze3 = {}, resume3 = {};
  state = drawingCameraStep(undefined, { type: 'navigate', token: freeze3 });
  state = drawingCameraStep(state, { type: 'preview-ready', token: freeze3 });
  state = drawingCameraStep(state, { type: 'resume-aligned', token: resume3 });
  assert.deepEqual(drawingCameraStep(state, { type: 'resume-error', token: resume3 }), { phase: 'live', token: null });
});

test('相机尾部先成功 align 才进入 resuming，期间退出不得重复 align', () => {
  const freeze = {};
  let state = drawingCameraStep(undefined, { type: 'navigate', token: freeze });
  state = drawingCameraStep(state, { type: 'preview-ready', token: freeze });
  assert.deepEqual(state, { phase: 'suspended', token: freeze });

  let alignCount = 0;
  const align = () => { alignCount++; return true; };
  const resume = {};
  assert.equal(align(), true, '本尾部必须先完成唯一一次真实 align');
  state = drawingCameraStep(state, { type: 'resume-aligned', token: resume });
  assert.deepEqual(state, { phase: 'resuming', token: resume }, 'resuming 只表示已 align、仅等双 rAF');

  const policy = drawingCameraExitPolicy(state);
  if (policy.align) align();
  assert.deepEqual(policy, { align: false, keepPreview: true });
  assert.equal(alignCount, 1, '同一尾部在双 rAF 前退出也只能真实 align 一次');
});

test('相机呈现策略只在 live 隐藏且 preview 在场时挂输入盾', () => {
  assert.deepEqual(drawingCameraPresentation({ active: true, visible: true, hasPreview: false }), {
    showShield: false,
  });
  assert.deepEqual(drawingCameraPresentation({ active: true, visible: true, hasPreview: true }), {
    showShield: false,
  }, 'freezing 期 live editor 自己持有输入');
  assert.deepEqual(drawingCameraPresentation({ active: true, visible: false, hasPreview: true }), {
    showShield: true,
  }, 'suspended/resuming 以及保留 preview 的 closing 期必须遮挡 RF');
  assert.deepEqual(drawingCameraPresentation({ active: false, visible: false, hasPreview: true }), {
    showShield: false,
  });
});

test('生产 FlowCanvas 真正消费相机呈现策略，缩放键唯一 owner 在相机钩子', () => {
  const flowCanvas = fs.readFileSync(path.resolve('web/src/canvas/FlowCanvas.jsx'), 'utf8');
  const cameraHook = fs.readFileSync(path.resolve('web/src/canvas/drawing-camera.jsx'), 'utf8');
  const drawLayer = fs.readFileSync(path.resolve('web/src/canvas/DrawLayer.jsx'), 'utf8');
  const css = fs.readFileSync(path.resolve('web/src/theme.css'), 'utf8');
  assert.match(flowCanvas, /drawingCameraPresentation\(\{[\s\S]*active:\s*penActive[\s\S]*visible:\s*drawVisible[\s\S]*hasPreview:\s*!!camera\.draftPreview/);
  assert.match(flowCanvas, /cameraPresentation\.showShield\s*&&[\s\S]*data-drawing-camera-shield/);
  assert.match(cameraHook, /target\s*===\s*document\.body\s*\|\|\s*target\s*===\s*document\.documentElement/,
    '画布点击后焦点回 body 时快捷键仍必须归 RF');
  assert.match(cameraHook, /command\s*===\s*['"]fit['"]\s*\?\s*navigateDrawingFit\(null\)\s*:\s*navigateDrawingZoom\(command\)/,
    'Shift+Digit1/2/3 必须分流到已有 RF 全景事务');
  assert.doesNotMatch(flowCanvas, /drawingZoomKeyCommand/,
    'FlowCanvas 不得再持第二套缩放键 owner——唯一 owner 在 drawing-camera');
  assert.match(css, /\.drawing-camera-shield\s*\{[^}]*z-index:\s*6[^}]*pointer-events:\s*auto/s);
  assert.doesNotMatch(drawLayer, /drawingZoomKeyRoute|onKeyDownCapture=/,
    'DrawLayer 不得保留第二套缩放键 owner');
});

test('align 只有唯一入口在相机钩子，FlowCanvas 与 DrawLayer 不再旁路', () => {
  const flowCanvas = fs.readFileSync(path.resolve('web/src/canvas/FlowCanvas.jsx'), 'utf8');
  const cameraHook = fs.readFileSync(path.resolve('web/src/canvas/drawing-camera.jsx'), 'utf8');
  assert.equal((cameraHook.match(/\.alignViewport\(/g) || []).length, 1,
    '相机钩子内 wrapper 是唯一真实 align 调用点');
  assert.equal((flowCanvas.match(/\.alignViewport\(/g) || []).length, 0,
    'FlowCanvas 不得绕过相机钩子直接 align');
  assert.match(cameraHook, /const alignDrawingViewport\s*=\s*useCallback/);
});

test('exit 抢占 freezing：未 ready preview 必须清掉，迟到 ready 不得再挂双影', async () => {
  const token = {};
  let state = drawingCameraStep(undefined, { type: 'navigate', token });
  let preview = { token, revision: 1 };
  let release;
  const deferredReady = new Promise(resolve => { release = resolve; }).then(() => {
    const next = drawingCameraStep(state, { type: 'preview-ready', token });
    if (next !== state) preview = { token, revision: 2 };
    state = next;
  });

  const policy = drawingCameraExitPolicy(state);
  assert.deepEqual(policy, { align: false, keepPreview: false });
  if (!policy.keepPreview) preview = null;
  state = drawingCameraStep(state, { type: 'reset' });
  release();
  await deferredReady;
  assert.deepEqual(state, { phase: 'live', token: null });
  assert.equal(preview, null, '迟到 preview-ready 不得恢复已清理的静态副本');

  assert.deepEqual(drawingCameraExitPolicy({ phase: 'suspended', token: {} }), { align: true, keepPreview: true });
  assert.deepEqual(drawingCameraExitPolicy({ phase: 'resuming', token: {} }), { align: false, keepPreview: true });
  assert.deepEqual(drawingCameraExitPolicy({ phase: 'live', token: null }), { align: false, keepPreview: false });
});

test('IME 同一 composition 周期只 freeze/toast 一次，end 后解锁下一周期', () => {
  let state;
  let freezes = 0, toasts = 0;
  state = drawingCompositionStep(state, { type: 'start' }).state;
  const navigate = () => {
    const route = drawingCompositionStep(state, { type: 'navigate' });
    state = route.state;
    if (route.action === 'block') return;
    freezes++;
    const blocked = drawingCompositionStep(state, { type: 'blocked', cycle: state.cycle });
    state = blocked.state;
    if (blocked.action === 'notify') toasts++;
  };
  navigate();
  navigate();
  navigate();
  assert.deepEqual({ freezes, toasts }, { freezes: 1, toasts: 1 });

  state = drawingCompositionStep(state, { type: 'end' }).state;
  state = drawingCompositionStep(state, { type: 'start' }).state;
  navigate();
  assert.deepEqual({ freezes, toasts }, { freezes: 2, toasts: 2 });
});

test('pending A 取消后 opening B：A 的迟到 then/catch 必须静默且只有 B ready', async () => {
  const files = { A: binary('A'), B: binary('B') };
  let releasePersist;
  let markPersistStarted;
  const persistGate = new Promise(resolve => { releasePersist = resolve; });
  const persistStarted = new Promise(resolve => { markPersistStarted = resolve; });
  const queue = createDrawingCommitQueue({ elements: [image('A'), image('B')], files }, async () => {
    markPersistStarted();
    await persistGate;
  });
  const deleteA = queue.submit(base => ({
    elements: deleteDrawingElement(base.elements, 'element-A'), files: base.files,
  }));
  await persistStarted;

  const requestA = {};
  const requestB = {};
  let currentRequest = requestA;
  const createCalls = [];
  const ready = [];
  const toasts = [];

  const openAfterIdle = (request, target) => queue.whenIdle().then(seed => {
    if (!drawingOpeningRequestCurrent(currentRequest, request)) return false;
    const transaction = createDrawingTransaction(seed, target);
    createCalls.push(target);
    if (!transaction) throw new Error(`missing ${target}`);
    ready.push(target);
    currentRequest = null;
    return transaction;
  });
  const failAfterIdle = (request, target) => queue.whenIdle()
    .then(() => { throw new Error(`stale ${target}`); })
    .catch(error => {
      if (!drawingOpeningRequestCurrent(currentRequest, request)) return false;
      currentRequest = null;
      toasts.push(error.message);
      return false;
    });

  const staleThen = openAfterIdle(requestA, 'element-A');
  const staleCatch = failAfterIdle(requestA, 'A');
  currentRequest = null; // cancel opening1(A)
  currentRequest = requestB; // opening2(B)
  const currentThen = openAfterIdle(requestB, 'element-B');
  releasePersist();

  const [staleResult, staleCatchResult, transactionB] = await Promise.all([staleThen, staleCatch, currentThen]);
  await deleteA;
  assert.equal(staleResult, false);
  assert.equal(staleCatchResult, false);
  assert.deepEqual(createCalls, ['element-B']);
  assert.deepEqual(transactionB.elements.map(element => element.id), ['element-B']);
  assert.deepEqual(Object.keys(transactionB.files), ['B']);
  assert.deepEqual(ready, ['element-B']);
  assert.deepEqual(toasts, []);
  assert.equal(currentRequest, null);
  assert.deepEqual(queue.snapshot().elements.map(element => element.id), ['element-B']);
  assert.equal(queue.snapshot().files.B, files.B);
});

test('opening 尚未 ready 就 early exit：closing success 必须收口 opening 门并 resolve(false)', () => {
  assert.deepEqual(drawingClosingHandoffStep({ hasOpeningResolver: true }), {
    opening: false,
    openingPromise: null,
    openingResolver: null,
    resolveOpeningWith: false,
  });
  assert.deepEqual(drawingClosingHandoffStep(), {
    opening: false,
    openingPromise: null,
    openingResolver: null,
    resolveOpeningWith: null,
  });
});

test('drawing image store round-trips valid files and rejects malformed entries', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-canvas-drawing-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const saved = saveDrawingFiles(dir, {
    good_id: binary('good_id'),
    '../escape': binary('../escape'),
    broken: { id: 'broken', dataURL: 'https://example.com/not-local-data' },
  });

  assert.deepEqual(Object.keys(saved), ['good_id']);
  assert.deepEqual(loadDrawingFiles(dir), saved);
  assert.deepEqual(normalizeDrawingFiles([]), {});
});

// ============================================================
//  普通模式的绘图命中：描边带可选中，空心内部穿透，后画者优先
// ============================================================
const rect = (id, x, y, w, h, extra = {}) => ({
  id, type: 'rectangle', x, y, width: w, height: h,
  backgroundColor: 'transparent', isDeleted: false, locked: false, ...extra,
});

test('空心矩形只认描边带：边缘命中，中空区域穿透给底下的卡片', () => {
  const els = [rect('frame', 100, 100, 400, 200)];
  assert.equal(hitDrawingElement(els, 100, 200, 8)?.id, 'frame');   // 左边缘
  assert.equal(hitDrawingElement(els, 300, 104, 8)?.id, 'frame');   // 上边缘带内
  assert.equal(hitDrawingElement(els, 300, 200, 8), null);          // 正中空心
  assert.equal(hitDrawingElement(els, 50, 50, 8), null);            // 界外
});

test('显式选绘图扩大空心封闭形状命中：中心可选，普通模式仍穿透', () => {
  const diamond = {
    id: 'diamond', type: 'diamond', x: 100, y: 100, width: 200, height: 120,
    backgroundColor: 'transparent', isDeleted: false, locked: false,
  };
  assert.equal(hitDrawingElement([diamond], 200, 160, 8), null);
  assert.equal(hitDrawingElement(
    [diamond], 200, 160, 8, { includeHollowInterior: true },
  )?.id, 'diamond');
  assert.equal(hitDrawingElement(
    [diamond], 90, 90, 8, { includeHollowInterior: true },
  ), null, '扩大热区不得越过形状外缘');
});

test('FlowCanvas 仅在显式选绘图待选态扩大空心封闭形状热区', () => {
  const source = fs.readFileSync(path.resolve('web/src/canvas/FlowCanvas.jsx'), 'utf8');
  assert.match(source, /const hitOptions = \{ includeHollowInterior: selectArmedRef\.current \};/);
  assert.equal((source.match(/hitDrawingElement\([^;]+hitOptions\)/g) || []).length, 2,
    '浮层与沉层命中必须共用待选态热区合同');
});

test('实心/填充元素与文字全域命中；已删除与锁定跳过；后画者优先', () => {
  const solid = rect('solid', 0, 0, 100, 100, { backgroundColor: '#ffd43b' });
  const text = { id: 'txt', type: 'text', x: 20, y: 20, width: 60, height: 24, isDeleted: false, locked: false };
  const dead = rect('dead', 0, 0, 100, 100, { isDeleted: true });
  const locked = rect('lock', 0, 0, 100, 100, { locked: true });
  assert.equal(hitDrawingElement([solid], 50, 50, 8)?.id, 'solid');            // 有填充=实心，全域命中
  assert.equal(hitDrawingElement([solid, text], 40, 30, 8)?.id, 'txt');        // 后画者优先
  assert.equal(hitDrawingElement([dead, locked], 50, 50, 8), null);            // 墓碑与锁定不挡路
});

test('容差随缩放语义：小容差下边缘带收窄，负宽高元素照常命中', () => {
  const els = [rect('frame', 100, 100, 400, 200)];
  assert.equal(hitDrawingElement(els, 300, 112, 2), null);                     // 带宽 2px 时 12px 深处已是空心
  const flipped = [rect('flip', 500, 300, -400, -200)];                        // 反向拖出的形状
  assert.equal(hitDrawingElement(flipped, 100, 200, 8)?.id, 'flip');
});

test('斜线与箭头只认墨迹线段：空腹穿透，线上命中（含 freedraw 折线）', () => {
  const arrow = { id: 'a', type: 'arrow', x: 0, y: 0, width: 300, height: 300, points: [[0, 0], [300, 300]], isDeleted: false, locked: false };
  assert.equal(hitDrawingElement([arrow], 150, 150, 8)?.id, 'a');   // 对角墨迹上
  assert.equal(hitDrawingElement([arrow], 250, 50, 8), null);       // 包围盒内右上空腹——不是玻璃
  const free = { id: 'f', type: 'freedraw', x: 10, y: 10, width: 100, height: 4, points: [[0, 0], [50, 2], [100, 0]], isDeleted: false, locked: false };
  assert.equal(hitDrawingElement([free], 60, 13, 8)?.id, 'f');
});

test('旋转元素命中跟着视觉走：旋转 90° 的扁矩形描边带命中，旧包围盒右端穿透', () => {
  const r = rect('rot', 100, 100, 200, 20, { angle: Math.PI / 2 });
  assert.equal(hitDrawingElement([r], 200, 12, 8)?.id, 'rot');      // 旋转后竖条顶端描边带
  assert.equal(hitDrawingElement([r], 290, 110, 8), null);          // 旋转前的横条右端已无墨迹
});

test('容器承载律：中心落在容器内的墨迹跟随，绑定标签随宿主，界外与墓碑不跟', () => {
  const rect = { x: 100, y: 100, w: 400, h: 300 };
  const els = [
    { id: 'in', type: 'rectangle', x: 150, y: 150, width: 100, height: 60 },            // 中心 (200,180) 在内
    { id: 'label', type: 'text', x: 160, y: 160, width: 60, height: 20, containerId: 'in' },
    { id: 'edge-out', type: 'rectangle', x: 450, y: 350, width: 200, height: 200 },     // 中心 (550,450) 在外
    { id: 'dead', type: 'rectangle', x: 200, y: 200, width: 10, height: 10, isDeleted: true },
    { id: 'arrow-in', type: 'arrow', x: 120, y: 120, width: 0, height: 0, points: [[0, 0], [100, 100]] },  // 中心 (170,170) 在内
  ];
  const ids = anchoredDrawingIds(els, rect).sort();
  assert.deepEqual(ids, ['arrow-in', 'in', 'label']);
  assert.deepEqual(anchoredDrawingIds([], rect), []);
});

test('连续整理只保留最近一步撤销，R0→R1→R2 后一次撤销使容器与墨迹同回 R1', () => {
  const r0Layout = { board: { x: 0, y: 0 } };
  const r1Layout = { board: { x: 100, y: 0 } };
  let ticket = createDrawingArrangeUndoTicket(r0Layout, [
    { rect: { x: 0, y: 0, w: 50, h: 50 }, dx: 100, dy: 0 },
  ]);
  ticket = createDrawingArrangeUndoTicket(r1Layout, [
    { rect: { x: 100, y: 0, w: 50, h: 50 }, dx: 100, dy: 0 },
  ]);

  assert.equal(ticket.snapshot, r1Layout);
  assert.deepEqual(ticket.undoMoves, [
    { rect: { x: 200, y: 0, w: 50, h: 50 }, dx: -100, dy: 0 },
  ]);
  const inkAtR2 = [rect('ink', 210, 10, 20, 20)];
  const move = ticket.undoMoves[0];
  const restored = translateDrawingElements(
    inkAtR2,
    anchoredDrawingIds(inkAtR2, move.rect),
    move.dx,
    move.dy,
  );
  assert.equal(restored[0].x, 110);
});

test('绘图命中功能件排除表覆盖 nodrag、React Flow 连接点与 Excalidraw 功能岛', () => {
  const selectors = new Set(DRAWING_HIT_BLOCK.split(',').map(selector => selector.trim()));
  assert.equal(selectors.has('.nodrag'), true);
  assert.equal(selectors.has('.react-flow__handle'), true);
  assert.equal(selectors.has('.Island'), true, '锁定版 Excalidraw 的功能岛类名区分大小写');
  assert.equal(selectors.has('.excalidraw'), false, '真实 Excalidraw canvas 空白仍必须允许退场');
});

test('DrawLayer 在建立空点退场与大底板手势前先排除编辑器功能岛', () => {
  const source = fs.readFileSync(path.resolve('web/src/canvas/DrawLayer.jsx'), 'utf8');
  const start = source.indexOf('const onDown = e => {');
  const end = source.indexOf('const onUp = e => {', start);
  assert.ok(start >= 0 && end > start, 'DrawLayer 必须保留可审计的 onDown/onUp 边界');
  const onDown = source.slice(start, end);
  const guard = onDown.indexOf('e.target.closest?.(DRAWING_HIT_BLOCK)');
  const clear = onDown.indexOf('downRef.current = null', guard);
  const cancel = onDown.indexOf('cancelAutoExit()');
  const begin = onDown.indexOf("type: 'begin'");
  const track = onDown.indexOf('downRef.current = {');
  assert.ok(guard >= 0, 'DrawLayer onDown 必须复用共享 DRAWING_HIT_BLOCK');
  assert.ok(clear > guard, '功能岛 pointerdown 必须清理任何旧 downRef');
  assert.match(onDown.slice(guard, cancel), /downRef\.current = null;\s*return;/,
    '功能岛必须立即退出 onDown');
  assert.ok(guard < cancel && guard < begin && guard < track,
    '功能岛门必须早于 auto-exit 状态和空点退场候选建立');
});

test('双平面分流：customData.below 沉层与浮层各归各，顺序保留', () => {
  const els = [
    rect('zone', 0, 0, 500, 300, { customData: { below: true } }),
    rect('note1', 10, 10, 50, 50),
    rect('zone2', 600, 0, 200, 200, { customData: { below: true } }),
    rect('note2', 70, 10, 50, 50),
  ];
  const { below, above } = splitDrawingPlanes(els);
  assert.deepEqual(below.map(e => e.id), ['zone', 'zone2']);
  assert.deepEqual(above.map(e => e.id), ['note1', 'note2']);
  assert.deepEqual(splitDrawingPlanes([]).below, []);
});

test('plane 签名跨持久化深克隆复用，仍辨认本地几何、Excal 版本与绘制顺序', () => {
  const first = rect('first', 0, 0, 100, 80, { version: 1, versionNonce: 11, index: 'a0' });
  const second = rect('second', 120, 0, 100, 80, { version: 1, versionNonce: 12, index: 'a1' });
  const baseline = drawingPlaneSignature([first, second], {});

  assert.equal(
    drawingPlaneSignaturesEqual(baseline, drawingPlaneSignature([first, second], {})),
    true,
    '只换外层数组不得误判为绘图变更',
  );
  assert.equal(
    drawingPlaneSignaturesEqual(baseline, drawingPlaneSignature([{ ...first }, { ...second }], {})),
    true,
    'API/JSON 回读的同视觉深克隆不得让两平面全脏',
  );
  const locallyMoved = { ...first, x: 5 };
  assert.equal(
    drawingPlaneSignaturesEqual(baseline, drawingPlaneSignature([locallyMoved, second], {})),
    false,
    '应用内同 version 的不可变几何变换也必须变脏',
  );

  first.x = 9;
  first.version = 2;
  assert.equal(
    drawingPlaneSignaturesEqual(baseline, drawingPlaneSignature([first, second], {})),
    false,
    'Excal 对同一对象原地推进 version 不得漏掉',
  );
  assert.equal(
    drawingPlaneSignaturesEqual(baseline, drawingPlaneSignature([second, first], {})),
    false,
    '顺序与 index 是 z-order 真相的一部分',
  );
});

test('plane dirty plan 只脏化层级或 hole 真正影响的平面', () => {
  const zone = rect('zone', 0, 0, 500, 400, { customData: { below: true }, version: 1 });
  const note = rect('note', 20, 20, 80, 60, { version: 1 });
  const beforePlanes = splitDrawingPlanes([zone, note]);
  const before = {
    below: drawingPlaneSignature(beforePlanes.below, {}),
    above: drawingPlaneSignature(beforePlanes.above, {}),
  };
  const sameRevisionContent = {
    below: drawingPlaneSignature([...beforePlanes.below], {}),
    above: drawingPlaneSignature([...beforePlanes.above], {}),
  };
  assert.deepEqual(drawingPlaneDirtyPlan(before, sameRevisionContent), { below: false, above: false, count: 0 });

  const visible = drawingTransactionVisibleElements([zone, note], ['note']);
  const holedPlanes = splitDrawingPlanes(visible);
  const holed = {
    below: drawingPlaneSignature(holedPlanes.below, {}),
    above: drawingPlaneSignature(holedPlanes.above, {}),
  };
  assert.deepEqual(drawingPlaneDirtyPlan(before, holed), { below: false, above: true, count: 1 });

  const floatedPlanes = splitDrawingPlanes(setDrawingElementPlane([zone, note], 'zone', false));
  const floated = {
    below: drawingPlaneSignature(floatedPlanes.below, {}),
    above: drawingPlaneSignature(floatedPlanes.above, {}),
  };
  assert.deepEqual(drawingPlaneDirtyPlan(before, floated), { below: true, above: true, count: 2 });
});

test('plane 工作路由优先复用 ready，其次 join 同签名在途，旧 promise 不清新世代', () => {
  const ready = drawingPlaneSignature([rect('ready', 0, 0, 10, 10, { version: 1 })], {});
  const pending = drawingPlaneSignature([rect('pending', 0, 0, 10, 10, { version: 1 })], {});
  const changed = drawingPlaneSignature([rect('changed', 0, 0, 10, 10, { version: 1 })], {});

  assert.equal(drawingPlaneWorkRoute(ready, pending, ready, true), 'ready');
  assert.equal(drawingPlaneWorkRoute(ready, pending, pending, true), 'join');
  assert.equal(drawingPlaneWorkRoute(ready, pending, changed, true), 'export');
  assert.equal(drawingPlaneWorkRoute(ready, pending, drawingPlaneSignature([], {}), false), 'clear');

  const oldPromise = Promise.resolve('old');
  const newPromise = Promise.resolve('new');
  const newer = { signature: changed, promise: newPromise };
  assert.equal(drawingPlaneSettledInFlight(newer, oldPromise), newer, '旧导出迟到不得清掉新世代');
  assert.equal(drawingPlaneSettledInFlight(newer, newPromise), null, '只有当前 promise 可清自己');
});

test('rendered frame 只接受当前 requested revision，cold 无命中且 stale 始终保留旧帧', () => {
  const oldWorld = { elements: [rect('old-visible', 0, 0, 20, 20)], files: {}, revision: 7 };
  const nextWorld = { elements: [rect('next-visible', 100, 0, 20, 20)], files: {}, revision: 8 };
  let frame = drawingFrameTruthStep(undefined, { type: 'request', revision: 7 });

  assert.equal(frame.phase, 'cold');
  assert.deepEqual(drawingFrameHitElements(frame), [], 'cold export 前不得暴露隐形热区');
  assert.equal(drawingFrameTruthStep(frame, { type: 'ready', revision: 6, world: oldWorld }), frame,
    '迟到 ready 不得冒充当前帧');

  frame = drawingFrameTruthStep(frame, { type: 'ready', revision: 7, world: oldWorld });
  assert.equal(frame.phase, 'ready');
  assert.deepEqual(drawingFrameHitElements(frame).map(element => element.id), ['old-visible']);

  frame = drawingFrameTruthStep(frame, { type: 'request', revision: 8 });
  assert.equal(frame.phase, 'updating');
  assert.deepEqual(drawingFrameHitElements(frame).map(element => element.id), ['old-visible'],
    '新 SVG 未 paint 前命中仍必须跟旧像素同代');
  assert.equal(drawingFrameTruthStep(frame, { type: 'error', revision: 7, error: new Error('late') }), frame,
    '迟到 error 不得污染新世代');

  frame = drawingFrameTruthStep(frame, {
    type: 'error', revision: 8, error: new Error('retry me'), attempt: 1, willRetry: true,
  });
  assert.equal(frame.phase, 'retrying');
  assert.deepEqual(drawingFrameHitElements(frame).map(element => element.id), ['old-visible']);
  frame = drawingFrameTruthStep(frame, {
    type: 'error', revision: 8, error: new Error('final'), attempt: 3, willRetry: false,
  });
  assert.equal(frame.phase, 'stale');
  assert.deepEqual(drawingFrameHitElements(frame).map(element => element.id), ['old-visible']);

  frame = drawingFrameTruthStep(frame, { type: 'ready', revision: 8, world: nextWorld });
  assert.equal(frame.phase, 'ready');
  assert.equal(frame.renderedWorld.revision, 8);
  assert.deepEqual(drawingFrameHitElements(frame).map(element => element.id), ['next-visible']);
});

test('frame export 重试固定最多三次并使用小幅退避', () => {
  assert.deepEqual(drawingFrameRetryDecision(1), { retry: true, nextAttempt: 2, delayMs: 40 });
  assert.deepEqual(drawingFrameRetryDecision(2), { retry: true, nextAttempt: 3, delayMs: 80 });
  assert.deepEqual(drawingFrameRetryDecision(3), { retry: false, nextAttempt: 3, delayMs: 0 });
  assert.deepEqual(drawingFrameRetryDecision(99), { retry: false, nextAttempt: 3, delayMs: 0 });
});

test('InkWorld SVG 固定 1x 导出尺寸，Retina 下视觉与 RF 命中几何同尺', () => {
  const source = fs.readFileSync(path.resolve('web/src/canvas/InkWorldLayer.jsx'), 'utf8');
  assert.match(source, /exportScale:\s*1/,
    'committed SVG 不得继承 devicePixelRatio 放大 width/height');
});

test('4518 帧探针只能驱动真实 open/exit，故障只能从 InkWorld exporter 注入', () => {
  const fixture = fs.readFileSync(path.resolve('tests/fixtures/canvas-acceptance/interaction-data.js'), 'utf8');
  const flowCanvas = fs.readFileSync(path.resolve('web/src/canvas/FlowCanvas.jsx'), 'utf8');
  const inkWorld = fs.readFileSync(path.resolve('web/src/canvas/InkWorldLayer.jsx'), 'utf8');

  assert.doesNotMatch(fixture, /beginHandoff|injectReady|injectError/,
    'fixture 不得手工写 handoff 或伪造 ready/error');
  assert.match(fixture, /frameTestProbeRef\.current\?*\.openDrawing\(/,
    'opening 必须调用 production openDrawing');
  assert.match(fixture, /frameTestProbeRef\.current\?*\.exitDrawing\(/,
    'closing 必须调用 production exitDrawing');
  assert.match(flowCanvas, /openDrawing:\s*\(tool, selectId\)\s*=>\s*openDrawing\(tool, selectId\)/);
  assert.match(flowCanvas, /exitDrawing:\s*\(\)\s*=>\s*exitDrawing\(\)/);
  assert.doesNotMatch(flowCanvas, /beginHandoff|injectReady|injectError/,
    'production probe 不得直接触碰 callback reducer/handoff refs');
  assert.match(inkWorld, /exporterProbe\?\.exportToSvg/,
    '导出故障 seam 必须位于真实 InkWorld exporter 边界');
});

test('4518 尾窗证伪只由可见按钮武装只读 rAF+timer 双时钟，不自造输入', () => {
  const fixture = fs.readFileSync(path.resolve('tests/fixtures/canvas-acceptance/interaction-data.js'), 'utf8');
  const checkNamesSource = fixture.match(/const CHECK_NAMES\s*=\s*Object\.freeze\(\[([^\]]+)]\)/)?.[1] || '';
  const tailHarnessSource = fixture.match(/const writeCameraTailProof[\s\S]+?(?=\n  const publish)/)?.[0] || '';
  const cleanupSource = fixture.match(/const cleanupCameraTailRun[\s\S]+?(?=\n  const failCameraTailRun)/)?.[0] || '';
  const cancelSource = fixture.match(/function cancelCameraTailObservation[\s\S]+?(?=\n}\n\nfunction cameraTailCallForRun)/)?.[0] || '';
  const observeSource = tailHarnessSource.match(/const observe = \(activeRun, source\)[\s\S]+?(?=\n    const scheduleRaf)/)?.[0] || '';

  assert.match(fixture, /data-camera-tail-exit-arm/,
    '必须有始终可见、可由 Computer Use 点击的尾窗证伪按钮');
  assert.match(tailHarnessSource, /requestAnimationFrame\([\s\S]+?observe\(run,\s*['"]raf['"]\)/,
    '必须持续预注册 run-scoped rAF 观察 resuming');
  assert.match(tailHarnessSource, /setTimeout\([\s\S]+?observe\(run,\s*['"]timer['"]\)/,
    '必须同时预注册 run-scoped timer 补足后台 rAF 盲窗');
  assert.doesNotMatch(fixture, /cameraTailWatcherRafRef/,
    '观察句柄必须全部归当前 run，不得再跨 run 共享全局 rAF ref');
  assert.match(cleanupSource, /cancelCameraTailObservation\(run\)/,
    'cleanup 必须统一取消当前 run 的 rafId、pollId 与 waitTimeoutId');
  assert.match(cancelSource, /cancelAnimationFrame\(run\.rafId\)/, 'cleanup 必须取消当前 run rafId');
  assert.match(cancelSource, /clearTimeout\(run\.pollId\)/, 'cleanup 必须取消当前 run pollId');
  assert.match(cancelSource, /clearTimeout\(run\.waitTimeoutId\)/, 'cleanup 必须取消等待 resuming 的 watchdog');
  assert.doesNotMatch(observeSource, /shieldSamples/,
    'timer/rAF observe 只能捕获 phase，不得生成 shield 帧样本');
  assert.match(tailHarnessSource, /await nextFrame\(\);[\s\S]+?shieldSamples\.push/,
    'shieldSamples 必须仍只由真实 rAF 帧生成');
  assert.match(tailHarnessSource, /frameTestProbeRef\.current\?\.snapshot\(\)/,
    'watcher 只读 production frameTestProbe snapshot');
  assert.match(tailHarnessSource, /current\?\.pointerResourceActive[\s\S]+?writeCameraTailProof\(run, \{ pointerActiveObserved: true \}\)/,
    'pointer active 仍必须采样并保留为诊断字段');
  assert.match(tailHarnessSource, /frameTestProbeRef\.current\?\.exitDrawing\(\)/,
    '观察到 resuming 后必须调用唯一 production exitDrawing');
  assert.match(tailHarnessSource, /configure\(['"]delay['"],\s*run\.scenario,\s*run\.runToken\)/,
    'selection closing 必须使用本轮唯一 scenario/runToken 注入 dirty export delay');
  assert.match(fixture, /releaseDelayed\(\)/,
    '尾窗取样后必须释放 delayed export');
  assert.match(fixture, /manualProof[\s\S]*cameraTailExit/,
    '报告必须独立暴露 manualProof.cameraTailExit');
  assert.doesNotMatch(checkNamesSource, /cameraTailExit/,
    '人工尾窗 proof 不得混入七项自动 CHECK_NAMES');
  assert.doesNotMatch(tailHarnessSource, /\.openDrawing\s*\(|\.setViewport\s*\(/,
    '尾窗按钮/watcher 不得打开事务或直写 viewport');
  assert.doesNotMatch(fixture, /dispatchEvent\s*\(|new\s+PointerEvent\s*\(|\.click\s*\(|\.focus\s*\(/,
    'fixture 不得派发合成输入、程序点击或焦点切换');
});

test('4518 尾窗双时钟：零 rAF 时 timer 可捕获 resuming，紧邻回调不得双 exit', () => {
  const fixture = fs.readFileSync(path.resolve('tests/fixtures/canvas-acceptance/interaction-data.js'), 'utf8');
  const cameraTailObservationStep = readNamedFunction(fixture, 'cameraTailObservationStep');
  const initial = { resumingHandled: false, observerSource: null, rafTicks: 0, timerTicks: 0 };

  const capturedByTimer = cameraTailObservationStep(initial, 'timer', 'resuming');
  assert.deepEqual(capturedByTimer, {
    resumingHandled: true,
    observerSource: 'timer',
    rafTicks: 0,
    timerTicks: 1,
    capture: true,
  }, 'rAF 一次都未运行时，timer 仍必须捕获且先锁住 handled');

  const adjacentRaf = cameraTailObservationStep(capturedByTimer, 'raf', 'resuming');
  const adjacentTimer = cameraTailObservationStep(adjacentRaf, 'timer', 'resuming');
  assert.equal(adjacentRaf.capture, false, '紧邻 rAF 不得第二次 exit');
  assert.equal(adjacentTimer.capture, false, '紧邻 timer 不得第二次 exit');
  assert.equal(adjacentTimer.observerSource, 'timer', '首个捕获时钟是唯一证据主权');
  assert.deepEqual({ rafTicks: adjacentTimer.rafTicks, timerTicks: adjacentTimer.timerTicks },
    { rafTicks: 1, timerTicks: 2 }, '两种时钟只累计各自观察次数');
});

test('4518 尾窗证据按 call 起点、run token 与 closing revision 三重隔离', () => {
  const fixture = fs.readFileSync(path.resolve('tests/fixtures/canvas-acceptance/interaction-data.js'), 'utf8');
  const cameraTailCallForRun = readNamedFunction(fixture, 'cameraTailCallForRun');
  const cameraTailRunCurrent = readNamedFunction(fixture, 'cameraTailRunCurrent');
  const active = {
    runToken: 2,
    scenario: 'camera-tail-exit-2',
    callStartIndex: 1,
    closingRevision: 22,
  };
  const calls = [
    { callIndex: 0, runToken: 1, scenario: 'camera-tail-exit-1', revision: 11, mode: 'delay', kind: 'group' },
    { callIndex: 1, runToken: 1, scenario: active.scenario, revision: 22, mode: 'delay', kind: 'group' },
    { callIndex: 2, runToken: active.runToken, scenario: active.scenario, revision: 11, mode: 'delay', kind: 'group' },
  ];
  assert.equal(cameraTailCallForRun(calls, active), null,
    '旧历史、旧 token 以及在新 configure 后才到的旧 revision 都不得命中新轮');
  const exact = { callIndex: 3, runToken: 2, scenario: active.scenario, revision: 22, mode: 'delay', kind: 'group' };
  assert.equal(cameraTailCallForRun([...calls, exact], active)?.callIndex, 3,
    '只有本轮起点之后且 token/scenario/revision 精确一致的 call 可被接受');

  const stale = { runToken: 1 };
  assert.equal(cameraTailRunCurrent(active, active), true);
  assert.equal(cameraTailRunCurrent(active, stale), false);
  let status = 'armed';
  const lateTimeout = () => { if (cameraTailRunCurrent(active, stale)) status = 'FAIL'; };
  const lateFailAfterCleanup = () => { if (cameraTailRunCurrent(active, stale)) status = 'FAIL'; };
  lateTimeout();
  lateFailAfterCleanup();
  assert.equal(status, 'armed', '旧 timeout/fail 在 await cleanup 后均不得覆盖新轮 UI');
});

test('4518 interaction fixture 必须被 focused gate 真正构建', async () => {
  const [{ build }, { default: react }] = await Promise.all([
    import('vite'),
    import('@vitejs/plugin-react'),
  ]);
  const fixtureRoot = path.resolve('tests/fixtures/canvas-acceptance');
  const result = await build({
    root: fixtureRoot,
    configFile: false,
    logLevel: 'silent',
    plugins: [react()],
    build: {
      write: false,
      rollupOptions: { input: path.join(fixtureRoot, 'index.html') },
    },
  });
  assert.ok(result, 'fixture Vite build 必须产出 bundle');
});

test('LE-008 Computer Use 原始证据可选注入 focused behavior log 并绑定 candidate', () => {
  const evidencePath = process.env.LE008_COMPUTER_USE_EVIDENCE;
  if (!evidencePath) return;
  assert.equal(path.isAbsolute(evidencePath), true, 'evidence 必须使用绝对路径');
  const raw = fs.readFileSync(evidencePath, 'utf8').trim();
  assert.equal(raw.split(/\r?\n/).length, 1, 'evidence JSON 必须为单行原始 transcript');
  const evidence = JSON.parse(raw);
  const candidateSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.equal(evidence.candidateSha, candidateSha, 'Computer Use 证据必须绑定当前 candidate SHA');
  const checkNames = ['coldError', 'closing', 'concurrent', 'lateIsolation', 'opening', 'revision', 'warmError'];
  assert.deepEqual(Object.keys(evidence.checks || {}).sort(), [...checkNames].sort(), 'checks 必须且只能包含七个具名判准');
  for (const name of checkNames) assert.equal(evidence.checks[name], true, `${name} 必须为 true`);
  assert.ok(Array.isArray(evidence.runs) && evidence.runs.length >= 3, '至少保留三轮 Computer Use 原始结果');
  for (const name of ['consoleErrors', 'consoleWarnings', 'pageErrors', 'apiResources']) {
    assert.ok(Array.isArray(evidence[name]), `${name} 必须保留原始数组`);
    assert.equal(evidence[name].length, 0, `${name} 必须为零`);
  }
  console.log(`LE008_COMPUTER_USE_EVIDENCE ${raw}`);
});

test('LE-009 Computer Use 原始证据可选注入 focused behavior log并绑定局部分组 candidate', () => {
  const evidencePath = process.env.LE009_COMPUTER_USE_EVIDENCE;
  if (!evidencePath) return;
  assert.equal(path.isAbsolute(evidencePath), true, 'evidence 必须使用绝对路径');
  const raw = fs.readFileSync(evidencePath, 'utf8').trim();
  assert.equal(raw.split(/\r?\n/).length, 1, 'evidence JSON 必须为单行原始 transcript');
  const evidence = JSON.parse(raw);
  const candidateSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  assert.equal(evidence.candidateSha, candidateSha, 'Computer Use 证据必须绑定当前 candidate SHA');
  assert.ok(Array.isArray(evidence.runs) && evidence.runs.length >= 3, '至少保留三轮 Computer Use 原始结果');
  for (const name of ['consoleErrors', 'consoleWarnings', 'pageErrors', 'apiResources']) {
    assert.ok(Array.isArray(evidence[name]), `${name} 必须保留原始数组`);
    assert.equal(evidence[name].length, 0, `${name} 必须为零`);
  }
  for (const [runIndex, run] of evidence.runs.entries()) {
    for (const [size, reused] of [[300, 3], [800, 8]]) {
      const report = run?.[String(size)];
      assert.equal(report?.size, size, `run ${runIndex + 1} 必须包含 ${size} report`);
      assert.equal(report?.secondSlotStable, true, `run ${runIndex + 1} ${size} 第二槽首 ID 必须稳定`);
      for (const kind of ['holeOpen', 'holeClose']) {
        const below = report?.[kind]?.metrics?.groupCounts?.below;
        assert.equal(below?.exported, 1, `run ${runIndex + 1} ${size} ${kind} 只导出目标槽`);
        assert.equal(below?.reused, reused, `run ${runIndex + 1} ${size} ${kind} 复用其余槽`);
      }
      assert.equal(report?.holeOpen?.renderedElementCount, size - 1,
        `run ${runIndex + 1} ${size} opening rendered 数必须扣除 excluded`);
      assert.equal(report?.holeClose?.renderedElementCount, size,
        `run ${runIndex + 1} ${size} closing rendered 数必须恢复全量`);
    }
  }
  console.log(`LE009_COMPUTER_USE_EVIDENCE ${raw}`);
});

const LE010_CHECK_NAMES = Object.freeze(['concurrent', 'revision', 'opening', 'closing', 'coldError', 'warmError', 'lateIsolation']);
const LE010_ACTION_NAMES = Object.freeze([
  'hardRefresh', 'openDrawingSelection', 'keyboardZoom', 'zoomIsland', 'highFrequencyNavigation',
  'reopenDrawingSelection', 'armTailWatcher', 'tailNavigation', 'readDiagnostics',
]);
const LE010_SNAPSHOT_STAGES = Object.freeze(['baseline', 'selectionLive', 'highFrequencyLive', 'tailPass', 'final']);
const LE010_CANONICAL_URL = 'http://127.0.0.1:4518/?mode=interaction';
const LE010_ARTIFACT_STAGES = Object.freeze(['address', 'selection', 'tail']);
const LE010_ARTIFACT_KEYS = Object.freeze([
  'id', 'round', 'stage', 'kind', 'relativePath', 'sha256', 'mimeType', 'byteLength', 'width', 'height',
]);
const isNonEmptyEvidenceValue = value => typeof value === 'string'
  ? value.trim().length > 0
  : Array.isArray(value) ? value.length > 0
    : !!value && typeof value === 'object' && Object.keys(value).length > 0;
const isFiniteEvidenceViewport = value => !!value
  && ['x', 'y', 'zoom'].every(key => Number.isFinite(value[key]));

function assertLe010ExactKeys(value, keys, label) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${label} 必须是对象`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} 字段必须精确匹配 schema`);
}

function le010PathInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function le010EvidenceRoot() {
  const commonDir = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: process.cwd(), encoding: 'utf8',
  }).trim();
  return path.join(path.dirname(commonDir), '.loop', 'v2', 'evidence', 'LE-010');
}

function assertLe010Png(buffer, artifact, label) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.ok(buffer.length >= 1024, `${label} PNG 字节过短，不是完整截图`);
  assert.equal(buffer.subarray(0, 8).equals(signature), true, `${label} PNG signature 无效`);
  assert.equal(buffer.readUInt32BE(8), 13, `${label} 首块必须是 13-byte IHDR`);
  assert.equal(buffer.subarray(12, 16).toString('ascii'), 'IHDR', `${label} 首块必须是 IHDR`);
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  assert.ok(width >= 800 && height >= 600, `${label} 必须是至少 800x600 的全屏截图`);
  assert.equal(width, artifact.width, `${label} PNG width 必须匹配 raw`);
  assert.equal(height, artifact.height, `${label} PNG height 必须匹配 raw`);
  const iendOffset = buffer.length - 12;
  assert.equal(buffer.readUInt32BE(iendOffset), 0, `${label} 末块 IEND 长度必须为 0`);
  assert.equal(buffer.subarray(iendOffset + 4, iendOffset + 8).toString('ascii'), 'IEND', `${label} 必须以 IEND 结束`);
}

function assertLe010Artifacts(evidence, candidateSha, evidencePath, evidenceRoot) {
  assert.match(candidateSha, /^[0-9a-f]{40}$/, 'candidate SHA 必须是 40 位小写十六进制');
  assert.ok(typeof evidencePath === 'string' && path.isAbsolute(evidencePath), 'evidencePath 必须是绝对路径');
  const root = path.resolve(evidenceRoot || le010EvidenceRoot());
  const candidateDir = path.join(root, candidateSha);
  const expectedEvidencePath = path.join(candidateDir, 'computer-use.raw.json');
  assert.equal(path.resolve(evidencePath), expectedEvidencePath, 'raw 必须位于当前 LE-010 candidate evidence 目录');
  const evidenceStat = fs.lstatSync(evidencePath);
  assert.equal(evidenceStat.isSymbolicLink(), false, 'raw 不得是 symlink');
  assert.equal(evidenceStat.isFile(), true, 'raw 必须是普通文件');
  const candidateReal = fs.realpathSync(candidateDir);
  const evidenceReal = fs.realpathSync(evidencePath);
  assert.equal(le010PathInside(candidateReal, evidenceReal), true, 'raw realpath 不得越出当前 candidate 目录');

  const expectedIds = [1, 2, 3].flatMap(round => LE010_ARTIFACT_STAGES.map(stage => `round-${round}-${stage}`));
  assert.ok(Array.isArray(evidence.computerUseArtifacts), 'computerUseArtifacts 必须是数组');
  assert.equal(evidence.computerUseArtifacts.length, 9, '必须恰好保留九张 Computer Use 截图');
  assert.deepEqual(evidence.computerUseArtifacts.map(artifact => artifact?.id), expectedIds,
    '截图 artifact 必须严格按三轮 address/selection/tail 排列');
  const hashes = new Set();
  const byId = new Map();
  for (const artifact of evidence.computerUseArtifacts) {
    const label = `artifact ${artifact?.id || '<missing>'}`;
    assertLe010ExactKeys(artifact, LE010_ARTIFACT_KEYS, label);
    const expectedId = `round-${artifact.round}-${artifact.stage}`;
    const expectedRelativePath = `screenshots/${expectedId}.png`;
    assert.ok([1, 2, 3].includes(artifact.round), `${label}.round 必须是 1/2/3`);
    assert.ok(LE010_ARTIFACT_STAGES.includes(artifact.stage), `${label}.stage 必须是 address/selection/tail`);
    assert.equal(artifact.id, expectedId, `${label}.id 必须由 round/stage 唯一决定`);
    assert.equal(artifact.kind, 'computer-use-screenshot', `${label}.kind 必须固定`);
    assert.equal(artifact.relativePath, expectedRelativePath, `${label}.relativePath 必须固定且不得穿越`);
    assert.equal(artifact.mimeType, 'image/png', `${label}.mimeType 必须为 image/png`);
    assert.match(artifact.sha256, /^[0-9a-f]{64}$/, `${label}.sha256 必须是 64 位小写十六进制`);
    assert.ok(Number.isInteger(artifact.byteLength) && artifact.byteLength >= 1024, `${label}.byteLength 必须是完整截图字节数`);
    assert.ok(Number.isInteger(artifact.width) && artifact.width >= 800, `${label}.width 必须至少 800`);
    assert.ok(Number.isInteger(artifact.height) && artifact.height >= 600, `${label}.height 必须至少 600`);

    const artifactPath = path.resolve(candidateDir, artifact.relativePath);
    assert.equal(artifactPath, path.join(candidateDir, expectedRelativePath), `${label} resolve 路径必须精确匹配`);
    assert.equal(le010PathInside(candidateDir, artifactPath), true, `${label} resolve 不得越出 candidate 目录`);
    const stat = fs.lstatSync(artifactPath);
    assert.equal(stat.isSymbolicLink(), false, `${label} 不得是 symlink`);
    assert.equal(stat.isFile(), true, `${label} 必须是普通文件`);
    const realPath = fs.realpathSync(artifactPath);
    assert.equal(le010PathInside(candidateReal, realPath), true, `${label} realpath 不得越出 candidate 目录`);
    const buffer = fs.readFileSync(realPath);
    assert.equal(buffer.length, artifact.byteLength, `${label} byteLength 必须匹配文件`);
    assert.equal(createHash('sha256').update(buffer).digest('hex'), artifact.sha256, `${label} sha256 必须匹配文件`);
    assertLe010Png(buffer, artifact, label);
    assert.equal(hashes.has(artifact.sha256), false, `${label} 不得复用其他阶段的截图字节`);
    hashes.add(artifact.sha256);
    byId.set(artifact.id, artifact);
  }
  return byId;
}

function assertLe010Checks(checks, label) {
  assert.deepEqual(Object.keys(checks || {}).sort(), [...LE010_CHECK_NAMES].sort(),
    `${label} checks 必须且只能包含七个生产判准`);
  for (const name of LE010_CHECK_NAMES) assert.equal(checks[name], true, `${label}.${name} 必须为 true`);
}

function assertLe010DragCoordinates(coordinates, label) {
  assert.ok(Array.isArray(coordinates) && coordinates.length > 0, `${label}.coordinates 必须非空`);
  const isPoint = point => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite);
  const segments = coordinates.length === 2 && coordinates.every(isPoint) ? [coordinates] : coordinates;
  assert.ok(segments.length > 0, `${label}.coordinates 必须至少有一段`);
  for (const [segmentIndex, segment] of segments.entries()) {
    assert.ok(Array.isArray(segment) && segment.length === 2 && segment.every(isPoint),
      `${label}.coordinates[${segmentIndex}] 必须是两个有限数坐标点`);
  }
}

function assertLe010ProductionSnapshot(snapshot, stage, label) {
  const production = snapshot?.production;
  assert.ok(production && typeof production === 'object', `${label}.${stage}.production 必须保留生产快照`);
  assert.ok(Number.isFinite(production.requestedRevision), `${label}.${stage} requestedRevision 必须有限`);
  assert.ok(Number.isFinite(production.renderedRevision), `${label}.${stage} renderedRevision 必须有限`);
  assert.ok(isNonEmptyEvidenceValue(production.framePhase), `${label}.${stage} framePhase 必须非空`);
  assert.ok(isNonEmptyEvidenceValue(production.cameraPhase), `${label}.${stage} cameraPhase 必须非空`);
  for (const key of ['opening', 'penActive', 'drawVisible', 'cameraShield', 'pointerResourceActive']) {
    assert.equal(typeof production[key], 'boolean', `${label}.${stage}.production.${key} 必须是布尔生产观测`);
  }
  assert.ok(isFiniteEvidenceViewport(production.viewport), `${label}.${stage} viewport 必须全为有限数`);
  if (stage === 'baseline' || stage === 'tailPass' || stage === 'final') {
    assert.equal(production.opening, false, `${label}.${stage} 不得残留 opening`);
    assert.equal(production.cameraPhase, 'live', `${label}.${stage} 相机必须是 live`);
  }
  if (stage === 'selectionLive' || stage === 'highFrequencyLive') {
    assert.equal(production.penActive, true, `${label}.${stage} 必须在真实绘图事务中`);
    assert.equal(production.drawVisible, true, `${label}.${stage} live editor 必须可见`);
    assert.equal(production.opening, false, `${label}.${stage} opening 必须已收口`);
    assert.equal(production.cameraPhase, 'live', `${label}.${stage} 取样时相机必须已恢复 live`);
  }
}

function assertLe010ComputerUseEvidence(evidence, candidateSha, evidencePath, { evidenceRoot } = {}) {
  assert.equal(evidence.candidateSha, candidateSha, 'Computer Use 证据必须绑定当前 candidate SHA');
  assert.equal(evidence.fixtureOnly, true, '只允许 4518 synthetic fixture');
  assert.equal(evidence.fixtureUrl, LE010_CANONICAL_URL, 'fixtureUrl 必须逐字绑定 4518 interaction fixture');
  assert.equal(evidence.realCanvasCoordinateDrag, false, '不得在真实画布做坐标拖拽');
  assert.equal(evidence.overallPassed, true, '顶层 overallPassed 必须为 true');
  assert.equal(evidence.verdict, 'PASS', '顶层 verdict 必须为 PASS');
  for (const name of ['errors', 'validationErrors']) {
    assert.ok(Array.isArray(evidence[name]), `顶层 ${name} 必须保留原始数组`);
    assert.equal(evidence[name].length, 0, `顶层 ${name} 必须为零`);
  }
  assert.ok(Array.isArray(evidence.runs), 'runs 必须是数组');
  assert.equal(evidence.runs.length, 3, '必须恰好保留三轮 fresh Computer Use 原始结果');
  assert.deepEqual(evidence.runs.map(run => run?.round), [1, 2, 3], 'round 必须严格为唯一有序的 1/2/3');
  const artifactsById = assertLe010Artifacts(evidence, candidateSha, evidencePath, evidenceRoot);

  for (const [index, run] of evidence.runs.entries()) {
    const label = `run ${index + 1}`;
    assert.equal(run?.passed, true, `${label} passed 必须为 true`);
    assert.ok(Array.isArray(run?.errors), `${label} errors 必须保留原始数组`);
    assert.equal(run.errors.length, 0, `${label} errors 必须为零`);

    assert.ok(Array.isArray(run?.actions) && run.actions.length > 0, `${label} actions 必须非空`);
    assert.deepEqual(run.actions.map(action => action?.action), [...LE010_ACTION_NAMES],
      `${label} action 必须严格按九步 UI 顺序`);
    const [hardRefresh, openSelection, keyboardAction, zoomAction, highFrequencyAction,
      reopenAction, armAction, tailAction, diagnosticsAction] = run.actions;
    const addressId = `round-${run.round}-address`;
    const selectionId = `round-${run.round}-selection`;
    const tailId = `round-${run.round}-tail`;
    assert.equal(artifactsById.get(addressId)?.round, run.round, `${label} address artifact 必须属于本轮`);
    assert.equal(artifactsById.get(selectionId)?.round, run.round, `${label} selection artifact 必须属于本轮`);
    assert.equal(artifactsById.get(tailId)?.round, run.round, `${label} tail artifact 必须属于本轮`);

    assertLe010ExactKeys(hardRefresh, ['action', 'input', 'observed'], `${label}.hardRefresh`);
    assertLe010ExactKeys(hardRefresh.input, ['shortcut', 'url', 'artifactId'], `${label}.hardRefresh.input`);
    assertLe010ExactKeys(hardRefresh.observed, ['status', 'requestedRevision', 'renderedRevision'], `${label}.hardRefresh.observed`);
    assert.deepEqual(hardRefresh.input, { shortcut: 'super+shift+r', url: LE010_CANONICAL_URL, artifactId: addressId },
      `${label} hardRefresh 必须逐字绑定本轮 4518 地址截图`);
    assert.equal(hardRefresh.observed.status, 'pass', `${label} hardRefresh status 必须为 pass`);
    assert.ok(Number.isFinite(hardRefresh.observed.requestedRevision), `${label} hardRefresh requestedRevision 必须有限`);
    assert.ok(Number.isFinite(hardRefresh.observed.renderedRevision), `${label} hardRefresh renderedRevision 必须有限`);

    assertLe010ExactKeys(openSelection, ['action', 'input', 'observed'], `${label}.openDrawingSelection`);
    assertLe010ExactKeys(openSelection.input, ['product', 'strokeClick', 'source', 'artifactId'], `${label}.openDrawingSelection.input`);
    assertLe010ExactKeys(openSelection.observed, ['requestedRevision', 'renderedRevision', 'zoomControlCount'], `${label}.openDrawingSelection.observed`);
    assert.equal(openSelection.input.product, '选绘图', `${label} 必须从产品“选绘图”入口进入`);
    assert.equal(openSelection.input.source, 'current screenshot', `${label} selection source 必须是当前截图`);
    assert.equal(openSelection.input.artifactId, selectionId, `${label} selection 必须引用本轮截图`);
    assert.ok(Array.isArray(openSelection.input.strokeClick) && openSelection.input.strokeClick.length === 2
      && openSelection.input.strokeClick.every(Number.isFinite), `${label} strokeClick 必须是有限坐标点`);
    assert.ok(Number.isFinite(openSelection.observed.requestedRevision), `${label} selection requestedRevision 必须有限`);
    assert.ok(Number.isFinite(openSelection.observed.renderedRevision), `${label} selection renderedRevision 必须有限`);
    assert.ok(Number.isInteger(openSelection.observed.zoomControlCount) && openSelection.observed.zoomControlCount >= 5,
      `${label} selection 必须看到至少五个缩放控件`);

    assertLe010ExactKeys(keyboardAction, ['action', 'input', 'observed'], `${label}.keyboardZoom`);
    assertLe010ExactKeys(keyboardAction.observed, ['fitSamples'], `${label}.keyboardZoom.observed`);
    assert.deepEqual(keyboardAction.input,
      ['super+plus', 'super+minus', 'super+0', 'Shift+Digit1', 'Shift+Digit2', 'Shift+Digit3'],
      `${label} keyboardZoom.input 必须严格按六个快捷键顺序`);

    assertLe010ExactKeys(zoomAction, ['action', 'input', 'observed'], `${label}.zoomIsland`);
    assertLe010ExactKeys(zoomAction.observed, ['viewports'], `${label}.zoomIsland.observed`);
    assert.deepEqual(zoomAction.input, ['minus', 'plus', '100%', 'fit'], `${label} zoomIsland.input 必须严格有序`);
    assert.ok(Array.isArray(zoomAction.observed.viewports) && zoomAction.observed.viewports.length === 4
      && zoomAction.observed.viewports.every(isFiniteEvidenceViewport), `${label} zoomIsland 必须保留四个有限 viewport`);

    assertLe010ExactKeys(highFrequencyAction, ['action', 'input', 'coordinates', 'observed'], `${label}.highFrequencyNavigation`);
    assertLe010ExactKeys(highFrequencyAction.input, ['sequence', 'gestureCount'], `${label}.highFrequencyNavigation.input`);
    assertLe010ExactKeys(highFrequencyAction.observed,
      ['delta', 'pointerAcquisitionDelta', 'pointerCleanupDelta'], `${label}.highFrequencyNavigation.observed`);
    assertLe010ExactKeys(highFrequencyAction.observed.delta,
      ['performed', 'gestureCount', 'shieldFrameDelta', 'viewportWriteDelta', 'nodePointerDelta'],
      `${label}.highFrequencyNavigation.observed.delta`);
    assert.deepEqual(highFrequencyAction.input, { sequence: ['hand', '产品选绘图', 'hand'], gestureCount: 3 },
      `${label} 高频导航 input 必须是三次真实手工具序列`);
    assertLe010DragCoordinates(highFrequencyAction.coordinates, `${label}.highFrequencyNavigation`);

    assertLe010ExactKeys(reopenAction, ['action', 'input', 'observed'], `${label}.reopenDrawingSelection`);
    assertLe010ExactKeys(reopenAction.input, ['product'], `${label}.reopenDrawingSelection.input`);
    assertLe010ExactKeys(reopenAction.observed, ['editorLive', 'zoomControlCount'], `${label}.reopenDrawingSelection.observed`);
    assert.deepEqual(reopenAction.input, { product: '选绘图' }, `${label} reopen 必须只走产品入口`);
    assert.equal(reopenAction.observed.editorLive, true, `${label} reopen 后 editor 必须 live`);
    assert.ok(Number.isInteger(reopenAction.observed.zoomControlCount) && reopenAction.observed.zoomControlCount >= 5,
      `${label} reopen 必须看到至少五个缩放控件`);

    assertLe010ExactKeys(armAction, ['action', 'input', 'observed'], `${label}.armTailWatcher`);
    assertLe010ExactKeys(armAction.input, ['visibleButton'], `${label}.armTailWatcher.input`);
    assertLe010ExactKeys(armAction.observed, ['status', 'runToken', 'armVisibility'], `${label}.armTailWatcher.observed`);
    assert.deepEqual(armAction.input, { visibleButton: '尾窗证伪：idle' }, `${label} 必须由可见按钮武装`);
    assert.equal(armAction.observed.status, 'armed', `${label} watcher 必须进入 armed`);

    assertLe010ExactKeys(tailAction, ['action', 'input', 'coordinates', 'observed'], `${label}.tailNavigation`);
    assertLe010ExactKeys(tailAction.input, ['sequence', 'attempt'], `${label}.tailNavigation.input`);
    assertLe010ExactKeys(tailAction.observed,
      ['status', 'observerSource', 'acquisitionDelta', 'cleanupDelta', 'viewportWriteDelta'],
      `${label}.tailNavigation.observed`);
    assert.deepEqual(tailAction.input, { sequence: ['hand', 'left drag'], attempt: 1 },
      `${label} tail 必须是一次真实手工具左拖`);
    assertLe010DragCoordinates(tailAction.coordinates, `${label}.tailNavigation`);

    assertLe010ExactKeys(diagnosticsAction, ['action', 'input', 'observed'], `${label}.readDiagnostics`);
    assertLe010ExactKeys(diagnosticsAction.input, ['source', 'artifactId'], `${label}.readDiagnostics.input`);
    assertLe010ExactKeys(diagnosticsAction.observed, ['status', 'proof', 'errors'], `${label}.readDiagnostics.observed`);
    assert.deepEqual(diagnosticsAction.input,
      { source: 'read-only CDP window.__CANVAS_INTERACTION__', artifactId: tailId },
      `${label} diagnostics 必须来自只读 production seam 并引用本轮 tail 截图`);
    assert.deepEqual(diagnosticsAction.observed, { status: 'pass', proof: 'PASS', errors: [0, 0, 0, 0] },
      `${label} diagnostics observed 必须精确为 production PASS`);

    assert.ok(Array.isArray(run?.fitViewportSamples), `${label} fitViewportSamples 必须是数组`);
    assert.equal(run.fitViewportSamples.length, 3, `${label} 必须保留三个 fit 数值样本`);
    assert.deepEqual(run.fitViewportSamples.map(sample => sample?.code), ['Shift+Digit1', 'Shift+Digit2', 'Shift+Digit3'],
      `${label} fit 样本 code 必须严格有序`);
    assert.deepEqual(keyboardAction.observed.fitSamples, run.fitViewportSamples,
      `${label} keyboard observed 必须与 production fit 样本同源`);
    for (const [sampleIndex, sample] of run.fitViewportSamples.entries()) {
      for (const key of ['before', 'after', 'target']) {
        assert.ok(isFiniteEvidenceViewport(sample?.[key]), `${label} fit sample ${sampleIndex + 1}.${key} 必须全为有限数`);
      }
      assert.ok(['x', 'y', 'zoom'].some(key => Math.abs(sample.before[key] - sample.after[key]) > 1e-9),
        `${label} fit sample ${sampleIndex + 1} 必须真实改变 RF viewport`);
      for (const key of ['x', 'y', 'zoom']) {
        const tolerance = 1e-6 * Math.max(1, Math.abs(sample.target[key]));
        assert.ok(Math.abs(sample.after[key] - sample.target[key]) <= tolerance,
          `${label} fit sample ${sampleIndex + 1}.after.${key} 必须约等于 production target`);
      }
    }

    assert.ok(Array.isArray(run?.snapshots) && run.snapshots.length > 0, `${label} snapshots 必须非空`);
    assert.deepEqual(run.snapshots.map(snapshot => snapshot?.stage), [...LE010_SNAPSHOT_STAGES],
      `${label} snapshots.stage 必须严格覆盖五个生产阶段`);
    run.snapshots.forEach((snapshot, snapshotIndex) => {
      assertLe010ProductionSnapshot(snapshot, LE010_SNAPSHOT_STAGES[snapshotIndex], label);
    });
    const finalSnapshot = run.snapshots.at(-1);
    assert.equal(finalSnapshot?.suiteStatus, 'pass', `${label} final snapshot suiteStatus 必须为 pass`);
    assertLe010Checks(finalSnapshot?.checks, `${label}.snapshots.final`);

    assert.equal(run?.handToolDrag, true, `${label} 必须真实选择 Excalidraw 手工具并左拖`);
    assert.equal(typeof run?.pointerActiveObserved, 'boolean', `${label} pointer active 诊断必须是布尔值`);
    assert.ok(run?.pointerAcquisitionDelta > 0, `${label} 必须真实获取 pointer 监听资源`);
    assert.equal(run?.pointerCleanupDelta, run?.pointerAcquisitionDelta, `${label} pointer 获取与有效 cleanup 必须配平`);
    assert.equal(run?.shieldObserved, true, `${label} 必须观察到输入盾`);
    assert.equal(run?.nodePointerDelta, 0, `${label} 尾窗不得穿透节点`);
    assert.deepEqual(run?.shortcuts, { in: true, out: true, reset: true }, `${label} 三个 mod 快捷键必须只改 RF viewport`);
    assert.ok(Number.isInteger(run?.zoomControls?.visible) && run.zoomControls.visible >= 5, `${label} 必须至少看到 5 个缩放控件`);
    assert.ok(Array.isArray(run?.zoomControls?.clickable), `${label} clickable 必须保留控件名数组`);
    for (const control of ['minus', 'plus', '100%', 'fit']) {
      assert.ok(run.zoomControls.clickable.includes(control), `${label} 缩放岛必须可点 ${control}`);
    }
    assert.equal(run?.highFrequency?.performed, true, `${label} 必须执行高频真实导航`);
    assert.ok(Number.isInteger(run?.highFrequency?.gestureCount) && run.highFrequency.gestureCount >= 3, `${label} 高频导航必须至少 3 次手势`);
    assert.ok(Number.isFinite(run?.highFrequency?.shieldFrameDelta) && run.highFrequency.shieldFrameDelta >= 3, `${label} 高频导航必须观察多帧输入盾`);
    assert.ok(Number.isFinite(run?.highFrequency?.viewportWriteDelta) && run.highFrequency.viewportWriteDelta >= 3, `${label} 高频导航必须产生多次 RF viewport 写入`);
    assert.equal(run?.highFrequency?.nodePointerDelta, 0, `${label} 高频尾窗不得穿透节点`);
    assert.deepEqual(highFrequencyAction.observed.delta, run.highFrequency,
      `${label} 高频 action observed 必须与本轮 production delta 同源`);
    assert.equal(highFrequencyAction.observed.pointerAcquisitionDelta, run.pointerAcquisitionDelta,
      `${label} 高频 action acquisition 必须与本轮同源`);
    assert.equal(highFrequencyAction.observed.pointerCleanupDelta, run.pointerCleanupDelta,
      `${label} 高频 action cleanup 必须与本轮同源`);
    assert.equal(run?.cameraAlignDelta, 1, `${label} 整段导航所有真实 align 总增量必须恰好为 1`);
    assert.ok(run?.viewportWriteDelta >= 1, `${label} 必须有 RF viewport 写入`);

    const tail = run?.manualProof?.cameraTailExit;
    assert.equal(tail?.status, 'PASS', `${label} 尾窗证伪状态必须为 PASS`);
    assert.equal(tail?.passed, true, `${label} 尾窗证伪必须通过`);
    assert.equal(tail?.buttonArmed, true, `${label} 必须由可见按钮武装 watcher`);
    assert.equal(tail?.fixtureDispatchedInput, false, `${label} fixture 不得自造输入`);
    assert.equal(tail?.phaseAtExit, 'resuming', `${label} 必须在 resuming 同步 exit`);
    assert.equal(tail?.resumingObserved, true, `${label} watcher 必须真实观察到 resuming`);
    assert.ok(['raf', 'timer'].includes(tail?.observerSource), `${label} observerSource 只能是 raf 或 timer`);
    for (const visibilityField of ['armVisibility', 'captureVisibility']) {
      const visibility = tail?.[visibilityField];
      assert.ok(visibility && typeof visibility === 'object', `${label} ${visibilityField} 必须保留原始可见性`);
      assert.ok(['visible', 'hidden', 'prerender'].includes(visibility.visibilityState),
        `${label} ${visibilityField}.visibilityState 必须是浏览器原始值`);
      assert.equal(typeof visibility.hasFocus, 'boolean', `${label} ${visibilityField}.hasFocus 必须是布尔值`);
    }
    assert.ok(Number.isInteger(tail?.rafTicks) && tail.rafTicks >= 0, `${label} rafTicks 必须是非负整数`);
    assert.ok(Number.isInteger(tail?.timerTicks) && tail.timerTicks >= 0, `${label} timerTicks 必须是非负整数`);
    assert.ok(tail.rafTicks + tail.timerTicks > 0, `${label} rAF/timer 至少真实观察一次`);
    assert.ok(tail.observerSource === 'raf' ? tail.rafTicks > 0 : tail.timerTicks > 0,
      `${label} observerSource 必须对应非零 tick`);
    assert.equal(tail?.exitBeforeResumeReady, true, `${label} exit 必须抢在 resume-ready 前`);
    assert.equal(tail?.exportDelayed, true, `${label} selection closing 必须真实触发 dirty export delay`);
    assert.equal(tail?.exportReleased, true, `${label} delayed export 必须恢复并释放`);
    assert.ok(Number.isInteger(tail?.runToken) && tail.runToken > 0, `${label} 必须保留本轮单调 runToken`);
    assert.ok(Number.isInteger(tail?.callStartIndex) && tail.callStartIndex >= 0, `${label} 必须保留本轮 callStartIndex`);
    assert.ok(Number.isFinite(tail?.closingRevision), `${label} 必须保留 production closing revision`);
    assert.equal(tail?.export?.callIndex >= tail.callStartIndex, true, `${label} export.callIndex 必须在本轮起点后`);
    assert.equal(tail?.export?.runToken, tail.runToken, `${label} export.runToken 必须精确属于本轮`);
    assert.equal(tail?.export?.scenario, tail.scenario, `${label} export.scenario 必须精确属于本轮`);
    assert.equal(tail?.export?.revision, tail.closingRevision, `${label} export.revision 必须精确匹配 closing generation`);
    assert.equal(tail?.cameraAlignDelta, 1, `${label} resuming exit 不得产生第二次 align`);
    assert.ok(Number.isFinite(tail?.viewportWriteDelta) && tail.viewportWriteDelta > 0, `${label} 真实手工具导航必须写入 RF viewport`);
    assert.ok(Array.isArray(tail?.shieldSamples) && tail.shieldSamples.length >= 3 && tail.shieldSamples.every(value => value === true), `${label} delayed closing 必须至少连续 3 帧 shield=true`);
    assert.equal(tail?.nodePointerDelta, 0, `${label} delayed closing 不得穿透节点`);
    assert.equal(typeof tail?.pointerActiveObserved, 'boolean', `${label} 尾窗 pointer active 诊断必须是布尔值`);
    assert.ok(tail?.acquisitionDelta > 0, `${label} 必须真实获取 pointer 资源`);
    assert.equal(tail?.cleanupDelta, tail?.acquisitionDelta, `${label} 尾窗 pointer 获取与 cleanup 必须配平`);
    assert.equal(tail?.final?.penActive, false, `${label} 尾窗退出后 penActive 必须为 false`);
    assert.equal(tail?.final?.opening, false, `${label} 尾窗退出后 opening 必须为 false`);
    assert.equal(tail?.final?.phase, 'live', `${label} 尾窗退出后必须恢复 live`);
    assert.equal(tail?.final?.shield, false, `${label} 尾窗退出后不得残留输入盾`);
    assert.equal(tail?.final?.pointerResourceActive, false, `${label} 尾窗退出后不得残留 pointer 资源`);
    assert.equal(tail?.final?.viewportFinite, true, `${label} 尾窗退出后 viewport 必须全为有限数`);
    assert.ok(isFiniteEvidenceViewport(tail?.final?.viewport), `${label} 尾窗最终 viewport 必须有限`);
    assert.equal(armAction.observed.runToken, tail.runToken, `${label} arm action 必须引用本轮 runToken`);
    assert.deepEqual(armAction.observed.armVisibility, tail.armVisibility, `${label} arm visibility 必须与 proof 同源`);
    assert.deepEqual(tailAction.observed, {
      status: tail.status,
      observerSource: tail.observerSource,
      acquisitionDelta: tail.acquisitionDelta,
      cleanupDelta: tail.cleanupDelta,
      viewportWriteDelta: tail.viewportWriteDelta,
    }, `${label} tail action observed 必须与 proof 同源`);

    assert.equal(run?.final?.phase, 'live', `${label} 最终必须恢复 live`);
    assert.equal(run?.final?.shield, false, `${label} 最终不得残留输入盾`);
    assert.equal(run?.final?.pointerResourceActive, false, `${label} 不得残留 window pointer 资源`);
    assert.ok(isFiniteEvidenceViewport(run?.final?.viewport), `${label} 必须保留最终有限 RF viewport`);
    assert.equal(run?.final?.suiteStatus, 'pass', `${label} final.suiteStatus 必须为 pass`);
    assertLe010Checks(run?.final?.checks, `${label}.final`);
    for (const name of ['consoleErrors', 'consoleWarnings', 'pageErrors', 'apiResources']) {
      assert.ok(Array.isArray(run?.final?.[name]), `${label} final.${name} 必须保留原始数组`);
      assert.equal(run.final[name].length, 0, `${label} final.${name} 必须为零`);
    }
  }
  assert.ok(evidence.runs.some(run => run?.highFrequency?.performed === true && run.highFrequency.viewportWriteDelta >= 3),
    '至少一轮必须用连续导航证明多次 RF 写入仍只 tail align 一次');
  for (const name of ['consoleErrors', 'consoleWarnings', 'pageErrors', 'apiResources']) {
    assert.ok(Array.isArray(evidence[name]), `${name} 必须保留原始数组`);
    assert.equal(evidence[name].length, 0, `${name} 必须为零`);
  }
}

test('LE-010 Computer Use 原始证据可选注入 focused behavior log 并绑定相机 candidate', () => {
  const evidencePath = process.env.LE010_COMPUTER_USE_EVIDENCE;
  if (!evidencePath) return;
  assert.equal(path.isAbsolute(evidencePath), true, 'evidence 必须使用绝对路径');
  const raw = fs.readFileSync(evidencePath, 'utf8').trim();
  assert.equal(raw.split(/\r?\n/).length, 1, 'evidence JSON 必须为单行原始 transcript');
  const evidence = JSON.parse(raw);
  const candidateSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  assertLe010ComputerUseEvidence(evidence, candidateSha, evidencePath);
  console.log(`LE010_COMPUTER_USE_EVIDENCE ${raw}`);
});

const validLe010Checks = () => Object.fromEntries(LE010_CHECK_NAMES.map(name => [name, true]));
const validLe010Production = (active = false, revision = 20) => ({
  requestedRevision: revision,
  renderedRevision: revision,
  framePhase: 'ready',
  opening: false,
  penActive: active,
  drawVisible: active,
  cameraPhase: 'live',
  cameraShield: false,
  pointerResourceActive: false,
  viewport: { x: 10, y: 20, zoom: 1 },
});
const validLe010Run = round => {
  const runToken = round;
  const scenario = `camera-tail-exit-${runToken}`;
  const callStartIndex = round * 10;
  const closingRevision = 30 + round;
  const fitViewportSamples = ['Shift+Digit1', 'Shift+Digit2', 'Shift+Digit3'].map((code, index) => ({
    code,
    before: { x: index, y: index, zoom: 1 },
    after: { x: 10 + index, y: 20 + index, zoom: 0.8 },
    target: { x: 10 + index, y: 20 + index, zoom: 0.8 },
  }));
  const highFrequency = { performed: true, gestureCount: 3, shieldFrameDelta: 3, viewportWriteDelta: 3, nodePointerDelta: 0 };
  const finalViewport = { x: 30, y: 40, zoom: 0.8 };
  const tailFinal = {
    penActive: false,
    opening: false,
    phase: 'live',
    shield: false,
    pointerResourceActive: false,
    viewport: finalViewport,
    viewportFinite: true,
  };
  const tail = {
    status: 'PASS',
    passed: true,
    buttonArmed: true,
    fixtureDispatchedInput: false,
    phaseAtExit: 'resuming',
    resumingObserved: true,
    observerSource: 'timer',
    armVisibility: { visibilityState: 'visible', hasFocus: true },
    captureVisibility: { visibilityState: 'hidden', hasFocus: false },
    rafTicks: 0,
    timerTicks: 2,
    exitBeforeResumeReady: true,
    exportDelayed: true,
    exportReleased: true,
    runToken,
    scenario,
    callStartIndex,
    closingRevision,
    export: {
      callIndex: callStartIndex,
      runToken,
      scenario,
      revision: closingRevision,
      mode: 'delay',
      kind: 'group',
    },
    cameraAlignDelta: 1,
    viewportWriteDelta: 3,
    nodePointerDelta: 0,
    pointerActiveObserved: true,
    acquisitionDelta: 1,
    cleanupDelta: 1,
    shieldSamples: [true, true, true],
    final: tailFinal,
  };
  const actions = [
    {
      action: 'hardRefresh',
      input: { shortcut: 'super+shift+r', url: LE010_CANONICAL_URL, artifactId: `round-${round}-address` },
      observed: { status: 'pass', requestedRevision: 20, renderedRevision: 20 },
    },
    {
      action: 'openDrawingSelection',
      input: { product: '选绘图', strokeClick: [688, 225], source: 'current screenshot', artifactId: `round-${round}-selection` },
      observed: { requestedRevision: 21, renderedRevision: 21, zoomControlCount: 5 },
    },
    {
      action: 'keyboardZoom',
      input: ['super+plus', 'super+minus', 'super+0', 'Shift+Digit1', 'Shift+Digit2', 'Shift+Digit3'],
      observed: { fitSamples: fitViewportSamples },
    },
    {
      action: 'zoomIsland',
      input: ['minus', 'plus', '100%', 'fit'],
      observed: { viewports: [0, 1, 2, 3].map(index => ({ x: index, y: index + 1, zoom: 0.8 + index / 10 })) },
    },
    {
      action: 'highFrequencyNavigation',
      input: { sequence: ['hand', '产品选绘图', 'hand'], gestureCount: 3 },
      coordinates: [[[10, 10], [20, 20]], [[20, 20], [30, 25]], [[30, 25], [40, 30]]],
      observed: { delta: highFrequency, pointerAcquisitionDelta: 1, pointerCleanupDelta: 1 },
    },
    {
      action: 'reopenDrawingSelection',
      input: { product: '选绘图' },
      observed: { editorLive: true, zoomControlCount: 5 },
    },
    {
      action: 'armTailWatcher',
      input: { visibleButton: '尾窗证伪：idle' },
      observed: { status: 'armed', runToken, armVisibility: tail.armVisibility },
    },
    {
      action: 'tailNavigation',
      input: { sequence: ['hand', 'left drag'], attempt: 1 },
      coordinates: [[50, 50], [70, 60]],
      observed: {
        status: 'PASS', observerSource: tail.observerSource, acquisitionDelta: 1, cleanupDelta: 1, viewportWriteDelta: 3,
      },
    },
    {
      action: 'readDiagnostics',
      input: { source: 'read-only CDP window.__CANVAS_INTERACTION__', artifactId: `round-${round}-tail` },
      observed: { status: 'pass', proof: 'PASS', errors: [0, 0, 0, 0] },
    },
  ];
  return {
    round,
    passed: true,
    errors: [],
    handToolDrag: true,
    pointerActiveObserved: true,
    pointerAcquisitionDelta: 1,
    pointerCleanupDelta: 1,
    shieldObserved: true,
    nodePointerDelta: 0,
    shortcuts: { in: true, out: true, reset: true },
    zoomControls: { visible: 5, clickable: ['minus', 'plus', '100%', 'fit'] },
    highFrequency,
    cameraAlignDelta: 1,
    viewportWriteDelta: 3,
    actions,
    fitViewportSamples,
    snapshots: [
      { stage: 'baseline', production: validLe010Production(false, 20) },
      { stage: 'selectionLive', production: validLe010Production(true, 21) },
      { stage: 'highFrequencyLive', production: validLe010Production(true, 21) },
      { stage: 'tailPass', production: validLe010Production(false, closingRevision), manualProof: { cameraTailExit: tail } },
      { stage: 'final', production: validLe010Production(false, closingRevision), suiteStatus: 'pass', checks: validLe010Checks() },
    ],
    manualProof: { cameraTailExit: tail },
    final: {
      ...tailFinal,
      suiteStatus: 'pass',
      checks: validLe010Checks(),
      consoleErrors: [],
      consoleWarnings: [],
      pageErrors: [],
      apiResources: [],
    },
  };
};
const LE010_TEST_CANDIDATE_SHA = 'a'.repeat(40);
const validLe010Evidence = () => ({
  candidateSha: LE010_TEST_CANDIDATE_SHA,
  fixtureOnly: true,
  fixtureUrl: LE010_CANONICAL_URL,
  realCanvasCoordinateDrag: false,
  overallPassed: true,
  verdict: 'PASS',
  errors: [],
  validationErrors: [],
  runs: [1, 2, 3].map(validLe010Run),
  consoleErrors: [],
  consoleWarnings: [],
  pageErrors: [],
  apiResources: [],
});

const le010PngChunk = (type, data = Buffer.alloc(0)) => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)]);
};

function validLe010Png(seed, width = 800, height = 600) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const marker = Buffer.alloc(1024, seed);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    le010PngChunk('IHDR', ihdr),
    le010PngChunk('tEXt', marker),
    le010PngChunk('IEND'),
  ]);
}

function createValidLe010EvidenceFixture(t) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'le010-evidence-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const evidenceRoot = path.join(tempRoot, '.loop', 'v2', 'evidence', 'LE-010');
  const candidateDir = path.join(evidenceRoot, LE010_TEST_CANDIDATE_SHA);
  const screenshotDir = path.join(candidateDir, 'screenshots');
  fs.mkdirSync(screenshotDir, { recursive: true });
  const evidence = validLe010Evidence();
  evidence.computerUseArtifacts = [1, 2, 3].flatMap(round => LE010_ARTIFACT_STAGES.map((stage, stageIndex) => {
    const id = `round-${round}-${stage}`;
    const buffer = validLe010Png(round * 10 + stageIndex);
    const relativePath = `screenshots/${id}.png`;
    fs.writeFileSync(path.join(candidateDir, relativePath), buffer);
    return {
      id,
      round,
      stage,
      kind: 'computer-use-screenshot',
      relativePath,
      sha256: createHash('sha256').update(buffer).digest('hex'),
      mimeType: 'image/png',
      byteLength: buffer.length,
      width: 800,
      height: 600,
    };
  }));
  const evidencePath = path.join(candidateDir, 'computer-use.raw.json');
  fs.writeFileSync(evidencePath, JSON.stringify(evidence));
  return { tempRoot, evidenceRoot, candidateDir, evidencePath, evidence };
}

const assertLe010Fixture = (fixture, evidence = fixture.evidence, candidateSha = LE010_TEST_CANDIDATE_SHA,
  evidencePath = fixture.evidencePath) => assertLe010ComputerUseEvidence(
  evidence, candidateSha, evidencePath, { evidenceRoot: fixture.evidenceRoot },
);

test('LE-010 evidence gate 接受当前 candidate 内完整九图并形成 behavior-log 可传递绑定', t => {
  const fixture = createValidLe010EvidenceFixture(t);
  assert.doesNotThrow(() => assertLe010Fixture(fixture));
  assert.equal(fixture.evidence.computerUseArtifacts.length, 9);
  assert.equal(new Set(fixture.evidence.computerUseArtifacts.map(artifact => artifact.sha256)).size, 9,
    '九个 round/stage 必须绑定九份不同截图字节');
});

test('LE-010 evidence gate 拒绝 4517、伪 source/proof 与 action 额外字段', t => {
  const fixture = createValidLe010EvidenceFixture(t);
  const cases = [
    ['顶层 4517', evidence => { evidence.fixtureUrl = 'http://127.0.0.1:4517/?mode=interaction'; }, /fixtureUrl/],
    ['hard refresh 4517', evidence => { evidence.runs[0].actions[0].input.url = 'http://127.0.0.1:4517/?mode=interaction'; }, /hardRefresh/],
    ['fabricated selection source', evidence => { evidence.runs[0].actions[1].input.source = 'fabricated'; }, /source/],
    ['forged diagnostics proof', evidence => { evidence.runs[0].actions[8].observed.proof = 'forged'; }, /diagnostics observed/],
    ['额外 action 字段', evidence => { evidence.runs[0].actions[3].observed.recoveredLatestAxIndex = true; }, /schema/],
  ];
  for (const [label, mutate, expected] of cases) {
    const evidence = structuredClone(fixture.evidence);
    mutate(evidence);
    assert.throws(() => assertLe010Fixture(fixture, evidence), expected, `${label} 必须被拒绝`);
  }
});

test('LE-010 evidence gate 拒绝跨目录、旧 candidate、hash 与 byteLength 伪造', t => {
  const fixture = createValidLe010EvidenceFixture(t);
  const pathEscape = structuredClone(fixture.evidence);
  pathEscape.computerUseArtifacts[0].relativePath = '../round-1-address.png';
  assert.throws(() => assertLe010Fixture(fixture, pathEscape), /relativePath/, '../ 必须被拒绝');

  const badHash = structuredClone(fixture.evidence);
  badHash.computerUseArtifacts[0].sha256 = '0'.repeat(64);
  assert.throws(() => assertLe010Fixture(fixture, badHash), /sha256/, '伪 hash 必须被拒绝');

  const badBytes = structuredClone(fixture.evidence);
  badBytes.computerUseArtifacts[0].byteLength++;
  assert.throws(() => assertLe010Fixture(fixture, badBytes), /byteLength/, '伪 byteLength 必须被拒绝');

  const oldCandidate = 'b'.repeat(40);
  const stale = structuredClone(fixture.evidence);
  stale.candidateSha = oldCandidate;
  assert.throws(() => assertLe010Fixture(fixture, stale, oldCandidate), /当前 LE-010 candidate/,
    '旧 candidate 目录不得复用当前九图');
});

test('LE-010 evidence gate 拒绝缺图、symlink、伪 PNG 与维度不符', t => {
  const fixture = createValidLe010EvidenceFixture(t);
  const artifact = fixture.evidence.computerUseArtifacts[0];
  const artifactPath = path.join(fixture.candidateDir, artifact.relativePath);
  const original = fs.readFileSync(artifactPath);

  const missingPath = `${artifactPath}.missing`;
  fs.renameSync(artifactPath, missingPath);
  try {
    assert.throws(() => assertLe010Fixture(fixture), /ENOENT/, '缺图必须被拒绝');
  } finally {
    fs.renameSync(missingPath, artifactPath);
  }

  const targetPath = `${artifactPath}.target`;
  fs.renameSync(artifactPath, targetPath);
  fs.symlinkSync(targetPath, artifactPath);
  try {
    assert.throws(() => assertLe010Fixture(fixture), /symlink/, '截图 symlink 必须被拒绝');
  } finally {
    fs.unlinkSync(artifactPath);
    fs.renameSync(targetPath, artifactPath);
  }

  const rawTargetPath = `${fixture.evidencePath}.target`;
  fs.renameSync(fixture.evidencePath, rawTargetPath);
  fs.symlinkSync(rawTargetPath, fixture.evidencePath);
  try {
    assert.throws(() => assertLe010Fixture(fixture), /raw 不得是 symlink/, 'raw symlink 必须被拒绝');
  } finally {
    fs.unlinkSync(fixture.evidencePath);
    fs.renameSync(rawTargetPath, fixture.evidencePath);
  }

  const fakeMagic = Buffer.alloc(original.length);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(fakeMagic);
  const fakeEvidence = structuredClone(fixture.evidence);
  fakeEvidence.computerUseArtifacts[0].sha256 = createHash('sha256').update(fakeMagic).digest('hex');
  fs.writeFileSync(artifactPath, fakeMagic);
  try {
    assert.throws(() => assertLe010Fixture(fixture, fakeEvidence), /IHDR/, '只有 PNG magic 的伪图必须被拒绝');
  } finally {
    fs.writeFileSync(artifactPath, original);
  }

  const missingIend = Buffer.from(original);
  missingIend.write('NOPE', missingIend.length - 8, 'ascii');
  const missingIendEvidence = structuredClone(fixture.evidence);
  missingIendEvidence.computerUseArtifacts[0].sha256 = createHash('sha256').update(missingIend).digest('hex');
  fs.writeFileSync(artifactPath, missingIend);
  try {
    assert.throws(() => assertLe010Fixture(fixture, missingIendEvidence), /IEND/, '缺失 IEND 的伪图必须被拒绝');
  } finally {
    fs.writeFileSync(artifactPath, original);
  }

  const wrongDimensions = structuredClone(fixture.evidence);
  wrongDimensions.computerUseArtifacts[0].width = 801;
  assert.throws(() => assertLe010Fixture(fixture, wrongDimensions), /width/, 'raw 与 IHDR 维度不符必须被拒绝');
});

test('LE-010 evidence gate 拒绝重复 round，不允许用三份同轮记录冒充 fresh 三轮', t => {
  const fixture = createValidLe010EvidenceFixture(t);
  const evidence = fixture.evidence;
  evidence.runs[1].round = 1;
  assert.throws(() => assertLe010Fixture(fixture), /round/);
});

test('LE-010 evidence gate 拒绝空 actions，不允许只用自写 passed 布尔值过门', t => {
  const fixture = createValidLe010EvidenceFixture(t);
  const evidence = fixture.evidence;
  evidence.runs[1].actions = [];
  assert.throws(() => assertLe010Fixture(fixture), /actions/);
});

test('LE-010 evidence gate 拒绝缺失双时钟来源、可见性与 tick 原始观测', t => {
  const fixture = createValidLe010EvidenceFixture(t);
  for (const field of ['observerSource', 'armVisibility', 'captureVisibility', 'rafTicks', 'timerTicks']) {
    const evidence = structuredClone(fixture.evidence);
    delete evidence.runs[0].manualProof.cameraTailExit[field];
    assert.throws(() => assertLe010Fixture(fixture, evidence), new RegExp(field),
      `缺少 ${field} 必须被证据门拒绝`);
  }
  const evidence = structuredClone(fixture.evidence);
  evidence.runs[0].manualProof.cameraTailExit.observerSource = 'synthetic';
  assert.throws(() => assertLe010Fixture(fixture, evidence), /observerSource/,
    'observerSource 只允许 raf 或 timer');
});

test('LE-010 pointer active 只是瞬时诊断，资源获取、写入、配平与零穿透才是硬门', t => {
  const fixture = fs.readFileSync(path.resolve('tests/fixtures/canvas-acceptance/interaction-data.js'), 'utf8');
  assert.doesNotMatch(fixture, /!proof\.pointerActiveObserved\s*&&/,
    'fixture 不得因为定时采样没撞见瞬时 active 就判失败');

  const evidenceFixture = createValidLe010EvidenceFixture(t);
  const evidence = evidenceFixture.evidence;
  for (const run of evidence.runs) {
    run.pointerActiveObserved = false;
    run.manualProof.cameraTailExit.pointerActiveObserved = false;
  }
  assert.doesNotThrow(() => assertLe010Fixture(evidenceFixture, evidence),
    'down/move/up 落在两次 poll 之间时，完整单调计数应允许 active 诊断为 false');

  const invalidCases = [
    ['run active 诊断非布尔', run => { run.pointerActiveObserved = 'false'; }, /布尔值/],
    ['tail active 诊断非布尔', run => { run.manualProof.cameraTailExit.pointerActiveObserved = null; }, /布尔值/],
    ['run acquisition=0', run => { run.pointerAcquisitionDelta = 0; }, /获取 pointer/],
    ['run write=0', run => { run.viewportWriteDelta = 0; }, /viewport 写入/],
    ['run cleanup mismatch', run => { run.pointerCleanupDelta = 2; }, /cleanup/],
    ['run node>0', run => { run.nodePointerDelta = 1; }, /穿透节点/],
    ['tail acquisition=0', run => { run.manualProof.cameraTailExit.acquisitionDelta = 0; }, /获取 pointer/],
    ['tail write=0', run => { run.manualProof.cameraTailExit.viewportWriteDelta = 0; }, /RF viewport/],
    ['tail cleanup mismatch', run => { run.manualProof.cameraTailExit.cleanupDelta = 2; }, /cleanup/],
    ['tail node>0', run => { run.manualProof.cameraTailExit.nodePointerDelta = 1; }, /穿透节点/],
  ];
  for (const [label, mutate, expected] of invalidCases) {
    const invalid = structuredClone(evidence);
    mutate(invalid.runs[0]);
    assert.throws(() => assertLe010Fixture(evidenceFixture, invalid), expected,
      `${label} 仍必须被证据门拒绝`);
  }
});

test('props 先追上 closing override 后再撤桥：persisted world 只在激活时分配严格递增 revision', () => {
  const oldElements = [rect('old', 0, 0, 20, 20)];
  const mergedElements = [rect('merged', 40, 0, 20, 20)];
  const files = {};
  let persistedWorld = null;
  let activeWorld = null;
  let revision = 0;
  const activate = (elements, override = null) => {
    const step = drawingWorldInputStep({
      persistedWorld, activeWorld, override, elements, files, revision,
    });
    persistedWorld = step.persistedWorld;
    activeWorld = step.world;
    revision = step.revision;
    return step;
  };

  const initial = activate(oldElements);
  const openingOverride = { elements: oldElements, files, excludedIds: ['old'], revision: ++revision };
  const opening = activate(oldElements, openingOverride);
  const propsCaughtUp = activate(mergedElements, openingOverride);
  const closingOverride = { elements: mergedElements, files, excludedIds: [], revision: ++revision };
  const closing = activate(mergedElements, closingOverride);
  const unbridged = activate(mergedElements);
  const stable = activate(mergedElements);

  assert.deepEqual(
    [initial.world.revision, opening.world.revision, closing.world.revision, unbridged.world.revision],
    [1, 2, 3, 4],
  );
  assert.equal(propsCaughtUp.world, openingOverride, 'props 追上时不得抢走 active override');
  assert.equal(propsCaughtUp.persistedWorld.revision, null, '未激活 persisted input 不得预分配过时 revision');
  assert.equal(unbridged.world.elements, mergedElements);
  assert.ok(unbridged.world.revision > closing.world.revision, '撤桥不得让 render input revision 回退');
  assert.equal(stable.world, unbridged.world, '同一 active persisted world 重渲染不得虚增 revision');
  assert.equal(stable.revision, unbridged.revision);
});

test('world input 的 speculative B 只是候选值，未 commit 前不能取得 authority', () => {
  const elementsA = [rect('committed-a', 0, 0, 20, 20)];
  const elementsB = [rect('speculative-b', 30, 0, 20, 20)];
  const elementsC = [rect('committed-c', 60, 0, 20, 20)];
  const files = {};
  let authority = { persistedWorld: null, activeWorld: null, revision: 0 };
  const render = elements => drawingWorldInputStep({ ...authority, elements, files });
  const commit = step => {
    authority = {
      persistedWorld: step.persistedWorld,
      activeWorld: step.world,
      revision: step.revision,
    };
  };

  const committedA = render(elementsA);
  commit(committedA);
  const speculativeB = render(elementsB);
  assert.ok(speculativeB.world.revision > committedA.world.revision, 'B 必须是真正的新 speculative generation');
  assert.equal(authority.activeWorld, committedA.world, 'B 未 commit 就不能取得 generation authority');

  const committedC = render(elementsC);
  commit(committedC);
  assert.equal(authority.activeWorld.elements, elementsC);
  assert.ok(authority.activeWorld.revision > committedA.world.revision);
  assert.notEqual(authority.activeWorld, speculativeB.world, '同步 C 必须直接丢弃未 commit 的 B');
});

test('连续 z-order group 严格按边界切分并保留元素顺序，空面不制造占位组', () => {
  const elements = ['a', 'b', 'c', 'd', 'e'].map((id, index) => rect(id, index * 10, 0, 8, 8));
  const groups = drawingPlaneGroups(elements, {}, 2);
  assert.deepEqual(groups.map(group => group.elements.map(element => element.id)), [['a', 'b'], ['c', 'd'], ['e']]);
  assert.deepEqual(groups.map(group => group.index), [0, 1, 2]);
  assert.deepEqual(drawingPlaneGroups([], {}, 2), []);
  assert.deepEqual(drawingPlaneGroupPlan([], [], []), []);
});

test('opening hole 只脏固定 committed 槽：300/800 首个沉层元素均只导出一组', () => {
  for (const [size, reused] of [[300, 3], [800, 8]]) {
    const below = splitDrawingPlanes(createCanvasAcceptanceElements(size)).below;
    const target = below.find(element => element.type !== 'text');
    const baseline = drawingPlaneGroups(below);
    const ready = baseline.map(group => ({ signature: group.signature, snapshot: { id: group.index } }));
    const opened = drawingPlaneGroups(below, {}, 48, [target.id]);
    const plan = drawingPlaneGroupPlan(ready, [], opened);

    assert.equal(plan.filter(group => group.route === 'export').length, 1, `${size} opening 只导出目标槽`);
    assert.equal(plan.filter(group => group.route === 'ready').length, reused, `${size} 其余槽全部复用`);
    assert.equal(opened[1].elements[0].id, baseline[1].elements[0].id, `${size} 第二槽首 ID 不漂移`);
  }
});

test('hole 排空整组仍保留 slot 并走 clear，后续槽继续 ready', () => {
  const elements = ['a', 'b', 'c', 'd', 'e'].map((id, index) => rect(id, index * 10, 0, 8, 8));
  const baseline = drawingPlaneGroups(elements, {}, 2);
  const ready = baseline.map(group => ({ signature: group.signature, snapshot: { id: group.index } }));
  const opened = drawingPlaneGroups(elements, {}, 2, ['a', 'b']);
  const plan = drawingPlaneGroupPlan(ready, [], opened);

  assert.equal(opened.length, baseline.length);
  assert.deepEqual(opened.map(group => group.elements.map(element => element.id)), [[], ['c', 'd'], ['e']]);
  assert.deepEqual(plan.map(group => group.route), ['clear', 'ready', 'ready']);
});

test('frame font signature 合并多字体字符集且与文字顺序/重复无关，纯几何不入签名', () => {
  const text = (id, fontFamily, value) => ({ id, type: 'text', fontFamily, text: value, originalText: value });
  const first = drawingFontSignature([
    text('early', 1, '早期龘'), rect('shape', 0, 0, 8, 8), text('later', 5, '自动化'), text('dup', 1, '早早'),
  ]);
  const reordered = drawingFontSignature([text('later', 5, '化自动'), text('early', 1, '龘期早')]);
  assert.deepEqual(first, reordered);
  assert.deepEqual(first.map(item => item.fontFamily), ['1', '5']);
  assert.equal(first[0].glyphs.includes('龘'), true);
  assert.deepEqual(drawingFontSignature([rect('shape', 0, 0, 8, 8)]), []);
});

test('早期独有字符或字体改变会脏化 capsule；纯几何变化继续 ready，同签名在途 join', () => {
  const text = (fontFamily, value) => ({ id: 'early', type: 'text', fontFamily, text: value, originalText: value });
  const ready = drawingFontSignature([text(1, '早期龘')]);
  const changedGlyph = drawingFontSignature([text(1, '早期靐')]);
  const changedFont = drawingFontSignature([text(5, '早期龘')]);
  assert.equal(drawingFontSignaturesEqual(ready, drawingFontSignature([text(1, '期早龘')])), true);
  assert.equal(drawingFontSignaturesEqual(ready, changedGlyph), false);
  assert.equal(drawingFontSignaturesEqual(ready, changedFont), false);
  assert.equal(drawingFontWorkRoute(ready, changedGlyph, ready, true), 'ready');
  assert.equal(drawingFontWorkRoute(ready, changedGlyph, changedGlyph, true), 'join');
  assert.equal(drawingFontWorkRoute(ready, changedGlyph, changedFont, true), 'export');
  assert.equal(drawingFontWorkRoute(ready, null, [], false), 'clear');
});

test('group plan 单元素变更只脏一组，未变组继续 ready 复用', () => {
  const elements = ['a', 'b', 'c', 'd', 'e', 'f'].map((id, index) => rect(id, index * 10, 0, 8, 8));
  const baseline = drawingPlaneGroups(elements, {}, 2);
  const ready = baseline.map(group => ({ signature: group.signature, snapshot: { id: group.index } }));
  const moved = elements.map(element => element.id === 'c' ? { ...element, x: element.x + 1 } : element);
  const plan = drawingPlaneGroupPlan(ready, [], drawingPlaneGroups(moved, {}, 2));
  assert.deepEqual(plan.map(group => group.route), ['ready', 'export', 'ready']);
});

test('跨 group 边界重排让相邻两组失效，后续连续顺序仍可复用', () => {
  const elements = ['a', 'b', 'c', 'd', 'e', 'f'].map((id, index) => rect(id, index * 10, 0, 8, 8));
  const baseline = drawingPlaneGroups(elements, {}, 2);
  const ready = baseline.map(group => ({ signature: group.signature, snapshot: { id: group.index } }));
  const reordered = [elements[0], elements[2], elements[1], ...elements.slice(3)];
  const plan = drawingPlaneGroupPlan(ready, [], drawingPlaneGroups(reordered, {}, 2));
  assert.deepEqual(plan.map(group => group.route), ['export', 'export', 'ready']);
  assert.deepEqual(plan.flatMap(group => group.elements.map(element => element.id)), ['a', 'c', 'b', 'd', 'e', 'f']);
});

test('多组同签名在途逐组 join；ready 仍优先于同槽在途', () => {
  const elements = ['a', 'b', 'c', 'd'].map((id, index) => rect(id, index * 10, 0, 8, 8));
  const groups = drawingPlaneGroups(elements, {}, 2);
  const inFlight = groups.map(group => ({ signature: group.signature, promise: Promise.resolve(group.index) }));
  assert.deepEqual(drawingPlaneGroupPlan([], inFlight, groups).map(group => group.route), ['join', 'join']);
  const ready = [{ signature: groups[0].signature, snapshot: { id: 0 } }];
  assert.deepEqual(drawingPlaneGroupPlan(ready, inFlight, groups).map(group => group.route), ['ready', 'join']);
});

test('图片签名只跟踪本 plane 引用的资产，同内容换代复用而标量变更变脏', () => {
  const photo = { ...image('photo'), x: 0, y: 0, width: 100, height: 80, customData: { below: true }, version: 1 };
  const note = rect('note', 120, 0, 80, 60, { version: 1 });
  const photoFile = binary('photo');
  const unrelated = binary('unrelated');
  const before = {
    below: drawingPlaneSignature([photo], { photo: photoFile, unrelated }),
    above: drawingPlaneSignature([note], { photo: photoFile, unrelated }),
  };
  const unrelatedReplacement = { ...unrelated, created: 2 };
  const unchanged = {
    below: drawingPlaneSignature([photo], { photo: photoFile, unrelated: unrelatedReplacement }),
    above: drawingPlaneSignature([note], { photo: photoFile, unrelated: unrelatedReplacement }),
  };
  assert.deepEqual(drawingPlaneDirtyPlan(before, unchanged), { below: false, above: false, count: 0 });

  photoFile.dataURL = 'data:image/png;base64,bmV3';
  photoFile.lastRetrieved = 3;
  const mutated = {
    below: drawingPlaneSignature([photo], { photo: photoFile, unrelated: unrelatedReplacement }),
    above: drawingPlaneSignature([note], { photo: photoFile, unrelated: unrelatedReplacement }),
  };
  assert.deepEqual(drawingPlaneDirtyPlan(before, mutated), { below: true, above: false, count: 1 });

  const replaced = {
    below: drawingPlaneSignature([photo], { photo: { ...photoFile }, unrelated: unrelatedReplacement }),
    above: mutated.above,
  };
  assert.deepEqual(drawingPlaneDirtyPlan(mutated, replaced), { below: false, above: false, count: 0 });

  const changedReplacement = {
    below: drawingPlaneSignature([photo], { photo: { ...photoFile, created: photoFile.created + 1 }, unrelated: unrelatedReplacement }),
    above: mutated.above,
  };
  assert.deepEqual(drawingPlaneDirtyPlan(mutated, changedReplacement), { below: true, above: false, count: 1 });
});

test('300/800 元素签名成本受控，单平面变更不连坐另一面', () => {
  const run = (size, budgetMs) => {
    const elements = createCanvasAcceptanceElements(size);
    const planes = splitDrawingPlanes(elements);
    assert.deepEqual([planes.below.length, planes.above.length], [size / 2, size / 2]);
    const started = performance.now();
    const before = {
      below: drawingPlaneSignature(planes.below, {}),
      above: drawingPlaneSignature(planes.above, {}),
    };
    const elapsed = performance.now() - started;
    assert.ok(elapsed <= budgetMs, `${size} 元素签名 ${elapsed.toFixed(2)}ms 超过 ${budgetMs}ms 红线`);

    const moved = mutateBelowPlane(elements, 1);
    const movedPlanes = splitDrawingPlanes(moved);
    const after = {
      below: drawingPlaneSignature(movedPlanes.below, {}),
      above: drawingPlaneSignature(movedPlanes.above, {}),
    };
    assert.deepEqual(drawingPlaneDirtyPlan(before, after), { below: true, above: false, count: 1 });
  };

  run(300, 50);
  run(800, 100);
});

test('已提交快照过滤墓碑，删除宿主时连带绑定文字', () => {
  const els = [
    rect('host', 0, 0, 100, 80),
    { id: 'label', type: 'text', x: 10, y: 10, width: 50, height: 20, containerId: 'host' },
    rect('keep', 200, 0, 50, 50),
    rect('dead', 300, 0, 50, 50, { isDeleted: true }),
  ];
  assert.deepEqual(committedDrawingElements(els).map(e => e.id), ['host', 'label', 'keep']);
  assert.deepEqual(deleteDrawingElement(els, 'host').map(e => e.id), ['keep']);
  assert.deepEqual(splitDrawingPlanes(els).above.map(e => e.id), ['host', 'label', 'keep']);
});

test('沉浮变换带着绑定文字，批量平移每个元素只移一次', () => {
  const els = [
    rect('host', 10, 20, 100, 80),
    { id: 'label', type: 'text', x: 20, y: 30, width: 50, height: 20, containerId: 'host' },
    rect('stay', 300, 40, 50, 50),
  ];
  const sunk = setDrawingElementPlane(els, 'host', true);
  assert.equal(sunk.find(e => e.id === 'host').customData.below, true);
  assert.equal(sunk.find(e => e.id === 'label').customData.below, true);
  const moved = translateDrawingElements(sunk, ['host', 'host', 'label'], 7, -3);
  assert.deepEqual(moved.map(e => [e.id, e.x, e.y]), [
    ['host', 17, 17], ['label', 27, 27], ['stay', 300, 40],
  ]);
  assert.deepEqual(els.map(e => [e.id, e.x, e.y]), [
    ['host', 10, 20], ['label', 20, 30], ['stay', 300, 40],
  ]);
});

test('committed 队列等前一笔成功才基于新快照执行，已删图片不复活', async () => {
  let releaseFirst;
  const firstGate = new Promise(resolve => { releaseFirst = resolve; });
  const calls = [];
  const host = rect('host', 10, 20, 100, 80);
  const queue = createDrawingCommitQueue({
    elements: [image('photo'), host],
    files: { photo: binary('photo') },
  }, snapshot => {
    calls.push(snapshot);
    return calls.length === 1 ? firstGate : Promise.resolve();
  });

  const first = queue.submit(base => ({
    elements: deleteDrawingElement(base.elements, 'element-photo'),
    files: base.files,
  }));
  const second = queue.submit(base => ({
    elements: translateDrawingElements(setDrawingElementPlane(base.elements, 'host', true), ['host'], 7, -3),
    files: base.files,
  }));

  await Promise.resolve();
  assert.equal(calls.length, 1, '第二笔不得在第一笔 resolve 前启动');
  assert.deepEqual(calls[0].elements.map(e => e.id), ['host']);
  assert.deepEqual(calls[0].files, {});

  releaseFirst();
  await first;
  const final = await second;
  assert.equal(calls.length, 2);
  assert.deepEqual(final.elements.map(e => e.id), ['host']);
  assert.deepEqual(final.files, {});
  assert.equal(final.elements[0].customData.below, true);
  assert.deepEqual([final.elements[0].x, final.elements[0].y], [17, 17]);
});

test('committed 队列单笔 reject 不推进基线也不毒死后续提交', async () => {
  let attempt = 0;
  const queue = createDrawingCommitQueue({
    elements: [rect('host', 10, 20, 100, 80)],
    files: {},
  }, () => {
    attempt++;
    return attempt === 1 ? Promise.reject(new Error('synthetic failure')) : Promise.resolve();
  });

  const failed = queue.submit(base => ({
    elements: deleteDrawingElement(base.elements, 'host'),
    files: base.files,
  }));
  const recovered = queue.submit(base => ({
    elements: translateDrawingElements(base.elements, ['host'], 5, 6),
    files: base.files,
  }));

  await assert.rejects(failed, /synthetic failure/);
  const final = await recovered;
  assert.equal(attempt, 2);
  assert.deepEqual(final.elements.map(e => [e.id, e.x, e.y]), [['host', 15, 26]]);
});

test('4518 只选择 allowlisted production fixture，并拒绝写请求、仓库路径与编码 traversal', () => {
  assert.equal(selectAcceptanceFixture([]), 'carry');
  assert.equal(selectAcceptanceFixture(['--fixture=canvas']), 'canvas');
  assert.throws(() => selectAcceptanceFixture(['--fixture=repo']), /unsupported/);
  assert.throws(() => selectAcceptanceFixture(['--fixture=carry', '--fixture=canvas']), /exactly once/);

  for (const requestUrl of [
    '/api/graph', '/data/canvas.json', '/@fs/private', '/.git/config',
    '/assets/../data/canvas.json', '/assets/%2e%2e/data/canvas.json',
    '/%2e%2e/%2e%2e/etc/passwd', '/%2Fetc/passwd', '/assets/%5c..%5cdata',
  ]) {
    assert.equal(classifyAcceptanceRequest('GET', requestUrl).status, 403, requestUrl);
  }
  assert.equal(classifyAcceptanceRequest('POST', '/').status, 405);
  assert.equal(classifyAcceptanceRequest('HEAD', '/assets/main.js').status, 200);
  assert.equal(classifyAcceptanceRequest('GET', '/main.jsx').status, 404);
  assert.deepEqual(classifyAcceptanceRequest('GET', '/'), { status: 200, relative: 'index.html' });

  const worker = 'assets/excal-subset-worker~subset-worker.chunk-lock.js';
  const entries = new Set([worker]);
  assert.doesNotMatch(acceptanceCspFor('index.html', entries), /'unsafe-eval'/);
  assert.doesNotMatch(acceptanceCspFor('assets/unrelated.js', entries), /'unsafe-eval'/);
  assert.match(acceptanceCspFor(worker, entries), /'unsafe-eval'/);
  assert.match(acceptanceCspFor(worker, entries), /'wasm-unsafe-eval'/);
});

test('shared Excalidraw font plugin rewrites the one locked fallback and rejects every drift axis', () => {
  const id = path.resolve('node_modules/@excalidraw/excalidraw/dist/prod/chunk-K2UTITRG.js');
  const source = fs.readFileSync(id, 'utf8');
  const hash = value => createHash('sha256').update(value).digest('hex');

  const valid = excalidrawLocalFonts();
  valid.buildStart();
  const transformed = valid.transform(source, id);
  valid.buildEnd();
  assert.doesNotMatch(transformed.code, /https:\/\/esm\.sh\//);
  assert.match(transformed.code, /ASSETS_FALLBACK_URL",window\.location\.origin\+"\/"/);
  assert.match(transformed.code, /Active worker did not respond/);

  const wrongVersion = excalidrawLocalFonts({ packageVersion: '0.18.2' });
  assert.throws(() => wrongVersion.buildStart(), /version drift/);

  const wrongId = excalidrawLocalFonts();
  wrongId.buildStart();
  assert.equal(wrongId.transform(source, id.replace('chunk-K2UTITRG.js', 'chunk-other.js')), null);
  assert.throws(() => wrongId.buildEnd(), /transformed 0/);

  const wrongHash = excalidrawLocalFonts({
    lock: { ...EXCALIDRAW_FONT_LOCK, sha256: '0'.repeat(64) },
  });
  wrongHash.buildStart();
  assert.throws(() => wrongHash.transform(source, id), /SHA drift/);

  const zeroHitSource = source.replace(
    EXCALIDRAW_FONT_LOCK.remoteSource,
    '`https://example.invalid/excalidraw/`',
  );
  const zeroHit = excalidrawLocalFonts({
    lock: { ...EXCALIDRAW_FONT_LOCK, sha256: hash(zeroHitSource) },
  });
  zeroHit.buildStart();
  assert.throws(() => zeroHit.transform(zeroHitSource, id), /matches 0/);

  const multiHitSource = `${source}\n/* ${EXCALIDRAW_FONT_LOCK.remoteSource} */`;
  const multiHit = excalidrawLocalFonts({
    lock: { ...EXCALIDRAW_FONT_LOCK, sha256: hash(multiHitSource) },
  });
  multiHit.buildStart();
  assert.throws(() => multiHit.transform(multiHitSource, id), /matches 2/);

  const repeatedModule = excalidrawLocalFonts();
  repeatedModule.buildStart();
  repeatedModule.transform(source, id);
  assert.throws(() => repeatedModule.transform(source, `${id}?duplicate`), /matched 2 modules/);
});

test('recursive build closure catches a two-hop worker core leak while allowing a small shared bridge', () => {
  const source = new Map([
    ['worker.js', 'import "./bridge.js"; self.onmessage=()=>{}'],
    ['bridge.js', 'import "./core.js";'],
    ['core.js', 'WebAssembly.compile()'],
    ['prod.js', 'import "./shared.js";'],
    ['app.js', 'import "./prod.js";'],
    ['shared.js', 'export const shared=1'],
    ['leak.js', 'import "./core.js";'],
    ['bad-app.js', 'import "./leak.js";'],
  ]);
  const workerClosure = collectStaticClosure('worker.js', source, 'worker');
  const prodClosure = collectStaticClosure('prod.js', source, 'prod');
  const appClosure = collectStaticClosure('app.js', source, 'app');
  assert.doesNotThrow(() => assertWorkerCoreIsolation({
    workerEntry: 'worker.js', prodEntry: 'prod.js', appEntry: 'app.js', workerCore: 'core.js',
    workerClosure, prodClosure, appClosure,
  }));
  const badAppClosure = collectStaticClosure('bad-app.js', source, 'bad-app');
  assert.throws(() => assertWorkerCoreIsolation({
    workerEntry: 'worker.js', prodEntry: 'prod.js', appEntry: 'bad-app.js', workerCore: 'core.js',
    workerClosure, prodClosure, appClosure: badAppClosure,
  }), /app main closure eagerly imports worker-only core/);
  assert.throws(() => collectStaticClosure('missing.js', source, 'missing'), /missing static/);
  const sizes = new Map([['bridge.js', 20_000], ['shared.js', 30_000], ['large.js', 64_001]]);
  assert.deepEqual(
    assertSharedChunkBudget(['bridge.js', 'shared.js'], file => sizes.get(file), 'synthetic'),
    [{ file: 'bridge.js', bytes: 20_000 }, { file: 'shared.js', bytes: 30_000 }],
  );
  assert.throws(
    () => assertSharedChunkBudget(['large.js'], file => sizes.get(file), 'synthetic'),
    /exceeds 64000B/,
  );
});

test('action toast renders a live region, claims once, and hover/focus pause preserves remaining lifetime', async t => {
  const [{ createServer }, React, { renderToStaticMarkup }] = await Promise.all([
    import('vite'),
    import('react'),
    import('react-dom/server'),
  ]);
  const vite = await createServer({
    appType: 'custom',
    clearScreen: false,
    configFile: false,
    logLevel: 'silent',
    root: path.resolve('web'),
    server: { middlewareMode: true },
  });
  t.after(() => vite.close());
  const {
    ToastItem, UIHost, appendToastStack, claimToastAction, createToastAutoClose,
  } = await vite.ssrLoadModule('/src/ui.jsx');
  const markup = renderToStaticMarkup(React.createElement(UIHost));
  assert.match(markup, /role="status"/);
  assert.match(markup, /aria-live="polite"/);

  const button = { disabled: false };
  let actions = 0;
  assert.equal(claimToastAction(button, () => { actions++; }), true);
  assert.equal(claimToastAction(button, () => { actions++; }), false);
  assert.equal(actions, 1);

  let clock = 1000;
  let scheduled = null;
  let closes = 0;
  const lifetime = createToastAutoClose({
    durationMs: 30000,
    onClose: () => { closes++; },
    now: () => clock,
    setTimer: (callback, delay) => {
      scheduled = { callback, delay };
      return scheduled;
    },
    clearTimer: handle => { if (scheduled === handle) scheduled = null; },
  });
  assert.equal(scheduled.delay, 30000);
  clock += 4000;
  lifetime.pause();
  assert.equal(lifetime.remaining(), 26000);
  assert.equal(scheduled, null, 'hover/focus pause 必须撤销当前自动关闭');
  clock += 60000;
  lifetime.resume();
  assert.equal(scheduled.delay, 26000, '离开 hover/focus 后只恢复剩余时长');
  scheduled.callback();
  assert.equal(closes, 1);

  const makeLifetime = () => {
    let current = null;
    const value = createToastAutoClose({
      durationMs: 30000,
      onClose: () => {},
      now: () => clock,
      setTimer: (callback, delay) => {
        current = { callback, delay };
        return current;
      },
      clearTimer: handle => { if (current === handle) current = null; },
    });
    return { value, scheduled: () => current };
  };
  const eventProps = lifetimeValue => ToastItem({
    item: { id: 7, msg: '可撤销', type: 'info', action: null },
    lifetime: lifetimeValue,
    onDismiss: () => {},
  }).props;

  clock = 1000;
  const hoverFirst = makeLifetime();
  const hoverFirstEvents = eventProps(hoverFirst.value);
  clock += 4000;
  hoverFirstEvents.onMouseEnter();
  assert.equal(hoverFirst.value.remaining(), 26000);
  clock += 5000;
  hoverFirstEvents.onFocusCapture();
  hoverFirstEvents.onMouseLeave();
  assert.equal(hoverFirst.scheduled(), null, 'hover 释放时 focus reason 仍在，不得恢复 timer');
  assert.equal(hoverFirst.value.remaining(), 26000, '组合 pause reason 只扣首次进入暂停前的时长');
  hoverFirstEvents.onBlurCapture({ currentTarget: { contains: () => false }, relatedTarget: null });
  assert.equal(hoverFirst.scheduled().delay, 26000, '最后 focus reason 释放才恢复剩余时长');
  hoverFirst.value.cancel();

  clock = 1000;
  const focusFirst = makeLifetime();
  const focusFirstEvents = eventProps(focusFirst.value);
  clock += 3000;
  focusFirstEvents.onFocusCapture();
  assert.equal(focusFirst.value.remaining(), 27000);
  clock += 7000;
  focusFirstEvents.onMouseEnter();
  const inside = {};
  focusFirstEvents.onBlurCapture({ currentTarget: { contains: target => target === inside }, relatedTarget: inside });
  assert.equal(focusFirst.scheduled(), null, '焦点仍在 toast 内部时不得释放 focus reason');
  focusFirstEvents.onBlurCapture({ currentTarget: { contains: () => false }, relatedTarget: null });
  assert.equal(focusFirst.scheduled(), null, 'focus 释放时 hover reason 仍在，不得恢复 timer');
  assert.equal(focusFirst.value.remaining(), 27000, 'focus→hover 也只扣一次 remaining');
  focusFirstEvents.onMouseLeave();
  assert.equal(focusFirst.scheduled().delay, 27000, '最后 hover reason 释放才恢复 timer');
  focusFirst.value.cancel();

  const cancelled = [];
  const lifetimes = new Map([1, 2, 3, 4].map(id => [id, {
    cancel: () => cancelled.push(id),
  }]));
  const nextItems = appendToastStack(
    [1, 2, 3].map(id => ({ id })),
    { id: 4 },
    lifetimes,
  );
  assert.deepEqual(nextItems.map(item => item.id), [2, 3, 4]);
  assert.deepEqual(cancelled, [1], '可见栈淘汰必须同步撤销旧计时器');
  assert.deepEqual([...lifetimes.keys()], [2, 3, 4], '可见栈淘汰不得在 lifetime Map 留残项');
});

test('whenIdle 创建后追加的成功提交也必须纳入稳定排空，并让 restored 代际失效', async () => {
  const queue = createDrawingCommitQueue({ elements: [rect('host', 0, 0, 50, 50)], files: {} }, async () => {});
  const before = queue.snapshot();
  const after = await queue.submit(base => ({ elements: [...base.elements, rect('zone', 0, 0, 500, 400)], files: base.files }));
  const restored = await queue.guardedRestore(after, before);
  assert.equal(restored.restored, true);

  const drained = queue.whenIdle();
  const later = queue.submit(base => ({ elements: translateDrawingElements(base.elements, ['host'], 9, 0), files: base.files }));
  const newer = await later;
  assert.equal(await drained, newer, 'wait创建后追加的新tail不能逃逸');
  assert.equal(queue.isIdleAt(restored.snapshot), false);
  assert.equal(queue.isIdleAt(newer), true);
});

test('whenIdle 创建后追加的失败提交被隔离，稳定排空仍返回 restored 成功代际', async () => {
  let failNext = false;
  const queue = createDrawingCommitQueue({ elements: [rect('host', 0, 0, 50, 50)], files: {} }, async () => {
    if (failNext) {
      failNext = false;
      throw new Error('synthetic appended failure');
    }
  });
  const before = queue.snapshot();
  const after = await queue.submit(base => ({ elements: [...base.elements, rect('zone', 0, 0, 500, 400)], files: base.files }));
  const restored = await queue.guardedRestore(after, before);

  const drained = queue.whenIdle();
  failNext = true;
  const later = queue.submit(base => ({ elements: translateDrawingElements(base.elements, ['host'], 9, 0), files: base.files }));
  await assert.rejects(later, /synthetic appended failure/);
  assert.equal(await drained, restored.snapshot);
  assert.equal(queue.isIdleAt(restored.snapshot), true);
});

test('isIdleAt 在延迟持久化pending期间为false，只在tail finally落定后为true', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const queue = createDrawingCommitQueue({ elements: [rect('host', 0, 0, 50, 50)], files: {} }, () => gate);
  const initial = queue.snapshot();
  const pending = queue.submit(base => ({ elements: translateDrawingElements(base.elements, ['host'], 3, 0), files: base.files }));
  assert.equal(queue.isIdleAt(initial), false);
  release();
  const settled = await pending;
  await queue.whenIdle();
  assert.equal(queue.isIdleAt(settled), true);
});

test('静态世界同步门：编辑阶段与props未追上override时hold，只在idle同代回声时sync并清屏幕override', () => {
  const external = { elements: [rect('merged', 0, 0, 10, 10)], files: {} };
  const override = { ...external, revision: 7 };

  assert.deepEqual(drawingWorldSyncStep({ idle: false, worldOverride: null, ...external }), { type: 'hold' });
  assert.deepEqual(drawingWorldSyncStep({ idle: false, worldOverride: override, ...external }), { type: 'hold' });
  assert.deepEqual(drawingWorldSyncStep({ idle: true, worldOverride: null, ...external }), { type: 'sync', clearOverride: null });
  assert.deepEqual(drawingWorldSyncStep({
    idle: true,
    worldOverride: override,
    elements: [rect('stale-props', 0, 0, 10, 10)],
    files: {},
  }), { type: 'hold' }, 'override在屏幕上而props尚未追上时绝不能倒灌queue');
  assert.deepEqual(drawingWorldSyncStep({ idle: true, worldOverride: override, ...external }), {
    type: 'sync', clearOverride: override,
  });

  const newer = { elements: [rect('newer', 0, 0, 10, 10)], files: {} };
  assert.deepEqual(drawingWorldSyncStep({
    idle: true,
    worldOverride: override,
    queueSnapshot: newer,
    ...newer,
  }), { type: 'sync', clearOverride: override }, 'future成功提交的props匹配queue真相时必须收口旧override');
});

test('撤销后的屏幕世界取完整pre-commit快照；后续成功已换代时不覆盖更新override', () => {
  const restored = {
    elements: [image('photo'), rect('host', 0, 0, 50, 50)],
    files: { photo: binary('photo') },
  };
  const oldOverride = { elements: [rect('zone', 0, 0, 500, 400)], files: {}, revision: 8 };
  const next = drawingRestoredWorldOverride({
    queueIdle: true,
    editorIdle: true,
    currentSnapshot: restored,
    restoredSnapshot: restored,
    currentOverride: oldOverride,
    revision: 9,
  });
  assert.deepEqual(next.elements.map(el => el.id), ['element-photo', 'host']);
  assert.equal(next.elements, restored.elements);
  assert.equal(next.files, restored.files);
  assert.equal(next.revision, 9);

  const newerSnapshot = { elements: [rect('newer', 0, 0, 20, 20)], files: {} };
  const newerOverride = { ...newerSnapshot, revision: 10 };
  assert.equal(drawingRestoredWorldOverride({
    queueIdle: true,
    editorIdle: true,
    currentSnapshot: newerSnapshot,
    restoredSnapshot: restored,
    currentOverride: newerOverride,
    revision: 11,
  }), newerOverride, 'stale undo不得清掉或覆盖更新代屏幕世界');
  assert.equal(drawingRestoredWorldOverride({
    queueIdle: true,
    editorIdle: false,
    currentSnapshot: restored,
    restoredSnapshot: restored,
    currentOverride: newerOverride,
    revision: 12,
  }), newerOverride, '等待排空期间重新opening/editing时不得主动安装静态恢复世界');
  assert.equal(drawingRestoredWorldOverride({
    queueIdle: false,
    editorIdle: true,
    currentSnapshot: restored,
    restoredSnapshot: restored,
    currentOverride: newerOverride,
    revision: 13,
  }), newerOverride, '成功代际相同但仍有pending时不得先安装静态恢复世界');
});

test('编辑事务门等待 pending 删除落盘，再以无旧图片与文件的同一快照水合', async () => {
  let releaseDelete;
  const deleteGate = new Promise(resolve => { releaseDelete = resolve; });
  const host = rect('host', 10, 20, 100, 80);
  const queue = createDrawingCommitQueue({
    elements: [image('photo'), host],
    files: { photo: binary('photo') },
  }, () => deleteGate);

  const deleting = queue.submit(base => ({
    elements: deleteDrawingElement(base.elements, 'element-photo'),
    files: base.files,
  }));
  let opened = false;
  const seedPromise = queue.whenIdle().then(seed => { opened = true; return seed; });

  await Promise.resolve();
  assert.equal(opened, false, 'pending 普通态提交结束前不得打开编辑器');
  releaseDelete();
  await deleting;
  const seed = await seedPromise;
  assert.deepEqual(seed.elements.map(e => e.id), ['host']);
  assert.deepEqual(seed.files, {});

  const edited = {
    elements: [...seed.elements, rect('new-ink', 200, 50, 40, 40)],
    files: seed.files,
  };
  assert.notEqual(queue.sync(edited), false, '编辑器 flush 快照应在 idle 时接管基线');
  const final = await queue.submit(base => ({
    elements: translateDrawingElements(base.elements, ['host'], 5, 6),
    files: base.files,
  }));
  assert.deepEqual(final.elements.map(e => [e.id, e.x, e.y]), [
    ['host', 15, 26], ['new-ink', 200, 50],
  ]);
  assert.deepEqual(final.files, {});
});

test('pending 期间拒绝 sync；pending 失败后排空种子仍是上次成功的 elements/files', async () => {
  let rejectPending;
  const pendingGate = new Promise((_, reject) => { rejectPending = reject; });
  const host = rect('host', 10, 20, 100, 80);
  const initial = {
    elements: [image('photo'), host],
    files: { photo: binary('photo') },
  };
  const queue = createDrawingCommitQueue(initial, () => pendingGate);
  const pending = queue.submit(base => ({
    elements: deleteDrawingElement(base.elements, 'element-photo'),
    files: base.files,
  }));

  assert.equal(queue.sync({ elements: [rect('stale', 0, 0, 1, 1)], files: {} }), false);
  let drained = false;
  const seedPromise = queue.whenIdle().then(seed => { drained = true; return seed; });
  await Promise.resolve();
  assert.equal(drained, false);

  rejectPending(new Error('synthetic pending failure'));
  await assert.rejects(pending, /synthetic pending failure/);
  const seed = await seedPromise;
  assert.deepEqual(seed.elements.map(e => e.id), ['element-photo', 'host']);
  assert.deepEqual(seed.files, { photo: binary('photo') });
});

test('精确包围盒：旋转矩形按四角实算，折线按 points 实算，负宽高照常', () => {
  // 旋转 90° 的 200x20 扁矩形，中心 (200,110) → 视觉竖条 (190,10)-(210,210)
  const rot = drawingBounds([rect('r', 100, 100, 200, 20, { angle: Math.PI / 2 })]);
  assert.ok(Math.abs(rot.minX - 190) < 1e-6 && Math.abs(rot.maxX - 210) < 1e-6);
  assert.ok(Math.abs(rot.minY - 10) < 1e-6 && Math.abs(rot.maxY - 210) < 1e-6);
  const line = drawingBounds([{ id: 'l', type: 'line', x: 50, y: 60, width: 0, height: 0, points: [[0, 0], [100, -40], [200, 30]] }]);
  assert.deepEqual([line.minX, line.minY, line.maxX, line.maxY], [50, 20, 250, 90]);
  const flip = drawingBounds([rect('f', 500, 300, -400, -200)]);
  assert.deepEqual([flip.minX, flip.minY, flip.maxX, flip.maxY], [100, 100, 500, 300]);
  assert.equal(drawingBounds([]), null);
});

test('空心椭圆四角穿透、描边带命中；实心椭圆腹地命中而角落仍穿透', () => {
  const e = { id: 'e', type: 'ellipse', x: 0, y: 0, width: 200, height: 100, backgroundColor: 'transparent', isDeleted: false, locked: false };
  assert.equal(hitDrawingElement([e], 8, 8, 8), null);              // 包围盒角落在椭圆外
  assert.equal(hitDrawingElement([e], 100, 3, 8)?.id, 'e');         // 顶点描边带
  assert.equal(hitDrawingElement([e], 100, 50, 8), null);           // 空心圆心穿透
  const s = { ...e, id: 's', backgroundColor: '#ffd43b' };
  assert.equal(hitDrawingElement([s], 100, 50, 8)?.id, 's');        // 实心腹地命中
  assert.equal(hitDrawingElement([s], 8, 8, 8), null);              // 实心也不吞角落
});
