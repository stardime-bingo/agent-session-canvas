/**
 * [INPUT]: 依赖 @excalidraw/excalidraw 与局部事务 elements/files；持久化主权由 FlowCanvas 的全量队列持有
 * [OUTPUT]: 对外提供仅在编辑态挂载的 DrawLayer；维护/flush/freeze 局部 draft、上报 IME 周期、capture 截断 Excal 缩放键，并仅在 opening/resume 同步对齐 RF viewport
 * [POS]: 临时目标事务编辑器；绝不直接保存局部副本，普通态与未选目标始终不挂载
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import React, { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { Excalidraw } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import {
  deleteDrawingElement, drawingEditorReadyStep, drawingSnapshot, hitDrawingElement,
  setDrawingElementPlane, translateDrawingElements,
} from './drawing.js';
import { drawingZoomKeyRoute } from './gestures.js';

export default forwardRef(function DrawLayer({ active, visible = true, initialElements, initialFiles, onToolChange, onReady, onDraftPageHide, onExitToCanvas, onCompositionChange }, ref) {
  const apiRef = useRef(null);
  const rootRef = useRef(null);
  const composingRef = useRef(false);
  const changeVersionRef = useRef(0);
  const downRef = useRef(null);
  const handshakeRef = useRef({ apiReady: false, hydrated: false, ready: false });
  const latestFiles = useRef(initialFiles || {});

  // excalidrawAPI 回调可能早于 initialData 水合；这个窗口内 flush 不许把已有绘图误写成空。
  const scene = () => {
    const current = apiRef.current?.getSceneElements() || [];
    return handshakeRef.current.hydrated || current.length ? current : (initialElements || []);
  };

  const draftSnapshot = () => drawingSnapshot(scene(), latestFiles.current);

  // 关标签页/刷新时只把局部 draft 交给父层；父层合并全量世界后才可 best-effort 保存。
  useEffect(() => {
    const onHide = () => onDraftPageHide?.(draftSnapshot());
    window.addEventListener('pagehide', onHide);
    return () => window.removeEventListener('pagehide', onHide);
  }, []);

  const alignViewport = v => {
    if (!v || !apiRef.current) return false;
    apiRef.current?.updateScene({
      appState: { scrollX: v.x / v.zoom, scrollY: v.y / v.zoom, zoom: { value: v.zoom } },
    });
    return true;
  };

  const freezeDraft = async () => {
    if (composingRef.current) return { status: 'blocked' };
    const focused = document.activeElement;
    if (focused && rootRef.current?.contains(focused)
      && (focused.tagName === 'TEXTAREA' || focused.tagName === 'INPUT' || focused.isContentEditable)) {
      focused.blur();
      let version = changeVersionRef.current;
      let stableFrames = 0;
      for (let frame = 0; frame < 4 && stableFrames < 2; frame++) {
        await new Promise(resolve => requestAnimationFrame(resolve));
        if (changeVersionRef.current === version) stableFrames++;
        else { version = changeVersionRef.current; stableFrames = 0; }
      }
    }
    return { status: 'ready', snapshot: draftSnapshot() };
  };

  const controllerRef = useRef(null);
  if (!controllerRef.current) controllerRef.current = {
    alignViewport,
    freezeDraft,
    activateTool(type) { apiRef.current?.setActiveTool({ type }); },
    getElements() { return apiRef.current ? scene() : null; },
    getSnapshot() { return draftSnapshot(); },
    selectElement(id) {
      apiRef.current?.updateScene({ appState: { selectedElementIds: { [id]: true } } });
    },
    deleteElement(id) {
      if (!apiRef.current) return Promise.reject(new Error('绘图编辑器未就绪'));
      apiRef.current.updateScene({ elements: deleteDrawingElement(scene(), id) });
      return Promise.resolve(draftSnapshot());
    },
    translateElements(ids, dx, dy) {
      if (!apiRef.current) return Promise.reject(new Error('绘图编辑器未就绪'));
      apiRef.current.updateScene({ elements: translateDrawingElements(scene(), ids, dx, dy) });
      return Promise.resolve(draftSnapshot());
    },
    setElementPlane(id, below) {
      if (!apiRef.current) return Promise.reject(new Error('绘图编辑器未就绪'));
      apiRef.current.updateScene({ elements: setDrawingElementPlane(scene(), id, below) });
      return Promise.resolve(draftSnapshot());
    },
    flush() { return Promise.resolve(draftSnapshot()); },
  };
  useImperativeHandle(ref, () => controllerRef.current, []);

  const advanceHandshake = (eventType, toolType) => {
    const step = drawingEditorReadyStep(handshakeRef.current, eventType);
    handshakeRef.current = step;
    if (step.notifyReady) onReady?.(controllerRef.current);
    if (step.notifyTool) onToolChange?.(toolType);
  };

  const onDown = e => {
    if (!active || !visible) return;
    const s = apiRef.current?.getAppState();
    downRef.current = {
      x: e.clientX, y: e.clientY,
      tool: s?.activeTool?.type,
      hadSel: Object.values(s?.selectedElementIds || {}).some(Boolean),
    };
  };
  const onUp = e => {
    const down = downRef.current;
    downRef.current = null;
    if (!active || !visible || !down || down.tool !== 'selection' || down.hadSel) return;
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
    const s = apiRef.current?.getAppState();
    if (!s) return;
    const zoom = s.zoom.value;
    const fx = e.clientX / zoom - s.scrollX, fy = e.clientY / zoom - s.scrollY;
    if (hitDrawingElement(scene(), fx, fy, 8 / zoom)) return;
    onExitToCanvas?.({ x: e.clientX, y: e.clientY });
  };
  const blockZoomKey = e => {
    const target = e.target;
    const editable = target?.tagName === 'TEXTAREA' || target?.tagName === 'INPUT' || target?.isContentEditable;
    const route = drawingZoomKeyRoute({
      code: e.code, editable, shiftKey: e.shiftKey, altKey: e.altKey,
      metaKey: e.metaKey, ctrlKey: e.ctrlKey,
    });
    if (route === 'pass') return;
    if (route === 'block') e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div ref={rootRef} className={`draw-layer draw-active${visible ? '' : ' draw-pending'}`}
      onPointerDownCapture={onDown} onPointerUpCapture={onUp}
      onKeyDownCapture={blockZoomKey}
      onCompositionStartCapture={() => { composingRef.current = true; onCompositionChange?.(true); }}
      onCompositionEndCapture={() => { composingRef.current = false; onCompositionChange?.(false); }}
      style={{ position: 'absolute', inset: 0, zIndex: 6, transformOrigin: '0 0', pointerEvents: visible ? 'auto' : 'none' }}>
      <Excalidraw
        excalidrawAPI={instance => {
          apiRef.current = instance;
          advanceHandshake('api');
        }}
        langCode="zh-CN"
        initialData={{
          elements: initialElements || [],
          files: initialFiles || {},
          appState: { viewBackgroundColor: 'transparent' },
          scrollToContent: false,
        }}
        onChange={(_, appState, files) => {
          changeVersionRef.current++;
          latestFiles.current = files || {};
          advanceHandshake('change', appState?.activeTool?.type);
        }}
        UIOptions={{
          canvasActions: {
            changeViewBackgroundColor: false, export: false, loadScene: false,
            saveToActiveFile: false, saveAsImage: false, toggleTheme: false, clearCanvas: false,
          },
          tools: { image: true },
        }}
      />
    </div>
  );
});
