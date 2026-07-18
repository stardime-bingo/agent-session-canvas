/**
 * [INPUT]: 无外部依赖的纯状态内核；持久化函数由创建方注入（api.putScene/putDrawingFiles）
 * [OUTPUT]: 对外提供 createSceneStore —— 单一场景真相源：同步 mutate、订阅、全画布 undo/redo、
 *           后台防抖冲刷（失败无限退避、永不阻塞交互）、远端回声采纳（LWW）
 * [POS]: web 的画布数据心脏。手 → 文档 → 屏幕同步直达；磁盘是河边取水人，永远不许筑坝
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

const FLUSH_DEBOUNCE_MS = 300;
const RETRY_BASE_MS = 1000;
const RETRY_CAP_MS = 15000;
const HISTORY_CAP = 100;

export const emptySceneDoc = () => ({
  seq: 0, layout: {}, edges: [], notes: [], boards: [], drawing: [], drawingFiles: {},
});

// 图片资产增量：只挑基线里没有的新 ID（同 ID 内容不可变，重复上传幂等）
export const sceneFilesDelta = (baseFiles = {}, nextFiles = {}) =>
  Object.fromEntries(Object.entries(nextFiles).filter(([id]) => !Object.hasOwn(baseFiles, id)));

export function createSceneStore(initial, { persistScene, persistFiles } = {}) {
  let doc = { ...emptySceneDoc(), ...initial, seq: 1 };
  let lastFlushed = doc;          // 最近一次成功落盘的文档（files delta 基线）
  let syncStatus = 'saved';       // saved | dirty | saving | error
  let lastError = null;
  let statusSnapshot = Object.freeze({ status: syncStatus, error: lastError });
  let serverRev = 0;              // 已知服务端代际：采纳只许单调前进，旧图回灌一律拒绝
  const listeners = new Set();
  const undoStack = [];
  const redoStack = [];
  let coalesceKey = null;         // 连续同键 mutate 合并为一步 undo（画笔流/打字流）
  let flushTimer = null;
  let retryTimer = null;
  let retryAttempt = 0;
  let flushing = false;

  const notify = () => listeners.forEach(listener => listener());
  const setStatus = status => {
    if (syncStatus === status && statusSnapshot.error === lastError) return;
    syncStatus = status;
    statusSnapshot = Object.freeze({ status, error: lastError });
    notify();
  };

  const scheduleFlush = (delay = FLUSH_DEBOUNCE_MS) => {
    clearTimeout(flushTimer);
    flushTimer = setTimeout(() => { flushTimer = null; void flush(); }, delay);
  };

  async function flush() {
    if (flushing) return;                 // 在飞快照落定后会自查追赶，无需并发
    if (doc === lastFlushed) { setStatus('saved'); return; }
    flushing = true;
    clearTimeout(retryTimer);
    setStatus('saving');
    const snapshot = doc;
    try {
      const delta = sceneFilesDelta(lastFlushed.drawingFiles, snapshot.drawingFiles);
      if (Object.keys(delta).length) await persistFiles(delta);
      const receipt = await persistScene({
        layout: snapshot.layout,
        canvas: {
          edges: snapshot.edges, notes: snapshot.notes,
          boards: snapshot.boards, drawing: snapshot.drawing,
        },
      });
      if (Number.isFinite(receipt?.rev)) serverRev = Math.max(serverRev, receipt.rev);
      lastFlushed = snapshot;
      retryAttempt = 0;
      lastError = null;
      flushing = false;
      if (doc !== snapshot) scheduleFlush(0);   // 冲刷期间又有新改动：立即追赶
      else setStatus('saved');
    } catch (error) {
      flushing = false;
      lastError = error;
      setStatus('error');
      const delay = Math.min(RETRY_BASE_MS * 2 ** retryAttempt, RETRY_CAP_MS);
      retryAttempt++;
      retryTimer = setTimeout(() => { retryTimer = null; void flush(); }, delay);
    }
  }

  const markDirty = () => {
    if (syncStatus !== 'error') setStatus('dirty');
    scheduleFlush();
  };

  return {
    get: () => doc,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    status: () => statusSnapshot,

    // 全系统唯一写入口：同步执行、同步可见。history:false 用于不值得单独撤销的纯回写。
    mutate(fn, { history = true, coalesce = null } = {}) {
      const next = fn(doc);
      if (!next || next === doc) return doc;
      if (history) {
        const sameRun = coalesce && coalesce === coalesceKey;
        if (!sameRun) {
          undoStack.push(doc);
          if (undoStack.length > HISTORY_CAP) undoStack.shift();
        }
        coalesceKey = coalesce;
        redoStack.length = 0;
      }
      doc = { ...next, seq: doc.seq + 1 };
      notify();
      markDirty();
      return doc;
    },

    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,

    undo() {
      const prev = undoStack.pop();
      if (!prev) return false;
      redoStack.push(doc);
      coalesceKey = null;
      doc = { ...prev, seq: doc.seq + 1 };
      notify();
      markDirty();
      return true;
    },

    redo() {
      const next = redoStack.pop();
      if (!next) return false;
      undoStack.push(doc);
      coalesceKey = null;
      doc = { ...next, seq: doc.seq + 1 };
      notify();
      markDirty();
      return true;
    },

    // 结束一段连续手势（画笔一笔收尾/便签失焦）：下一次同键 mutate 开新的 undo 步
    endCoalescing() { coalesceKey = null; },

    // 远端回声（别的标签页写了）：本地干净才采纳；本地有脏改动则本地胜（LWW，冲刷会覆盖）；
    // rev 单调门：与在飞冲刷赛跑的旧图读值不许倒灌覆盖新真相
    adoptRemote(remote, incomingRev = null) {
      if (doc !== lastFlushed || flushing) return false;
      if (Number.isFinite(incomingRev)) {
        if (incomingRev < serverRev) return false;
        serverRev = incomingRev;
      }
      coalesceKey = null;
      doc = { ...emptySceneDoc(), ...remote, seq: doc.seq + 1 };
      lastFlushed = doc;
      notify();
      setStatus('saved');
      return true;
    },

    // pagehide 兜底：立即发起一次冲刷（fetch keepalive 由注入的 persist 自选）
    flushNow() {
      clearTimeout(flushTimer);
      flushTimer = null;
      return flush();
    },
  };
}
