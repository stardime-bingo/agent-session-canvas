/**
 * [INPUT]: SceneStore 当前文档、writerId、同源 localStorage/IndexedDB
 * [OUTPUT]: pagehide 大载荷恢复：同步保存无图片正文但含引用 fileIds 的场景快照，IndexedDB 按引用隔离暂存资产
 * [POS]: keepalive 64KB 浏览器上限之外的本地安全网；只在服务端快照更旧时回放，不参与日常渲染主权
 * [PROTOCOL]: 变更时更新此头部，然后检查 App.jsx/InkTools.jsx/web/CLAUDE.md
 */

export const SCENE_RECOVERY_PREFIX = 'agent-canvas-scene-recovery:v1:';
const DB_NAME = 'agent-canvas-scene-recovery';
const DB_STORE = 'drawing-files';

export const sceneRecoveryKey = writerId => `${SCENE_RECOVERY_PREFIX}${writerId}`;

export const sceneRecoveryFileIds = scene => [...new Set((scene?.drawing || [])
  .filter(element => !element?.isDeleted && element?.type === 'image' && typeof element.fileId === 'string' && element.fileId)
  .map(element => element.fileId))].sort();

export function sceneRecoverySnapshot(doc) {
  return {
    layout: doc.layout,
    edges: doc.edges,
    notes: doc.notes,
    boards: doc.boards,
    drawing: doc.drawing,
  };
}

export function saveSceneRecovery(doc, writerId, storage = globalThis.localStorage) {
  if (!storage || !writerId || !doc) return null;
  const key = sceneRecoveryKey(writerId);
  const record = {
    version: 1,
    writerId,
    clientSeq: doc.seq,
    savedAt: Date.now(),
    fileIds: sceneRecoveryFileIds(doc),
    scene: sceneRecoverySnapshot(doc),
  };
  try {
    storage.setItem(key, JSON.stringify(record));
    return { key, ...record };
  } catch {
    return null;
  }
}

export function readLatestSceneRecovery(serverUpdatedAt = 0, storage = globalThis.localStorage) {
  if (!storage) return null;
  const keys = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (key?.startsWith(SCENE_RECOVERY_PREFIX)) keys.push(key);
  }
  let latest = null;
  for (const key of keys) {
    try {
      const record = JSON.parse(storage.getItem(key));
      if (record?.version !== 1 || !record.scene || !Number.isFinite(record.savedAt)) throw new Error('invalid recovery');
      if (record.savedAt <= serverUpdatedAt) {
        storage.removeItem(key);
        continue;
      }
      const fileIds = Array.isArray(record.fileIds)
        ? [...new Set(record.fileIds.filter(id => typeof id === 'string' && id))].sort()
        : sceneRecoveryFileIds(record.scene);
      if (!latest || record.savedAt > latest.savedAt) latest = { key, ...record, fileIds };
    } catch {
      storage.removeItem(key);
    }
  }
  return latest;
}

export function clearSceneRecovery(key, limits = {}, storage = globalThis.localStorage) {
  try {
    if (!key || !storage) return false;
    const record = JSON.parse(storage.getItem(key));
    if (Number.isFinite(limits.clientSeq) && Number.isFinite(record?.clientSeq)
      && record.clientSeq > limits.clientSeq) return false;
    if (Number.isFinite(limits.savedAt) && Number.isFinite(record?.savedAt)
      && record.savedAt > limits.savedAt) return false;
    storage.removeItem(key);
    return true;
  } catch { return false; /* 隐私模式下清不掉不影响服务端真相。 */ }
}

const openRecoveryDb = () => new Promise((resolve, reject) => {
  if (!globalThis.indexedDB) return resolve(null);
  const request = indexedDB.open(DB_NAME, 1);
  request.onupgradeneeded = () => request.result.createObjectStore(DB_STORE, { keyPath: 'id' });
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error || new Error('恢复仓打开失败'));
});

const transactFiles = async (mode, action) => {
  try {
    const db = await openRecoveryDb();
    if (!db) return null;
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(DB_STORE, mode);
      const store = transaction.objectStore(DB_STORE);
      const result = action(store);
      transaction.oncomplete = () => { db.close(); resolve(result?.result ?? true); };
      transaction.onerror = () => { db.close(); reject(transaction.error || new Error('恢复仓事务失败')); };
      transaction.onabort = () => { db.close(); reject(transaction.error || new Error('恢复仓事务取消')); };
    });
  } catch {
    return null;
  }
};

export const stageRecoveryFile = file => file?.id
  ? transactFiles('readwrite', store => store.put(file))
  : Promise.resolve(null);

export async function loadRecoveryFiles(fileIds = []) {
  const wanted = new Set(fileIds);
  if (!wanted.size) return {};
  const rows = await transactFiles('readonly', store => store.getAll());
  return Array.isArray(rows)
    ? Object.fromEntries(rows.filter(file => file?.id && wanted.has(file.id)).map(file => [file.id, file]))
    : {};
}

export const clearRecoveryFiles = ids => transactFiles('readwrite', store => {
  for (const id of ids || []) store.delete(id);
  return true;
});
