/**
 * [INPUT]: 依赖浏览器 IndexedDB，或 node:test 注入的同形 adapter
 * [OUTPUT]: 提供单 active drawing draft 的串行防抖 journal、只读元数据检查/深拷贝导出/精确身份放弃、FlowCanvas 水合/closing 协调器、scene/baseline/closure 精确恢复判定与 request/epoch/seq 条件清理
 * [POS]: 临时编辑草稿仓；只恢复局部 editSeed，不参与 committed 世界合并或网络提交
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

const RECORD_KEY = 'active';
const stable = value => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
};
export const drawingDraftClosureFingerprint = transaction =>
  stable({
    kind: transaction?.kind,
    targetId: transaction?.targetId,
    originalIds: transaction?.originalIds || [],
    anchorIndex: transaction?.anchorIndex,
  });
export async function drawingDraftSnapshotFingerprint(snapshot) {
  const bytes = new TextEncoder().encode(stable(snapshot));
  if (!globalThis.crypto?.subtle) return `json:${new TextDecoder().decode(bytes)}`;
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}
const validRecord = value => value?.schemaVersion === 1
  && typeof value.requestId === 'string' && value.requestId
  && Number.isInteger(value.epoch) && value.epoch > 0
  && Number.isInteger(value.seq) && value.seq > 0
  && typeof value.sceneToken === 'string' && value.sceneToken
  && typeof value.closureFingerprint === 'string'
  && typeof value.baselineFingerprint === 'string' && value.baselineFingerprint
  && typeof value.mergedFingerprint === 'string' && value.mergedFingerprint
  && Array.isArray(value.draft?.elements)
  && value.draft?.files && typeof value.draft.files === 'object' && !Array.isArray(value.draft.files);
const sameIdentity = (left, right) => !!left && !!right
  && left.requestId === right.requestId && left.epoch === right.epoch;

export function createIndexedDbDraftAdapter(indexedDB = globalThis.indexedDB) {
  let opened;
  const db = () => {
    if (!indexedDB) return Promise.reject(new Error('IndexedDB unavailable'));
    if (opened) return opened;
    opened = new Promise((resolve, reject) => {
      const request = indexedDB.open('agent-canvas-drawing-drafts', 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('drafts')) {
          request.result.createObjectStore('drafts');
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('IndexedDB open failed'));
    });
    return opened;
  };
  const transaction = async (mode, task) => {
    const database = await db();
    return new Promise((resolve, reject) => {
      const tx = database.transaction('drafts', mode);
      const store = tx.objectStore('drafts');
      let result;
      try { result = task(store); } catch (error) { reject(error); return; }
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
      tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
    });
  };
  return {
    async get() {
      const database = await db();
      return new Promise((resolve, reject) => {
        const request = database.transaction('drafts', 'readonly').objectStore('drafts').get(RECORD_KEY);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error || new Error('IndexedDB read failed'));
      });
    },
    put(record) {
      return transaction('readwrite', store => { store.put(record, RECORD_KEY); });
    },
    async deleteIfIdentity(identity) {
      const database = await db();
      return new Promise((resolve, reject) => {
        const tx = database.transaction('drafts', 'readwrite');
        const store = tx.objectStore('drafts');
        const request = store.get(RECORD_KEY);
        let removed = false;
        request.onsuccess = () => {
          if (sameIdentity(request.result, identity)) {
            store.delete(RECORD_KEY);
            removed = true;
          }
        };
        request.onerror = () => reject(request.error || new Error('IndexedDB read failed'));
        tx.oncomplete = () => resolve(removed);
        tx.onerror = () => reject(tx.error || new Error('IndexedDB delete failed'));
        tx.onabort = () => reject(tx.error || new Error('IndexedDB delete aborted'));
      });
    },
  };
}

export function createDrawingDraftStore({
  adapter = createIndexedDbDraftAdapter(),
  debounceMs = 250,
  onError = () => {},
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  fingerprint = drawingDraftSnapshotFingerprint,
} = {}) {
  let active = null;
  let epochCounter = 0;
  let seq = 0;
  let timer = null;
  let pendingRecord = null;
  let tail = Promise.resolve();
  let warned = false;
  const report = error => {
    if (!warned) {
      warned = true;
      onError(error);
    }
    return null;
  };
  const enqueue = task => {
    const run = tail.then(task).catch(report);
    tail = run.then(() => {});
    return run;
  };
  const cancelTimer = () => {
    if (timer !== null) clearTimer(timer.handle);
    timer = null;
  };
  const writePending = expected => {
    if (expected && (!pendingRecord
      || !sameIdentity(expected, pendingRecord) || expected.seq !== pendingRecord.seq)) {
      return tail;
    }
    cancelTimer();
    const pending = pendingRecord;
    pendingRecord = null;
    if (!pending) return tail;
    return enqueue(async () => {
      const owner = active;
      if (!sameIdentity(owner, pending)) return false;
      const merged = owner.mergeDraft(pending.draft);
      const baselineFingerprint = owner.baselineFingerprint
        || await fingerprint(owner.baselineSnapshot);
      const mergedFingerprint = await fingerprint(merged);
      if (active !== owner || !sameIdentity(active, pending)) return false;
      owner.baselineFingerprint = baselineFingerprint;
      const persisted = {
        schemaVersion: 1,
        requestId: pending.requestId,
        epoch: pending.epoch,
        seq: pending.seq,
        sceneToken: owner.sceneToken,
        closureFingerprint: owner.closureFingerprint,
        baselineFingerprint,
        mergedFingerprint,
        draft: structuredClone(pending.draft),
      };
      await adapter.put(persisted);
      if (active !== owner || !sameIdentity(active, pending)) {
        await adapter.deleteIfIdentity(persisted);
        return false;
      }
      return true;
    });
  };
  const buildPending = draft => {
    if (!active) return null;
    return {
      requestId: active.requestId,
      epoch: active.epoch,
      seq: ++seq,
      draft,
    };
  };
  return Object.freeze({
    async inspect({ sceneToken, closureFingerprint, baselineSnapshot } = {}) {
      return enqueue(async () => {
        const record = await adapter.get();
        if (record == null) return { status: 'empty' };
        const valid = validRecord(record);
        const canMatch = valid
          && typeof sceneToken === 'string'
          && typeof closureFingerprint === 'string'
          && baselineSnapshot !== undefined;
        const currentFingerprint = canMatch ? await fingerprint(baselineSnapshot) : null;
        return {
          status: valid ? 'present' : 'invalid',
          requestId: typeof record.requestId === 'string' ? record.requestId : null,
          epoch: Number.isInteger(record.epoch) ? record.epoch : null,
          seq: Number.isInteger(record.seq) ? record.seq : null,
          sceneToken: typeof record.sceneToken === 'string' ? record.sceneToken : null,
          closureFingerprint: typeof record.closureFingerprint === 'string'
            ? record.closureFingerprint
            : null,
          elementCount: Array.isArray(record.draft?.elements) ? record.draft.elements.length : 0,
          approximateBytes: new TextEncoder().encode(JSON.stringify(record)).byteLength,
          matchesCurrentScene: canMatch
            ? record.sceneToken === sceneToken
              && record.closureFingerprint === closureFingerprint
              && record.baselineFingerprint === currentFingerprint
            : false,
        };
      });
    },
    exportActiveDraft() {
      return enqueue(async () => {
        const record = await adapter.get();
        return record == null ? null : structuredClone(record);
      });
    },
    discard(identity) {
      return enqueue(async () => {
        const removed = await adapter.deleteIfIdentity(identity);
        if (removed && sameIdentity(active, identity)) {
          cancelTimer();
          pendingRecord = null;
          active = null;
        }
        return removed;
      });
    },
    async recover({ sceneToken, closureFingerprint, baselineSnapshot }) {
      const record = await enqueue(() => adapter.get());
      if (record == null) return { status: 'empty' };
      if (!validRecord(record)) return { status: 'conflict', reason: 'invalid-record' };
      const currentFingerprint = await fingerprint(baselineSnapshot);
      if (currentFingerprint === record.mergedFingerprint) {
        await enqueue(() => adapter.deleteIfIdentity(record));
        return { status: 'committed', requestId: record.requestId };
      }
      if (record.sceneToken === sceneToken
        && record.closureFingerprint === closureFingerprint
        && record.baselineFingerprint === currentFingerprint) {
        return { status: 'restored', record: structuredClone(record) };
      }
      return { status: 'conflict', reason: 'scene-baseline-or-closure-mismatch' };
    },
    begin({
      requestId,
      sceneToken,
      closureFingerprint,
      baselineSnapshot,
      mergeDraft,
      epoch: initialEpoch,
      seq: initialSeq = 0,
    }) {
      cancelTimer();
      pendingRecord = null;
      const epoch = Number.isInteger(initialEpoch) && initialEpoch > 0
        ? initialEpoch
        : epochCounter + 1;
      epochCounter = Math.max(epochCounter, epoch);
      active = {
        requestId,
        sceneToken,
        closureFingerprint,
        baselineSnapshot,
        mergeDraft,
        baselineFingerprint: null,
        epoch,
      };
      seq = Math.max(0, initialSeq);
      return Object.freeze({ requestId, epoch });
    },
    schedule(draft) {
      const pending = buildPending(draft);
      if (!pending) return 0;
      pendingRecord = pending;
      cancelTimer();
      const handle = setTimer(() => writePending(pending), debounceMs);
      timer = { handle, pending };
      return pending.seq;
    },
    flush(draft) {
      if (draft) pendingRecord = buildPending(draft);
      return writePending();
    },
    clear(identity) {
      if (sameIdentity(active, identity)) {
        cancelTimer();
        pendingRecord = null;
        active = null;
      }
      return enqueue(() => adapter.deleteIfIdentity(identity));
    },
    deactivate(identity) {
      if (!sameIdentity(active, identity)) return false;
      cancelTimer();
      pendingRecord = null;
      active = null;
      return true;
    },
    idle: async () => {
      await writePending();
      return tail;
    },
  });
}

export function createDrawingDraftCoordinator(
  store = createDrawingDraftStore(),
  scheduleMicrotask = globalThis.queueMicrotask,
) {
  let activeIdentity = null;
  let hydrated = false;
  let skipHydrationChange = false;
  let hydrationGeneration = 0;
  const resetHydration = () => {
    hydrationGeneration++;
    hydrated = false;
    skipHydrationChange = false;
  };
  return Object.freeze({
    inspect: input => store.inspect(input),
    exportActiveDraft: () => store.exportActiveDraft(),
    async discard(identity) {
      const removed = await store.discard(identity);
      if (removed && sameIdentity(activeIdentity, identity)) {
        activeIdentity = null;
        resetHydration();
      }
      return removed;
    },
    recover: input => store.recover(input),
    begin(input) {
      activeIdentity = store.begin(input);
      resetHydration();
      return activeIdentity;
    },
    markHydrated(identity = activeIdentity) {
      if (!sameIdentity(activeIdentity, identity)) return false;
      hydrated = true;
      skipHydrationChange = true;
      const generation = ++hydrationGeneration;
      scheduleMicrotask?.(() => {
        if (hydrationGeneration === generation) skipHydrationChange = false;
      });
      return true;
    },
    schedule(draft) {
      if (!hydrated || !activeIdentity) return 0;
      if (skipHydrationChange) {
        skipHydrationChange = false;
        return 0;
      }
      return store.schedule(draft);
    },
    flush: draft => store.flush(draft),
    clear(identity) {
      if (sameIdentity(activeIdentity, identity)) {
        activeIdentity = null;
        resetHydration();
      }
      return store.clear(identity);
    },
    deactivate(identity) {
      if (!sameIdentity(activeIdentity, identity)) return false;
      activeIdentity = null;
      resetHydration();
      return store.deactivate(identity);
    },
    async rebaseAfterClosingFailure(input, draft) {
      const identity = store.begin(input);
      activeIdentity = identity;
      hydrated = true;
      skipHydrationChange = false;
      hydrationGeneration++;
      await store.flush(draft);
      return identity;
    },
    idle: () => store.idle(),
  });
}

export function advanceAutoSinkUndoTicket(current, {
  transaction,
  commitBase,
  committed,
  advancedTransaction,
  sunkIds = [],
} = {}) {
  if (sunkIds.length) {
    return { sunkIds: [...sunkIds], after: committed, transaction: advancedTransaction };
  }
  if (current?.transaction === transaction && current.after === commitBase) {
    const below = new Set((committed?.elements || [])
      .filter(element => element?.customData?.below)
      .map(element => element.id));
    const remaining = current.sunkIds.filter(id => below.has(id));
    return remaining.length
      ? { ...current, sunkIds: remaining, after: committed, transaction: advancedTransaction }
      : null;
  }
  return current;
}

export function submitAutoSinkUndo(queue, ticket, setPlane) {
  let restored = false;
  return queue.submit(base => {
    if (!ticket || base !== ticket.after) return null;
    restored = true;
    let elements = base.elements;
    for (const id of ticket.sunkIds || []) elements = setPlane(elements, id, false);
    return { elements, files: base.files };
  }).then(snapshot => ({ restored, snapshot }));
}
