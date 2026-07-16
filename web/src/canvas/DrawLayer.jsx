/**
 * [INPUT]: 依赖 @excalidraw/excalidraw 与局部事务 elements/files；持久化主权由 FlowCanvas 的全量队列持有
 * [OUTPUT]: 对外提供仅在编辑态挂载的 DrawLayer；维护/flush/freeze 局部 draft、水合后上报本地 journal、上报 IME 周期、在手势跟踪前排除编辑器功能岛、识别新事务单次大底板落笔，并仅在 opening/resume 同步对齐 RF viewport
 * [POS]: 临时目标事务编辑器；绝不直接保存局部副本，普通态与未选目标始终不挂载
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import React, { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import { Excalidraw } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import {
  deleteDrawingElement, DRAWING_HIT_BLOCK, drawingAutoExitGestureStep, drawingEditorReadyStep, drawingSnapshot, hitDrawingElement,
  setDrawingElementPlane, translateDrawingElements,
} from './drawing.js';

export default forwardRef(function DrawLayer({ active, visible = true, initialElements, initialFiles, autoExitLargeNew = false, onToolChange, onReady, onDraftChange, onDraftLocalFlush, onExitToCanvas, onAutoExitLargeNew, onCompositionChange }, ref) {
  const apiRef = useRef(null);
  const rootRef = useRef(null);
  const composingRef = useRef(false);
  const changeVersionRef = useRef(0);
  const downRef = useRef(null);
  const autoExitRef = useRef({ phase: 'idle' });
  const autoExitTokenRef = useRef(0);
  const autoExitRafRef = useRef(null);
  const handshakeRef = useRef({ apiReady: false, hydrated: false, ready: false });
  const latestFiles = useRef(initialFiles || {});

  // excalidrawAPI 回调可能早于 initialData 水合；这个窗口内 flush 不许把已有绘图误写成空。
  const scene = () => {
    const current = apiRef.current?.getSceneElements() || [];
    return handshakeRef.current.hydrated || current.length ? current : (initialElements || []);
  };

  const draftSnapshot = () => drawingSnapshot(scene(), latestFiles.current);

  const cancelAutoExit = token => {
    if (autoExitRafRef.current !== null) cancelAnimationFrame(autoExitRafRef.current);
    autoExitRafRef.current = null;
    const result = drawingAutoExitGestureStep(autoExitRef.current, { type: 'cancel', token });
    autoExitRef.current = result.state;
  };

  const scheduleAutoExit = token => {
    const frame = () => {
      autoExitRafRef.current = null;
      if (composingRef.current) {
        cancelAutoExit(token);
        return;
      }
      const result = drawingAutoExitGestureStep(autoExitRef.current, { type: 'frame', token });
      autoExitRef.current = result.state;
      if (result.action === 'wait') {
        autoExitRafRef.current = requestAnimationFrame(frame);
      } else if (result.action === 'signal') {
        onAutoExitLargeNew?.({ id: result.elementId, token, signaledAt: performance.now() });
      }
    };
    if (autoExitRafRef.current !== null) cancelAnimationFrame(autoExitRafRef.current);
    autoExitRafRef.current = requestAnimationFrame(frame);
  };

  // 关标签页/切后台只 flush 同源本地 journal；绝不在尾窗发网络请求。
  useEffect(() => {
    const onHide = () => onDraftLocalFlush?.();
    const onVisibility = () => { if (document.visibilityState === 'hidden') onHide(); };
    window.addEventListener('pagehide', onHide);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', onHide);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [onDraftLocalFlush]);

  useEffect(() => {
    if (!active || !visible || !autoExitLargeNew) cancelAutoExit();
  }, [active, visible, autoExitLargeNew]);

  useEffect(() => () => cancelAutoExit(), []);

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
    if (!active || !visible || !e.isPrimary || e.button !== 0) return;
    if (e.target.closest?.(DRAWING_HIT_BLOCK)) {
      downRef.current = null;
      return;
    }
    cancelAutoExit();
    const s = apiRef.current?.getAppState();
    const elements = scene();
    const token = ++autoExitTokenRef.current;
    const autoExit = drawingAutoExitGestureStep(autoExitRef.current, {
      type: 'begin', enabled: autoExitLargeNew && !composingRef.current, token, pointerId: e.pointerId,
      tool: s?.activeTool?.type, beforeIds: elements.map(element => element.id), elements,
      changeVersion: changeVersionRef.current,
    });
    autoExitRef.current = autoExit.state;
    downRef.current = {
      x: e.clientX, y: e.clientY,
      pointerId: e.pointerId, token,
      tool: s?.activeTool?.type,
      hadSel: Object.values(s?.selectedElementIds || {}).some(Boolean),
    };
  };
  const onUp = e => {
    const down = downRef.current;
    if (!active || !visible || !down || e.pointerId !== down.pointerId) return;
    downRef.current = null;
    const released = drawingAutoExitGestureStep(autoExitRef.current, {
      type: 'release', token: down.token, pointerId: e.pointerId,
    });
    autoExitRef.current = released.state;
    if (released.action === 'schedule') scheduleAutoExit(down.token);
    if (down.tool !== 'selection' || down.hadSel) return;
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 5) return;
    const s = apiRef.current?.getAppState();
    if (!s) return;
    const zoom = s.zoom.value;
    const fx = e.clientX / zoom - s.scrollX, fy = e.clientY / zoom - s.scrollY;
    if (hitDrawingElement(scene(), fx, fy, 8 / zoom)) return;
    onExitToCanvas?.({ x: e.clientX, y: e.clientY });
  };
  const onPointerCancel = e => {
    const down = downRef.current;
    if (!down || down.pointerId !== e.pointerId) return;
    downRef.current = null;
    cancelAutoExit(down.token);
  };
  return (
    <div ref={rootRef} className={`draw-layer draw-active${visible ? '' : ' draw-pending'}`}
      onPointerDownCapture={onDown} onPointerUpCapture={onUp} onPointerCancelCapture={onPointerCancel}
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
        onChange={(elements, appState, files) => {
          changeVersionRef.current++;
          latestFiles.current = files || {};
          const tracked = autoExitRef.current;
          if (tracked.phase === 'tracking' && appState?.activeTool?.type !== tracked.tool) {
            cancelAutoExit(tracked.token);
          } else if (tracked.phase === 'tracking' || tracked.phase === 'released') {
            const changed = drawingAutoExitGestureStep(tracked, {
              type: 'change', token: tracked.token, elements, changeVersion: changeVersionRef.current,
            });
            autoExitRef.current = changed.state;
          }
          advanceHandshake('change', appState?.activeTool?.type);
          if (handshakeRef.current.ready) {
            onDraftChange?.(drawingSnapshot(elements, latestFiles.current));
          }
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
