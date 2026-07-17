/**
 * [INPUT]: 依赖 @xyflow/react、layout 纯布局内核、五种自定义节点、menus 的菜单构建器与删除流程、ui 的 toast/Icon
 * [OUTPUT]: 对外提供 FlowCanvas 组件：统一容器模型、弹性生长、拖放改归属、三系统边+手动边、
 *           增量成员防重叠、Figma 式框选/平移/触控板手势、滚轮双模（触控板平移/鼠标缩放+模式切换钮）、
 *           容器缩放定桩、全画布落空连线选择（含就地打开会话上下文）、缩放感知连接点、原生绘图选择/画笔、
 *           committed ink 与节点共用 ViewportPortal 唯一相机、commit-bound requested generation 与已 paint rendered world 统一像素/命中/MiniMap、cold/stale 可见回执、编辑态 wheel/key/Safari gesture/pointer 全入口 RF 相机事务（Shift+1/2/3 统一全景 fit）、唯一 Excal 对齐入口与成功/acquire/cleanup 只读计数及 live 隐藏期同层输入盾/可见缩放岛、
 *           目标关系闭包局部事务、IndexedDB 单 active 草稿精确恢复/条件清理/冲突只读检查+本地导出+精确放弃/closing 失败按 committed token 续写、新建大底板落笔即退场/自动沉层与仅抬 sunkIds 的稳定排空撤销、屏幕/队列/持久化三真相收口、opening request 身份门与纯取消、无双影帧交接与真实阶段回执、
 *           普通模式绘图命中（pane/容器面同河、nodrag/连接点等功能件优先）与 Backspace 删除治理；4518 seam 只驱动真实 open/exit 动作并替换 Ink exporter
 *           direct 容器承载只在 RF node.position 已进 DOM 的 layout effect 同步桥与最终 DROP；同步 buildGraph batch 整理规划共用 rendered world 所有权，batch 多 delta bridge 只由精确目标 generation DOM-ready 清除且向 4518 probe 只读公开其代际/桥状态；事务受 App 场景变更队列硬闸门约束，Escape/pointercancel 只取消当前指针的 DRAGGING 并阻断迟到 DROP
 * [POS]: canvas 的画布引擎。归属律：layout.d 手动指定 > 路径推断；容器永远生长包住成员；
 *        每一次点击必有可感知的回应：选中态/菜单/提示三选一
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import React, { useMemo, useCallback, useRef, useEffect, useLayoutEffect, useState, lazy, Suspense } from 'react';
import { ReactFlow, useNodesState, useEdgesState, Controls, ControlButton, MiniMap, Background, BackgroundVariant, Panel, MarkerType, ConnectionMode, getViewportForBounds } from '@xyflow/react';
import WorkspaceNode from './WorkspaceNode.jsx';
import SessionNode from './SessionNode.jsx';
import DistrictNode from './DistrictNode.jsx';
import BoardNode, { BOARD_COLORS } from './BoardNode.jsx';
import NoteNode from './NoteNode.jsx';
import { buildGraph, COL_W, resizedContainerChildren } from './layout.js';
import { sessionMenu, workspaceMenu, districtMenu, boardMenu, noteMenu, paneMenu, edgeMenu, deleteBoardFlow, deleteNoteFlow } from './menus.jsx';
import { connectionDrop, syncHandleHitArea } from './connections.js';
import {
  advanceDrawingTransaction, autoSinkLargeNewDrawingDraft, canvasGeometryAllowed, canvasGeometryPreparation, createDrawingCommitQueue, createDrawingTransaction,
  deleteDrawingElement, DRAWING_HIT_BLOCK, drawingCameraExitPolicy, drawingCameraPresentation, drawingCameraStep, drawingClosingHandoffStep, drawingCompositionStep, drawingExitAction, drawingExitFailureNotice, drawingFrameHitElements, drawingFrameTruthStep, drawingOpeningRequestCurrent, drawingRestoredWorldOverride, drawingTransactionVisibleElements, drawingWorldInputStep, drawingWorldSyncStep, hitDrawingElement, mergeDrawingTransaction,
  setDrawingElementPlane,
} from './drawing.js';
import {
  advanceAutoSinkUndoTicket, createDrawingDraftCoordinator, createDrawingDraftStore,
  drawingDraftClosureFingerprint, submitAutoSinkUndo,
} from './drawing-draft-store.js';
import InkWorldLayer from './InkWorldLayer.jsx';
import MiniMapInk from './MiniMapInk.jsx';
import {
  createBatchCarryBridge, createContainerCarryController, createInkDomAdapter, planBatchCarry, presentedWorld,
} from './container-carry.js';
import {
  createPointerListenerResource, drawingGestureCapture, drawingGestureRoute, drawingWheelRoute, drawingZoomKeyCommand, keyboardViewport, panViewport, scaleViewport,
  wheelDevice, wheelViewport, zoomViewport, WHEEL_MODES, nextWheelMode,
} from './gestures.js';
import { Icon, toast, confirmPop } from '../ui.jsx';

// Excalidraw 体量大（~1MB gz 半壁江山），懒加载拆包：无笔迹且未拿起画笔时根本不挂载
const DrawLayer = lazy(() => import('./DrawLayer.jsx'));

const nodeTypes = { workspace: WorkspaceNode, session: SessionNode, district: DistrictNode, board: BoardNode, note: NoteNode };

const MIN_ZOOM = 0.1, MAX_ZOOM = 1.8;   // 缩放界限唯一真相：RF props 与滚轮内核共用
const NO_DRAWING_IDS = Object.freeze([]);
const CAMERA_EXTERNAL_EXCLUDE = '.nowheel, .react-flow__minimap, .react-flow__controls, .ctx-menu, .island';
const CAMERA_EXCAL_UI = '.Island, button, input, textarea, select, [contenteditable="true"], [role="menu"], [role="dialog"]';
const CAMERA_TAIL_MS = 180;

const shortDraftValue = value => value ? `${value.slice(0, 8)}…${value.slice(-4)}` : '未知';
const draftByteLabel = bytes => bytes < 1024
  ? `${bytes} B`
  : bytes < 1024 * 1024
    ? `${(bytes / 1024).toFixed(1)} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const downloadDrawingDraft = record => {
  const body = `${JSON.stringify(record, null, 2)}\n`;
  const url = URL.createObjectURL(new Blob([body], { type: 'application/json' }));
  const link = document.createElement('a');
  const requestId = String(record.requestId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '-');
  link.href = url;
  link.download = `agent-canvas-drawing-draft-${requestId}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
};

const containerKey = id => id.startsWith('district:') ? id.slice(9) : id;

// 命中检测：工作区中心落在哪个容器矩形里——拖动预览与松手落定共用同一双眼睛
function hitContainer(node, all) {
  const containers = all.filter(n => n.type === 'district' || n.type === 'board');
  const oldParent = containers.find(n => n.id === node.parentId);
  if (!oldParent) return { oldParent: null, hit: null, abs: null };
  const abs = { x: oldParent.position.x + node.position.x, y: oldParent.position.y + node.position.y };
  const center = { x: abs.x + COL_W / 2, y: abs.y + 30 };
  const hit = containers.find(c => {
    const w = c.width ?? c.data._w ?? c.data.width, h = c.height ?? c.data._h ?? c.data.height;
    return center.x >= c.position.x && center.x <= c.position.x + w &&
           center.y >= c.position.y && center.y <= c.position.y + h;
  });
  return { oldParent, hit, abs };
}

const EDGE_LABEL = { worktree: 'worktree 分支', family: '同族项目', handoff: '接力血缘', manual: '手动连线' };

export default function FlowCanvas({ workspaces, sessionsByKey, edges, layout, canvas, sceneToken, sceneStale = false, sceneMutationPendingRef, onMoveNode, onCanvasAction, onRenameSession, onRenameWs, selectedKey, onSelect, onChanged, onArrange, focusRef, actionsRef, geometryPendingRef, expanded, searching, onToggleExpand, frameTestProbeRef, inkExporterProbe }) {
  const instRef = useRef(null);
  const [menu, setMenu] = useState(null);           // 右键快捷菜单 {x, y, items}
  const [edgeTip, setEdgeTip] = useState(null);     // 边悬浮说明牌 {x, y, text}
  const [renaming, setRenaming] = useState({ id: null, n: 0 });   // 就地改名信号（nonce 驱动）
  const [penActive, setPenActive] = useState(false);
  const [drawOpening, setDrawOpening] = useState(false);
  const [drawVisible, setDrawVisible] = useState(false);
  const [selectArmed, setSelectArmed] = useState(false);
  const [drawTool, setDrawTool] = useState('selection');
  const [editSeed, setEditSeed] = useState(null);
  const [worldOverride, setWorldOverride] = useState(null);
  const [draftPreview, setDraftPreview] = useState(null);
  const [inkFrame, setInkFrame] = useState();
  const drawRef = useRef(null);
  const penActiveRef = useRef(false);
  const drawVisibleRef = useRef(false);
  const selectArmedRef = useRef(false);
  const drawToolRef = useRef('selection');
  const pendingSelectRef = useRef(null);
  const editTransactionRef = useRef(null);
  const editBaseRef = useRef(null);
  const autoSinkUndoRef = useRef(null);
  const worldRevisionRef = useRef(0);
  const persistedWorldRef = useRef(null);
  const requestedWorldRef = useRef(null);
  const worldHandoffRef = useRef(null);
  const frameTestEventsRef = useRef([]);
  const openingRef = useRef(false);
  const openingRequestRef = useRef(null);
  const openingPromiseRef = useRef(null);
  const openingReadyResolveRef = useRef(null);
  const exitingDrawRef = useRef(false);
  const cameraStateRef = useRef({ phase: 'live', token: null });
  const cameraPendingVpRef = useRef(null);
  const cameraPreviewRevisionRef = useRef(0);
  const cameraResumeTimerRef = useRef(null);
  const cameraRafOneRef = useRef(null);
  const cameraRafTwoRef = useRef(null);
  const drawingViewportAlignCountRef = useRef(0);
  const cameraViewportWriteCountRef = useRef(0);
  const gestureScaleRef = useRef(1);
  const compositionStateRef = useRef({ cycle: 0, active: false, blocked: false, notified: false });
  const spaceNavRef = useRef(false);
  const pointerNavRef = useRef(null);
  const pointerResourceRef = useRef(null);
  const pointerAcquisitionCountRef = useRef(0);
  const pointerCleanupCountRef = useRef(0);
  const dropHiRef = useRef(null);                   // 拖动中的投放目标高亮
  const rootRef = useRef(null);
  const carryControllerRef = useRef(null);
  const carryPendingFrameRef = useRef(null);
  const batchCarryBridgeRef = useRef(null);
  const carryFrameSequenceRef = useRef(0);
  const carryBeginDurationRef = useRef(0);
  const carryMoveDurationsRef = useRef([]);
  const carryPointerDownRef = useRef(null);
  const carryMoveRef = useRef(null);
  const carryDropRef = useRef(null);
  const dragStartRef = useRef(new Map());
  const cancelledCarryRef = useRef(new Map());
  const [carryView, setCarryView] = useState({ phase: 'IDLE', anchorIds: [], dx: 0, dy: 0 });
  const [carryTargetWorld, setCarryTargetWorld] = useState(null);
  const [carryRetryToken, setCarryRetryToken] = useState(0);
  const [batchCarryRetryable, setBatchCarryRetryable] = useState(false);
  const clearSelectionRef = useRef(() => {});       // 进绘图前清 RF 选中——Delete 不许一键双雷（定义在下方，ref 解前向引用）
  const sceneTokenRef = useRef(sceneToken);
  sceneTokenRef.current = sceneToken;
  const drawingCommitQueueRef = useRef(null);
  if (!drawingCommitQueueRef.current) {
    drawingCommitQueueRef.current = createDrawingCommitQueue(
      { elements: canvas?.drawing, files: canvas?.drawingFiles },
      async (next, previousSuccessful) => {
        const receipt = await onCanvasAction('drawingCommit', { next, previousSuccessful });
        if (typeof receipt?.sceneToken === 'string') sceneTokenRef.current = receipt.sceneToken;
        return receipt;
      },
    );
  }
  const drawingCommitQueue = drawingCommitQueueRef.current;
  const draftJournalRef = useRef(null);
  if (!draftJournalRef.current) {
    draftJournalRef.current = createDrawingDraftCoordinator(createDrawingDraftStore({
      onError: () => toast('本地草稿恢复不可用；本次仍可正常保存到画布', 'error'),
    }));
  }
  const draftJournal = draftJournalRef.current;
  const draftRequestRef = useRef(null);
  const updateDrawVisible = useCallback(visible => {
    drawVisibleRef.current = visible;
    setDrawVisible(visible);
  }, []);

  const alignDrawingViewport = useCallback((controller, vp) => {
    if (!controller || !vp || !controller.alignViewport(vp)) return false;
    drawingViewportAlignCountRef.current++;
    return true;
  }, []);

  const clearPointerNavigation = useCallback(() => {
    const resource = pointerResourceRef.current;
    pointerResourceRef.current = null;
    pointerNavRef.current = null;
    if (resource?.cleanup()) pointerCleanupCountRef.current++;
  }, []);

  // 三真相收口：编辑期不倒灌；override 在场时必须等 props 同引用追上，才同步队列并按身份撤桥。
  useEffect(() => {
    const step = drawingWorldSyncStep({
      idle: !penActive && !drawOpening,
      worldOverride,
      queueSnapshot: drawingCommitQueue.snapshot(),
      elements: canvas?.drawing,
      files: canvas?.drawingFiles,
    });
    if (step.type !== 'sync') return;
    drawingCommitQueue.sync({ elements: canvas?.drawing, files: canvas?.drawingFiles });
    if (step.clearOverride) {
      setWorldOverride(current => current === step.clearOverride ? null : current);
    }
  }, [drawingCommitQueue, canvas?.drawing, canvas?.drawingFiles, worldOverride, penActive, drawOpening]);

  const geometryAllowed = useCallback(() => canvasGeometryAllowed({
    opening: openingRef.current,
    drawing: penActiveRef.current,
    pending: geometryPendingRef?.current || carryPendingFrameRef.current?.kind === 'batch',
  }), [geometryPendingRef]);
  // App 的全局整理只和 opening/pending 互斥；已进入绘图后的全局动作政策保持不变。
  const geometryLocked = useCallback(() => !canvasGeometryAllowed({
    opening: openingRef.current,
    pending: geometryPendingRef?.current,
  }), [geometryPendingRef]);
  const opening = useCallback(() => openingRef.current, []);

  const triggerRename = useCallback(id => setRenaming(r => ({ id, n: r.n + 1 })), []);

  // ---- 滚轮双模：触控板=平移（RF panOnScroll 原生），鼠标滚轮=光标锚定缩放（此处接管）；
  //      捏合/Ctrl/Meta 缩放与 Shift 横移一律交还 React Flow 原生手势，绝不重造 ----
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
    if (cameraRafOneRef.current !== null) cancelAnimationFrame(cameraRafOneRef.current);
    if (cameraRafTwoRef.current !== null) cancelAnimationFrame(cameraRafTwoRef.current);
    cameraRafOneRef.current = null;
    cameraRafTwoRef.current = null;
  }, []);

  const resetDrawingCamera = useCallback((showLive = true) => {
    clearCameraTiming();
    clearPointerNavigation();
    cameraStateRef.current = drawingCameraStep(cameraStateRef.current, { type: 'reset' });
    cameraPendingVpRef.current = null;
    compositionStateRef.current = drawingCompositionStep(compositionStateRef.current, { type: 'end' }).state;
    setDraftPreview(null);
    if (showLive && penActiveRef.current) updateDrawVisible(true);
  }, [clearCameraTiming, clearPointerNavigation, updateDrawVisible]);

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
        updateDrawVisible(true);
        toast('绘图相机对齐失败，已恢复编辑现场', 'error');
        return;
      }
      const next = drawingCameraStep(cameraStateRef.current, { type: 'resume-aligned', token });
      if (next === cameraStateRef.current) return;
      cameraStateRef.current = next;
      cameraRafOneRef.current = requestAnimationFrame(() => {
        cameraRafOneRef.current = null;
        cameraRafTwoRef.current = requestAnimationFrame(() => {
          cameraRafTwoRef.current = null;
          const ready = drawingCameraStep(cameraStateRef.current, { type: 'resume-ready', token });
          if (ready === cameraStateRef.current) return;
          cameraStateRef.current = ready;
          cameraPendingVpRef.current = null;
          updateDrawVisible(true);
          setDraftPreview(null);
        });
      });
    }, CAMERA_TAIL_MS);
  }, [alignDrawingViewport, clearCameraTiming, updateDrawVisible]);

  const failCameraFreeze = useCallback((token, message) => {
    const next = drawingCameraStep(cameraStateRef.current, { type: 'preview-error', token });
    if (next === cameraStateRef.current) return;
    cameraStateRef.current = next;
    cameraPendingVpRef.current = null;
    setDraftPreview(null);
    updateDrawVisible(true);
    if (message) toast(message, 'error');
  }, [updateDrawVisible]);

  // 编辑态导航只改 RF 相机：首个意图先冻结 draft，预览入 DOM 后才让 RF 开始移动。
  const navigateDrawingCamera = useCallback(transform => {
    const inst = instRef.current;
    if (!inst || !penActiveRef.current || openingRef.current || exitingDrawRef.current) return false;
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
    cameraViewportWriteCountRef.current++;
    syncHandleHitArea(rootRef.current, nextVp.zoom);
    scheduleCameraResume();
    return true;
  }, [clearCameraTiming, failCameraFreeze, scheduleCameraResume]);

  const onDraftPreviewReady = useCallback(revision => {
    if (!draftPreview || draftPreview.revision !== revision) return;
    const next = drawingCameraStep(cameraStateRef.current, {
      type: 'preview-ready', token: draftPreview.token,
    });
    if (next === cameraStateRef.current) return;
    cameraStateRef.current = next;
    updateDrawVisible(false);
    const vp = cameraPendingVpRef.current || instRef.current?.getViewport();
    if (vp) {
      instRef.current?.setViewport(vp);
      cameraViewportWriteCountRef.current++;
      syncHandleHitArea(rootRef.current, vp.zoom);
    }
    scheduleCameraResume();
  }, [draftPreview, scheduleCameraResume, updateDrawVisible]);

  const onDraftPreviewError = useCallback((revision, error, result) => {
    if (!draftPreview || draftPreview.revision !== revision) return;
    if (result?.final === false) return;
    failCameraFreeze(draftPreview.token, `绘图预览失败：${error.message}`);
  }, [draftPreview, failCameraFreeze]);

  useEffect(() => () => {
    clearCameraTiming();
    clearPointerNavigation();
  }, [clearCameraTiming, clearPointerNavigation]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let streak = null;
    const onWheel = e => {
      const externalExcluded = !!e.target.closest?.(CAMERA_EXTERNAL_EXCLUDE);
      const insideExcal = !!e.target.closest?.('.excalidraw');
      const excalUi = insideExcal && !!e.target.closest?.(CAMERA_EXCAL_UI);
      const drawingActive = penActiveRef.current && !openingRef.current;
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
              mode: wheelModeRef.current, streak, now, min: MIN_ZOOM, max: MAX_ZOOM,
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
      if (inst) inst.setViewport(zoomViewport(inst.getViewport(), e, el.getBoundingClientRect(), { min: MIN_ZOOM, max: MAX_ZOOM }));
    };
    root.addEventListener('wheel', onWheel, { capture: true, passive: false });
    return () => root.removeEventListener('wheel', onWheel, { capture: true });
  }, [navigateDrawingCamera]);

  const navigateDrawingZoom = useCallback(command => {
    const root = rootRef.current;
    if (!root) return false;
    return navigateDrawingCamera(vp => keyboardViewport(
      vp, command, root.getBoundingClientRect(), { min: MIN_ZOOM, max: MAX_ZOOM },
    ));
  }, [navigateDrawingCamera]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const options = { capture: true, passive: false };
    const handle = phase => event => {
      const insideRoot = !!event.target && root.contains(event.target);
      const externalExcluded = !!event.target.closest?.(CAMERA_EXTERNAL_EXCLUDE);
      const insideExcal = !!event.target.closest?.('.excalidraw');
      const excalUi = insideExcal && !!event.target.closest?.(CAMERA_EXCAL_UI);
      // Excal 自己在 document 上监听 Safari gesture；我们必须在同级 capture 先封住 root 外与 opening/exiting。
      const route = drawingGestureRoute({
        mounted: penActiveRef.current,
        insideRoot,
        opening: openingRef.current,
        exiting: exitingDrawRef.current,
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
          { min: MIN_ZOOM, max: MAX_ZOOM },
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
  }, [navigateDrawingCamera]);

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
  }, []);

  const onCameraPointerDown = useCallback(e => {
    if (!penActiveRef.current || openingRef.current || exitingDrawRef.current
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
    if (resource.attach()) {
      pointerAcquisitionCountRef.current++;
      pointerResourceRef.current = resource;
    } else if (pointerNavRef.current === session) {
      pointerNavRef.current = null;
    }
  }, [clearPointerNavigation, navigateDrawingCamera]);

  const onRootPointerDownCapture = useCallback(event => {
    const handle = event.target.closest?.('.container-drag-handle');
    const node = handle?.closest?.('.react-flow__node');
    const rect = node?.getBoundingClientRect?.();
    const flowNode = node?.dataset?.id ? instRef.current?.getNode(node.dataset.id) : null;
    carryPointerDownRef.current = node?.dataset?.id && rect
      ? {
        nodeId: node.dataset.id, pointerId: event.pointerId, left: rect.left, top: rect.top,
        x: flowNode?.position.x, y: flowNode?.position.y,
      }
      : null;
    onCameraPointerDown(event);
  }, [onCameraPointerDown]);

  const carryBlocksDrawing = useCallback(() => {
    const phase = carryControllerRef.current?.state().phase || 'IDLE';
    return phase !== 'IDLE' || carryPendingFrameRef.current?.kind === 'batch';
  }, []);

  // ---- 绘图编辑：静态 committed 世界常驻；局部 draft 只在 hole SVG 进入 DOM 后显现。 ----
  const onInkSnapshotReady = useCallback((revision, metrics, renderedWorld, source = 'ink-world') => {
    if (!renderedWorld || requestedWorldRef.current?.revision !== revision) return;
    const carryFrame = carryPendingFrameRef.current;
    if (carryFrame
      && carryFrame.requestedRevision === revision
      && carryFrame.requestedExcludedIds === renderedWorld.excludedIds
      && renderedWorld.generationId === carryFrame.targetFrameId
      && requestedWorldRef.current?.generationId === carryFrame.targetFrameId) {
      if (carryFrame.kind === 'batch') {
        carryFrame.settleOutcome?.({ status: 'ready' });
        batchCarryBridgeRef.current?.clear();
        carryPendingFrameRef.current = null;
        setBatchCarryRetryable(false);
        setCarryTargetWorld(current => current?.txId === carryFrame.txId
          && current.targetFrameId === carryFrame.targetFrameId ? null : current);
      } else {
        carryControllerRef.current?.frameReady(carryFrame.txId, carryFrame.targetFrameId);
      }
    }
    if (frameTestProbeRef) frameTestEventsRef.current = [
      ...frameTestEventsRef.current,
      {
        type: 'ready', source, revision, attempt: metrics?.attempt || 1,
        generationId: renderedWorld?.generationId ?? null,
      },
    ].slice(-24);
    setInkFrame(current => {
      const requested = current?.requestedRevision === revision
        ? current
        : drawingFrameTruthStep(current, { type: 'request', revision });
      return drawingFrameTruthStep(requested, {
        type: 'ready', revision, world: renderedWorld, attempt: metrics?.attempt,
      });
    });
    const handoff = worldHandoffRef.current;
    if (!handoff || handoff.revision !== revision) return;
    if (handoff.phase === 'opening'
      && !drawingOpeningRequestCurrent(openingRequestRef.current, handoff.openingRequest)) return;
    if (handoff.phase === 'closing' && openingRequestRef.current
      && !drawingOpeningRequestCurrent(openingRequestRef.current, handoff.openingRequest)) return;
    worldHandoffRef.current = null;
    if (handoff.phase === 'opening') {
      updateDrawVisible(true);
      setDrawOpening(false);
      openingRef.current = false;
      openingPromiseRef.current = null;
      const resolveOpening = openingReadyResolveRef.current;
      openingReadyResolveRef.current = null;
      openingRequestRef.current = null;
      resolveOpening?.(true);
      return;
    }

    // InkWorld 的完整 merged SVG 已经进入 DOM；layout-effect 回调内同步卸载 live draft，首 paint 前闭合。
    if (drawingOpeningRequestCurrent(openingRequestRef.current, handoff.openingRequest)) {
      const closeStep = drawingClosingHandoffStep({ hasOpeningResolver: !!openingReadyResolveRef.current });
      const resolveOpening = openingReadyResolveRef.current;
      openingRef.current = closeStep.opening;
      openingPromiseRef.current = closeStep.openingPromise;
      openingReadyResolveRef.current = closeStep.openingResolver;
      openingRequestRef.current = null;
      if (closeStep.resolveOpeningWith !== null) resolveOpening?.(closeStep.resolveOpeningWith);
    }
    updateDrawVisible(false);
    resetDrawingCamera(false);
    setEditSeed(null);
    editTransactionRef.current = null;
    editBaseRef.current = null;
    pendingSelectRef.current = null;
    penActiveRef.current = false;
    setPenActive(false);
    setDrawOpening(false);
    handoff.resolve?.(true);
  }, [frameTestProbeRef, resetDrawingCamera, updateDrawVisible]);

  const onInkSnapshotError = useCallback((revision, error, result = {}, source = 'ink-world') => {
    if (requestedWorldRef.current?.revision !== revision) return;
    if (frameTestProbeRef) frameTestEventsRef.current = [
      ...frameTestEventsRef.current,
      {
        type: 'error', source, revision, message: error?.message || String(error),
        attempt: result.attempt || 0, willRetry: !!result.willRetry, final: result.final !== false,
      },
    ].slice(-24);
    setInkFrame(current => {
      const requested = current?.requestedRevision === revision
        ? current
        : drawingFrameTruthStep(current, { type: 'request', revision });
      return drawingFrameTruthStep(requested, {
        type: 'error', revision, error, attempt: result.attempt, willRetry: !!result.willRetry,
      });
    });
    if (result.final === false) return;
    const carryFrame = carryPendingFrameRef.current;
    if (carryFrame
      && carryFrame.requestedRevision === revision
      && carryFrame.requestedExcludedIds === result.excludedIds
      && result.generationId === carryFrame.targetFrameId
      && requestedWorldRef.current?.generationId === carryFrame.targetFrameId) {
      if (carryFrame.kind === 'batch') {
        carryFrame.failed = true;
        setBatchCarryRetryable(true);
        carryFrame.settleOutcome?.({ status: 'retryable-paint', error });
      } else {
        carryControllerRef.current?.frameError(carryFrame.txId, carryFrame.targetFrameId);
      }
    }
    const handoff = worldHandoffRef.current;
    if (!handoff || handoff.revision !== revision) return;
    if (handoff.phase === 'opening'
      && !drawingOpeningRequestCurrent(openingRequestRef.current, handoff.openingRequest)) return;
    if (handoff.phase === 'closing' && openingRequestRef.current
      && !drawingOpeningRequestCurrent(openingRequestRef.current, handoff.openingRequest)) return;
    worldHandoffRef.current = null;
    if (handoff.phase === 'opening') {
      setWorldOverride(null);
      resetDrawingCamera(false);
      updateDrawVisible(false);
      setDrawOpening(false);
      setEditSeed(null);
      editTransactionRef.current = null;
      editBaseRef.current = null;
      draftJournal.deactivate(draftRequestRef.current);
      draftRequestRef.current = null;
      openingRef.current = false;
      openingPromiseRef.current = null;
      penActiveRef.current = false;
      setPenActive(false);
      const resolveOpening = openingReadyResolveRef.current;
      openingReadyResolveRef.current = null;
      openingRequestRef.current = null;
      resolveOpening?.(false);
      toast(`打开绘图失败：${error.message}`, 'error');
      return;
    }
    const base = editBaseRef.current;
    const transaction = editTransactionRef.current;
    if (base && transaction) setWorldOverride({
      elements: base.elements, files: base.files, excludedIds: transaction.originalIds,
      revision: ++worldRevisionRef.current,
    });
    handoff.reject?.(error);
  }, [frameTestProbeRef, resetDrawingCamera, updateDrawVisible]);

  const exitDrawing = useCallback(async () => {
    const openingRequest = openingRequestRef.current;
    const action = drawingExitAction({
      opening: openingRef.current,
      visible: drawVisibleRef.current,
      hasOpeningResolver: !!openingReadyResolveRef.current,
    });
    if (action.type === 'cancel-opening') {
      if (!drawingOpeningRequestCurrent(openingRequestRef.current, openingRequest)) return false;
      const resolveOpening = openingReadyResolveRef.current;
      setMenu(null);
      worldHandoffRef.current = null;
      setWorldOverride(null);
      resetDrawingCamera(false);
      updateDrawVisible(false);
      setDrawOpening(false);
      setEditSeed(null);
      editTransactionRef.current = null;
      editBaseRef.current = null;
      draftJournal.deactivate(draftRequestRef.current);
      draftRequestRef.current = null;
      openingRef.current = action.opening;
      openingRequestRef.current = null;
      openingPromiseRef.current = action.openingPromise;
      openingReadyResolveRef.current = action.openingResolver;
      penActiveRef.current = false;
      pendingSelectRef.current = null;
      setPenActive(false);
      if (action.resolveOpeningWith !== null) resolveOpening?.(action.resolveOpeningWith);
      return true;
    }
    if (!penActiveRef.current || exitingDrawRef.current) return false;
    exitingDrawRef.current = true;
    clearPointerNavigation();
    setMenu(null);
    setDrawOpening(true);   // flush 之后不能再接收新笔；失败会原地解锁，成功则保持到 full SVG 交接
    const cameraExit = drawingCameraExitPolicy(cameraStateRef.current);
    clearCameraTiming();
    if (cameraExit.align) {
      const vp = instRef.current?.getViewport();
      alignDrawingViewport(drawRef.current, vp);
    }
    // 退出抢占相机 token：只保留已 ready preview 填洞，freezing 的迟到副本立即卸载。
    cameraStateRef.current = drawingCameraStep(cameraStateRef.current, { type: 'reset' });
    cameraPendingVpRef.current = null;
    if (!cameraExit.keepPreview) setDraftPreview(null);
    let persisted = false;
    let committedSceneToken = null;
    try {
      const draft = await drawRef.current?.flush();
      const transaction = editTransactionRef.current;
      if (!draft || !transaction) throw new Error('绘图编辑器尚未就绪');
      await draftJournal.flush(draft);
      let preparedDraft = draft;
      let newAutoSinkTicket = null;
      let commitBase = null;
      const previousAutoSinkTicket = autoSinkUndoRef.current;
      const committed = await drawingCommitQueue.submitWithReceipt(base => {
        commitBase = base;
        const prepared = autoSinkLargeNewDrawingDraft(base, transaction, draft);
        preparedDraft = prepared.snapshot;
        if (prepared.sunkIds.length) newAutoSinkTicket = { sunkIds: prepared.sunkIds };
        return mergeDrawingTransaction(base, transaction, prepared.snapshot);
      });
      const merged = committed.snapshot;
      persisted = true;
      committedSceneToken = committed.receipt?.sceneToken;
      if (typeof committedSceneToken !== 'string' || !committedSceneToken) {
        throw new Error('绘图提交回执缺少 sceneToken');
      }
      if (newAutoSinkTicket) {
        // static frame 交接若失败，live draft 也必须带着同一层级真相，重试不能把底板浮回去。
        await Promise.all(newAutoSinkTicket.sunkIds.map(id => drawRef.current.setElementPlane(id, true)));
      }
      // 持久化已成功但 full SVG 仍可能失败：立即 rebase 所有权，后续删除新生 ID 时重试/pagehide 不得复活幽灵。
      editBaseRef.current = merged;
      const advancedTransaction = advanceDrawingTransaction(transaction, preparedDraft);
      editTransactionRef.current = advancedTransaction;
      autoSinkUndoRef.current = advanceAutoSinkUndoTicket(previousAutoSinkTicket, {
        transaction,
        commitBase,
        committed: merged,
        advancedTransaction,
        sunkIds: newAutoSinkTicket?.sunkIds,
      });

      const revision = ++worldRevisionRef.current;
      const closed = new Promise((resolve, reject) => {
        worldHandoffRef.current = { phase: 'closing', revision, openingRequest, resolve, reject };
      });
      // live draft 继续填着旧 hole；只有完整 merged SVG 进 DOM 后才会在 layout effect 同步卸载。
      setWorldOverride({ elements: merged.elements, files: merged.files, excludedIds: NO_DRAWING_IDS, revision });
      const closedOk = await closed;
      // handoff 一成功便先拿走票据；后续 IndexedDB 清理失败也不得让下一次普通编辑继承旧 closing 撤销。
      const autoSinkTicket = closedOk ? autoSinkUndoRef.current : null;
      if (closedOk) autoSinkUndoRef.current = null;
      if (closedOk && draftRequestRef.current) {
        const identity = draftRequestRef.current;
        await draftJournal.clear(identity);
        if (draftRequestRef.current === identity) draftRequestRef.current = null;
      }
      // closing 失败后若用户又成功提交过，旧票据即使终于交接成功也不得冒充本代自动沉底。
      if (closedOk && autoSinkTicket && drawingCommitQueue.snapshot() === autoSinkTicket.after) {
        toast('大块底板已自动沉到卡片下面', 'ok', {
          label: '撤销',
          onClick: () => {
            if (carryBlocksDrawing()) {
              toast('容器批注正在交接，请稍后再撤销自动沉底');
              return;
            }
            if (openingRef.current || penActiveRef.current) {
              toast('请先退出当前绘图，再撤销自动沉底');
              return;
            }
            submitAutoSinkUndo(drawingCommitQueue, autoSinkTicket, setDrawingElementPlane)
              .then(async ({ restored, snapshot }) => {
                const settled = restored ? await drawingCommitQueue.whenIdle() : snapshot;
                if (restored && settled === snapshot && !openingRef.current && !penActiveRef.current) {
                  const revision = ++worldRevisionRef.current;
                  setWorldOverride(current => {
                    const next = drawingRestoredWorldOverride({
                      queueIdle: drawingCommitQueue.isIdleAt(snapshot),
                      editorIdle: !openingRef.current && !penActiveRef.current,
                      currentSnapshot: drawingCommitQueue.snapshot(),
                      restoredSnapshot: snapshot,
                      currentOverride: current,
                      revision,
                    });
                    return next === current ? current : { ...next, excludedIds: NO_DRAWING_IDS };
                  });
                }
                toast(
                  restored ? '已撤销自动沉底' : '撤销已失效：之后已有新的绘图变更',
                  restored ? 'ok' : 'info',
                );
              })
              .catch(error => toast(`撤销自动沉底失败：${error.message}`, 'error'));
          },
        });
      }
      return closedOk;
    } catch (err) {
      if (persisted && editBaseRef.current && editTransactionRef.current) {
        const liveDraft = await drawRef.current?.flush();
        const requestId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
        const base = editBaseRef.current;
        const transaction = editTransactionRef.current;
        draftRequestRef.current = await draftJournal.rebaseAfterClosingFailure({
          requestId,
          sceneToken: committedSceneToken || sceneTokenRef.current,
          closureFingerprint: drawingDraftClosureFingerprint(transaction),
          baselineSnapshot: base,
          mergeDraft: nextDraft => mergeDrawingTransaction(base, transaction, nextDraft),
        }, liveDraft);
      }
      const notice = drawingExitFailureNotice({ persisted, errorMessage: err.message });
      toast(notice.message, 'error');
      setDrawOpening(false);
      resetDrawingCamera(true);
      if (drawingOpeningRequestCurrent(openingRequestRef.current, openingRequest)) {
        openingRef.current = false;
        openingRequestRef.current = null;
        openingPromiseRef.current = null;
        const resolveReady = openingReadyResolveRef.current;
        openingReadyResolveRef.current = null;
        resolveReady?.(false);
      }
      return false;
    } finally {
      exitingDrawRef.current = false;
    }
  }, [alignDrawingViewport, carryBlocksDrawing, clearCameraTiming, clearPointerNavigation, drawingCommitQueue, resetDrawingCamera, updateDrawVisible]);

  const autoExitLargeNewDrawing = useCallback(() => {
    const transaction = editTransactionRef.current;
    if (openingRef.current || exitingDrawRef.current || compositionStateRef.current.active) return;
    if (transaction?.kind !== 'new' || transaction.originalIds?.length) return;
    void exitDrawing();
  }, [exitDrawing]);

  const prepareGeometry = useCallback(async () => {
    const step = canvasGeometryPreparation({
      opening: openingRef.current,
      drawing: penActiveRef.current,
      pending: geometryPendingRef?.current,
    });
    if (step === 'blocked') {
      toast(openingRef.current ? '绘图正在打开，请稍后再整理' : '画布布局正在落定，请稍后再试');
      return false;
    }
    if (step === 'exit-drawing') return exitDrawing();
    return true;
  }, [exitDrawing, geometryPendingRef]);

  const showDraftConflictActions = useCallback(metadata => {
    const identity = metadata?.requestId && metadata?.epoch
      ? { requestId: metadata.requestId, epoch: metadata.epoch }
      : null;
    toast('检测到冲突草稿：已保留，并阻止自动覆盖', 'error', {
      label: '查看冲突详情',
      onClick: () => {
        if (!metadata || metadata.status === 'empty') {
          toast('冲突草稿已不存在', 'info');
          return;
        }
        toast(
          `草稿 ${shortDraftValue(metadata.requestId)} · 保存序号 ${metadata.seq ?? '未知'} · ${metadata.elementCount} 个元素 · 约 ${draftByteLabel(metadata.approximateBytes || 0)} · 画布 ${shortDraftValue(metadata.sceneToken)} · 目标 ${shortDraftValue(metadata.closureFingerprint)} · 与当前画布${metadata.matchesCurrentScene ? '匹配' : '不匹配'}`,
          'info',
        );
      },
    });
    toast('建议先导出一份本地 JSON，再决定是否放弃', 'info', {
      label: '导出草稿',
      onClick: () => {
        void draftJournal.exportActiveDraft()
          .then(record => {
            if (!record) {
              toast('没有可导出的冲突草稿', 'info');
              return;
            }
            downloadDrawingDraft(record);
            toast('草稿已下载到本机；未发送到网络', 'ok');
          })
          .catch(error => toast(`导出草稿失败：${error.message}`, 'error'));
      },
    });
    toast('只有确认不再需要时，才显式放弃这份草稿', 'info', {
      label: '放弃草稿',
      onClick: () => {
        void (async () => {
          if (!identity) {
            toast('草稿身份不完整，未执行删除；请先导出后再处理', 'error');
            return;
          }
          const confirmed = await confirmPop({
            text: '放弃这份本地绘图草稿？',
            detail: '放弃后无法从本机恢复。建议先点“导出草稿”保存 JSON 备份。',
            yesLabel: '确认放弃',
            danger: true,
          });
          if (!confirmed) {
            toast('已保留冲突草稿', 'info');
            return;
          }
          const removed = await draftJournal.discard(identity);
          toast(
            removed ? '冲突草稿已放弃；现在可以重新打开绘图' : '草稿已变化或不存在，未删除任何内容',
            removed ? 'ok' : 'info',
          );
        })().catch(error => toast(`放弃草稿失败：${error.message}`, 'error'));
      },
    });
  }, [draftJournal]);

  const openDrawing = useCallback((tool, selectId) => {
    if (carryBlocksDrawing()) {
      toast('容器批注正在交接，请稍后再打开绘图');
      return Promise.resolve(false);
    }
    if (!openingRef.current && !penActiveRef.current && geometryPendingRef?.current) {
      toast('画布布局正在落定，请稍后再打开绘图');
      return Promise.resolve(false);
    }
    setMenu(null);
    selectArmedRef.current = false;
    setSelectArmed(false);
    clearSelectionRef.current();   // 清掉看板选中：绘图里按 Delete 时 RF 不许顺手删掉选中的手动边
    const toggleActiveTool = penActiveRef.current && drawToolRef.current === tool && !selectId;
    drawToolRef.current = tool;
    setDrawTool(tool);

    // drain/hole 尚未完成：工具可切换，但另一目标不能偷换当前事务。
    if (openingRef.current) {
      if (selectId && pendingSelectRef.current && pendingSelectRef.current !== selectId) {
        toast('当前目标正在打开，请稍后再选择另一段绘图');
        return Promise.resolve(false);
      }
      if (selectId) pendingSelectRef.current = selectId;
      drawRef.current?.activateTool(tool);
      return openingPromiseRef.current;
    }
    pendingSelectRef.current = selectId || null;
    if (toggleActiveTool) {
      return exitDrawing();
    }
    if (penActiveRef.current) {
      const transaction = editTransactionRef.current;
      if (selectId && !transaction?.originalIds?.includes(selectId)) {
        toast('请先退出当前绘图，再选择另一段绘图');
        return Promise.resolve(false);
      }
      drawRef.current?.activateTool(tool);
      if (selectId) drawRef.current?.selectElement(selectId);
      return Promise.resolve(true);
    }

    // 第一条进入请求在任何 await 前封门；其后的普通态提交必须失败，不能越过 drain。
    const openingRequest = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
    openingRequestRef.current = openingRequest;
    openingRef.current = true;
    resetDrawingCamera(false);
    setDrawOpening(true);
    let resolveReady;
    const ready = new Promise(resolve => { resolveReady = resolve; });
    openingReadyResolveRef.current = resolveReady;
    const openingPromise = drawingCommitQueue.whenIdle().then(async seed => {
      if (!drawingOpeningRequestCurrent(openingRequestRef.current, openingRequest)) return false;
      const transaction = createDrawingTransaction(seed, selectId || null);
      if (!transaction) throw new Error('目标绘图刚刚发生变化，请重新选择');
      const closureFingerprint = drawingDraftClosureFingerprint(transaction);
      const recoveryInput = {
        sceneToken: sceneTokenRef.current,
        closureFingerprint,
        baselineSnapshot: seed,
      };
      const recovery = await draftJournal.recover(recoveryInput);
      if (!drawingOpeningRequestCurrent(openingRequestRef.current, openingRequest)) return false;
      if (recovery.status === 'conflict') {
        const metadata = await draftJournal.inspect(recoveryInput);
        const error = new Error('本地绘图草稿与当前画布冲突');
        error.code = 'DRAWING_DRAFT_CONFLICT';
        error.draftMetadata = metadata;
        throw error;
      }
      const recovered = recovery.status === 'restored' ? recovery.record : null;
      const requestId = recovered?.requestId
        || globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
      const draft = recovered?.draft || transaction;
      editBaseRef.current = seed;
      editTransactionRef.current = transaction;
      draftRequestRef.current = draftJournal.begin({
        requestId,
        sceneToken: sceneTokenRef.current,
        closureFingerprint,
        baselineSnapshot: seed,
        mergeDraft: nextDraft => mergeDrawingTransaction(seed, transaction, nextDraft),
        epoch: recovered?.epoch,
        seq: recovered?.seq || 0,
      });
      setEditSeed({ ...transaction, ...draft, openingRequest });
      updateDrawVisible(false);
      penActiveRef.current = true;
      setPenActive(true);
      return ready;
    }).catch(err => {
      if (!drawingOpeningRequestCurrent(openingRequestRef.current, openingRequest)) return false;
      openingRef.current = false;
      openingRequestRef.current = null;
      openingPromiseRef.current = null;
      openingReadyResolveRef.current = null;
      setDrawOpening(false);
      updateDrawVisible(false);
      setEditSeed(null);
      editTransactionRef.current = null;
      editBaseRef.current = null;
      draftJournal.deactivate(draftRequestRef.current);
      draftRequestRef.current = null;
      penActiveRef.current = false;
      setPenActive(false);
      if (err.code === 'DRAWING_DRAFT_CONFLICT') showDraftConflictActions(err.draftMetadata);
      else toast(`打开绘图失败：${err.message}`, 'error');
      return false;
    });
    openingPromiseRef.current = openingPromise;
    return openingPromise;
  }, [carryBlocksDrawing, draftJournal, drawingCommitQueue, exitDrawing, geometryPendingRef, resetDrawingCamera, showDraftConflictActions, updateDrawVisible]);

  const togglePen = useCallback(() => {
    if (penActiveRef.current && !openingRef.current) exitDrawing();
    else openDrawing('freedraw');
  }, [exitDrawing, openDrawing]);

  // 空点退场：选绘图模式点在空白处 → 放行回看板，并把这次点击转交给底下的卡片/画板
  const exitToCanvas = useCallback(async ({ x, y }) => {
    if (!await exitDrawing()) return;
    setTimeout(() => {   // 等绘图编辑器卸载、指针恢复后再转交
      const el = document.elementFromPoint(x, y);
      if (!el) return;
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, isPrimary: true }));
      el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, isPrimary: true }));
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
    }, 0);
  }, [exitDrawing]);

  // 选绘图入口只武装普通平面；真正命中目标后才创建局部事务、挂载 Excalidraw。
  const openSelectDrawing = useCallback(() => {
    if (penActiveRef.current || openingRef.current) {
      openDrawing('selection');
      return;
    }
    const armed = !selectArmedRef.current;
    selectArmedRef.current = armed;
    setSelectArmed(armed);
    drawToolRef.current = 'selection';
    setDrawTool('selection');
    if (!armed) return;
    toast(drawingFrameHitElements(inkFrame).length
      ? '请选择一段绘图；点空白会返回并继续操作底下对象'
      : '画布还没有绘图——点空白返回，或改用画笔开始绘制');
  }, [openDrawing, inkFrame]);

  const onDrawToolChange = useCallback(tool => {
    if (!tool || tool === drawToolRef.current) return;
    drawToolRef.current = tool;
    setDrawTool(tool);
  }, []);

  useEffect(() => {
    if (!penActive && !selectArmed) return;
    const onKey = e => {
      if (e.key !== 'Escape') return;
      if (selectArmedRef.current && !penActiveRef.current) {
        selectArmedRef.current = false;
        setSelectArmed(false);
        return;
      }
      // Excalidraw 文字编辑中的 Esc 归它自己（结束输入），不许连坐退出绘图
      const t = e.target;
      if (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable) return;
      exitDrawing();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [penActive, selectArmed, exitDrawing]);

  // Esc 分层：菜单在 capture 阶段拦截并阻断传播——面板与选中不许连坐
  useEffect(() => {
    if (!menu) return;
    const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); setMenu(null); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [menu]);

  const built = useMemo(
    () => buildGraph(workspaces, sessionsByKey, layout, canvas?.boards, edges, expanded, searching),
    [workspaces, sessionsByKey, layout, canvas?.boards, edges, expanded, searching],
  );

  // ---- 手绘层节点：便签自由漂浮；选中态交 React Flow 原生管理（点选不再全图重建）----
  const allNodes = useMemo(() => [
    ...built.nodes.map(n => {
      if (n.type === 'board') return {
        ...n,
        data: {
          ...n.data,
          editSignal: renaming.id === n.id ? renaming.n : 0,
          onSetBoard: b => onCanvasAction('setBoard', b),
          onDelBoard: (board, pos) => deleteBoardFlow(board, pos, onCanvasAction),
          onResize: p => {
            const current = instRef.current?.getNodes() || [];
            const childEntries = resizedContainerChildren(current, n.id);
            if (childEntries.length) onMoveNode(childEntries);
            onCanvasAction('setBoard', {
              id: n.data.board.id, x: Math.round(p.x), y: Math.round(p.y),
              w: Math.round(p.width), h: Math.round(p.height),
            });
          },
        },
      };
      if (n.type === 'district') return {
        ...n,
        data: {
          ...n.data,
          // 拉角/拉边松手：位置与尺寸一并写入街区布局记忆
          onResize: p => {
            const current = instRef.current?.getNodes() || [];
            onMoveNode([{
              path: n.id, x: Math.round(p.x), y: Math.round(p.y),
              w: Math.round(p.width), h: Math.round(p.height),
            }, ...resizedContainerChildren(current, n.id)]);
          },
        },
      };
      if (n.type === 'workspace') return {
        ...n,
        data: {
          ...n.data,
          editSignal: renaming.id === n.id ? renaming.n : 0,
          onRename: name => onRenameWs(n.id, name),
          onToggleExpand: () => onToggleExpand(n.id),
        },
      };
      if (n.type === 'session') return {
        ...n,
        data: {
          ...n.data,
          editSignal: renaming.id === n.id ? renaming.n : 0,
          onRename: title => onRenameSession(n.id, title),
        },
      };
      return n;
    }),
    ...(canvas?.notes || []).map(n => ({
      id: n.id, type: 'note', position: { x: n.x, y: n.y },
      width: n.w || 232, height: n.h || 128,
      data: {
        note: n,
        onSetNote: note => onCanvasAction('setNote', note),
        onDelNote: (note, pos) => deleteNoteFlow(note, pos, onCanvasAction),
      },
      draggable: true, selectable: true, deletable: true, zIndex: 10,
    })),
  ], [built, canvas?.notes, onCanvasAction, onRenameSession, onRenameWs, onToggleExpand, renaming]);

  const [nodes, setNodes, onNodesChange] = useNodesState(allNodes);
  // 图数据在松手后重建时必须在浏览器绘制前接管，且保留 RF 原生选中态；
  // useEffect 会先画一帧旧父级/旧选中，再画新图，肉眼就是工作区“闪一下”。
  useLayoutEffect(() => {
    setNodes(current => {
      const selected = new Set(current.filter(n => n.selected).map(n => n.id));
      return allNodes.map(n => selected.has(n.id) ? { ...n, selected: true } : n);
    });
  }, [allNodes, setNodes]);

  useLayoutEffect(() => {
    const controller = createContainerCarryController({
      dom: createInkDomAdapter(rootRef.current),
      commit: command => onCanvasAction('containerCarry', command),
      queryStatus: (opId, baseToken) => onCanvasAction('containerCarryStatus', { opId, baseToken }),
      requestFrame: (result, txId) => {
        const targetFrameId = ++carryFrameSequenceRef.current;
        const requested = requestedWorldRef.current;
        const targetWorld = {
          elements: result.drawing,
          files: requested?.files || {},
          excludedIds: NO_DRAWING_IDS,
          revision: Math.max(worldRevisionRef.current, requested?.revision || 0) + 1,
          generationId: targetFrameId,
        };
        carryPendingFrameRef.current = {
          kind: 'direct', txId, targetFrameId, requestedRevision: null, requestedExcludedIds: null,
        };
        setCarryTargetWorld({ txId, targetFrameId, world: targetWorld });
        return targetFrameId;
      },
      clearFrameOwner: (txId, targetFrameId) => {
        const pending = carryPendingFrameRef.current;
        if (pending?.txId === txId && pending.targetFrameId === targetFrameId) {
          carryPendingFrameRef.current = null;
          setCarryTargetWorld(current => current?.txId === txId && current.targetFrameId === targetFrameId
            ? null : current);
        }
      },
      retryFrame: () => setCarryRetryToken(token => token + 1),
      onConflict: (_error, failed) => {
        setNodes(current => current.map(node => node.id === failed.containerId
          ? { ...node, position: { ...failed.from } } : node));
        onCanvasAction('sceneConflict');
        toast('画布已有新修改，请刷新', 'error');
      },
    });
    carryControllerRef.current = controller;
    const unsubscribe = controller.subscribe(setCarryView);
    return () => {
      unsubscribe();
      controller.dispose();
      if (carryControllerRef.current === controller) carryControllerRef.current = null;
    };
  }, [onCanvasAction, setNodes]);

  // RF 是容器可见几何的唯一权威：DOM node.position 提交后，layout effect 才同步墨迹桥。
  // pointermove 不提前写 CSS；最终 DROP 也在同一提交点先补最后一笔 MOVE 再落盘。
  useLayoutEffect(() => {
    const controller = carryControllerRef.current;
    const state = controller?.state();
    if (!state || state.phase !== 'DRAGGING') return;
    const drop = carryDropRef.current;
    const move = drop?.txId === state.txId && drop.containerId === state.containerId
      ? drop
      : carryMoveRef.current;
    if (!move || move.txId !== state.txId || move.containerId !== state.containerId) return;
    carryMoveRef.current = null;
    const moveStarted = performance.now();
    controller.move(state.txId, move.position);
    carryMoveDurationsRef.current.push(performance.now() - moveStarted);
    if (carryMoveDurationsRef.current.length > 256) carryMoveDurationsRef.current.shift();
    if (drop?.txId === state.txId && drop.containerId === state.containerId) {
      carryDropRef.current = null;
      controller.drop(state.txId, move.position);
    }
  }, [nodes]);

  // ---- 边：三种系统边 + 紫色人笔；半受控（选中/删除交 RF），悬空端点直接丢弃 ----
  // 箭头语义：有方向的关系（分支/接力/手动）带箭头，亲缘无先后不带
  const EDGE_META = {
    worktree: { color: '#e2611f', arrow: true },
    family: { color: '#155eef', arrow: false },
    handoff: { color: '#12b76a', arrow: true },
    manual: { color: '#7c3aed', arrow: true },
  };

  const flowEdges = useMemo(() => {
    const ids = new Set(allNodes.map(n => n.id));
    return [
      ...edges.map(e => ({ id: `${e.type}:${e.from}→${e.to}`, from: e.from, to: e.to, type: e.type })),
      ...(canvas?.edges || []).map(e => ({ id: e.id, from: e.from, to: e.to, type: 'manual' })),
    ]
      .filter(e => ids.has(e.from) && ids.has(e.to))
      .map(e => {
        const m = EDGE_META[e.type];
        return {
          id: e.id, source: e.from, target: e.to, className: e.type, type: 'default',
          interactionWidth: 16,
          // 删除主权：只有手动边可选可删，系统边由地形推断、只可观察
          selectable: e.type === 'manual', deletable: e.type === 'manual', focusable: e.type === 'manual',
          pathOptions: { curvature: 0.35 },   // 曲率放大：线条飘逸舒展，不走直角急弯
          ...(m.arrow ? { markerEnd: { type: MarkerType.ArrowClosed, color: m.color, width: 16, height: 16 } } : {}),
        };
      });
  }, [edges, canvas?.edges, allNodes]);

  const [rfEdges, setRfEdges, onEdgesChange] = useEdgesState(flowEdges);
  useEffect(() => { setRfEdges(flowEdges); }, [flowEdges, setRfEdges]);

  const onConnect = useCallback(conn => {
    if (conn.source && conn.target && conn.source !== conn.target) {
      onCanvasAction('addEdge', { from: conn.source, to: conn.target });
    }
  }, [onCanvasAction]);

  // ---- 边的名与解释：点击/悬停都说人话 ----
  const nameOf = useCallback(end => {
    const s = sessionsByKey[end];
    if (s) return s.title;
    if (end.startsWith('note:')) return '便签';
    return end.split('/').filter(Boolean).pop() || end;
  }, [sessionsByKey]);

  const edgeText = useCallback(edge =>
    `${EDGE_LABEL[edge.className] || '关联'}：${nameOf(edge.source)} ⇄ ${nameOf(edge.target)}`,
  [nameOf]);

  const onEdgeClick = useCallback((_, edge) => {
    // 手动边：RF 原生选中即反馈（加粗提亮，Backspace 可删）；系统边：给一句解释
    if (edge.className !== 'manual') toast(edgeText(edge));
  }, [edgeText]);

  const onEdgeMouseEnter = useCallback((e, edge) => {
    setEdgeTip({
      x: Math.min(e.clientX + 12, window.innerWidth - 360), y: e.clientY + 16,
      text: edgeText(edge) + (edge.className === 'manual' ? '　点选后 Backspace 删除' : ''),
    });
  }, [edgeText]);
  const onEdgeMouseLeave = useCallback(() => setEdgeTip(null), []);

  // ============================================================
  //  删除治理：Backspace/Delete 只对便签/画板/手动边生效——
  //  有字的便签与画板过自绘确认；画板不走 RF 内部删除（子节点会悬空），
  //  确认后直接走数据流，重建时自然消失
  // ============================================================
  const posOf = n => {
    const p = instRef.current?.flowToScreenPosition?.(n.position);
    return p ? { x: p.x, y: p.y } : {};
  };

  const onBeforeDelete = useCallback(async ({ nodes: delN, edges: delE }) => {
    const notes = delN.filter(n => n.type === 'note');
    const boards = delN.filter(n => n.type === 'board');
    const manual = delE.filter(e => e.className === 'manual');
    if (!notes.length && !boards.length && !manual.length) return false;

    if (boards.length) {
      deleteBoardFlow(boards[0].data.board, posOf(boards[0]), onCanvasAction);
      return false;   // RF 内部永不删容器——数据流重建去移除，子节点不悬空
    }
    const texted = notes.filter(n => n.data.note.text?.trim());
    if (texted.length) {
      const ok = await confirmPop({
        ...posOf(texted[0]), danger: true, yesLabel: '删除',
        text: notes.length > 1 ? `删除选中的 ${notes.length} 张便签？` : '删除这张写了字的便签？',
        detail: texted[0].data.note.text.slice(0, 90),
      });
      if (!ok) return false;
    }
    return { nodes: notes, edges: manual };
  }, [onCanvasAction]);

  const onNodesDelete = useCallback(deleted => {
    for (const n of deleted) if (n.type === 'note') onCanvasAction('delNote', n.id);
  }, [onCanvasAction]);

  const onEdgesDelete = useCallback(deleted => {
    for (const e of deleted) if (e.className === 'manual') onCanvasAction('delEdge', e.id);
  }, [onCanvasAction]);

  // ---- 拉线落空 = 在松手处选择“便签 / 画板”，选中后对象与线原子落盘 ----
  const onConnectEnd = useCallback((event, connectionState) => {
    rootRef.current?.classList.remove('connecting');
    const drop = connectionDrop(event, connectionState);
    if (!drop) return;
    const { x, y, from } = drop;
    const pos = instRef.current.screenToFlowPosition({ x, y });
    const items = [
      // 从会话卡拉出的线：第一去处是就地打开它的完整上下文终端框
      ...(sessionsByKey[from] ? [{ label: <><Icon name="terminal" /> 打开会话上下文</>, fn: () =>
        onCanvasAction('openContext', { key: from, x, y }) }] : []),
      { label: <><Icon name="note" /> 新建便签并连接</>, fn: () => onCanvasAction('nodeFromEdge', {
        kind: 'note', from, x: Math.round(pos.x), y: Math.round(pos.y),
      }) },
      { label: <><Icon name="board" /> 新建画板并连接</>, fn: () => onCanvasAction('nodeFromEdge', {
        kind: 'board', from, x: Math.round(pos.x), y: Math.round(pos.y),
      }) },
    ];
    setMenu({
      x: Math.max(10, Math.min(x, window.innerWidth - 210)),
      y: Math.max(10, Math.min(y, window.innerHeight - items.length * 34 - 16)),
      items,
    });
  }, [onCanvasAction, sessionsByKey]);

  // ============================================================
  //  右键快捷菜单：七套（含街区与手动边），构建器在 menus.jsx
  // ============================================================
  const openMenu = (e, items) => {
    e.preventDefault();
    // 视口 clamp：屏幕边缘右键不许把菜单挤出去
    const h = items.length * 34 + 16;
    setMenu({
      x: Math.min(e.clientX, window.innerWidth - 210),
      y: Math.min(e.clientY, window.innerHeight - h),
      items,
    });
  };

  const focusDistrict = useCallback(node => {
    const w = node.width ?? node.data._w, h = node.height ?? node.data._h;
    instRef.current?.fitBounds(
      { x: node.position.x, y: node.position.y, width: w, height: h },
      { duration: 600, padding: 0.12 });
  }, []);

  const menuCtx = () => ({
    onSelect, onChanged, onCanvasAction,
    rename: triggerRename,
    focusWs: path => focusRef.current(path),
    focusDistrict,
    fit: () => focusRef.current(null),
    arrange: pos => onArrange?.(pos),
    addBoardAt: pos => {
      const p = instRef.current.screenToFlowPosition(pos);
      onCanvasAction('setBoard', { x: Math.round(p.x), y: Math.round(p.y), w: 520, h: 360, name: '新画板' });
    },
    openContext: (key, pos) => onCanvasAction('openContext', {
      key, x: pos?.x ?? window.innerWidth / 2 - 290, y: pos?.y ?? 90,
    }),
  });

  const onNodeContextMenu = useCallback((e, node) => {
    const ctx = menuCtx();
    // 视觉最上层者赢：绘图叠在任何对象上（含会话卡/工作区），删除/编辑入口一律排在对象动作之前
    const hit = drawingHitFromEvent(e);
    const base =
      node.type === 'session' ? sessionMenu(node.data.session, ctx)
      : node.type === 'workspace' ? workspaceMenu(node.data.workspace, ctx)
      : node.type === 'district' ? districtMenu(node, ctx)
      : node.type === 'board' ? boardMenu(node.data.board, ctx)
      : node.type === 'note' ? noteMenu(node.data.note, ctx)
      : [];
    openMenu(e, [...(hit ? drawingMenuItems(hit) : []), ...base]);
  }, [onSelect, onChanged, onCanvasAction, onArrange, triggerRename, focusDistrict, openDrawing, inkFrame]);

  // ============================================================
  //  普通模式的绘图命中：pane 与容器空白面都是"画布空地"，视觉最上层者赢——
  //  绘图层画在一切之上，点得到看得到的东西才叫融合。标题栏/按钮等功能件除外。
  // ============================================================
  // 功能件排除清单唯一真相：点击/悬停两条路径共用，永不分叉
  // 平面感知命中：卡片/容器上只认浮层（沉层垫在它们下面，视觉都被盖住了）；
  // 纯空地(pane)先浮后沉——看得见谁就点得到谁
  const hitDrawingAt = (fx, fy, planes = 'above') => {
    const painted = carryTargetWorld?.kind === 'batch'
      ? carryTargetWorld.world
      : presentedWorld(inkFrame?.renderedWorld, carryControllerRef.current?.state());
    const els = penActiveRef.current ? (drawRef.current?.getElements?.() || []) : (painted?.elements || []);
    const tol = 8 / (instRef.current?.getZoom() || 1);
    const above = hitDrawingElement(els.filter(el => !el.customData?.below), fx, fy, tol);
    if (above || planes === 'above') return above;
    return hitDrawingElement(els.filter(el => el.customData?.below), fx, fy, tol);
  };

  const drawingHitFromEvent = (e, planes) => {
    if (penActiveRef.current) return null;
    if (e.target?.closest?.(DRAWING_HIT_BLOCK)) return null;
    const p = instRef.current?.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    return p ? hitDrawingAt(p.x, p.y, planes) : null;
  };

  const enterDrawingSelection = hit => {
    selectArmedRef.current = false;
    setSelectArmed(false);
    openDrawing('selection', hit.id)
      .then(opened => { if (opened) toast('已选中绘图——Delete 删除，Esc 返回看板'); })
      .catch(err => toast(`打开绘图失败：${err.message}`, 'error'));
  };

  const commitDrawing = useCallback(transform => {
    if (carryBlocksDrawing()) {
      return Promise.reject(new Error('容器批注正在交接'));
    }
    if (openingRef.current || penActiveRef.current) {
      return Promise.reject(new Error('绘图编辑事务进行中'));
    }
    return drawingCommitQueue.submit(transform);
  }, [carryBlocksDrawing, drawingCommitQueue]);

  const drawingMenuItems = hit => [
    // 层级主权：区域底板沉到卡片下面当背景（不再挡点击），批注浮到上面
    { label: hit.customData?.below
        ? <><Icon name="up" /> 浮到卡片上面</>
        : <><Icon name="down" /> 沉到卡片下面</>,
      fn: () => commitDrawing(base => ({
        elements: setDrawingElementPlane(base.elements, hit.id, !hit.customData?.below),
        files: base.files,
      }))
        .then(() => toast(hit.customData?.below ? '已浮到卡片上面' : '已沉为背景底板——不再遮挡卡片点击', 'ok'))
        .catch(err => toast(`层级调整失败：${err.message}`, 'error')) },
    { label: <><Icon name="cursor" /> 选中编辑此绘图</>, fn: () => openDrawing('selection', hit.id) },
    { label: <><Icon name="trash" /> 删除此绘图</>, danger: true, fn: async mpos => {
      const ok = await confirmPop({
        x: mpos?.x, y: mpos?.y, danger: true, yesLabel: '删除',
        text: '删除这段绘图？', detail: '仅删除这一个绘图元素，画布其余笔迹不受影响。',
      });
      if (ok) {
        // 回执跟真实落盘结果走：daemon 恰好重启时不许拿绿色回执骗人
        commitDrawing(base => ({ elements: deleteDrawingElement(base.elements, hit.id), files: base.files }))
          .then(() => toast('绘图已删除', 'ok'))
          .catch(err => toast(`删除未落盘：${err.message}`, 'error'));
      }
    } },
    { sep: true },
  ];

  const onPaneClick = useCallback(e => {
    const hit = drawingHitFromEvent(e, 'all');   // 纯空地：浮层批注优先，其次沉层底板
    if (hit) return enterDrawingSelection(hit);
    if (selectArmedRef.current) {
      selectArmedRef.current = false;
      setSelectArmed(false);
    }
    onSelect(null);
    setMenu(null);
  }, [onSelect, openDrawing, inkFrame]);

  // 悬停绘图描边带 → 指针光标（rAF 节流，元素只有几个，成本可忽略）；移动中整体静默
  const overDrawRaf = useRef(0);
  const moveEndT = useRef(null);
  useEffect(() => () => clearTimeout(moveEndT.current), []);
  const onPaneMouseMove = useCallback(e => {
    if (penActiveRef.current) return;
    if (rootRef.current?.classList.contains('canvas-moving')) return;   // 平移/缩放中内容扫过光标，悬停态不许进出闪烁
    const { clientX, clientY } = e;
    const blocked = !!e.target?.closest?.(DRAWING_HIT_BLOCK);
    const planes = e.target?.classList?.contains('react-flow__pane') ? 'all' : 'above';
    cancelAnimationFrame(overDrawRaf.current);
    overDrawRaf.current = requestAnimationFrame(() => {
      const p = blocked ? null : instRef.current?.screenToFlowPosition({ x: clientX, y: clientY });
      rootRef.current?.classList.toggle('over-drawing', !!(p && hitDrawingAt(p.x, p.y, planes)));
    });
  }, [inkFrame]);
  useEffect(() => () => cancelAnimationFrame(overDrawRaf.current), []);

  // 一切节点与 pane 同一条河：描边带悬停指示处处点亮（空心区/功能件由命中检测自己排除）
  const onNodeMouseMove = useCallback(e => onPaneMouseMove(e), [onPaneMouseMove]);

  const onPaneContextMenu = useCallback(e => {
    const pos = instRef.current.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    const at = { x: Math.round(pos.x), y: Math.round(pos.y) };
    const hit = drawingHitFromEvent(e, 'all');
    openMenu(e, [...(hit ? drawingMenuItems(hit) : []), ...paneMenu(at, menuCtx())]);
  }, [onCanvasAction, onArrange, openDrawing, inkFrame]);

  const onEdgeContextMenu = useCallback((e, edge) => {
    e.preventDefault();
    if (edge.className === 'manual') openMenu(e, edgeMenu(edge, { onCanvasAction }));
    else toast(edgeText(edge));   // 系统边：右键也给解释，绝不弹浏览器原生菜单
  }, [onCanvasAction, edgeText]);

  // ---- 新便签 / 新画板：落在当前视野中央 ----
  const centerFlow = () => {
    const inst = instRef.current;
    const pane = document.querySelector('.react-flow');
    const { width, height } = pane.getBoundingClientRect();
    return inst.screenToFlowPosition({ x: width / 2, y: height / 2 });
  };

  const addNote = useCallback(() => {
    const pos = centerFlow();
    onCanvasAction('setNote', { x: Math.round(pos.x - 116), y: Math.round(pos.y - 48), text: '', color: 'yellow' });
  }, [onCanvasAction]);

  const addBoard = useCallback(() => {
    const pos = centerFlow();
    onCanvasAction('setBoard', { x: Math.round(pos.x - 260), y: Math.round(pos.y - 180), w: 520, h: 360, name: '新画板' });
  }, [onCanvasAction]);

  // ============================================================
  //  容器承载律（FigJam/Miro 共识）：容器搬家，锚定其内的墨迹一起走。
  //  多容器重叠时面积小者优先认领，一个元素只跟一个容器
  // ============================================================
  const onNodeDragStart = useCallback((event, node) => {
    if (!geometryAllowed()) return;
    if (node.type === 'district' || node.type === 'board') {
      cancelledCarryRef.current.delete(node.id);
      carryMoveRef.current = null;
      carryDropRef.current = null;
      const pointerDown = carryPointerDownRef.current;
      const from = pointerDown?.nodeId === node.id
        && Number.isFinite(pointerDown.x) && Number.isFinite(pointerDown.y)
        ? { x: pointerDown.x, y: pointerDown.y }
        : { x: node.position.x, y: node.position.y };
      const containers = (instRef.current?.getNodes() || [])
        .filter(candidate => candidate.type === 'district' || candidate.type === 'board')
        .map(candidate => ({
          id: candidate.id, x: candidate.position.x, y: candidate.position.y,
          w: candidate.width ?? candidate.data._w, h: candidate.height ?? candidate.data._h,
        }));
      const beginStarted = performance.now();
      carryMoveDurationsRef.current = [];
      const txId = carryControllerRef.current?.begin({
        queueIdle: drawingCommitQueue.isIdleAt(drawingCommitQueue.snapshot()),
        sceneMutationPending: !!sceneMutationPendingRef?.current,
        drawingTransaction: openingRef.current || exitingDrawRef.current || penActiveRef.current,
        renderedWorld: inkFrame?.renderedWorld || null,
        renderedRevision: inkFrame?.renderedWorld?.revision,
        requestedRevision: requestedWorldRef.current?.revision,
        sceneToken,
        container: containers.find(container => container.id === node.id),
        containers,
        from,
      });
      carryBeginDurationRef.current = performance.now() - beginStarted;
      const pointerId = event?.pointerId ?? event?.nativeEvent?.pointerId
        ?? (pointerDown?.nodeId === node.id ? pointerDown.pointerId : undefined);
      dragStartRef.current.set(node.id, {
        ...from, w: node.width ?? node.data._w, h: node.height ?? node.data._h,
        txId, pointerId, blocked: !txId,
      });
      if (!txId) toast('正在保存上一笔画布操作');
    }
  }, [drawingCommitQueue, geometryAllowed, inkFrame, sceneMutationPendingRef, sceneToken]);

  const planArrangeBatch = useCallback(nextLayout => {
    const rendered = inkFrame?.renderedWorld || null;
    const requested = requestedWorldRef.current;
    if ((canvas?.drawing || []).length
      && (!rendered || rendered.revision !== requested?.revision || rendered.excludedIds !== requested.excludedIds)) {
      return null;
    }
    const before = buildGraph(
      workspaces, sessionsByKey, layout, canvas?.boards, edges, expanded, searching,
    );
    const after = buildGraph(
      workspaces, sessionsByKey, nextLayout, canvas?.boards, edges, expanded, searching,
    );
    return {
      layout: nextLayout,
      moves: planBatchCarry(before.nodes, after.nodes, rendered),
    };
  }, [canvas?.boards, canvas?.drawing, edges, expanded, inkFrame, layout, searching, sessionsByKey, workspaces]);

  const presentBatchCarryResult = useCallback(result => {
    if (!result?.movedIds?.length) return Promise.resolve({ status: 'ready' });
    if (carryPendingFrameRef.current) return Promise.reject(new Error('已有容器承载正在交接'));
    const targetFrameId = ++carryFrameSequenceRef.current;
    const txId = `batch:${result.opId}`;
    const requested = requestedWorldRef.current;
    batchCarryBridgeRef.current ||= createBatchCarryBridge(rootRef.current);
    batchCarryBridgeRef.current.present(result.moves);
    setBatchCarryRetryable(false);
    let settle;
    let settled = false;
    const handoff = new Promise(resolve => { settle = resolve; });
    const settleOutcome = outcome => {
      if (settled) return false;
      settled = true;
      settle(outcome);
      return true;
    };
    {
      carryPendingFrameRef.current = {
        kind: 'batch',
        txId,
        opId: result.opId,
        targetFrameId,
        requestedRevision: null,
        requestedExcludedIds: null,
        settleOutcome,
        failed: false,
      };
    }
    setCarryTargetWorld({
      kind: 'batch',
      txId,
      targetFrameId,
      world: {
        elements: result.drawing,
        files: requested?.files || {},
        excludedIds: NO_DRAWING_IDS,
        revision: Math.max(worldRevisionRef.current, requested?.revision || 0) + 1,
        generationId: targetFrameId,
      },
    });
    return handoff;
  }, []);

  useEffect(() => () => {
    const pending = carryPendingFrameRef.current;
    if (pending?.kind !== 'batch') return;
    pending.settleOutcome?.({ status: 'disposed' });
    batchCarryBridgeRef.current?.clear();
    carryPendingFrameRef.current = null;
  }, []);

  // 清空画布选中：Esc 与关面板共用（选中态与面板永不脱钩）
  const clearSelection = useCallback(() => {
    setNodes(ns => ns.some(n => n.selected) ? ns.map(n => n.selected ? { ...n, selected: false } : n) : ns);
    setRfEdges(es => es.some(e => e.selected) ? es.map(e => e.selected ? { ...e, selected: false } : e) : es);
  }, [setNodes, setRfEdges]);
  clearSelectionRef.current = clearSelection;

  useEffect(() => { if (!selectedKey) clearSelection(); }, [selectedKey, clearSelection]);

  const drawingFocusViewport = useCallback(path => {
    const inst = instRef.current;
    const root = rootRef.current;
    if (!inst || !root?.clientWidth || !root?.clientHeight) return null;
    if (path) {
      const p = built.positions[path];
      if (!p) return null;
      const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, 0.9));
      return {
        zoom,
        x: root.clientWidth / 2 - (p.x + p.w / 2) * zoom,
        y: root.clientHeight / 2 - (p.y + Math.min(p.h / 2, 280)) * zoom,
      };
    }
    const visibleNodes = inst.getNodes().filter(node => !node.hidden);
    if (!visibleNodes.length) return inst.getViewport();
    return getViewportForBounds(
      inst.getNodesBounds(visibleNodes), root.clientWidth, root.clientHeight,
      MIN_ZOOM, 0.8, 0.1,
    );
  }, [built]);

  const navigateDrawingFit = useCallback(path => {
    const target = drawingFocusViewport(path);
    return target ? navigateDrawingCamera(() => target) : false;
  }, [drawingFocusViewport, navigateDrawingCamera]);

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
      if (command && !openingRef.current && !exitingDrawRef.current) {
        command === 'fit' ? navigateDrawingFit(null) : navigateDrawingZoom(command);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [navigateDrawingFit, navigateDrawingZoom]);

  useEffect(() => {
    focusRef.current = path => {
      const inst = instRef.current;
      if (!inst) return;
      if (penActiveRef.current) return navigateDrawingFit(path);
      if (!path) return inst.fitView({ padding: 0.1, duration: 700, maxZoom: 0.8 });
      const p = built.positions[path];
      if (p) inst.setCenter(p.x + p.w / 2, p.y + Math.min(p.h / 2, 280), { zoom: 0.9, duration: 650 });
    };
    if (actionsRef) actionsRef.current = {
      addNote, addBoard, fit: () => focusRef.current(null), toggleDraw: togglePen, clearSelection,
      geometryLocked, opening, prepareGeometry,
      planArrangeBatch, presentBatchCarryResult,
    };
  }, [built, focusRef, actionsRef, addNote, addBoard, togglePen, navigateDrawingFit, clearSelection, geometryLocked, opening, prepareGeometry, planArrangeBatch, presentBatchCarryResult]);

  const onNodeClick = useCallback((e, node) => {
    const hit = drawingHitFromEvent(e);   // 视觉最上层者赢：描边带上的点击优先归绘图，空心区照常穿透给卡片
    if (hit) return enterDrawingSelection(hit);
    if (selectArmedRef.current) {
      selectArmedRef.current = false;
      setSelectArmed(false);
    }
    if (node.type === 'session') onSelect(node.id);
    // 其余类型：RF 原生选中态即回应（描边+手柄亮起）
  }, [onSelect, openDrawing, inkFrame]);

  // ---- 双击就地改名：会话卡/画板/工作区同一条信号线 ----
  const onNodeDoubleClick = useCallback((_, node) => {
    if (node.type === 'session' || node.type === 'board' || node.type === 'workspace') triggerRename(node.id);
  }, [triggerRename]);

  // ============================================================
  //  拖动即记忆 + 拖放改归属：
  //  拖动中投放目标实时高亮（DOM 类直改，零重渲染）；
  //  松手 → 命中哪个容器就归谁，快照旧容器兄弟与全部街区位置防跳位
  // ============================================================
  const setDropHi = useCallback(id => {
    if (dropHiRef.current === id) return;
    if (dropHiRef.current) document.querySelector(`[data-id="${CSS.escape(dropHiRef.current)}"]`)?.classList.remove('rf-drop-target');
    if (id) document.querySelector(`[data-id="${CSS.escape(id)}"]`)?.classList.add('rf-drop-target');
    dropHiRef.current = id;
  }, []);

  const cancelActiveCarry = useCallback(pointerId => {
    const controller = carryControllerRef.current;
    const state = controller?.state();
    if (!state || state.phase !== 'DRAGGING') return false;
    const start = dragStartRef.current.get(state.containerId);
    if (!start || start.txId !== state.txId) return false;
    if (pointerId !== undefined && start.pointerId !== pointerId) return false;
    carryMoveRef.current = null;
    carryDropRef.current = null;
    dragStartRef.current.delete(state.containerId);
    cancelledCarryRef.current.set(state.containerId, start);
    setDropHi(null);
    controller.cancel(state.txId);
    setNodes(current => current.map(node => node.id === state.containerId
      ? { ...node, position: { x: start.x, y: start.y } } : node));
    return true;
  }, [setDropHi, setNodes]);

  useEffect(() => {
    const onKeyDown = event => {
      if (event.key !== 'Escape' || !cancelActiveCarry()) return;
      event.preventDefault();
      event.stopPropagation();
    };
    const onPointerCancel = event => {
      cancelActiveCarry(event.pointerId);
    };
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('pointercancel', onPointerCancel, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('pointercancel', onPointerCancel, true);
    };
  }, [cancelActiveCarry]);

  const onNodeDrag = useCallback((event, node) => {
    if (!geometryAllowed()) return;
    if (node.type === 'district' || node.type === 'board') {
      const cancelled = cancelledCarryRef.current.get(node.id);
      const pointerId = event?.pointerId ?? event?.nativeEvent?.pointerId;
      if (cancelled && (pointerId === undefined || cancelled.pointerId === pointerId)) {
        setNodes(current => current.map(candidate => candidate.id === node.id
          ? { ...candidate, position: { x: cancelled.x, y: cancelled.y } } : candidate));
        return;
      }
      const start = dragStartRef.current.get(node.id);
      if (start?.blocked) {
        setNodes(current => current.map(candidate => candidate.id === node.id
          ? { ...candidate, position: { x: start.x, y: start.y } } : candidate));
      } else if (start?.txId) {
        carryMoveRef.current = {
          txId: start.txId,
          containerId: node.id,
          position: { ...node.position },
        };
      }
      return;
    }
    if (node.type !== 'workspace') return;
    const { oldParent, hit } = hitContainer(node, instRef.current?.getNodes() || []);
    setDropHi(hit && oldParent && hit.id !== oldParent.id ? hit.id : null);
  }, [geometryAllowed, setDropHi, setNodes]);

  const onNodeDragStop = useCallback((event, node) => {
    setDropHi(null);
    if (carryPointerDownRef.current?.nodeId === node.id) carryPointerDownRef.current = null;
    const cancelled = cancelledCarryRef.current.get(node.id);
    const pointerId = event?.pointerId ?? event?.nativeEvent?.pointerId;
    if (cancelled && (pointerId === undefined || cancelled.pointerId === pointerId)) {
      cancelledCarryRef.current.delete(node.id);
      setNodes(current => current.map(candidate => candidate.id === node.id
        ? { ...candidate, position: { x: cancelled.x, y: cancelled.y } } : candidate));
      return;
    }
    if (!geometryAllowed()) {
      dragStartRef.current.delete(node.id);
      return;
    }
    const all = instRef.current?.getNodes() || [];
    if (node.type === 'workspace') {
      const { oldParent, hit, abs } = hitContainer(node, all);
      if (!oldParent) return;   // 拖动瞬间容器被删（另一窗口/刷新）——弃子保平安
      const dest = (hit && hit.id !== node.parentId) ? hit : oldParent;
      const rel = { x: Math.max(PAD.l, abs.x - dest.position.x), y: Math.max(PAD.t, abs.y - dest.position.y) };

      const entries = [
        { path: node.id, x: Math.round(rel.x), y: Math.round(rel.y), d: containerKey(dest.id) },
        ...all
          .filter(n => n.type === 'workspace' && n.parentId === node.parentId && n.id !== node.id)
          .map(n => ({ path: n.id, x: n.position.x, y: n.position.y, d: containerKey(node.parentId) })),
        ...all
          .filter(n => n.type === 'district')
          .map(n => ({ path: n.id, x: n.position.x, y: n.position.y })),
      ];
      onMoveNode(entries);
      if (dest.id !== node.parentId) {
        toast(`看板中已划入「${dest.type === 'board' ? dest.data.board.name : dest.data.name}」，本地文件未移动`, 'ok');
      }
    } else if (node.type === 'district' || node.type === 'board') {
      const start = dragStartRef.current.get(node.id);
      dragStartRef.current.delete(node.id);
      if (start?.blocked) {
        setNodes(current => current.map(candidate => candidate.id === node.id
          ? { ...candidate, position: { x: start.x, y: start.y } } : candidate));
      } else if (start?.txId) {
        carryDropRef.current = {
          txId: start.txId,
          containerId: node.id,
          position: { ...node.position },
        };
        setNodes(current => current.map(candidate => candidate.id === node.id
          ? { ...candidate, position: { ...node.position } } : candidate));
      }
    } else if (node.type === 'note') {
      onCanvasAction('setNote', { id: node.id, x: Math.round(node.position.x), y: Math.round(node.position.y) });
    }
  }, [onMoveNode, onCanvasAction, geometryAllowed, setDropHi, setNodes]);

  // 视口记忆：刷新回到上次看的地方，不再被甩回原点
  const initVp = useRef(undefined);
  if (initVp.current === undefined) {
    try { initVp.current = JSON.parse(localStorage.vp); } catch { initVp.current = null; }
  }
  const worldInput = drawingWorldInputStep({
    persistedWorld: persistedWorldRef.current,
    activeWorld: requestedWorldRef.current,
    override: carryTargetWorld?.world || worldOverride,
    elements: canvas?.drawing,
    files: canvas?.drawingFiles,
    excludedIds: NO_DRAWING_IDS,
    revision: worldRevisionRef.current,
  });
  const world = worldInput.world;
  // render 只推导候选 world；帧主权随本次 React commit 发布。并发 render 若被丢弃，
  // 绝不能让 speculative generation 拒收仍在屏幕上的 ready/error 或卡住交接门。
  useLayoutEffect(() => {
    persistedWorldRef.current = worldInput.persistedWorld;
    worldRevisionRef.current = worldInput.revision;
    requestedWorldRef.current = world;
    const pending = carryPendingFrameRef.current;
    if (pending
      && carryTargetWorld?.txId === pending.txId
      && carryTargetWorld.targetFrameId === pending.targetFrameId
      && world.generationId === pending.targetFrameId) {
      pending.requestedRevision = world.revision;
      pending.requestedExcludedIds = world.excludedIds;
    }
  }, [carryTargetWorld, worldInput.persistedWorld, worldInput.revision, world]);
  useEffect(() => {
    setInkFrame(current => drawingFrameTruthStep(current, { type: 'request', revision: world.revision }));
  }, [world.revision]);
  const renderedWorld = inkFrame?.renderedWorld || null;
  const requestedHasInk = drawingTransactionVisibleElements(world.elements || [], world.excludedIds).length > 0;
  const framePhase = inkFrame?.requestedRevision === world.revision
    ? inkFrame.phase
    : (renderedWorld ? 'updating' : 'cold');
  const inkStatus = !penActive && (
    framePhase === 'retrying'
      ? (renderedWorld ? '绘图更新失败，正在重试…' : '绘图载入失败，正在重试…')
      : framePhase === 'stale' ? '绘图暂时显示上一帧·自动重试未成功'
        : framePhase === 'failed' ? '绘图暂未显现·自动重试未成功'
          : framePhase === 'cold' && requestedHasInk ? '绘图正在显现…'
            : null
  );
  const cameraPresentation = drawingCameraPresentation({
    active: penActive, visible: drawVisible, hasPreview: !!draftPreview,
  });

  // 4518 隔离夹具的动作 seam：只暴露只读快照与真实 open/exit；故障仅从 Ink exporter 边界注入。
  // 发布放在 layout effect，speculative render 被丢弃时不会篡改探针主权。
  useLayoutEffect(() => {
    if (!frameTestProbeRef) return undefined;
    const snapshot = () => {
      const requestedWorld = requestedWorldRef.current;
      const rendered = inkFrame?.renderedWorld || null;
      const hitElements = drawingFrameHitElements(inkFrame);
      return {
        requestedRevision: requestedWorld?.revision ?? null,
        requestedGenerationId: requestedWorld?.generationId ?? null,
        requestedElementIds: (requestedWorld?.elements || []).map(element => element.id),
        renderedRevision: rendered?.revision ?? null,
        renderedGenerationId: rendered?.generationId ?? null,
        renderedElementIds: (rendered?.elements || []).map(element => element.id),
        hitRevision: hitElements === rendered?.elements ? (rendered?.revision ?? null) : null,
        hitElementIds: hitElements.map(element => element.id),
        framePhase: inkFrame?.phase || 'idle',
        frameAttempt: inkFrame?.attempt || 0,
        frameError: inkFrame?.error?.message || null,
        handoffPhase: worldHandoffRef.current?.phase || null,
        handoffRevision: worldHandoffRef.current?.revision ?? null,
        opening: openingRef.current,
        openingResolverPending: !!openingReadyResolveRef.current,
        penActive: penActiveRef.current,
        drawVisible: drawVisibleRef.current,
        cameraPhase: cameraStateRef.current.phase,
        cameraShield: !!rootRef.current?.querySelector('[data-drawing-camera-shield]'),
        cameraAlignCount: drawingViewportAlignCountRef.current,
        cameraViewportWriteCount: cameraViewportWriteCountRef.current,
        pointerAcquisitionCount: pointerAcquisitionCountRef.current,
        pointerCleanupCount: pointerCleanupCountRef.current,
        pointerResourceActive: !!pointerResourceRef.current,
        carryPhase: carryControllerRef.current?.state().phase || 'IDLE',
        carryDelta: {
          dx: carryControllerRef.current?.state().dx || 0,
          dy: carryControllerRef.current?.state().dy || 0,
        },
        carryBeginDuration: carryBeginDurationRef.current,
        carryMoveDurations: [...carryMoveDurationsRef.current],
        carryPointerId: (() => {
          const state = carryControllerRef.current?.state();
          return state?.containerId ? (dragStartRef.current.get(state.containerId)?.pointerId ?? null) : null;
        })(),
        carryEvents: carryControllerRef.current?.events() || [],
        carryTargetFrame: (() => {
          const pending = carryPendingFrameRef.current;
          return pending ? {
            kind: pending.kind,
            txId: pending.txId,
            opId: pending.opId || null,
            targetFrameId: pending.targetFrameId,
            requestedRevision: pending.requestedRevision,
            excludedIdsCurrent: pending.requestedExcludedIds === requestedWorldRef.current?.excludedIds,
            generationCurrent: pending.targetFrameId === requestedWorldRef.current?.generationId,
            failed: !!pending.failed,
          } : null;
        })(),
        batchBridgeCount: batchCarryBridgeRef.current?.count() || 0,
        batchCarryRetryable,
        viewport: instRef.current?.getViewport() || null,
        callbackEvents: [...frameTestEventsRef.current],
      };
    };
    const probe = {
      snapshot,
      openDrawing: (tool, selectId) => openDrawing(tool, selectId),
      commitDrawing: transform => commitDrawing(transform),
      exitDrawing: () => exitDrawing(),
    };
    frameTestProbeRef.current = probe;
    return () => {
      if (frameTestProbeRef.current === probe) frameTestProbeRef.current = null;
    };
  }, [batchCarryRetryable, commitDrawing, exitDrawing, frameTestProbeRef, inkFrame, openDrawing, world.revision]);

  return (
    <div ref={rootRef} onPointerDownCapture={onRootPointerDownCapture}
      data-rendered-revision={renderedWorld?.revision ?? ''}
      data-requested-revision={world.revision}
      data-carry-phase={carryView.phase}
      className={`canvas-root${penActive ? ' drawing-on' : ''}${drawOpening ? ' drawing-opening' : ''}${selectArmed ? ' drawing-armed' : ''}`} style={{ position: 'relative', width: '100%', height: '100%' }}>
    <ReactFlow
      nodes={nodes}
      edges={rfEdges}
      nodeTypes={nodeTypes}
      nodesDraggable={!drawOpening && !sceneStale}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onMoveStart={() => {
        setMenu(null); setEdgeTip(null);
        clearTimeout(moveEndT.current); moveEndT.current = null;   // 新手势接管：撤销待决的落定
        rootRef.current?.classList.add('canvas-moving');
        rootRef.current?.classList.remove('over-drawing');          // 移动中悬停态整体静默，不许闪
      }}
      onMove={(_, vp) => {
        syncHandleHitArea(rootRef.current, vp.zoom);
      }}
      onMoveEnd={(_, vp) => {
        // onMove 已逐帧喂到位；这里只收尾状态类与视口记忆（滚轮缩放每格发一次 end，收敛到手势尾部）
        clearTimeout(moveEndT.current);
        moveEndT.current = setTimeout(() => {
          moveEndT.current = null;
          rootRef.current?.classList.remove('canvas-moving');
          try { localStorage.vp = JSON.stringify(vp); } catch { /* 隐私模式等存不进就算了 */ }
        }, 180);
      }}
      onInit={inst => {
        instRef.current = inst;
        syncHandleHitArea(rootRef.current, inst.getZoom());
      }}
      onNodeClick={onNodeClick}
      onNodeDoubleClick={onNodeDoubleClick}
      onNodeDrag={onNodeDrag}
      onNodeDragStart={onNodeDragStart}
      onNodeDragStop={onNodeDragStop}
      onPaneClick={onPaneClick}
      onPaneMouseMove={onPaneMouseMove}
      onNodeMouseMove={onNodeMouseMove}
      onNodeContextMenu={onNodeContextMenu}
      onPaneContextMenu={onPaneContextMenu}
      onEdgeContextMenu={onEdgeContextMenu}
      onEdgeClick={onEdgeClick}
      onEdgeMouseEnter={onEdgeMouseEnter}
      onEdgeMouseLeave={onEdgeMouseLeave}
      selectionOnDrag
      panOnDrag={[1]}
      panOnScroll
      panOnScrollSpeed={1}
      zoomOnScroll={false}
      zoomOnPinch
      zoomOnDoubleClick={false}
      onConnect={onConnect}
      onConnectStart={() => rootRef.current?.classList.add('connecting')}
      onConnectEnd={onConnectEnd}
      onBeforeDelete={onBeforeDelete}
      onNodesDelete={onNodesDelete}
      onEdgesDelete={onEdgesDelete}
      deleteKeyCode={['Backspace', 'Delete']}
      connectionLineStyle={{ stroke: '#7c3aed', strokeWidth: 2 }}
      connectionMode={ConnectionMode.Loose}
      connectionRadius={44}
      connectOnClick={false}   // 只认拖线；点击续连会在取消落空菜单后留下隐形状态，普通点击就误生边
      nodeDragThreshold={5}
      defaultViewport={initVp.current || { x: 60, y: 80, zoom: 0.5 }}
      minZoom={MIN_ZOOM}
      maxZoom={MAX_ZOOM}
      proOptions={{ hideAttribution: true }}
    >
      {/* committed ink 与节点共享 React Flow 的同一 viewport transform；视口手势不触发重导出。 */}
      <InkWorldLayer
        elements={world.elements}
        files={world.files}
        excludedIds={world.excludedIds}
        revision={world.revision}
        generationId={world.generationId}
        onSnapshotReady={onInkSnapshotReady}
        onSnapshotError={onInkSnapshotError}
        exporterProbe={inkExporterProbe}
        retryToken={carryRetryToken}
      />
      {draftPreview && <InkWorldLayer
        elements={draftPreview.elements}
        files={draftPreview.files}
        excludedIds={NO_DRAWING_IDS}
        revision={draftPreview.revision}
        onSnapshotReady={onDraftPreviewReady}
        onSnapshotError={onDraftPreviewError}
      />}
      {/* ===== 关系图例：四种线各是什么，一眼即懂（绘图编辑时为工具层让位） ===== */}
      {!penActive && <Panel position="bottom-center" style={{ pointerEvents: 'none' }}>
        <div className="mono" style={{
          display: 'flex', gap: 18, alignItems: 'center',
          background: 'var(--bg-panel)', border: '1px solid var(--line)',
          borderRadius: 99, padding: '6px 18px', fontSize: 11, color: 'var(--ink-dim)',
          boxShadow: 'var(--shadow)',
        }}>
          {[['#e2611f', '━ ▸', 'worktree 分支'], ['#155eef', '┄', '同族项目'], ['#12b76a', '━ ▸', '接力血缘'], ['#7c3aed', '─ ▸', '手动连线']].map(([c, glyph, label]) => (
            <span key={label} style={{ display: 'flex', gap: 6, alignItems: 'center', whiteSpace: 'nowrap' }}>
              <span style={{ color: c, fontWeight: 700 }}>{glyph}</span>{label}
            </span>
          ))}
        </div>
      </Panel>}
      {/* ===== 右键快捷菜单 ===== */}
      {menu && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 999 }}
            onClick={() => setMenu(null)} onContextMenu={e => { e.preventDefault(); setMenu(null); }} />
          <div className="ctx-menu" style={{ left: menu.x, top: menu.y }}>
            {menu.items.map((it, i) => it.sep
              ? <div key={i} className="sep" />
              : (
                <div key={i} className={`item ${it.danger ? 'danger' : ''}`}
                  onClick={() => { const pos = { x: menu.x, y: menu.y }; setMenu(null); it.fn(pos); }}>
                  {it.label}
                </div>
              ))}
          </div>
        </>
      )}
      <Background variant={BackgroundVariant.Dots} gap={26} size={1.4} color="#d0d5dd" />
      {!penActive && <Controls showInteractive={false}>
        <ControlButton onClick={cycleWheel}
          title={`${WHEEL_MODES[wheelMode].label}：${WHEEL_MODES[wheelMode].hint}（点击切换）`}>
          <Icon name={WHEEL_MODES[wheelMode].icon} />
        </ControlButton>
      </Controls>}
      {!penActive && <MiniMap
        pannable zoomable
        nodeColor={n =>
          n.type === 'note' ? '#f7e06e'
          : n.type === 'board' ? (BOARD_COLORS[n.data?.board?.color]?.fill || '#dbe7fb')
          : n.type === 'district' ? '#dbe7fb'
          : n.type === 'workspace' ? '#c9d4e8'
          : 'transparent'}
        maskColor="rgba(242, 244, 247, 0.85)"
      />}
      {/* 小地图墨迹层：缩略图是空间定向工具，区域底板是最有定向价值的地标 */}
      {!penActive && <MiniMapInk
        elements={renderedWorld?.elements}
        revision={renderedWorld?.revision}
        rootRef={rootRef}
      />}
    </ReactFlow>
    {inkStatus && (
      <div className={`ink-frame-status ${framePhase}`} role="status" aria-live="polite">
        {inkStatus}
      </div>
    )}
    {(carryView.phase === 'RETRYABLE_PAINT' || batchCarryRetryable) && (
      <button type="button" className="ink-carry-retry" onClick={() => {
        const pendingFrame = carryPendingFrameRef.current;
        if (pendingFrame?.kind === 'batch') {
          pendingFrame.failed = false;
          setBatchCarryRetryable(false);
          setCarryRetryToken(token => token + 1);
        } else {
          carryControllerRef.current?.retry();
        }
      }}>
        重试显示批注
      </button>
    )}
    {/* ===== 边悬浮说明牌 ===== */}
    {edgeTip && <div className="edge-tip" style={{ left: edgeTip.x, top: edgeTip.y }}>{edgeTip.text}</div>}
    {cameraPresentation.showShield && (
      <div className="drawing-camera-shield" data-drawing-camera-shield="true" aria-hidden="true" />
    )}
    {penActive && editSeed && (
      <Suspense fallback={null}>
        <DrawLayer
          ref={drawRef} active={penActive} visible={drawVisible}
          initialElements={editSeed.elements}
          initialFiles={editSeed.files}
          autoExitLargeNew={editSeed.kind === 'new' && !editSeed.originalIds?.length}
          onToolChange={onDrawToolChange}
          onCompositionChange={active => {
            compositionStateRef.current = drawingCompositionStep(compositionStateRef.current, {
              type: active ? 'start' : 'end',
            }).state;
          }}
          onExitToCanvas={exitToCanvas}
          onAutoExitLargeNew={autoExitLargeNewDrawing}
          onDraftChange={draft => {
            const transaction = editTransactionRef.current;
            const requestId = draftRequestRef.current;
            if (transaction && requestId) draftJournal.schedule(draft);
          }}
          onDraftLocalFlush={() => { void draftJournal.flush(); }}
          onReady={controller => {
            const openingRequest = editSeed.openingRequest;
            if (!drawingOpeningRequestCurrent(openingRequestRef.current, openingRequest)) return;
            const vp = instRef.current?.getViewport();
            alignDrawingViewport(controller, vp);
            controller.activateTool(drawToolRef.current);
            const selectId = pendingSelectRef.current;
            const selected = !selectId || controller.getElements()?.some(el => el.id === selectId);
            if (selectId && selected) controller.selectElement(selectId);
            if (!selected) {
              updateDrawVisible(false);
              setDrawOpening(false);
              setEditSeed(null);
              editTransactionRef.current = null;
              editBaseRef.current = null;
              draftJournal.deactivate(draftRequestRef.current);
              draftRequestRef.current = null;
              openingRef.current = false;
              openingRequestRef.current = null;
              openingPromiseRef.current = null;
              penActiveRef.current = false;
              pendingSelectRef.current = null;
              setPenActive(false);
              const resolveReady = openingReadyResolveRef.current;
              openingReadyResolveRef.current = null;
              resolveReady?.(false);
              toast('目标绘图刚刚发生变化，请重新选择', 'error');
              return;
            }
            draftJournal.markHydrated(draftRequestRef.current);
            const transaction = editTransactionRef.current;
            const base = editBaseRef.current;
            if (!transaction?.originalIds?.length) {
              // 新绘图从空 draft 开始，committed 世界没有洞；水合完成即可在首帧显现。
              updateDrawVisible(true);
              openingRef.current = false;
              openingRequestRef.current = null;
              setDrawOpening(false);
              openingPromiseRef.current = null;
              const resolveReady = openingReadyResolveRef.current;
              openingReadyResolveRef.current = null;
              resolveReady?.(true);
              return;
            }
            const revision = ++worldRevisionRef.current;
            worldHandoffRef.current = { phase: 'opening', revision, openingRequest };
            setWorldOverride({
              elements: base.elements, files: base.files, excludedIds: transaction.originalIds, revision,
            });
          }}
        />
      </Suspense>
    )}
    {penActive && (
      <div className="island drawing-zoom-island" aria-label="绘图视图缩放">
        <button type="button" data-drawing-zoom="out" onClick={() => navigateDrawingZoom('out')} title="缩小（⌘-）">−</button>
        <button type="button" data-drawing-zoom="in" onClick={() => navigateDrawingZoom('in')} title="放大（⌘+）">+</button>
        <button type="button" data-drawing-zoom="reset" onClick={() => navigateDrawingZoom('reset')} title="回到 100%">100%</button>
        <button type="button" data-drawing-zoom="fit" onClick={() => navigateDrawingFit(null)} title="全景归位">全景</button>
        <button type="button" data-drawing-zoom="wheel" onClick={cycleWheel}
          title={`${WHEEL_MODES[wheelMode].label}：${WHEEL_MODES[wheelMode].hint}（点击切换）`}>
          <Icon name={WHEEL_MODES[wheelMode].icon} />
        </button>
      </div>
    )}
    {/* 画布工具岛：顶部正中——绘图选择与画笔始终在场，激活后滑移让位给 Excalidraw 工具栏（.drawing-on 驱动）。
        必须是绘图层的兄弟(z:7)：React Flow 根自成层叠上下文，Panel 里的按钮会被画笔层截住 */}
    <div className="island tool-island">
      <button className="btn ghost" onClick={addNote} title="贴一张便签到视野中央（快捷键 N）"><Icon name="note" /> 便签</button>
      <button className="btn ghost" onClick={addBoard} title="创建自定义画板：拉角调大小、双击改名、工作区拖进来就归它管（快捷键 B）"><Icon name="board" /> 画板</button>
      <span className="topbar-sep" />
      <button className={`btn ${(selectArmed || (penActive && drawTool === 'selection')) ? 'primary' : 'ghost'}`} onClick={openSelectDrawing}
        title={selectArmed ? '请选择一段绘图；点空白或 Esc 返回看板' : penActive && drawTool === 'selection' ? '正在编辑绘图；再次点击或 Esc 返回看板' : '选择并精细设置已有绘图：描边、背景、透明度与图层'}>
        <Icon name="cursor" /> 选绘图
      </button>
      <button className={`btn ${penActive && drawTool === 'freedraw' ? 'primary' : 'ghost'}`} onClick={() => openDrawing('freedraw')}
        title={penActive && drawTool === 'freedraw' ? '画笔已拿起；再次点击或 Esc 返回看板' : '拿起常驻画笔；也可从原生工具栏换形状、箭头、文字和图片（快捷键 D）'}>
        <Icon name="pen" /> 画笔
      </button>
      <span className="topbar-sep" />
      <button className="btn ghost" onClick={() => focusRef.current(null)}
        title="全景归位（F）· 空白左拖框选 · 双指/空格/中键平移 · 捏合或鼠标滚轮缩放"><Icon name="fit" /> 全景</button>
    </div>
    </div>
  );
}
