/**
 * [INPUT]: 依赖 gestures.js 导航纯内核、drawing.js 相机状态机、DrawLayer freeze/align 控制器、RF instance
 * [OUTPUT]: 对外提供 useDrawingCamera —— 编辑态导航独立相机事务：freeze→静态预览→逐事件 RF viewport→
 *           180ms 尾部对齐→双 rAF 恢复 live；wheel/缩放键/Safari gesture/空格与中键平移全入口；普通态鼠标滚轮锚定缩放
 * [POS]: canvas 的相机层。只在 session live 相接管；预览/输入盾由 FlowCanvas 按可渲染表征推导
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  drawingCameraExitPolicy, drawingCameraStep, drawingCompositionStep,
} from './drawing.js';
import {
  createPointerListenerResource, drawingGestureCapture, drawingGestureRoute, drawingWheelRoute,
  drawingZoomKeyCommand, keyboardViewport, panViewport, scaleViewport, wheelDevice, wheelViewport,
  zoomViewport, WHEEL_MODES, nextWheelMode,
} from './gestures.js';
import { syncHandleHitArea } from './connections.js';
import { toast } from '../ui.jsx';

const CAMERA_EXTERNAL_EXCLUDE = '.nowheel, .react-flow__minimap, .react-flow__controls, .ctx-menu, .island';
const CAMERA_EXCAL_UI = '.Island, button, input, textarea, select, [contenteditable="true"], [role="menu"], [role="dialog"]';
const CAMERA_TAIL_MS = 180;

export function useDrawingCamera({
  instRef, rootRef, drawRef, penActiveRef, sessionPhaseRef, drawToolRef,
  setEditorVisible, getFitViewport, minZoom, maxZoom,
}) {
  const [draftPreview, setDraftPreview] = useState(null);
  const cameraStateRef = useRef({ phase: 'live', token: null });
  const cameraPendingVpRef = useRef(null);
  const cameraPreviewRevisionRef = useRef(0);
  const cameraResumeTimerRef = useRef(null);
  const cameraRafOneRef = useRef(null);
  const cameraRafTwoRef = useRef(null);
  const gestureScaleRef = useRef(1);
  const compositionStateRef = useRef({ cycle: 0, active: false, blocked: false, notified: false });
  const spaceNavRef = useRef(false);
  const pointerNavRef = useRef(null);
  const pointerResourceRef = useRef(null);

  // ---- 滚轮双模：触控板=平移（RF 原生），鼠标滚轮=光标锚定缩放；缩放条第四钮三态兜底 ----
  const [wheelMode, setWheelMode] = useState(() =>
    ['trackpad', 'mouse'].includes(localStorage.wheelMode) ? localStorage.wheelMode : 'auto');
  const wheelModeRef = useRef(wheelMode);

  const cycleWheel = useCallback(() => {
    const next = nextWheelMode(wheelModeRef.current);
    wheelModeRef.current = next;
    setWheelMode(next);
    try { localStorage.wheelMode = next; } catch { /* 隐私模式存不进就算了 */ }
    toast(`${WHEEL_MODES[next].label}：${WHEEL_MODES[next].hint}`);
  }, []);

  const clearCameraTiming = useCallback(() => {
    clearTimeout(cameraResumeTimerRef.current);
    cameraResumeTimerRef.current = null;
    clearTimeout(cameraRafOneRef.current);
    clearTimeout(cameraRafTwoRef.current);
    cameraRafOneRef.current = null;
    cameraRafTwoRef.current = null;
  }, []);

  const clearPointerNavigation = useCallback(() => {
    const resource = pointerResourceRef.current;
    pointerResourceRef.current = null;
    pointerNavRef.current = null;
    resource?.cleanup();
  }, []);

  const resetCamera = useCallback((showLive = true) => {
    clearCameraTiming();
    clearPointerNavigation();
    cameraStateRef.current = drawingCameraStep(cameraStateRef.current, { type: 'reset' });
    cameraPendingVpRef.current = null;
    compositionStateRef.current = drawingCompositionStep(compositionStateRef.current, { type: 'end' }).state;
    setDraftPreview(null);
    if (showLive && penActiveRef.current) setEditorVisible(true);
  }, [clearCameraTiming, clearPointerNavigation, penActiveRef, setEditorVisible]);

  const alignDrawingViewport = useCallback((controller, vp) =>
    !!(controller && vp && controller.alignViewport(vp)), []);

  // 恢复链不可卡死律：握手全部走定时器（rAF 会在后台/重载荷下整体停摆——实测 1.5s 零 tick），
  // 外加 400ms 看门狗强制收尾。宁可极端情况下轻微跳变，绝不允许"墨迹消失且永不回来"。
  const finishResume = useCallback(token => {
    const ready = drawingCameraStep(cameraStateRef.current, { type: 'resume-ready', token });
    if (ready === cameraStateRef.current) return;
    cameraStateRef.current = ready;
    cameraPendingVpRef.current = null;
    setEditorVisible(true);
    setDraftPreview(null);
  }, [setEditorVisible]);

  const scheduleCameraResume = useCallback(() => {
    clearCameraTiming();
    cameraResumeTimerRef.current = setTimeout(() => {
      cameraResumeTimerRef.current = null;
      if (cameraStateRef.current.phase !== 'suspended') return;
      const token = {};
      const vp = instRef.current?.getViewport();
      if (!alignDrawingViewport(drawRef.current, vp)) {
        cameraStateRef.current = drawingCameraStep(cameraStateRef.current, { type: 'reset' });
        cameraPendingVpRef.current = null;
        setDraftPreview(null);
        setEditorVisible(true);
        toast('绘图相机对齐失败，已恢复编辑现场', 'error');
        return;
      }
      const next = drawingCameraStep(cameraStateRef.current, { type: 'resume-aligned', token });
      if (next === cameraStateRef.current) return;
      cameraStateRef.current = next;
      // 两帧等待近似（对齐后的 Excalidraw 画完再揭幕）+ 看门狗兜底，全部 rAF 无关
      cameraRafOneRef.current = setTimeout(() => { cameraRafOneRef.current = null; finishResume(token); }, 64);
      cameraRafTwoRef.current = setTimeout(() => { cameraRafTwoRef.current = null; finishResume(token); }, 400);
    }, CAMERA_TAIL_MS);
  }, [alignDrawingViewport, clearCameraTiming, drawRef, finishResume, instRef, setEditorVisible]);

  const failCameraFreeze = useCallback((token, message) => {
    const next = drawingCameraStep(cameraStateRef.current, { type: 'preview-error', token });
    if (next === cameraStateRef.current) return;
    cameraStateRef.current = next;
    cameraPendingVpRef.current = null;
    setDraftPreview(null);
    setEditorVisible(true);
    if (message) toast(message, 'error');
  }, [setEditorVisible]);

  // 编辑态导航只改 RF 相机：首个意图先冻结 draft，预览入 DOM 后才让 RF 开始移动。
  const navigateDrawingCamera = useCallback(transform => {
    const inst = instRef.current;
    if (!inst || !penActiveRef.current || sessionPhaseRef.current !== 'live') return false;
    const imeRoute = drawingCompositionStep(compositionStateRef.current, { type: 'navigate' });
    compositionStateRef.current = imeRoute.state;
    if (imeRoute.action === 'block') return true;
    const state = cameraStateRef.current;
    const source = state.phase === 'freezing'
      ? (cameraPendingVpRef.current || inst.getViewport())
      : inst.getViewport();
    const nextVp = transform(source);
    if (!nextVp) return false;

    if (state.phase === 'live') {
      const token = {};
      const compositionCycle = compositionStateRef.current.cycle;
      cameraStateRef.current = drawingCameraStep(state, { type: 'navigate', token });
      cameraPendingVpRef.current = nextVp;
      Promise.resolve(drawRef.current?.freezeDraft()).then(result => {
        if (cameraStateRef.current.phase !== 'freezing' || cameraStateRef.current.token !== token) return;
        if (result?.status === 'blocked') {
          const imeBlocked = drawingCompositionStep(compositionStateRef.current, {
            type: 'blocked', cycle: compositionCycle,
          });
          compositionStateRef.current = imeBlocked.state;
          failCameraFreeze(token, imeBlocked.action === 'notify'
            ? '文字正在输入，结束输入后再移动画布'
            : null);
          return;
        }
        if (result?.status !== 'ready' || !result.snapshot) {
          failCameraFreeze(token, '绘图草稿尚未稳定');
          return;
        }
        setDraftPreview({
          ...result.snapshot,
          revision: ++cameraPreviewRevisionRef.current,
          token,
        });
      }).catch(error => failCameraFreeze(token, `绘图预览失败：${error.message}`));
      return true;
    }

    if (state.phase === 'freezing') {
      cameraPendingVpRef.current = nextVp;
      return true;
    }

    if (state.phase === 'resuming') clearCameraTiming();
    const token = {};
    cameraStateRef.current = drawingCameraStep(state, { type: 'navigate', token });
    cameraPendingVpRef.current = nextVp;
    inst.setViewport(nextVp);
    syncHandleHitArea(rootRef.current, nextVp.zoom);
    scheduleCameraResume();
    return true;
  }, [clearCameraTiming, drawRef, failCameraFreeze, instRef, penActiveRef, rootRef, scheduleCameraResume, sessionPhaseRef]);

  const onDraftPreviewReady = useCallback(revision => {
    if (!draftPreview || draftPreview.revision !== revision) return;
    const next = drawingCameraStep(cameraStateRef.current, {
      type: 'preview-ready', token: draftPreview.token,
    });
    if (next === cameraStateRef.current) return;
    cameraStateRef.current = next;
    setEditorVisible(false);
    const vp = cameraPendingVpRef.current || instRef.current?.getViewport();
    if (vp) {
      instRef.current?.setViewport(vp);
      syncHandleHitArea(rootRef.current, vp.zoom);
    }
    scheduleCameraResume();
  }, [draftPreview, instRef, rootRef, scheduleCameraResume, setEditorVisible]);

  const onDraftPreviewError = useCallback((revision, error, result) => {
    if (!draftPreview || draftPreview.revision !== revision) return;
    if (result?.final === false) return;
    failCameraFreeze(draftPreview.token, `绘图预览失败：${error.message}`);
  }, [draftPreview, failCameraFreeze]);

  useEffect(() => () => {
    clearCameraTiming();
    clearPointerNavigation();
  }, [clearCameraTiming, clearPointerNavigation]);

  // ---- wheel 三路路由：外部功能件放行 / Excal UI 只断传播 / 绘图面进 RF 相机；普通态鼠标滚轮锚定缩放 ----
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let streak = null;
    const onWheel = e => {
      const externalExcluded = !!e.target.closest?.(CAMERA_EXTERNAL_EXCLUDE);
      const insideExcal = !!e.target.closest?.('.excalidraw');
      const excalUi = insideExcal && !!e.target.closest?.(CAMERA_EXCAL_UI);
      const drawingActive = penActiveRef.current && sessionPhaseRef.current === 'live';
      if (drawingActive) {
        const route = drawingWheelRoute({ active: true, externalExcluded, excalUi });
        if (route === 'pass') return;
        if (route === 'block') {
          // 保留 textarea/Island 的原生滚动默认行为，但不让 Excal handleWheel 把它变成相机手势。
          e.stopPropagation();
          return;
        }
        if (route === 'camera') {
          e.preventDefault();
          e.stopPropagation();
          const now = Date.now();
          let device = streak?.device || 'trackpad';
          navigateDrawingCamera(vp => {
            const result = wheelViewport(vp, e, root.getBoundingClientRect(), {
              mode: wheelModeRef.current, streak, now, min: minZoom, max: maxZoom,
            });
            device = result.device === 'pinch' ? 'trackpad' : result.device;
            return result.viewport;
          });
          streak = { device, t: now };
          return;
        }
      }
      if (externalExcluded) return;
      const el = e.target.closest?.('.react-flow');
      if (!el || e.ctrlKey || e.metaKey || e.shiftKey) return;
      const now = Date.now();
      const device = wheelModeRef.current === 'auto' ? wheelDevice(e, streak, now) : wheelModeRef.current;
      streak = { device, t: now };
      if (device !== 'mouse') return;   // 触控板滚动放行，d3 原生平移接手
      e.preventDefault();
      e.stopPropagation();              // 同一事件不许再被 d3 当平移消费一遍
      const inst = instRef.current;
      if (inst) inst.setViewport(zoomViewport(inst.getViewport(), e, el.getBoundingClientRect(), { min: minZoom, max: maxZoom }));
    };
    root.addEventListener('wheel', onWheel, { capture: true, passive: false });
    return () => root.removeEventListener('wheel', onWheel, { capture: true });
  }, [instRef, maxZoom, minZoom, navigateDrawingCamera, penActiveRef, rootRef, sessionPhaseRef]);

  const navigateDrawingZoom = useCallback(command => {
    const root = rootRef.current;
    if (!root) return false;
    return navigateDrawingCamera(vp => keyboardViewport(
      vp, command, root.getBoundingClientRect(), { min: minZoom, max: maxZoom },
    ));
  }, [maxZoom, minZoom, navigateDrawingCamera, rootRef]);

  const navigateDrawingFit = useCallback(path => {
    const target = getFitViewport(path);
    return target ? navigateDrawingCamera(() => target) : false;
  }, [getFitViewport, navigateDrawingCamera]);

  // Safari gesture 旁路：Excal 在 document 上监听，必须同级 capture 先封住
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const options = { capture: true, passive: false };
    const handle = phase => event => {
      const insideRoot = !!event.target && root.contains(event.target);
      const externalExcluded = !!event.target.closest?.(CAMERA_EXTERNAL_EXCLUDE);
      const insideExcal = !!event.target.closest?.('.excalidraw');
      const excalUi = insideExcal && !!event.target.closest?.(CAMERA_EXCAL_UI);
      const route = drawingGestureRoute({
        mounted: penActiveRef.current,
        insideRoot,
        opening: sessionPhaseRef.current === 'opening',
        exiting: sessionPhaseRef.current === 'exiting',
        externalExcluded,
        excalUi,
      });
      const captured = drawingGestureCapture(event, {
        route, phase, lastScale: gestureScaleRef.current,
      });
      gestureScaleRef.current = phase === 'end' ? 1 : captured.nextScale;
      if (captured.camera && phase === 'change') {
        navigateDrawingCamera(vp => scaleViewport(
          vp, captured.scaleDelta, event, root.getBoundingClientRect(),
          { min: minZoom, max: maxZoom },
        ));
      }
    };
    const onStart = handle('start'), onChange = handle('change'), onEnd = handle('end');
    document.addEventListener('gesturestart', onStart, options);
    document.addEventListener('gesturechange', onChange, options);
    document.addEventListener('gestureend', onEnd, options);
    return () => {
      document.removeEventListener('gesturestart', onStart, options);
      document.removeEventListener('gesturechange', onChange, options);
      document.removeEventListener('gestureend', onEnd, options);
      gestureScaleRef.current = 1;
    };
  }, [maxZoom, minZoom, navigateDrawingCamera, penActiveRef, rootRef, sessionPhaseRef]);

  // 空格平移意图：编辑态按下即表态，防 Excalidraw 抢走
  useEffect(() => {
    const editable = target => target?.tagName === 'TEXTAREA' || target?.tagName === 'INPUT' || target?.isContentEditable;
    const onDown = e => {
      if (e.code !== 'Space' || editable(e.target)) return;
      spaceNavRef.current = true;
      if (penActiveRef.current) e.preventDefault();
    };
    const onUp = e => { if (e.code === 'Space') spaceNavRef.current = false; };
    const onBlur = () => { spaceNavRef.current = false; };
    window.addEventListener('keydown', onDown, true);
    window.addEventListener('keyup', onUp, true);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onDown, true);
      window.removeEventListener('keyup', onUp, true);
      window.removeEventListener('blur', onBlur);
    };
  }, [penActiveRef]);

  // 缩放快捷键（⌘+/⌘-/⌘0、Shift+1/2/3 统一全景）在 root capture 阻断 Excal 全局监听
  useEffect(() => {
    const editable = target => target?.tagName === 'TEXTAREA' || target?.tagName === 'INPUT' || target?.isContentEditable;
    const onKey = e => {
      if (!penActiveRef.current) return;
      const root = rootRef.current;
      const target = e.target;
      const canvasTarget = root?.contains(target)
        || target === document.body || target === document.documentElement;
      if (!canvasTarget) return;
      const insideExcal = !!target?.closest?.('.excalidraw');
      const isEditable = editable(target);
      if (isEditable && !insideExcal) return;
      const { route, command } = drawingZoomKeyCommand({
        code: e.code, editable: isEditable, shiftKey: e.shiftKey, altKey: e.altKey,
        metaKey: e.metaKey, ctrlKey: e.ctrlKey,
      });
      if (route === 'pass') return;
      if (route === 'block') e.preventDefault();
      e.stopPropagation();
      if (command && sessionPhaseRef.current === 'live') {
        command === 'fit' ? navigateDrawingFit(null) : navigateDrawingZoom(command);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [navigateDrawingFit, navigateDrawingZoom, penActiveRef, rootRef, sessionPhaseRef]);

  // 中键/空格+左键平移：window 级幂等监听资源，finish/unmount 无条件回收
  const onCameraPointerDown = useCallback(e => {
    if (!penActiveRef.current || sessionPhaseRef.current !== 'live'
      || e.target.closest?.(`${CAMERA_EXTERNAL_EXCLUDE}, ${CAMERA_EXCAL_UI}`)) return;
    const isPan = e.button === 1
      || (e.button === 0 && (spaceNavRef.current || drawToolRef.current === 'hand'));
    if (!isPan || pointerNavRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    clearPointerNavigation();
    navigateDrawingCamera(vp => vp);
    const session = { pointerId: e.pointerId, x: e.clientX, y: e.clientY };
    pointerNavRef.current = session;
    const onMove = event => {
      if (pointerNavRef.current !== session || event.pointerId !== session.pointerId) return;
      const dx = event.clientX - session.x, dy = event.clientY - session.y;
      session.x = event.clientX; session.y = event.clientY;
      event.preventDefault();
      event.stopPropagation();
      navigateDrawingCamera(vp => panViewport(vp, dx, dy));
    };
    const finish = event => {
      if (pointerNavRef.current !== session) return;
      if (event?.pointerId !== undefined && event.pointerId !== session.pointerId) return;
      clearPointerNavigation();
    };
    const resource = createPointerListenerResource(window, { onMove, onFinish: finish });
    if (resource.attach()) pointerResourceRef.current = resource;
    else if (pointerNavRef.current === session) pointerNavRef.current = null;
  }, [clearPointerNavigation, drawToolRef, navigateDrawingCamera, penActiveRef, sessionPhaseRef]);

  const onCompositionEvent = useCallback(active => {
    compositionStateRef.current = drawingCompositionStep(compositionStateRef.current, {
      type: active ? 'start' : 'end',
    }).state;
  }, []);

  return {
    draftPreview, onDraftPreviewReady, onDraftPreviewError,
    navigateDrawingCamera, navigateDrawingZoom, navigateDrawingFit,
    onCameraPointerDown, onCompositionEvent, resetCamera, clearPointerNavigation,
    prepareExit: useCallback(() => {
      // 退出抢占相机：清时钟与指针，只有 suspended/resuming 的已 ready 预览留下填 closing 洞
      const keepPreview = drawingCameraExitPolicy(cameraStateRef.current).keepPreview;
      clearCameraTiming();
      clearPointerNavigation();
      cameraStateRef.current = drawingCameraStep(cameraStateRef.current, { type: 'reset' });
      cameraPendingVpRef.current = null;
      if (!keepPreview) setDraftPreview(null);
    }, [clearCameraTiming, clearPointerNavigation]),
    wheelMode, cycleWheel,
  };
}
