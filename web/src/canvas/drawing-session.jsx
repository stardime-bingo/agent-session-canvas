/**
 * [INPUT]: 依赖 scene-store 的 mutate/undo、drawing.js 的事务闭包与合并纯函数、DrawLayer 控制器
 * [OUTPUT]: 对外提供 useDrawingSession —— 绘图编辑生命周期：同步打开、onChange 连续合并进 store、
 *           无握手退出（世界帧追上即卸载）、首笔大底板自动沉层 + 可撤销 toast、选绘图待选态
 * [POS]: canvas 的绘图会话心脏。持久化是 store 的私事：这里没有队列、没有回执、没有门
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  advanceDrawingTransaction, autoSinkLargeNewDrawingDraft, createDrawingTransaction,
  drawingSnapshot, mergeDrawingTransaction, setDrawingElementPlane,
} from './drawing.js';
import { toast } from '../ui.jsx';

const MERGE_DEBOUNCE_MS = 140;    // 画笔流合并节流：肉眼无感，undo 以一段手势为一步
const REVEAL_TIMEOUT_MS = 600;    // 洞帧/收尾帧超时兜底：帧没来也不许把用户困在过渡态
const NO_IDS = Object.freeze([]);

export function useDrawingSession({ store, drawRef, getRenderedWorld, onBeforeExit, onExitToCanvas }) {
  const [penActive, setPenActive] = useState(false);
  const [drawVisible, setDrawVisible] = useState(false);
  const [drawTool, setDrawTool] = useState('selection');
  const [selectArmed, setSelectArmed] = useState(false);
  const [editSeed, setEditSeed] = useState(null);          // DrawLayer 初始 elements/files
  const [excludedIds, setExcludedIds] = useState(NO_IDS);  // committed 世界的洞：编辑器正在托管的元素

  const penActiveRef = useRef(false);
  const drawVisibleRef = useRef(false);
  const drawToolRef = useRef('selection');
  const selectArmedRef = useRef(false);
  const transactionRef = useRef(null);
  const exitingRef = useRef(false);
  const sessionPhaseRef = useRef('idle');    // idle → opening → live → exiting → idle；相机只在 live 相接管
  const composingRef = useRef(false);
  const pendingExitRef = useRef(false);      // IME 组字期间收到退出请求：compositionend 后补退
  const mergeTimerRef = useRef(null);
  const pendingDraftRef = useRef(null);
  const autoSinkNotifiedRef = useRef(false);
  const revealRef = useRef(null);            // { kind:'open'|'exit', seq, timer }
  const pendingSelectRef = useRef(null);

  const setVisible = useCallback(visible => {
    drawVisibleRef.current = visible;
    setDrawVisible(visible);
    if (visible && sessionPhaseRef.current === 'opening') sessionPhaseRef.current = 'live';
  }, []);

  const clearReveal = () => {
    if (revealRef.current?.timer) clearTimeout(revealRef.current.timer);
    revealRef.current = null;
  };

  // ---- 连续合并：编辑器每次稳定 change 都同步进场景真相，崩溃丢失 ≤ 一次防抖窗 ----
  const mergeDraft = useCallback(draft => {
    const transaction = transactionRef.current;
    if (!transaction || !draft) return;
    const doc = store.get();
    const base = { elements: doc.drawing, files: doc.drawingFiles };
    // 首笔大实心底板自动沉层：只在 new 事务的第一次合并可能发生，沉了要告知并可撤销
    const prepared = autoSinkLargeNewDrawingDraft(base, transaction, draft);
    const merged = mergeDrawingTransaction(base, transaction, draft);
    store.mutate(d => ({ ...d, drawing: merged.elements, drawingFiles: merged.files }),
      { coalesce: 'draw' });
    transactionRef.current = advanceDrawingTransaction(transaction, prepared.snapshot);
    setExcludedIds(transactionRef.current.originalIds || NO_IDS);
    if (prepared.sunkIds.length && !autoSinkNotifiedRef.current) {
      autoSinkNotifiedRef.current = true;
      const sunkIds = prepared.sunkIds;
      // 编辑器里的活副本也要带上同一层级真相，后续合并不许把底板浮回来
      for (const id of sunkIds) void drawRef.current?.setElementPlane?.(id, true);
      toast('大块底板已自动沉到卡片下面', 'ok', {
        label: '撤销',
        onClick: () => {
          for (const id of sunkIds) void drawRef.current?.setElementPlane?.(id, false);
          store.mutate(d => ({
            ...d,
            drawing: sunkIds.reduce((els, id) => setDrawingElementPlane(els, id, false), d.drawing),
          }));
          toast('已撤销自动沉底', 'ok');
        },
      });
    }
  }, [store, drawRef]);

  const flushMerge = useCallback(() => {
    clearTimeout(mergeTimerRef.current);
    mergeTimerRef.current = null;
    if (pendingDraftRef.current) {
      const draft = pendingDraftRef.current;
      pendingDraftRef.current = null;
      mergeDraft(draft);
    }
  }, [mergeDraft]);

  const onDraftChange = useCallback(draft => {
    if (!penActiveRef.current || exitingRef.current) return;
    pendingDraftRef.current = draft;
    clearTimeout(mergeTimerRef.current);
    mergeTimerRef.current = setTimeout(flushMerge, MERGE_DEBOUNCE_MS);
  }, [flushMerge]);

  // 切后台/关页前把手上这一笔合并进 store 并推一把冲刷
  useEffect(() => {
    const onHide = () => { flushMerge(); store.flushNow?.(); };
    window.addEventListener('pagehide', onHide);
    const onVisibility = () => { if (document.visibilityState === 'hidden') onHide(); };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', onHide);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [flushMerge, store]);

  // ---- 打开：同步建事务、挂编辑器；洞帧进 DOM 才显形，杜绝一帧双影 ----
  const openDrawing = useCallback((tool, selectId = null) => {
    selectArmedRef.current = false;
    setSelectArmed(false);
    if (penActiveRef.current) {
      // 已在编辑：同工具再点=退出；换工具/选目标（目标必须在本事务闭包内）
      if (drawToolRef.current === tool && !selectId) return exitDrawing();
      const transaction = transactionRef.current;
      if (selectId && !transaction?.originalIds?.includes(selectId)) {
        toast('请先退出当前绘图，再选择另一段绘图');
        return Promise.resolve(false);
      }
      drawToolRef.current = tool;
      setDrawTool(tool);
      drawRef.current?.activateTool(tool);
      if (selectId) drawRef.current?.selectElement(selectId);
      return Promise.resolve(true);
    }
    const doc = store.get();
    const transaction = createDrawingTransaction(
      { elements: doc.drawing, files: doc.drawingFiles }, selectId,
    );
    if (!transaction) {
      toast('目标绘图刚刚发生变化，请重新选择', 'error');
      return Promise.resolve(false);
    }
    transactionRef.current = transaction;
    autoSinkNotifiedRef.current = false;
    pendingSelectRef.current = selectId;
    drawToolRef.current = tool;
    setDrawTool(tool);
    setEditSeed({ kind: transaction.kind, elements: transaction.elements, files: transaction.files });
    sessionPhaseRef.current = 'opening';
    penActiveRef.current = true;
    setPenActive(true);
    setVisible(false);   // 编辑器先隐藏；洞帧就位（或超时兜底）才显形
    return Promise.resolve(true);
  }, [store, drawRef]);   // eslint-disable-line react-hooks/exhaustive-deps

  // DrawLayer 水合完成：选中目标、请求洞帧；空事务无洞可等，当帧显形
  const onEditorReady = useCallback(controller => {
    const transaction = transactionRef.current;
    if (!transaction) return;
    controller.activateTool(drawToolRef.current);
    const selectId = pendingSelectRef.current;
    if (selectId && controller.getElements()?.some(el => el.id === selectId)) {
      controller.selectElement(selectId);
    }
    pendingSelectRef.current = null;
    if (!transaction.originalIds?.length) {
      setVisible(true);
      return;
    }
    setExcludedIds(transaction.originalIds);
    clearReveal();
    revealRef.current = {
      kind: 'open',
      timer: setTimeout(() => { clearReveal(); setVisible(true); }, REVEAL_TIMEOUT_MS),
    };
  }, [setVisible]);

  // ---- 退出：合并收尾同步落 store，编辑器保持在场直到世界帧追上（或超时），同一 commit 卸载 ----
  const exitDrawing = useCallback(async () => {
    if (!penActiveRef.current || exitingRef.current) return false;
    if (composingRef.current) { pendingExitRef.current = true; return false; }   // IME 组字中不拔编辑器
    exitingRef.current = true;
    sessionPhaseRef.current = 'exiting';
    clearReveal();
    onBeforeExit?.();   // 相机让位：清时钟/指针，suspended 的已 ready 预览留下填收尾洞
    try {
      const draft = await drawRef.current?.flush?.();
      pendingDraftRef.current = null;
      clearTimeout(mergeTimerRef.current);
      if (draft) mergeDraft(drawingSnapshot(draft.elements, draft.files));
      store.endCoalescing();
      const targetSeq = store.get().seq;
      const hadHole = (transactionRef.current?.originalIds || []).length > 0;
      setExcludedIds(NO_IDS);       // 洞补回：世界重新拥有全部元素
      // 没洞可补且世界已是当前代（空手进出/纯选中看看）：当场收尾，不等帧
      const rendered = getRenderedWorld?.();
      if (!hadHole && rendered && rendered.revision >= targetSeq) {
        finishExit();
        return true;
      }
      await new Promise(resolve => {
        revealRef.current = {
          kind: 'exit', seq: targetSeq, resolve,
          timer: setTimeout(() => { finishExit(); resolve(); }, REVEAL_TIMEOUT_MS),
        };
      });
      return true;
    } finally {
      exitingRef.current = false;
    }
  }, [mergeDraft, store]);   // eslint-disable-line react-hooks/exhaustive-deps

  const finishExit = () => {
    clearReveal();
    transactionRef.current = null;
    pendingSelectRef.current = null;
    sessionPhaseRef.current = 'idle';
    penActiveRef.current = false;
    setPenActive(false);
    setVisible(false);
    setEditSeed(null);
    setExcludedIds(NO_IDS);
  };

  // 世界帧回执：打开等洞、退出等全量，各自追上即收尾——纯声明式，没有第二种握手
  const onWorldFrame = useCallback(renderedWorld => {
    const reveal = revealRef.current;
    if (!reveal) return;
    if (reveal.kind === 'open') {
      const excluded = new Set(renderedWorld.excludedIds || []);
      const holePunched = (transactionRef.current?.originalIds || []).every(id => excluded.has(id));
      if (holePunched) { clearReveal(); setVisible(true); }
    } else if (reveal.kind === 'exit' && renderedWorld.revision >= reveal.seq) {
      const resolve = reveal.resolve;
      finishExit();
      resolve?.();
    }
  }, [setVisible]);   // eslint-disable-line react-hooks/exhaustive-deps

  const onCompositionChange = useCallback(active => {
    composingRef.current = active;
    if (!active && pendingExitRef.current) {
      pendingExitRef.current = false;
      void exitDrawing();
    }
  }, [exitDrawing]);

  // 选绘图入口：无目标先武装普通平面，命中才真正开编辑
  const armSelect = useCallback(hasInk => {
    if (penActiveRef.current) return openDrawing('selection');
    const armed = !selectArmedRef.current;
    selectArmedRef.current = armed;
    setSelectArmed(armed);
    drawToolRef.current = 'selection';
    setDrawTool('selection');
    if (armed) {
      toast(hasInk
        ? '请选择一段绘图；点空白会返回并继续操作底下对象'
        : '画布还没有绘图——点空白返回，或改用画笔开始绘制');
    }
    return Promise.resolve(armed);
  }, [openDrawing]);

  const disarmSelect = useCallback(() => {
    selectArmedRef.current = false;
    setSelectArmed(false);
  }, []);

  const togglePen = useCallback(() => {
    if (penActiveRef.current) void exitDrawing();
    else void openDrawing('freedraw');
  }, [exitDrawing, openDrawing]);

  useEffect(() => () => { clearTimeout(mergeTimerRef.current); clearReveal(); }, []);

  return {
    penActive, penActiveRef, drawVisible, drawVisibleRef, drawTool, drawToolRef,
    selectArmed, selectArmedRef, editSeed, excludedIds, sessionPhaseRef, setVisible,
    openDrawing, exitDrawing, togglePen, armSelect, disarmSelect,
    onDraftChange, onEditorReady, onWorldFrame, onCompositionChange,
    onToolChange: useCallback(tool => {
      if (!tool || tool === drawToolRef.current) return;
      drawToolRef.current = tool;
      setDrawTool(tool);
    }, []),
    exitToCanvas: useCallback(async ({ x, y }) => {
      if (!await exitDrawing()) return;
      setTimeout(() => {   // 等编辑器卸载、指针恢复后把这次点击转交给底下对象
        const el = document.elementFromPoint(x, y);
        if (!el) return;
        el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, isPrimary: true }));
        el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, isPrimary: true }));
        el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
      }, 0);
      onExitToCanvas?.();
    }, [exitDrawing, onExitToCanvas]),
  };
}
