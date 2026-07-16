/**
 * Browser carry controller and the only DOM adapter for the marker/CSS bridge.
 * The controller owns domain state; React and SVG only render its commands.
 */
import {
  computeAnchorIds, createCarryLedger, createCarryState, reduceCarry,
} from '../../../shared/canvas-carry.mjs';

const MARKER_PREFIX = 'ink-marker:';
const uuid = () => globalThis.crypto?.randomUUID?.()
  || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

export function createSceneMutationQueue() {
  const pendingRef = { current: 0 };
  const authorityRef = { current: null };
  let tail = Promise.resolve();
  return Object.freeze({
    pendingRef, authorityRef,
    adoptAuthority(token) {
      if (typeof token === 'string' && token) authorityRef.current = token;
    },
    enqueue(request, apply = value => value, guard = {}) {
      pendingRef.current++;
      const operation = tail.then(request).then(async result => {
        if (guard.baseToken && result?.status === 'committed'
          && authorityRef.current !== guard.baseToken
          && authorityRef.current !== result.sceneToken) {
          return { status: 'superseded', opId: result.opId };
        }
        await apply(result);
        if (typeof result?.sceneToken === 'string' && result.sceneToken) {
          authorityRef.current = result.sceneToken;
        }
        return result;
      });
      const settled = operation.finally(() => { pendingRef.current--; });
      tail = settled.catch(() => {});
      return settled;
    },
  });
}

export function markerExportElements(elements = []) {
  return elements.map(element => element?.id
    ? { ...element, link: `${MARKER_PREFIX}${encodeURIComponent(element.id)}` }
    : element);
}

export function installExportMarkers(svg) {
  for (const anchor of svg?.querySelectorAll?.('a[href], a[xlink\\:href]') || []) {
    const href = anchor.getAttribute('href') || anchor.getAttribute('xlink:href') || '';
    if (!href.startsWith(MARKER_PREFIX)) continue;
    anchor.setAttribute('data-ink-element-id', decodeURIComponent(href.slice(MARKER_PREFIX.length)));
    anchor.removeAttribute('href');
    anchor.removeAttribute('xlink:href');
  }
  return svg;
}

export function createInkDomAdapter(root) {
  let marked = [];
  let clears = 0;
  const select = id => root?.querySelectorAll?.(`[data-ink-element-id="${CSS.escape(id)}"]`) || [];
  return Object.freeze({
    mark(anchorIds) {
      marked.forEach(node => node.classList.remove('ink-carry-anchor'));
      marked = anchorIds.flatMap(id => [...select(id)]);
      marked.forEach(node => node.classList.add('ink-carry-anchor'));
      root?.classList.toggle('ink-carry-active', !!marked.length);
    },
    present(dx, dy) {
      root?.style.setProperty('--carry-x', `${dx}px`);
      root?.style.setProperty('--carry-y', `${dy}px`);
    },
    clear() {
      marked.forEach(node => node.classList.remove('ink-carry-anchor'));
      marked = [];
      root?.classList.remove('ink-carry-active');
      root?.style.removeProperty('--carry-x');
      root?.style.removeProperty('--carry-y');
      clears++;
    },
    stats: () => ({ marked: marked.length, clears }),
  });
}

export function presentedWorld(renderedWorld, state) {
  if (!renderedWorld || !state?.anchorIds?.length || !['DRAGGING', 'COMMITTING', 'QUERYING_OPERATION', 'AWAITING_FRAME', 'RETRYABLE_PAINT'].includes(state.phase)) {
    return renderedWorld;
  }
  const ids = new Set(state.anchorIds);
  return {
    ...renderedWorld,
    elements: renderedWorld.elements.map(element => ids.has(element.id)
      ? { ...element, x: element.x + state.dx, y: element.y + state.dy }
      : element),
  };
}

export function createContainerCarryController({
  dom, commit, queryStatus, requestFrame, retryFrame, clearFrameOwner, onConflict, ledgerLimit = 128,
}) {
  let state = createCarryState();
  let frameOwner = null;
  const ledger = createCarryLedger(ledgerLimit);
  const listeners = new Set();
  const notify = () => listeners.forEach(listener => listener(state));
  const dispatch = event => {
    const before = state;
    const step = reduceCarry(state, event);
    state = step.state;
    if (state !== before) {
      ledger.append(event, before, state);
    }
    for (const command of step.commands) run(command);
    if (state !== before) notify();
    return state !== before;
  };
  const current = (txId, opId, phases) => phases.includes(state.phase)
    && state.txId === txId && state.opId === opId;
  const clearOwnedFrame = () => {
    if (!frameOwner) return;
    clearFrameOwner?.(frameOwner.txId, frameOwner.targetFrameId);
    frameOwner = null;
  };
  const conflict = (event, error) => {
    if (!current(event.txId, event.opId, ['COMMITTING', 'QUERYING_OPERATION'])) return false;
    const failed = state;
    if (!dispatch(event)) return false;
    onConflict?.(error, failed);
    return true;
  };
  const committed = (txId, opId, result, eventType = 'COMMIT_OK') => {
    const querying = eventType === 'STATUS_COMMITTED';
    const phases = [querying ? 'QUERYING_OPERATION' : 'COMMITTING'];
    if (!current(txId, opId, phases)) return;
    if (result?.status !== 'committed' || result.opId !== opId) {
      conflict({ type: 'OP_UNKNOWN', txId, opId }, { code: 'OP_RESULT_MISMATCH' });
      return;
    }
    const acceptedType = querying ? 'STATUS_ACCEPTED' : 'COMMIT_ACCEPTED';
    if (!dispatch({ type: acceptedType, txId, opId })) return;
    const targetFrameId = result.movedIds?.length ? requestFrame(result, txId) : null;
    if (targetFrameId != null) frameOwner = { txId, targetFrameId };
    if (!dispatch({ type: eventType, txId, opId, targetFrameId })) clearOwnedFrame();
  };
  const run = command => {
    if (command.type === 'MARK') dom.mark(command.anchorIds);
    else if (command.type === 'PRESENT') dom.present(command.dx, command.dy);
    else if (command.type === 'CLEAR') dom.clear();
    else if (command.type === 'RETRY_FRAME') retryFrame(command.targetFrameId, command.txId);
    else if (command.type === 'COMMIT') {
      commit(command.command).then(
        result => committed(command.txId, command.command.opId, result),
        error => {
          if (!current(command.txId, command.command.opId, ['COMMITTING'])) return;
          if (error?.status === 409) {
            conflict({ type: 'CONFLICT', txId: command.txId, opId: command.command.opId }, error);
          } else dispatch({ type: 'RESPONSE_UNKNOWN', txId: command.txId, opId: command.command.opId });
        },
      );
    } else if (command.type === 'QUERY_STATUS') {
      queryStatus(command.opId, state.baseToken).then(
        result => result.status === 'committed'
          ? committed(command.txId, command.opId, result, 'STATUS_COMMITTED')
          : conflict(
            { type: 'OP_UNKNOWN', txId: command.txId, opId: command.opId },
            { code: result.status === 'superseded' ? 'STATUS_SUPERSEDED' : 'OP_UNKNOWN' },
          ),
        () => conflict(
          { type: 'OP_UNKNOWN', txId: command.txId, opId: command.opId },
          { code: 'OP_UNKNOWN' },
        ),
      );
    }
  };
  return Object.freeze({
    begin(input) {
      if (state.phase !== 'IDLE') return null;
      const elements = input.renderedWorld?.elements || [];
      const hasInk = elements.length > 0;
      if (!input.queueIdle || input.sceneMutationPending || input.drawingTransaction || !input.sceneToken
        || (hasInk && (!input.renderedWorld || input.renderedRevision !== input.requestedRevision))) return null;
      const anchorIds = hasInk
        ? (computeAnchorIds(elements, input.containers).get(input.container.id) || [])
        : [];
      const txId = uuid();
      dispatch({
        type: 'BEGIN', txId, opId: uuid(), baseToken: input.sceneToken,
        containerId: input.container.id, from: input.from, anchorIds,
      });
      return txId;
    },
    move: (txId, to) => dispatch({ type: 'MOVE', txId, to }),
    drop: (txId, to) => dispatch({ type: 'DROP', txId, to }),
    cancel: txId => dispatch({ type: 'CANCEL', txId }),
    frameReady(txId, targetFrameId) {
      const accepted = dispatch({ type: 'TARGET_FRAME_READY', txId, targetFrameId });
      if (accepted) clearOwnedFrame();
      return accepted;
    },
    frameError: (txId, targetFrameId) => dispatch({ type: 'FINAL_FRAME_ERROR', txId, targetFrameId }),
    retry: () => state.txId && dispatch({ type: 'RETRY', txId: state.txId }),
    state: () => state,
    events: () => ledger.read(),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    dispose() {
      dispatch({ type: 'UNMOUNT' });
      clearOwnedFrame();
      listeners.clear();
    },
  });
}
