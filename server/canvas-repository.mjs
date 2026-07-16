/**
 * Durable canvas/layout repository and direct/batch semantic container-carry service.
 * Every scene read/write shares one cross-process lock; drawing files are out of scope.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  applyBatchCarry, applyCarry, validateBatchCarryCommand, validateCarryCommand,
} from '../shared/canvas-carry.mjs';

const EMPTY_CANVAS = Object.freeze({ edges: [], notes: [], boards: [], drawing: [] });
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

export class SceneError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    Object.assign(this, extra);
  }
}

function assertJson(value, at = '$', code = 'SCENE_CORRUPT') {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new SceneError(503, code, `non-finite number at ${at}`);
    return;
  }
  if (Array.isArray(value)) return value.forEach((entry, index) => assertJson(entry, `${at}[${index}]`, code));
  if (typeof value !== 'object') throw new SceneError(503, code, `non-JSON value at ${at}`);
  for (const [key, entry] of Object.entries(value)) assertJson(entry, `${at}.${key}`, code);
}

const compareCodePoints = (a, b) => {
  const aa = Array.from(a, char => char.codePointAt(0));
  const bb = Array.from(b, char => char.codePointAt(0));
  for (let i = 0; i < Math.min(aa.length, bb.length); i++) {
    if (aa[i] !== bb[i]) return aa[i] - bb[i];
  }
  return aa.length - bb.length;
};

function canonical(value) {
  if (typeof value === 'number') return Object.is(value, -0) ? '0' : JSON.stringify(value);
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort(compareCodePoints).map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

export function sceneToken(scene) {
  const canvas = { ...EMPTY_CANVAS, ...(scene.canvas || {}) };
  assertJson(canvas);
  assertJson(scene.layout || {});
  return crypto.createHash('sha256').update(canonical({ canvas, layout: scene.layout || {} })).digest('hex');
}

const clone = value => structuredClone(value);
const plainObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const finitePoint = value => plainObject(value) && Number.isFinite(value.x) && Number.isFinite(value.y);
const tokenPattern = /^[0-9a-f]{64}$/;
const isoTimestamp = value => {
  if (typeof value !== 'string') return false;
  try { return new Date(value).toISOString() === value; } catch { return false; }
};
const exactKeys = (value, keys) => plainObject(value)
  && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');

export function createCanvasRepository(dataDir, options = {}) {
  const canvasFile = path.join(dataDir, 'canvas.json');
  const layoutFile = path.join(dataDir, 'layout.json');
  const lockDir = path.join(dataDir, '.canvas-scene.lock');
  const journalFile = path.join(dataDir, 'canvas-carry-journal.json');
  const receiptsDir = path.join(dataDir, 'canvas-carry-receipts');
  fs.mkdirSync(dataDir, { recursive: true });

  const fault = stage => options.fault?.(stage);
  const fsyncDir = dir => {
    const fd = fs.openSync(dir, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  };
  const durableWrite = (file, value, stage = 'write') => {
    fault(stage);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
    const fd = fs.openSync(tmp, 'wx');
    try {
      fs.writeFileSync(fd, JSON.stringify(value, null, 2));
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(tmp, file);
    fsyncDir(path.dirname(file));
  };
  const durableDelete = file => {
    if (!fs.existsSync(file)) return;
    fs.unlinkSync(file);
    fsyncDir(path.dirname(file));
  };
  const corrupt = (code, message) => { throw new SceneError(503, code, message); };
  const strictRead = (file, fallback, label, code = 'SCENE_CORRUPT') => {
    if (!fs.existsSync(file)) return clone(fallback);
    let value;
    try { value = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) { corrupt(code, `${label} is invalid JSON: ${error.message}`); }
    assertJson(value, '$', code);
    if (!plainObject(value)) corrupt(code, `${label} must be an object`);
    return value;
  };
  const validateScene = (scene, code = 'SCENE_CORRUPT', label = 'scene') => {
    if (!exactKeys(scene, ['canvas', 'layout'])) corrupt(code, `${label} schema mismatch`);
    if (!plainObject(scene.canvas) || !plainObject(scene.layout)) corrupt(code, `${label} documents must be objects`);
    for (const key of ['edges', 'notes', 'boards', 'drawing']) {
      if (!Array.isArray(scene.canvas[key])) corrupt(code, `${label}.canvas.${key} must be an array`);
    }
    const drawingIds = new Set();
    for (const element of scene.canvas.drawing) {
      if (!plainObject(element) || typeof element.id !== 'string' || !element.id || drawingIds.has(element.id)) {
        corrupt(code, `${label}.canvas.drawing schema mismatch`);
      }
      drawingIds.add(element.id);
    }
    assertJson(scene, '$', code);
    return scene;
  };
  const validateDirectResult = (result, opId, code) => {
    if (!exactKeys(result, ['status', 'opId', 'sceneToken', 'container', 'drawing', 'movedIds'])
      || result.status !== 'committed' || result.opId !== opId || !tokenPattern.test(result.sceneToken)
      || !exactKeys(result.container, ['kind', 'id', 'x', 'y'])
      || !['board', 'district'].includes(result.container.kind)
      || typeof result.container.id !== 'string' || !result.container.id.startsWith(`${result.container.kind}:`)
      || !finitePoint(result.container) || !Array.isArray(result.drawing) || !Array.isArray(result.movedIds)) {
      corrupt(code, 'carry result schema mismatch');
    }
    const drawingIds = new Set();
    for (const element of result.drawing) {
      if (!plainObject(element) || typeof element.id !== 'string' || !element.id || drawingIds.has(element.id)) {
        corrupt(code, 'carry result drawing schema mismatch');
      }
      drawingIds.add(element.id);
    }
    const moved = new Set(result.movedIds);
    if (moved.size !== result.movedIds.length
      || result.movedIds.some(id => typeof id !== 'string' || !drawingIds.has(id))) {
      corrupt(code, 'carry result movedIds mismatch');
    }
    return result;
  };
  const validateBatchResult = (result, opId, code) => {
    if (!exactKeys(result, ['status', 'opId', 'sceneToken', 'layout', 'drawing', 'movedIds', 'moves'])
      || result.status !== 'committed' || result.opId !== opId || !tokenPattern.test(result.sceneToken)
      || !plainObject(result.layout) || !Array.isArray(result.drawing)
      || !Array.isArray(result.movedIds) || !Array.isArray(result.moves)) {
      corrupt(code, 'batch carry result schema mismatch');
    }
    let normalized;
    try {
      normalized = validateBatchCarryCommand({
        opId: result.opId,
        baseToken: result.sceneToken,
        layout: result.layout,
        moves: result.moves,
      });
    } catch (error) {
      corrupt(code, `batch carry result schema mismatch: ${error.message}`);
    }
    if (canonical(normalized.layout) !== canonical(result.layout)
      || canonical(normalized.moves) !== canonical(result.moves)) {
      corrupt(code, 'batch carry result normalization mismatch');
    }
    const drawingIds = new Set();
    for (const element of result.drawing) {
      if (!plainObject(element) || typeof element.id !== 'string' || !element.id || drawingIds.has(element.id)) {
        corrupt(code, 'batch carry result drawing schema mismatch');
      }
      drawingIds.add(element.id);
    }
    const moved = new Set(result.movedIds);
    if (moved.size !== result.movedIds.length
      || result.movedIds.some(id => typeof id !== 'string' || !drawingIds.has(id))) {
      corrupt(code, 'batch carry result movedIds mismatch');
    }
    return result;
  };
  const validateResult = (result, opId, code) => (
    plainObject(result) && Object.hasOwn(result, 'layout')
      ? validateBatchResult(result, opId, code)
      : validateDirectResult(result, opId, code)
  );
  const validateReceipt = (receipt, opId) => {
    const code = 'RECEIPT_CORRUPT';
    if (!exactKeys(receipt, ['schemaVersion', 'opId', 'committedAt', 'result'])
      || ![1, 2].includes(receipt.schemaVersion) || receipt.opId !== opId
      || !isoTimestamp(receipt.committedAt)) {
      corrupt(code, 'carry receipt schema mismatch');
    }
    validateResult(receipt.result, opId, code);
    if ((receipt.schemaVersion === 1) !== !Object.hasOwn(receipt.result, 'layout')) {
      corrupt(code, 'carry receipt version mismatch');
    }
    return receipt;
  };
  const validateDirectJournal = journal => {
    const code = 'JOURNAL_CORRUPT';
    if (!exactKeys(journal, [
      'schemaVersion', 'phase', 'opId', 'baseToken', 'afterToken', 'createdAt',
      'before', 'after', 'result',
    ]) || journal.schemaVersion !== 1 || !['prepared', 'committed'].includes(journal.phase)
      || typeof journal.opId !== 'string' || !journal.opId
      || !tokenPattern.test(journal.baseToken) || !tokenPattern.test(journal.afterToken)
      || !isoTimestamp(journal.createdAt)) {
      corrupt(code, 'carry journal schema mismatch');
    }
    validateScene(journal.before, code, 'journal.before');
    validateScene(journal.after, code, 'journal.after');
    validateResult(journal.result, journal.opId, code);
    if (sceneToken(journal.before) !== journal.baseToken
      || sceneToken(journal.after) !== journal.afterToken
      || journal.result.sceneToken !== journal.afterToken
      || canonical(journal.result.drawing) !== canonical(journal.after.canvas.drawing)) {
      corrupt(code, 'carry journal token/result mismatch');
    }
    const container = journal.result.container;
    const beforeContainer = container.kind === 'board'
      ? journal.before.canvas.boards.find(board => String(board.id) === container.id.slice(6))
      : journal.before.layout[container.id];
    const afterContainer = container.kind === 'board'
      ? journal.after.canvas.boards.find(board => String(board.id) === container.id.slice(6))
      : journal.after.layout[container.id];
    if (!finitePoint(beforeContainer) || !finitePoint(afterContainer)
      || afterContainer.x !== container.x || afterContainer.y !== container.y) {
      corrupt(code, 'carry journal container/result mismatch');
    }
    const dx = afterContainer.x - beforeContainer.x;
    const dy = afterContainer.y - beforeContainer.y;
    const stableBefore = clone(journal.before);
    const stableAfter = clone(journal.after);
    stableAfter.canvas.drawing = stableBefore.canvas.drawing;
    if (container.kind === 'board') {
      const index = stableAfter.canvas.boards.findIndex(board => String(board.id) === container.id.slice(6));
      stableAfter.canvas.boards[index] = stableBefore.canvas.boards.find(board => String(board.id) === container.id.slice(6));
    } else {
      stableAfter.layout[container.id] = stableBefore.layout[container.id];
    }
    if (canonical(stableBefore) !== canonical(stableAfter)) corrupt(code, 'carry journal unrelated scene mismatch');
    if (journal.before.canvas.drawing.length !== journal.after.canvas.drawing.length) {
      corrupt(code, 'carry journal drawing mismatch');
    }
    const changed = [];
    for (let index = 0; index < journal.after.canvas.drawing.length; index++) {
      const prior = journal.before.canvas.drawing[index];
      const element = journal.after.canvas.drawing[index];
      if (prior.id !== element.id) corrupt(code, 'carry journal drawing mismatch');
      if (canonical(prior) === canonical(element)) continue;
      changed.push(element.id);
      if (canonical({ ...prior, x: Number(prior.x) + dx, y: Number(prior.y) + dy }) !== canonical(element)) {
        corrupt(code, 'carry journal movedIds mismatch');
      }
    }
    if (canonical(changed) !== canonical(journal.result.movedIds)) corrupt(code, 'carry journal movedIds mismatch');
    return journal;
  };
  const validateBatchJournal = journal => {
    const code = 'JOURNAL_CORRUPT';
    if (!exactKeys(journal, [
      'schemaVersion', 'kind', 'phase', 'opId', 'baseToken', 'afterToken', 'createdAt',
      'before', 'after', 'result',
    ]) || journal.schemaVersion !== 2 || journal.kind !== 'batch'
      || !['prepared', 'committed'].includes(journal.phase)
      || typeof journal.opId !== 'string' || !journal.opId
      || !tokenPattern.test(journal.baseToken) || !tokenPattern.test(journal.afterToken)
      || !isoTimestamp(journal.createdAt)) {
      corrupt(code, 'batch carry journal schema mismatch');
    }
    validateScene(journal.before, code, 'journal.before');
    validateScene(journal.after, code, 'journal.after');
    validateBatchResult(journal.result, journal.opId, code);
    if (sceneToken(journal.before) !== journal.baseToken
      || sceneToken(journal.after) !== journal.afterToken
      || journal.result.sceneToken !== journal.afterToken
      || canonical(journal.result.layout) !== canonical(journal.after.layout)
      || canonical(journal.result.drawing) !== canonical(journal.after.canvas.drawing)) {
      corrupt(code, 'batch carry journal token/result mismatch');
    }
    const stableBefore = clone(journal.before);
    const stableAfter = clone(journal.after);
    stableAfter.layout = stableBefore.layout;
    stableAfter.canvas.drawing = stableBefore.canvas.drawing;
    if (canonical(stableBefore) !== canonical(stableAfter)) {
      corrupt(code, 'batch carry journal unrelated scene mismatch');
    }
    const beforeIds = new Set(journal.before.canvas.drawing.map(element => element.id));
    if (journal.result.moves.some(move => move.anchorIds.some(id => !beforeIds.has(id)))) {
      corrupt(code, 'batch carry journal anchor mismatch');
    }
    const expectedDrawing = applyBatchCarry(journal.before.canvas.drawing, journal.result.moves);
    if (canonical(expectedDrawing) !== canonical(journal.after.canvas.drawing)) {
      corrupt(code, 'batch carry journal drawing mismatch');
    }
    const changed = journal.after.canvas.drawing.flatMap((element, index) =>
      canonical(element) === canonical(journal.before.canvas.drawing[index]) ? [] : [element.id]);
    if (canonical(changed) !== canonical(journal.result.movedIds)) {
      corrupt(code, 'batch carry journal movedIds mismatch');
    }
    return journal;
  };
  const validateJournal = journal => journal?.schemaVersion === 2
    ? validateBatchJournal(journal)
    : validateDirectJournal(journal);
  const readUnlocked = () => {
    const canvas = { ...clone(EMPTY_CANVAS), ...strictRead(canvasFile, {}, 'canvas') };
    return validateScene({ canvas, layout: strictRead(layoutFile, {}, 'layout') });
  };
  const receiptFile = opId => path.join(receiptsDir, `${crypto.createHash('sha256').update(opId).digest('hex')}.json`);
  const readReceipt = opId => {
    const file = receiptFile(opId);
    if (!fs.existsSync(file)) return null;
    return validateReceipt(strictRead(file, {}, 'carry receipt', 'RECEIPT_CORRUPT'), opId);
  };
  const readJournal = () => {
    if (!fs.existsSync(journalFile)) return null;
    return validateJournal(strictRead(journalFile, {}, 'carry journal', 'JOURNAL_CORRUPT'));
  };
  const writeScene = (scene, stagePrefix) => {
    validateScene(scene);
    durableWrite(canvasFile, scene.canvas, `${stagePrefix}:canvas`);
    durableWrite(layoutFile, scene.layout, `${stagePrefix}:layout`);
  };
  const recoverUnlocked = () => {
    const journal = readJournal();
    if (!journal) return;
    if (journal.phase === 'prepared') {
      writeScene(journal.before, 'recover-prepared');
      durableDelete(journalFile);
      return;
    }
    const existing = readReceipt(journal.opId);
    if (existing && canonical(existing.result) !== canonical(journal.result)) {
      throw new SceneError(503, 'RECEIPT_CORRUPT', 'journal and receipt disagree');
    }
    writeScene(journal.after, 'recover-committed');
    if (!existing) durableWrite(receiptFile(journal.opId), {
      schemaVersion: journal.schemaVersion, opId: journal.opId, committedAt: journal.createdAt, result: journal.result,
    }, 'recover:receipt');
    durableDelete(journalFile);
  };
  const withLock = task => {
    const deadline = Date.now() + (options.lockTimeoutMs || 5000);
    for (;;) {
      try { fs.mkdirSync(lockDir); break; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        try {
          if (Date.now() - fs.statSync(lockDir).mtimeMs > 30000) {
            fs.rmSync(lockDir, { recursive: true, force: true });
            continue;
          }
        } catch { continue; }
        if (Date.now() >= deadline) throw new SceneError(503, 'SCENE_LOCK_TIMEOUT', 'canvas scene lock timed out');
        sleep(10);
      }
    }
    try { return task(); }
    finally { fs.rmSync(lockDir, { recursive: true, force: true }); }
  };
  const pruneReceipts = activeOpId => {
    try {
      if (!fs.existsSync(receiptsDir)) return;
      const now = Date.now();
      const entries = fs.readdirSync(receiptsDir).map(name => {
        const file = path.join(receiptsDir, name);
        return { file, mtime: fs.statSync(file).mtimeMs };
      }).sort((a, b) => b.mtime - a.mtime);
      entries.forEach((entry, index) => {
        if (index < 128 || now - entry.mtime <= 7 * 864e5) return;
        try {
          const receipt = JSON.parse(fs.readFileSync(entry.file, 'utf8'));
          if (receipt.opId !== activeOpId) durableDelete(entry.file);
        } catch { /* corrupt receipts are handled when addressed */ }
      });
    } catch { /* cleanup cannot turn a durable commit into failure */ }
  };

  return Object.freeze({
    read() {
      return withLock(() => {
        recoverUnlocked();
        const scene = readUnlocked();
        return { ...clone(scene), sceneToken: sceneToken(scene) };
      });
    },
    mutate(mutator) {
      return withLock(() => {
        recoverUnlocked();
        const before = readUnlocked();
        const draft = clone(before);
        const result = mutator(draft);
        validateScene(draft);
        if (canonical(draft.canvas) !== canonical(before.canvas)) durableWrite(canvasFile, draft.canvas, 'mutation:canvas');
        if (canonical(draft.layout) !== canonical(before.layout)) durableWrite(layoutFile, draft.layout, 'mutation:layout');
        return { result, sceneToken: sceneToken(draft), scene: clone(draft) };
      });
    },
    recover() {
      return withLock(() => { recoverUnlocked(); return true; });
    },
    carry(raw, context = {}) {
      let command;
      try { command = validateCarryCommand(raw); }
      catch (error) { throw new SceneError(400, 'INVALID_CARRY', error.message); }
      return withLock(() => {
        recoverUnlocked();
        const prior = readReceipt(command.opId);
        if (prior) return clone(prior.result);
        const before = readUnlocked();
        const currentToken = sceneToken(before);
        if (command.baseToken !== currentToken) {
          throw new SceneError(409, 'SCENE_CONFLICT', 'canvas scene has changed', { sceneToken: currentToken });
        }
        const boardId = command.containerId.startsWith('board:') ? command.containerId.slice(6) : null;
        const boardIndex = boardId === null ? -1 : before.canvas.boards.findIndex(board => String(board.id) === boardId);
        const district = command.containerId.startsWith('district:')
          && (context.districtIds?.has(command.containerId) || Object.hasOwn(before.layout, command.containerId));
        if (boardIndex < 0 && !district) throw new SceneError(409, 'CONTAINER_MISSING', 'container no longer exists', { sceneToken: currentToken });
        const persistedPosition = boardIndex >= 0 ? before.canvas.boards[boardIndex] : before.layout[command.containerId];
        if (persistedPosition
          && (persistedPosition.x !== command.from.x || persistedPosition.y !== command.from.y)) {
          throw new SceneError(409, 'POSITION_MISMATCH', 'container start position has changed', { sceneToken: currentToken });
        }
        const ids = new Set(before.canvas.drawing.map(element => element?.id).filter(Boolean));
        if (command.anchorIds.some(id => !ids.has(id))) {
          throw new SceneError(409, 'ANCHOR_MISSING', 'anchored drawing no longer exists', { sceneToken: currentToken });
        }
        const dx = command.to.x - command.from.x;
        const dy = command.to.y - command.from.y;
        const anchors = new Set(command.anchorIds);
        const movedIds = before.canvas.drawing
          .map(element => element.id)
          .filter(id => anchors.has(id));
        const after = clone(before);
        after.canvas.drawing = applyCarry(after.canvas.drawing, movedIds, dx, dy);
        let container;
        if (boardIndex >= 0) {
          after.canvas.boards[boardIndex] = { ...after.canvas.boards[boardIndex], x: command.to.x, y: command.to.y };
          container = { kind: 'board', id: command.containerId, x: command.to.x, y: command.to.y };
        } else {
          after.layout[command.containerId] = { ...(after.layout[command.containerId] || {}), x: command.to.x, y: command.to.y };
          container = { kind: 'district', id: command.containerId, x: command.to.x, y: command.to.y };
        }
        const afterToken = sceneToken(after);
        const result = {
          status: 'committed', opId: command.opId, sceneToken: afterToken, container,
          drawing: after.canvas.drawing, movedIds,
        };
        const createdAt = new Date().toISOString();
        const journal = {
          schemaVersion: 1, phase: 'prepared', opId: command.opId,
          baseToken: command.baseToken, afterToken, createdAt, before, after, result,
        };
        durableWrite(journalFile, journal, 'carry:prepared');
        if (boardIndex >= 0) durableWrite(canvasFile, after.canvas, 'carry:canvas');
        else {
          durableWrite(canvasFile, after.canvas, 'carry:canvas');
          durableWrite(layoutFile, after.layout, 'carry:layout');
        }
        durableWrite(journalFile, { ...journal, phase: 'committed' }, 'carry:committed');
        durableWrite(receiptFile(command.opId), {
          schemaVersion: 1, opId: command.opId, committedAt: new Date().toISOString(), result,
        }, 'carry:receipt');
        durableDelete(journalFile);
        pruneReceipts(command.opId);
        return clone(result);
      });
    },
    batchCarry(raw, context = {}) {
      let command;
      try { command = validateBatchCarryCommand(raw); }
      catch (error) { throw new SceneError(400, 'INVALID_BATCH_CARRY', error.message); }
      return withLock(() => {
        recoverUnlocked();
        const prior = readReceipt(command.opId);
        if (prior) return clone(prior.result);
        const before = readUnlocked();
        const currentToken = sceneToken(before);
        if (command.baseToken !== currentToken) {
          throw new SceneError(409, 'SCENE_CONFLICT', 'canvas scene has changed', { sceneToken: currentToken });
        }
        for (const move of command.moves) {
          const boardId = move.containerId.startsWith('board:') ? move.containerId.slice(6) : null;
          const boardExists = boardId !== null
            && before.canvas.boards.some(board => String(board.id) === boardId);
          const districtExists = move.containerId.startsWith('district:')
            && (context.districtIds?.has(move.containerId)
              || Object.hasOwn(before.layout, move.containerId)
              || Object.hasOwn(command.layout, move.containerId));
          if (!boardExists && !districtExists) {
            throw new SceneError(409, 'CONTAINER_MISSING', 'container no longer exists', { sceneToken: currentToken });
          }
        }
        const drawingIds = new Set(before.canvas.drawing.map(element => element.id));
        if (command.moves.some(move => move.anchorIds.some(id => !drawingIds.has(id)))) {
          throw new SceneError(409, 'ANCHOR_MISSING', 'anchored drawing no longer exists', { sceneToken: currentToken });
        }
        const after = clone(before);
        after.layout = clone(command.layout);
        after.canvas.drawing = applyBatchCarry(after.canvas.drawing, command.moves);
        const movedIds = after.canvas.drawing.flatMap((element, index) =>
          canonical(element) === canonical(before.canvas.drawing[index]) ? [] : [element.id]);
        const afterToken = sceneToken(after);
        const result = {
          status: 'committed',
          opId: command.opId,
          sceneToken: afterToken,
          layout: after.layout,
          drawing: after.canvas.drawing,
          movedIds,
          moves: command.moves,
        };
        const createdAt = new Date().toISOString();
        const journal = {
          schemaVersion: 2,
          kind: 'batch',
          phase: 'prepared',
          opId: command.opId,
          baseToken: command.baseToken,
          afterToken,
          createdAt,
          before,
          after,
          result,
        };
        durableWrite(journalFile, journal, 'batch-carry:prepared');
        durableWrite(canvasFile, after.canvas, 'batch-carry:canvas');
        durableWrite(layoutFile, after.layout, 'batch-carry:layout');
        durableWrite(journalFile, { ...journal, phase: 'committed' }, 'batch-carry:committed');
        durableWrite(receiptFile(command.opId), {
          schemaVersion: 2,
          opId: command.opId,
          committedAt: new Date().toISOString(),
          result,
        }, 'batch-carry:receipt');
        durableDelete(journalFile);
        pruneReceipts(command.opId);
        return clone(result);
      });
    },
    status(opId) {
      if (typeof opId !== 'string' || !opId) throw new SceneError(400, 'INVALID_OP_ID', 'opId is required');
      return withLock(() => {
        recoverUnlocked();
        const receipt = readReceipt(opId);
        return receipt ? clone(receipt.result) : { status: 'unknown', opId };
      });
    },
    paths: Object.freeze({ canvasFile, layoutFile, journalFile, receiptsDir, lockDir }),
  });
}
