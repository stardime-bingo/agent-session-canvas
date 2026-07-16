/**
 * Pure container-carry domain: painted-world ownership, direct/batch semantic
 * mutation validation and the tx/op/frame state machine. No DOM, React or filesystem dependencies.
 */

const finite = value => typeof value === 'number' && Number.isFinite(value);
const point = value => value && finite(value.x) && finite(value.y);
const plainObject = value => !!value && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => plainObject(value)
  && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
const idle = stale => ({
  phase: stale ? 'CONFLICT_STALE' : 'IDLE',
  txId: null, opId: null, targetFrameId: null, containerId: null,
  from: null, to: null, anchorIds: [], dx: 0, dy: 0,
});

export const createCarryState = () => idle(false);

export function computeAnchorIds(elements = [], containers = []) {
  const validContainers = containers
    .filter(c => c?.id && finite(c.x) && finite(c.y) && finite(c.w) && finite(c.h) && c.w >= 0 && c.h >= 0)
    .map((c, order) => ({ ...c, order, area: c.w * c.h }))
    .sort((a, b) => a.area - b.area || a.order - b.order);
  const owner = new Map();
  const byId = new Map(elements.filter(Boolean).map(element => [element.id, element]));
  for (const element of elements) {
    if (!element?.id || element.isDeleted || element.containerId) continue;
    const x = Number(element.x) + Number(element.width || 0) / 2;
    const y = Number(element.y) + Number(element.height || 0) / 2;
    const container = validContainers.find(c => x >= c.x && x <= c.x + c.w && y >= c.y && y <= c.y + c.h);
    if (container) owner.set(element.id, container.id);
  }
  // Only Excalidraw bound text inherits its container host; bound arrows keep
  // their own geometric ownership and cannot be claimed by traversal order.
  for (const element of elements) {
    if (element?.type !== 'text' || !element.containerId || !byId.has(element.containerId)) continue;
    const containerId = owner.get(element.containerId);
    if (containerId) owner.set(element.id, containerId);
  }
  const result = new Map(validContainers.map(c => [c.id, []]));
  for (const element of elements) {
    const containerId = owner.get(element?.id);
    if (containerId) result.get(containerId)?.push(element.id);
  }
  return result;
}

export function applyCarry(elements = [], anchorIds = [], dx = 0, dy = 0) {
  if (!finite(dx) || !finite(dy)) throw new TypeError('carry delta must be finite');
  const ids = new Set(anchorIds);
  if (!ids.size || (!dx && !dy)) return elements;
  return elements.map(element => ids.has(element?.id)
    ? { ...element, x: Number(element.x) + dx, y: Number(element.y) + dy }
    : element);
}

export function applyBatchCarry(elements = [], moves = []) {
  const deltas = new Map();
  for (const move of moves) {
    const dx = move.to.x - move.from.x;
    const dy = move.to.y - move.from.y;
    if (!finite(dx) || !finite(dy)) throw new TypeError('batch carry delta must be finite');
    if (!dx && !dy) continue;
    for (const id of move.anchorIds) {
      if (deltas.has(id)) throw new TypeError('batch anchorIds must be globally unique');
      deltas.set(id, { dx, dy });
    }
  }
  if (!deltas.size) return elements;
  return elements.map(element => {
    const delta = deltas.get(element?.id);
    return delta
      ? { ...element, x: Number(element.x) + delta.dx, y: Number(element.y) + delta.dy }
      : element;
  });
}

export function validateLayoutSnapshot(raw) {
  if (!plainObject(raw)) throw new TypeError('layout must be an object');
  const layout = {};
  for (const [path, entry] of Object.entries(raw)) {
    if (!path || path.length > 4096 || !plainObject(entry)) throw new TypeError('invalid layout entry');
    const keys = Object.keys(entry);
    if (keys.some(key => !['x', 'y', 'd', 'w', 'h'].includes(key))) throw new TypeError('invalid layout fields');
    const next = {};
    for (const key of ['x', 'y', 'w', 'h']) {
      if (entry[key] === undefined) continue;
      if (!finite(entry[key]) || ((key === 'w' || key === 'h') && entry[key] < 0)) {
        throw new TypeError(`invalid layout ${key}`);
      }
      next[key] = entry[key];
    }
    if (entry.d !== undefined) {
      if (typeof entry.d !== 'string' || entry.d.length > 4096) throw new TypeError('invalid layout d');
      next.d = entry.d;
    }
    layout[path] = next;
  }
  return layout;
}

function validateBatchMoves(raw) {
  if (!Array.isArray(raw) || raw.length > 2000) throw new TypeError('invalid batch moves');
  const containers = new Set();
  const anchors = new Set();
  return raw.map(move => {
    if (!exactKeys(move, ['containerId', 'from', 'to', 'anchorIds'])
      || typeof move.containerId !== 'string'
      || (!move.containerId.startsWith('board:') && !move.containerId.startsWith('district:'))
      || !point(move.from) || !point(move.to)
      || !Array.isArray(move.anchorIds) || move.anchorIds.length > 10000
      || containers.has(move.containerId)) {
      throw new TypeError('invalid batch move');
    }
    containers.add(move.containerId);
    const anchorIds = [];
    for (const id of move.anchorIds) {
      if (typeof id !== 'string' || !id || anchors.has(id)) {
        throw new TypeError('batch anchorIds must be globally unique non-empty strings');
      }
      anchors.add(id);
      anchorIds.push(id);
    }
    return {
      containerId: move.containerId,
      from: { x: move.from.x, y: move.from.y },
      to: { x: move.to.x, y: move.to.y },
      anchorIds,
    };
  });
}

export function validateBatchCarryCommand(raw) {
  if (!exactKeys(raw, ['opId', 'baseToken', 'layout', 'moves'])) {
    throw new TypeError('invalid batch carry command fields');
  }
  for (const key of ['opId', 'baseToken']) {
    if (typeof raw[key] !== 'string' || !raw[key] || raw[key].length > 512) throw new TypeError(`invalid ${key}`);
  }
  return {
    opId: raw.opId,
    baseToken: raw.baseToken,
    layout: validateLayoutSnapshot(raw.layout),
    moves: validateBatchMoves(raw.moves),
  };
}

export function validateCarryCommand(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('carry command must be an object');
  const keys = Object.keys(raw).sort();
  const expected = ['anchorIds', 'baseToken', 'containerId', 'from', 'opId', 'to'];
  if (keys.length !== expected.length || keys.some((key, i) => key !== expected[i])) throw new TypeError('invalid carry command fields');
  for (const key of ['opId', 'baseToken', 'containerId']) {
    if (typeof raw[key] !== 'string' || !raw[key] || raw[key].length > 512) throw new TypeError(`invalid ${key}`);
  }
  if (!point(raw.from) || !point(raw.to)) throw new TypeError('invalid carry coordinates');
  if (!Array.isArray(raw.anchorIds) || raw.anchorIds.length > 10000) throw new TypeError('invalid anchorIds');
  const anchorIds = [...new Set(raw.anchorIds)];
  if (anchorIds.length !== raw.anchorIds.length || anchorIds.some(id => typeof id !== 'string' || !id)) {
    throw new TypeError('anchorIds must be unique non-empty strings');
  }
  return {
    opId: raw.opId, baseToken: raw.baseToken, containerId: raw.containerId,
    from: { x: raw.from.x, y: raw.from.y }, to: { x: raw.to.x, y: raw.to.y }, anchorIds,
  };
}

const sameGesture = (state, event) => event.txId === state.txId
  && (!event.opId || event.opId === state.opId);

export function reduceCarry(state = createCarryState(), event) {
  const commands = [];
  let next = state;
  switch (event?.type) {
    case 'BEGIN':
      if (state.phase !== 'IDLE' || !event.txId || !event.opId || !event.baseToken || !point(event.from)) break;
      next = {
        phase: 'DRAGGING', txId: event.txId, opId: event.opId, targetFrameId: null,
        baseToken: event.baseToken, containerId: event.containerId, from: { ...event.from },
        to: { ...event.from }, anchorIds: [...event.anchorIds], dx: 0, dy: 0, acceptedResult: null,
      };
      commands.push({ type: 'MARK', txId: event.txId, anchorIds: next.anchorIds });
      break;
    case 'MOVE':
      if (state.phase !== 'DRAGGING' || !sameGesture(state, event) || !point(event.to)) break;
      next = { ...state, to: { ...event.to }, dx: event.to.x - state.from.x, dy: event.to.y - state.from.y };
      commands.push({ type: 'PRESENT', txId: state.txId, dx: next.dx, dy: next.dy });
      break;
    case 'CANCEL':
    case 'ZERO_DROP':
      if (state.phase !== 'DRAGGING' || !sameGesture(state, event)) break;
      next = idle(false);
      commands.push({ type: 'CLEAR', txId: state.txId });
      break;
    case 'DROP': {
      if (state.phase !== 'DRAGGING' || !sameGesture(state, event)) break;
      const to = point(event.to) ? event.to : state.to;
      if (to.x === state.from.x && to.y === state.from.y) {
        next = idle(false);
        commands.push({ type: 'CLEAR', txId: state.txId });
        break;
      }
      const command = validateCarryCommand({
        opId: state.opId, baseToken: state.baseToken, containerId: state.containerId,
        from: state.from, to, anchorIds: state.anchorIds,
      });
      next = { ...state, phase: 'COMMITTING', to: { ...to }, dx: to.x - state.from.x, dy: to.y - state.from.y };
      commands.push({ type: 'COMMIT', txId: state.txId, command });
      break;
    }
    case 'COMMIT_ACCEPTED':
      if (state.phase !== 'COMMITTING' || !sameGesture(state, event)) break;
      next = { ...state, acceptedResult: 'commit' };
      break;
    case 'STATUS_ACCEPTED':
      if (state.phase !== 'QUERYING_OPERATION' || !sameGesture(state, event)) break;
      next = { ...state, acceptedResult: 'status' };
      break;
    case 'COMMIT_OK':
    case 'STATUS_COMMITTED': {
      const source = event.type === 'COMMIT_OK' ? 'commit' : 'status';
      const phase = source === 'commit' ? 'COMMITTING' : 'QUERYING_OPERATION';
      if (state.phase !== phase || state.acceptedResult !== source || !sameGesture(state, event)) break;
      if (!state.anchorIds.length) {
        next = idle(false);
        commands.push({ type: 'CLEAR', txId: state.txId });
      } else if (event.targetFrameId != null) {
        next = { ...state, phase: 'AWAITING_FRAME', targetFrameId: event.targetFrameId };
      }
      break;
    }
    case 'RESPONSE_UNKNOWN':
      if (state.phase !== 'COMMITTING' || !sameGesture(state, event)) break;
      next = { ...state, phase: 'QUERYING_OPERATION' };
      commands.push({ type: 'QUERY_STATUS', txId: state.txId, opId: state.opId });
      break;
    case 'OP_UNKNOWN':
    case 'CONFLICT':
      if (!['COMMITTING', 'QUERYING_OPERATION'].includes(state.phase) || !sameGesture(state, event)) break;
      next = idle(true);
      commands.push({ type: 'CLEAR', txId: state.txId });
      break;
    case 'ABORTED':
      if (!['COMMITTING', 'QUERYING_OPERATION'].includes(state.phase) || !sameGesture(state, event)) break;
      next = idle(false);
      commands.push({ type: 'CLEAR', txId: state.txId });
      break;
    case 'TARGET_FRAME_READY':
      if (state.phase !== 'AWAITING_FRAME' || !sameGesture(state, event) || event.targetFrameId !== state.targetFrameId) break;
      next = idle(false);
      commands.push({ type: 'CLEAR', txId: state.txId });
      break;
    case 'FINAL_FRAME_ERROR':
      if (state.phase !== 'AWAITING_FRAME' || !sameGesture(state, event) || event.targetFrameId !== state.targetFrameId) break;
      next = { ...state, phase: 'RETRYABLE_PAINT' };
      break;
    case 'RETRY':
      if (state.phase !== 'RETRYABLE_PAINT' || !sameGesture(state, event)) break;
      next = { ...state, phase: 'AWAITING_FRAME' };
      commands.push({ type: 'RETRY_FRAME', txId: state.txId, targetFrameId: state.targetFrameId });
      break;
    case 'UNMOUNT':
      next = idle(false);
      if (state.txId) commands.push({ type: 'CLEAR', txId: state.txId });
      break;
  }
  return { state: next, commands };
}

export function createCarryLedger(limit = 128) {
  let seq = 0;
  const entries = [];
  return Object.freeze({
    append(event, from, to) {
      if (event.type === 'MOVE' && entries.at(-1)?.event === 'MOVE') entries.pop();
      entries.push(Object.freeze({
        seq: ++seq, txId: event.txId ?? to.txId, event: event.type,
        from: from.phase, to: to.phase, opId: to.opId, baseToken: to.baseToken,
        frameId: event.targetFrameId ?? to.targetFrameId,
      }));
      if (entries.length > limit) entries.splice(0, entries.length - limit);
    },
    read: () => Object.freeze([...entries]),
  });
}
