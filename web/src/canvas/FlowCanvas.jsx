/**
 * [INPUT]: 依赖 @xyflow/react、scene-store 真相源、drawing-session/drawing-camera 两钩子、layout 纯布局内核、
 *          五种自定义节点、menus 菜单构建器、connections 连接点内核、container-carry 承载规划与 DOM 桥
 * [OUTPUT]: 对外提供 FlowCanvas 组件：统一容器模型、弹性生长、拖放改归属、三系统边+手动边、
 *           Figma 式框选/平移/触控板手势、滚轮双模、容器缩放定桩、落空连线选择、缩放感知连接点、
 *           原生绘图选择/画笔（连续合并进 store）、committed ink 与节点共用唯一相机、
 *           容器承载=乐观拖动+一次 mutate+帧追上撤桥、整理 applyArrange 同理、普通模式绘图命中与删除治理
 * [POS]: canvas 的画布引擎总装。一切写动作同步进 store；渲染（InkWorld 帧）永远只是订阅者，不是闸门
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import React, { useMemo, useCallback, useRef, useEffect, useLayoutEffect, useState, lazy, Suspense } from 'react';
import { ReactFlow, useNodesState, useEdgesState, Controls, ControlButton, MiniMap, Background, BackgroundVariant, Panel, MarkerType, ConnectionMode, getViewportForBounds } from '@xyflow/react';
import WorkspaceNode from './WorkspaceNode.jsx';
import SessionNode from './SessionNode.jsx';
import DistrictNode from './DistrictNode.jsx';
import BoardNode, { BOARD_COLORS } from './BoardNode.jsx';
import NoteNode from './NoteNode.jsx';
import { buildGraph, COL_W, PAD, resizedContainerChildren } from './layout.js';
import { sessionMenu, workspaceMenu, districtMenu, boardMenu, noteMenu, paneMenu, edgeMenu, deleteBoardFlow, deleteNoteFlow } from './menus.jsx';
import { connectionDrop, syncHandleHitArea } from './connections.js';
import {
  committedDrawingElements, deleteDrawingElement, DRAWING_HIT_BLOCK, drawingCameraPresentation,
  drawingFrameHitElements, drawingFrameTruthStep, drawingTransactionVisibleElements,
  hitDrawingElement, setDrawingElementPlane,
} from './drawing.js';
import { useDrawingSession } from './drawing-session.jsx';
import { useDrawingCamera } from './drawing-camera.jsx';
import InkWorldLayer from './InkWorldLayer.jsx';
import MiniMapInk from './MiniMapInk.jsx';
import { createBatchCarryBridge, createInkDragBridge, planBatchCarry } from './container-carry.js';
import { applyBatchCarry, applyCarry, computeAnchorIds } from '../../../shared/canvas-carry.mjs';
import { WHEEL_MODES } from './gestures.js';
import { Icon, toast, confirmPop } from '../ui.jsx';

// Excalidraw 体量大（~1MB gz 半壁江山），懒加载拆包：无笔迹且未拿起画笔时根本不挂载
const DrawLayer = lazy(() => import('./DrawLayer.jsx'));

const nodeTypes = { workspace: WorkspaceNode, session: SessionNode, district: DistrictNode, board: BoardNode, note: NoteNode };

const MIN_ZOOM = 0.1, MAX_ZOOM = 1.8;   // 缩放界限唯一真相：RF props 与滚轮内核共用
const NO_DRAWING_IDS = Object.freeze([]);
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
// 箭头语义：有方向的关系（分支/接力/手动）带箭头，亲缘无先后不带
const EDGE_META = {
  worktree: { color: '#e2611f', arrow: true },
  family: { color: '#155eef', arrow: false },
  handoff: { color: '#12b76a', arrow: true },
  manual: { color: '#7c3aed', arrow: true },
};

export default function FlowCanvas({ workspaces, sessionsByKey, edges, layout, canvas, store, onMoveNode, onCanvasAction, onRenameSession, onRenameWs, selectedKey, onSelect, onChanged, onArrange, focusRef, actionsRef, expanded, searching, onToggleExpand, frameTestProbeRef, inkExporterProbe }) {
  const instRef = useRef(null);
  const rootRef = useRef(null);
  const drawRef = useRef(null);
  const [menu, setMenu] = useState(null);           // 右键快捷菜单 {x, y, items}
  const [edgeTip, setEdgeTip] = useState(null);     // 边悬浮说明牌 {x, y, text}
  const [renaming, setRenaming] = useState({ id: null, n: 0 });   // 就地改名信号（nonce 驱动）
  const [inkFrame, setInkFrame] = useState();
  const clearSelectionRef = useRef(() => {});
  const dropHiRef = useRef(null);                   // 拖动中的投放目标高亮
  const dragBridgeRef = useRef(null);               // 拖动期墨迹跟随桥
  const batchBridgeRef = useRef(null);              // 整理多 delta 桥
  const bridgeSeqRef = useRef(null);                // 桥的目标 seq：帧追上即撤
  const carryRef = useRef(null);                    // { nodeId, x, y, anchorIds }
  const dragStartRef = useRef(new Map());

  // ---- 绘图会话与相机 ----
  const beforeExitRef = useRef(() => {});
  const session = useDrawingSession({
    store, drawRef,
    getRenderedWorld: () => inkFrameRef.current?.renderedWorld || null,
    onBeforeExit: () => beforeExitRef.current(),
  });
  const {
    penActive, penActiveRef, drawVisible, drawTool, drawToolRef, selectArmed, selectArmedRef,
    editSeed, excludedIds, sessionPhaseRef, openDrawing, exitDrawing, togglePen, armSelect,
  } = session;
  const inkFrameRef = useRef(null);
  inkFrameRef.current = inkFrame;

  const built = useMemo(
    () => buildGraph(workspaces, sessionsByKey, layout, canvas.boards, edges, expanded, searching),
    [workspaces, sessionsByKey, layout, canvas.boards, edges, expanded, searching],
  );

  const getFitViewport = useCallback(path => {
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

  const camera = useDrawingCamera({
    instRef, rootRef, drawRef, penActiveRef, sessionPhaseRef, drawToolRef,
    setEditorVisible: session.setVisible, getFitViewport, minZoom: MIN_ZOOM, maxZoom: MAX_ZOOM,
  });
  beforeExitRef.current = camera.prepareExit;

  // ---- committed ink 世界：真相就是 store 文档，revision 就是 seq，没有第二套主权 ----
  const world = {
    elements: canvas.drawing, files: canvas.drawingFiles,
    excludedIds, revision: canvas.seq,
  };
  useEffect(() => {
    setInkFrame(current => drawingFrameTruthStep(current, { type: 'request', revision: world.revision }));
  }, [world.revision]);

  const clearBridgesIfCaughtUp = useCallback(renderedWorld => {
    if (bridgeSeqRef.current === null || renderedWorld.revision < bridgeSeqRef.current) return;
    bridgeSeqRef.current = null;
    dragBridgeRef.current?.clear();
    batchBridgeRef.current?.clear();
  }, []);

  const onInkSnapshotReady = useCallback((revision, metrics, renderedWorld) => {
    if (!renderedWorld) return;
    setInkFrame(current => {
      const requested = current?.requestedRevision === revision
        ? current
        : drawingFrameTruthStep(current, { type: 'request', revision });
      return drawingFrameTruthStep(requested, {
        type: 'ready', revision, world: renderedWorld, attempt: metrics?.attempt,
      });
    });
    clearBridgesIfCaughtUp(renderedWorld);
    session.onWorldFrame(renderedWorld);
  }, [clearBridgesIfCaughtUp, session.onWorldFrame]);   // eslint-disable-line react-hooks/exhaustive-deps

  const onInkSnapshotError = useCallback((revision, error, result = {}) => {
    setInkFrame(current => {
      const requested = current?.requestedRevision === revision
        ? current
        : drawingFrameTruthStep(current, { type: 'request', revision });
      return drawingFrameTruthStep(requested, {
        type: 'error', revision, error, attempt: result.attempt, willRetry: !!result.willRetry,
      });
    });
  }, []);

  const renderedWorld = inkFrame?.renderedWorld || null;
  const requestedHasInk = drawingTransactionVisibleElements(world.elements || [], world.excludedIds).length > 0;
  const framePhase = inkFrame?.requestedRevision === world.revision
    ? inkFrame.phase
    : (renderedWorld ? 'updating' : 'cold');
  const inkStatus = !penActive && (
    framePhase === 'retrying'
      ? (renderedWorld ? '绘图更新失败，正在重试…' : '绘图载入失败，正在重试…')
      : framePhase === 'stale' ? '绘图暂时显示上一帧·自动重试中'
        : framePhase === 'failed' ? '绘图暂未显现·自动重试中'
          : framePhase === 'cold' && requestedHasInk ? '绘图正在显现…'
            : null
  );
  const cameraPresentation = drawingCameraPresentation({
    active: penActive, visible: drawVisible, hasPreview: !!camera.draftPreview,
  });

  // ---- 绘图直改：同步 mutate，回执即真相（磁盘由 store 后台追认）----
  const mutateDrawing = useCallback((fn, options) => {
    store.mutate(doc => {
      const drawing = fn(doc.drawing);
      return drawing === doc.drawing ? doc : { ...doc, drawing };
    }, options);
  }, [store]);

  // ============================================================
  //  普通模式的绘图命中：pane 与容器空白面都是"画布空地"，视觉最上层者赢
  // ============================================================
  const hitDrawingAt = (fx, fy, planes = 'above') => {
    const els = penActiveRef.current
      ? (drawRef.current?.getElements?.() || [])
      : (inkFrame?.renderedWorld?.elements || []);
    const tol = 8 / (instRef.current?.getZoom() || 1);
    const hitOptions = { includeHollowInterior: selectArmedRef.current };
    const above = hitDrawingElement(els.filter(el => !el.customData?.below), fx, fy, tol, hitOptions);
    if (above || planes === 'above') return above;
    return hitDrawingElement(els.filter(el => el.customData?.below), fx, fy, tol, hitOptions);
  };

  const drawingHitFromEvent = (e, planes) => {
    if (penActiveRef.current) return null;
    if (e.target?.closest?.(DRAWING_HIT_BLOCK)) return null;
    const p = instRef.current?.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    return p ? hitDrawingAt(p.x, p.y, planes) : null;
  };

  const enterDrawingSelection = hit => {
    session.disarmSelect();
    openDrawing('selection', hit.id)
      .then(opened => { if (opened) toast('已选中绘图——Delete 删除，Esc 返回看板'); })
      .catch(err => toast(`打开绘图失败：${err.message}`, 'error'));
  };

  const drawingMenuItems = hit => [
    // 层级主权：区域底板沉到卡片下面当背景（不再挡点击），批注浮到上面
    { label: hit.customData?.below
        ? <><Icon name="up" /> 浮到卡片上面</>
        : <><Icon name="down" /> 沉到卡片下面</>,
      fn: () => {
        mutateDrawing(els => setDrawingElementPlane(els, hit.id, !hit.customData?.below));
        toast(hit.customData?.below ? '已浮到卡片上面' : '已沉为背景底板——不再遮挡卡片点击', 'ok');
      } },
    { label: <><Icon name="cursor" /> 选中编辑此绘图</>, fn: () => openDrawing('selection', hit.id) },
    { label: <><Icon name="trash" /> 删除此绘图</>, danger: true, fn: async mpos => {
      const ok = await confirmPop({
        x: mpos?.x, y: mpos?.y, danger: true, yesLabel: '删除',
        text: '删除这段绘图？', detail: '仅删除这一个绘图元素，画布其余笔迹不受影响。',
      });
      if (ok) {
        mutateDrawing(els => deleteDrawingElement(els, hit.id));
        toast('绘图已删除', 'ok', { label: '撤销', onClick: () => store.undo() });
      }
    } },
    { sep: true },
  ];

  // ---- 悬停绘图描边带 → 指针光标（rAF 节流）；移动中整体静默 ----
  const overDrawRaf = useRef(0);
  const moveEndT = useRef(null);
  useEffect(() => () => clearTimeout(moveEndT.current), []);
  const onPaneMouseMove = useCallback(e => {
    if (penActiveRef.current) return;
    if (rootRef.current?.classList.contains('canvas-moving')) return;
    const { clientX, clientY } = e;
    const blocked = !!e.target?.closest?.(DRAWING_HIT_BLOCK);
    const planes = e.target?.classList?.contains('react-flow__pane') ? 'all' : 'above';
    cancelAnimationFrame(overDrawRaf.current);
    overDrawRaf.current = requestAnimationFrame(() => {
      const p = blocked ? null : instRef.current?.screenToFlowPosition({ x: clientX, y: clientY });
      rootRef.current?.classList.toggle('over-drawing', !!(p && hitDrawingAt(p.x, p.y, planes)));
    });
  }, [inkFrame]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => cancelAnimationFrame(overDrawRaf.current), []);
  const onNodeMouseMove = useCallback(e => onPaneMouseMove(e), [onPaneMouseMove]);

  const onPaneClick = useCallback(e => {
    const hit = drawingHitFromEvent(e, 'all');   // 纯空地：浮层批注优先，其次沉层底板
    if (hit) return enterDrawingSelection(hit);
    session.disarmSelect();
    onSelect(null);
    setMenu(null);
  }, [onSelect, openDrawing, inkFrame]);   // eslint-disable-line react-hooks/exhaustive-deps

  // ============================================================
  //  节点装配：便签自由漂浮；选中态交 React Flow 原生管理
  // ============================================================
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
    ...canvas.notes.map(n => ({
      id: n.id, type: 'note', position: { x: n.x, y: n.y },
      width: n.w || 232, height: n.h || 128,
      data: {
        note: n,
        onSetNote: note => onCanvasAction('setNote', note),
        onDelNote: (note, pos) => deleteNoteFlow(note, pos, onCanvasAction),
      },
      draggable: true, selectable: true, deletable: true, zIndex: 10,
    })),
  ], [built, canvas.notes, onCanvasAction, onRenameSession, onRenameWs, onToggleExpand, renaming, onMoveNode]);

  const [nodes, setNodes, onNodesChange] = useNodesState(allNodes);
  // 图数据重建必须在浏览器绘制前接管，且保留 RF 原生选中态——useEffect 会闪一帧旧图
  useLayoutEffect(() => {
    setNodes(current => {
      const selected = new Set(current.filter(n => n.selected).map(n => n.id));
      return allNodes.map(n => selected.has(n.id) ? { ...n, selected: true } : n);
    });
  }, [allNodes, setNodes]);

  const flowEdges = useMemo(() => {
    const ids = new Set(allNodes.map(n => n.id));
    return [
      ...edges.map(e => ({ id: `${e.type}:${e.from}→${e.to}`, from: e.from, to: e.to, type: e.type })),
      ...canvas.edges.map(e => ({ id: e.id, from: e.from, to: e.to, type: 'manual' })),
    ]
      .filter(e => ids.has(e.from) && ids.has(e.to))
      .map(e => {
        const m = EDGE_META[e.type];
        return {
          id: e.id, source: e.from, target: e.to, className: e.type, type: 'default',
          interactionWidth: 16,
          // 删除主权：只有手动边可选可删，系统边由地形推断、只可观察
          selectable: e.type === 'manual', deletable: e.type === 'manual', focusable: e.type === 'manual',
          pathOptions: { curvature: 0.35 },
          ...(m.arrow ? { markerEnd: { type: MarkerType.ArrowClosed, color: m.color, width: 16, height: 16 } } : {}),
        };
      });
  }, [edges, canvas.edges, allNodes]);

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
  //  删除治理：Backspace/Delete 只对便签/画板/手动边生效
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

  // ---- 拉线落空 = 在松手处选择去处；会话卡首选就地打开上下文终端框 ----
  const onConnectEnd = useCallback((event, connectionState) => {
    rootRef.current?.classList.remove('connecting');
    const drop = connectionDrop(event, connectionState);
    if (!drop) return;
    const { x, y, from } = drop;
    const pos = instRef.current.screenToFlowPosition({ x, y });
    const items = [
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

  const menuCtx = () => ({
    onSelect, onChanged, onCanvasAction,
    rename: id => setRenaming(r => ({ id, n: r.n + 1 })),
    focusWs: path => focusRef.current(path),
    focusDistrict,
    fit: () => focusRef.current(null),
    arrange: () => onArrange?.(),
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
  }, [onSelect, onChanged, onCanvasAction, onArrange, focusDistrict, openDrawing, inkFrame]);   // eslint-disable-line react-hooks/exhaustive-deps

  const onPaneContextMenu = useCallback(e => {
    const pos = instRef.current.screenToFlowPosition({ x: e.clientX, y: e.clientY });
    const at = { x: Math.round(pos.x), y: Math.round(pos.y) };
    const hit = drawingHitFromEvent(e, 'all');
    openMenu(e, [...(hit ? drawingMenuItems(hit) : []), ...paneMenu(at, menuCtx())]);
  }, [onCanvasAction, onArrange, openDrawing, inkFrame]);   // eslint-disable-line react-hooks/exhaustive-deps

  const onEdgeContextMenu = useCallback((e, edge) => {
    e.preventDefault();
    if (edge.className === 'manual') openMenu(e, edgeMenu(edge, { onCanvasAction }));
    else toast(edgeText(edge));   // 系统边：右键也给解释，绝不弹浏览器原生菜单
  }, [onCanvasAction, edgeText]);

  // ============================================================
  //  容器承载：拖动乐观进行（墨迹 DOM 桥跟随），松手一次 mutate，帧追上撤桥
  // ============================================================
  const aliveDrawing = () => committedDrawingElements(store.get().drawing);

  const onNodeDragStart = useCallback((_, node) => {
    if (node.type !== 'district' && node.type !== 'board') return;
    const containers = (instRef.current?.getNodes() || [])
      .filter(c => c.type === 'district' || c.type === 'board')
      .map(c => ({ id: c.id, x: c.position.x, y: c.position.y, w: c.width ?? c.data._w, h: c.height ?? c.data._h }));
    const anchorIds = computeAnchorIds(aliveDrawing(), containers).get(node.id) || [];
    carryRef.current = { nodeId: node.id, x: node.position.x, y: node.position.y, anchorIds };
    dragStartRef.current.set(node.id, { x: node.position.x, y: node.position.y });
    if (anchorIds.length) {
      dragBridgeRef.current ||= createInkDragBridge(rootRef.current);
      dragBridgeRef.current.mark(anchorIds);
    }
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  const onNodeDrag = useCallback((_, node) => {
    const carry = carryRef.current;
    if (carry?.nodeId === node.id && carry.anchorIds.length) {
      dragBridgeRef.current?.move(node.position.x - carry.x, node.position.y - carry.y);
    }
    if (node.type !== 'workspace') return;
    const { oldParent, hit } = hitContainer(node, instRef.current?.getNodes() || []);
    setDropHi(hit && oldParent && hit.id !== oldParent.id ? hit.id : null);
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  const setDropHi = useCallback(id => {
    if (dropHiRef.current === id) return;
    if (dropHiRef.current) document.querySelector(`[data-id="${CSS.escape(dropHiRef.current)}"]`)?.classList.remove('rf-drop-target');
    if (id) document.querySelector(`[data-id="${CSS.escape(id)}"]`)?.classList.add('rf-drop-target');
    dropHiRef.current = id;
  }, []);

  const onNodeDragStop = useCallback((_, node) => {
    setDropHi(null);
    const all = instRef.current?.getNodes() || [];
    if (node.type === 'workspace') {
      const { oldParent, hit, abs } = hitContainer(node, all);
      if (!oldParent) return;   // 拖动瞬间容器被删——弃子保平安
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
      return;
    }
    if (node.type === 'district' || node.type === 'board') {
      const carry = carryRef.current;
      carryRef.current = null;
      dragStartRef.current.delete(node.id);
      if (!carry || carry.nodeId !== node.id) return;
      const dx = node.position.x - carry.x;
      const dy = node.position.y - carry.y;
      if (!dx && !dy) { dragBridgeRef.current?.clear(); return; }
      store.mutate(doc => {
        const next = { ...doc };
        if (node.type === 'board') {
          const rawId = node.id.slice(6);
          next.boards = doc.boards.map(b => String(b.id) === rawId
            ? { ...b, x: Math.round(node.position.x), y: Math.round(node.position.y) } : b);
        } else {
          next.layout = {
            ...doc.layout,
            [node.id]: { ...(doc.layout[node.id] || {}), x: Math.round(node.position.x), y: Math.round(node.position.y) },
          };
        }
        if (carry.anchorIds.length) next.drawing = applyCarry(doc.drawing, carry.anchorIds, dx, dy);
        return next;
      });
      // 桥保持偏移直到含平移的世界帧进 DOM，撤桥瞬间静态图恰好接位，肉眼无缝
      if (carry.anchorIds.length) bridgeSeqRef.current = store.get().seq;
      else dragBridgeRef.current?.clear();
      return;
    }
    if (node.type === 'note') {
      onCanvasAction('setNote', { id: node.id, x: Math.round(node.position.x), y: Math.round(node.position.y) });
    }
  }, [onMoveNode, onCanvasAction, setDropHi, store]);

  // Escape 取消进行中的容器拖拽：节点弹回原位、桥撤销
  useEffect(() => {
    const onKeyDown = event => {
      if (event.key !== 'Escape') return;
      const carry = carryRef.current;
      if (!carry) return;
      const start = dragStartRef.current.get(carry.nodeId);
      carryRef.current = null;
      dragStartRef.current.delete(carry.nodeId);
      dragBridgeRef.current?.clear();
      if (start) {
        setNodes(current => current.map(n => n.id === carry.nodeId
          ? { ...n, position: { x: start.x, y: start.y } } : n));
      }
      event.preventDefault();
      event.stopPropagation();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [setNodes]);

  // ---- 整理：before/after 同步规划，一次 mutate（layout+drawing），桥补帧差 ----
  const applyArrange = useCallback(targetLayout => {
    const before = instRef.current?.getNodes() || built.nodes;
    const after = buildGraph(workspaces, sessionsByKey, targetLayout, canvas.boards, edges, expanded, searching);
    const moves = planBatchCarry(before, after.nodes, aliveDrawing());
    if (moves.some(m => m.anchorIds.length)) {
      batchBridgeRef.current ||= createBatchCarryBridge(rootRef.current);
      batchBridgeRef.current.present(moves);
    }
    store.mutate(doc => ({
      ...doc,
      layout: targetLayout,
      drawing: applyBatchCarry(doc.drawing, moves),
    }));
    bridgeSeqRef.current = store.get().seq;
    return true;
  }, [built, workspaces, sessionsByKey, canvas.boards, edges, expanded, searching, store]);   // eslint-disable-line react-hooks/exhaustive-deps

  // ---- 就地改名信号、焦点与动作出口 ----
  const clearSelection = useCallback(() => {
    setNodes(ns => ns.some(n => n.selected) ? ns.map(n => n.selected ? { ...n, selected: false } : n) : ns);
    setRfEdges(es => es.some(e => e.selected) ? es.map(e => e.selected ? { ...e, selected: false } : e) : es);
  }, [setNodes, setRfEdges]);
  clearSelectionRef.current = clearSelection;
  useEffect(() => { if (!selectedKey) clearSelection(); }, [selectedKey, clearSelection]);

  useEffect(() => {
    focusRef.current = path => {
      const inst = instRef.current;
      if (!inst) return;
      if (penActiveRef.current) return camera.navigateDrawingFit(path);
      if (!path) return inst.fitView({ padding: 0.1, duration: 700, maxZoom: 0.8 });
      const p = built.positions[path];
      if (p) inst.setCenter(p.x + p.w / 2, p.y + Math.min(p.h / 2, 280), { zoom: 0.9, duration: 650 });
    };
    if (actionsRef) actionsRef.current = {
      addNote, addBoard, fit: () => focusRef.current(null), toggleDraw: togglePen, clearSelection,
      applyArrange,
      prepareGeometry: async () => penActiveRef.current ? exitDrawing() : true,
    };
  }, [built, focusRef, actionsRef, addNote, addBoard, togglePen, clearSelection, applyArrange, exitDrawing, camera.navigateDrawingFit]);   // eslint-disable-line react-hooks/exhaustive-deps

  const onNodeClick = useCallback((e, node) => {
    const hit = drawingHitFromEvent(e);   // 视觉最上层者赢：描边带上的点击优先归绘图，空心区照常穿透
    if (hit) return enterDrawingSelection(hit);
    session.disarmSelect();
    if (node.type === 'session') onSelect(node.id);
  }, [onSelect, openDrawing, inkFrame]);   // eslint-disable-line react-hooks/exhaustive-deps

  const onNodeDoubleClick = useCallback((_, node) => {
    if (node.type === 'session' || node.type === 'board' || node.type === 'workspace') {
      setRenaming(r => ({ id: node.id, n: r.n + 1 }));
    }
  }, []);

  // Esc：待选态先解除；Excalidraw 文字编辑中的 Esc 归它自己；其余退出绘图
  useEffect(() => {
    if (!penActive && !selectArmed) return;
    const onKey = e => {
      if (e.key !== 'Escape') return;
      if (selectArmedRef.current && !penActiveRef.current) {
        session.disarmSelect();
        return;
      }
      const t = e.target;
      if (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable) return;
      void exitDrawing();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [penActive, selectArmed, exitDrawing]);   // eslint-disable-line react-hooks/exhaustive-deps

  // Esc 分层：菜单在 capture 阶段拦截并阻断传播——面板与选中不许连坐
  useEffect(() => {
    if (!menu) return;
    const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); setMenu(null); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [menu]);

  // 退出绘图后相机归位（清预览/时钟/指针）
  useEffect(() => {
    if (!penActive) camera.resetCamera(false);
  }, [penActive]);   // eslint-disable-line react-hooks/exhaustive-deps

  // ---- 4518 夹具探针：只读快照 + 真实 open/exit 动作 seam ----
  useLayoutEffect(() => {
    if (!frameTestProbeRef) return undefined;
    const probe = {
      snapshot: () => ({
        requestedRevision: world.revision,
        renderedRevision: inkFrame?.renderedWorld?.revision ?? null,
        renderedElementIds: (inkFrame?.renderedWorld?.elements || []).map(el => el.id),
        framePhase: inkFrame?.phase || 'idle',
        frameAttempt: inkFrame?.attempt || 0,
        penActive: penActiveRef.current,
        drawVisible: session.drawVisibleRef.current,
        sessionPhase: sessionPhaseRef.current,
        excludedIds: [...excludedIds],
        docSeq: store.get().seq,
      }),
      openDrawing: (tool, selectId) => openDrawing(tool, selectId),
      exitDrawing: () => exitDrawing(),
      mutateDrawing: fn => mutateDrawing(fn),
    };
    frameTestProbeRef.current = probe;
    return () => {
      if (frameTestProbeRef.current === probe) frameTestProbeRef.current = null;
    };
  }, [frameTestProbeRef, inkFrame, world.revision, excludedIds, openDrawing, exitDrawing, mutateDrawing]);   // eslint-disable-line react-hooks/exhaustive-deps

  // 视口记忆：刷新回到上次看的地方，不再被甩回原点
  const initVp = useRef(undefined);
  if (initVp.current === undefined) {
    try { initVp.current = JSON.parse(localStorage.vp); } catch { initVp.current = null; }
  }

  return (
    <div ref={rootRef} onPointerDownCapture={camera.onCameraPointerDown}
      data-rendered-revision={renderedWorld?.revision ?? ''}
      data-requested-revision={world.revision}
      className={`canvas-root${penActive ? ' drawing-on' : ''}${selectArmed ? ' drawing-armed' : ''}`} style={{ position: 'relative', width: '100%', height: '100%' }}>
    <ReactFlow
      nodes={nodes}
      edges={rfEdges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onMoveStart={() => {
        setMenu(null); setEdgeTip(null);
        clearTimeout(moveEndT.current); moveEndT.current = null;
        rootRef.current?.classList.add('canvas-moving');
        rootRef.current?.classList.remove('over-drawing');
      }}
      onMove={(_, vp) => {
        syncHandleHitArea(rootRef.current, vp.zoom);
      }}
      onMoveEnd={(_, vp) => {
        clearTimeout(moveEndT.current);
        moveEndT.current = setTimeout(() => {
          moveEndT.current = null;
          rootRef.current?.classList.remove('canvas-moving');
          try { localStorage.vp = JSON.stringify(vp); } catch { /* 隐私模式存不进就算了 */ }
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
      connectOnClick={false}
      connectionMode={ConnectionMode.Loose}
      connectionRadius={44}
      onBeforeDelete={onBeforeDelete}
      onNodesDelete={onNodesDelete}
      onEdgesDelete={onEdgesDelete}
      deleteKeyCode={penActive ? null : ['Backspace', 'Delete']}
      minZoom={MIN_ZOOM}
      maxZoom={MAX_ZOOM}
      defaultViewport={initVp.current || { x: 60, y: 80, zoom: 0.5 }}
      proOptions={{ hideAttribution: true }}
    >
      {/* committed ink 与节点共享 React Flow 的同一 viewport transform；视口手势不触发重导出 */}
      <InkWorldLayer
        elements={world.elements}
        files={world.files}
        excludedIds={world.excludedIds}
        revision={world.revision}
        onSnapshotReady={onInkSnapshotReady}
        onSnapshotError={onInkSnapshotError}
        exporterProbe={inkExporterProbe}
      />
      {camera.draftPreview && <InkWorldLayer
        elements={camera.draftPreview.elements}
        files={camera.draftPreview.files}
        excludedIds={NO_DRAWING_IDS}
        revision={camera.draftPreview.revision}
        onSnapshotReady={camera.onDraftPreviewReady}
        onSnapshotError={camera.onDraftPreviewError}
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
        <ControlButton onClick={camera.cycleWheel}
          title={`${WHEEL_MODES[camera.wheelMode].label}：${WHEEL_MODES[camera.wheelMode].hint}（点击切换）`}>
          <Icon name={WHEEL_MODES[camera.wheelMode].icon} />
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
          autoExitLargeNew={editSeed.kind === 'new'}
          onToolChange={session.onToolChange}
          onCompositionChange={active => {
            camera.onCompositionEvent(active);
            session.onCompositionChange(active);
          }}
          onExitToCanvas={session.exitToCanvas}
          onAutoExitLargeNew={() => void exitDrawing()}
          onDraftChange={session.onDraftChange}
          onReady={session.onEditorReady}
        />
      </Suspense>
    )}
    {penActive && (
      <div className="island drawing-zoom-island" aria-label="绘图视图缩放">
        <button type="button" data-drawing-zoom="out" onClick={() => camera.navigateDrawingZoom('out')} title="缩小（⌘-）">−</button>
        <button type="button" data-drawing-zoom="in" onClick={() => camera.navigateDrawingZoom('in')} title="放大（⌘+）">+</button>
        <button type="button" data-drawing-zoom="reset" onClick={() => camera.navigateDrawingZoom('reset')} title="回到 100%">100%</button>
        <button type="button" data-drawing-zoom="fit" onClick={() => camera.navigateDrawingFit(null)} title="全景归位">全景</button>
        <button type="button" data-drawing-zoom="wheel" onClick={camera.cycleWheel}
          title={`${WHEEL_MODES[camera.wheelMode].label}：${WHEEL_MODES[camera.wheelMode].hint}（点击切换）`}>
          <Icon name={WHEEL_MODES[camera.wheelMode].icon} />
        </button>
      </div>
    )}
    {/* 画布工具岛：顶部正中——必须是绘图层的兄弟(z:7)：RF 根自成层叠上下文 */}
    <div className="island tool-island">
      <button className="btn ghost" onClick={addNote} title="贴一张便签到视野中央（快捷键 N）"><Icon name="note" /> 便签</button>
      <button className="btn ghost" onClick={addBoard} title="创建自定义画板：拉角调大小、双击改名、工作区拖进来就归它管（快捷键 B）"><Icon name="board" /> 画板</button>
      <span className="topbar-sep" />
      <button className={`btn ${(selectArmed || (penActive && drawTool === 'selection')) ? 'primary' : 'ghost'}`}
        onClick={() => armSelect(drawingFrameHitElements(inkFrame).length > 0)}
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
