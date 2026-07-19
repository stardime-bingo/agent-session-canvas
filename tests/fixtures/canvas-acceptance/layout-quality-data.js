/**
 * [INPUT]: 匿名多街区/多画板乱序几何、production FlowCanvas/SceneStore/TopBar
 * [OUTPUT]: 4518 智能整理视觉与行为夹具；真实按钮驱动后报告车道、行对齐、画板/墨迹随行、便签不动与碰撞
 * [POS]: 只在 ?mode=layout-quality 加载；不请求 API、不读取 4517/data
 * [PROTOCOL]: 变更时更新 main.jsx/verify.py/README/web/CLAUDE.md
 */
import React, { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import '@xyflow/react/dist/style.css';
import '../../../web/src/theme.css';
import FlowCanvas from '../../../web/src/canvas/FlowCanvas.jsx';
import { buildGraph, tidyLayoutEntries } from '../../../web/src/canvas/layout.js';
import { createSceneStore } from '../../../web/src/scene-store.js';
import TopBar from '../../../web/src/panels/TopBar.jsx';
import { toast, UIHost } from '../../../web/src/ui.jsx';

const h = React.createElement;
const BOARD_ID = 'layout-quality-board';
const BOARD_KEY = `board:${BOARD_ID}`;
const GROUPS = [
  { key: '产品 / 发布', slug: 'launch', count: 6, x: 80, y: 180 },
  { key: '内容 / 增长', slug: 'content', count: 5, x: 2550, y: 120 },
  { key: '工程 / 基建', slug: 'infra', count: 4, x: 520, y: 1920 },
  { key: '课程 / 交付', slug: 'course', count: 3, x: 3100, y: 1750 },
];
const WORKSPACES = [];
const SESSIONS_BY_KEY = {};
const INITIAL_LAYOUT = {};
let serial = 0;

function addWorkspace(group, index, membership = group.key) {
  const path = `/Users/fixture/${group.slug}/workspace-${index + 1}`;
  const count = [1, 5, 2, 8, 3, 6][(serial + index) % 6];
  const keys = Array.from({ length: count }, (_, sessionIndex) => `codex:layout-${serial}-${sessionIndex}`);
  const day = String(Math.max(1, 19 - serial)).padStart(2, '0');
  const lastActivity = `2026-07-${day}T0${serial % 9}:00:00.000Z`;
  for (const [sessionIndex, key] of keys.entries()) {
    SESSIONS_BY_KEY[key] = {
      key, cwd: path, tool: sessionIndex % 2 ? 'claude' : 'codex', status: sessionIndex ? 'done' : 'active',
      title: `匿名整理任务 ${serial + 1}.${sessionIndex + 1}`, updatedAt: lastActivity,
      kind: 'session', subagents: 0, runs: 1, summary: '', hasHandoff: false, gitBranch: 'main',
    };
  }
  WORKSPACES.push({
    path, name: `工作区 ${String(serial + 1).padStart(2, '0')}`, parent: null,
    tools: { codex: Math.ceil(count / 2), claude: Math.floor(count / 2) },
    lastActivity, sessionKeys: keys, visibleKeys: keys,
  });
  INITIAL_LAYOUT[path] = {
    d: membership,
    x: 34 + (index % 3) * 392 + (index % 2) * 36,
    y: 78 + Math.floor(index / 3) * 720 + (index % 3) * 125,
  };
  serial += 1;
}

for (const group of GROUPS) {
  for (let index = 0; index < group.count; index++) addWorkspace(group, index);
  INITIAL_LAYOUT[`district:${group.key}`] = { x: group.x, y: group.y, w: 1640, h: 1450 };
}
const BOARD_GROUP = { key: BOARD_KEY, slug: 'board' };
addWorkspace(BOARD_GROUP, 0, BOARD_KEY);
addWorkspace(BOARD_GROUP, 1, BOARD_KEY);

const INITIAL_BOARD = {
  id: BOARD_ID, x: 1350, y: 980, w: 1580, h: 1120,
  name: '人工项目画板', color: 'blue',
};
const INITIAL_NOTE = { id: 'note:layout-loose', x: -220, y: 3280, w: 240, h: 138, color: 'yellow', text: '便签保持手工位置' };
const INITIAL_INK = {
  id: 'layout-board-ink', type: 'rectangle', x: INITIAL_BOARD.x + 35, y: INITIAL_BOARD.y + 40,
  width: 420, height: 210, angle: 0, strokeColor: '#155eef', backgroundColor: '#dbeafe',
  fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid', roughness: 0, opacity: 45,
  roundness: { type: 3 }, seed: 4518, version: 1, versionNonce: 4518, index: null,
  isDeleted: false, groupIds: [], frameId: null, boundElements: null, updated: 1,
  link: null, locked: false, customData: { below: true },
};
const INITIAL_DOC = {
  layout: INITIAL_LAYOUT,
  edges: [],
  notes: [INITIAL_NOTE],
  boards: [INITIAL_BOARD],
  drawing: [INITIAL_INK],
  drawingFiles: {},
};
const probe = window.__LAYOUT_ACCEPTANCE__ = { ready: false, status: 'booting', report: null };
const arrangePerformance = { syncMs: null, firstPaintMs: null, longTasks: [] };
let longTaskObserver = null;
try {
  longTaskObserver = new PerformanceObserver(list => {
    if (probe.status !== 'arranging') return;
    for (const entry of list.getEntries()) arrangePerformance.longTasks.push(entry.duration);
  });
  longTaskObserver.observe({ type: 'longtask', buffered: true });
} catch { /* verifier 会明确要求受支持的 Chrome；夹具本身仍可展示。 */ }

function rectsOverlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function collectReport(doc) {
  const built = buildGraph(WORKSPACES, SESSIONS_BY_KEY, doc.layout, doc.boards, [], new Set(), false);
  const containers = built.nodes.filter(node => node.type === 'district' || node.type === 'board').map(node => ({
    id: node.id, type: node.type, x: node.position.x, y: node.position.y,
    w: node.width ?? node.data._w, h: node.height ?? node.data._h,
  }));
  const collisions = [];
  for (let left = 0; left < containers.length; left++) {
    for (let right = left + 1; right < containers.length; right++) {
      if (rectsOverlap(containers[left], containers[right])) collisions.push([containers[left].id, containers[right].id]);
    }
  }
  const workspaceNodes = built.nodes.filter(node => node.type === 'workspace');
  const rowOrder = [];
  let rowsAligned = true;
  for (const container of containers) {
    const actual = workspaceNodes
      .filter(node => node.parentId === container.id)
      .sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x)
      .map(node => node.id);
    const expected = WORKSPACES
      .filter(workspace => doc.layout[workspace.path]?.d === (container.type === 'board' ? container.id : container.id.slice(9)))
      .sort((a, b) => b.lastActivity.localeCompare(a.lastActivity) || a.path.localeCompare(b.path))
      .map(workspace => workspace.path);
    rowOrder.push({ container: container.id, actual, expected });
    if (actual.join('\n') !== expected.join('\n')) rowsAligned = false;
  }
  const minX = Math.min(...containers.map(item => item.x), INITIAL_NOTE.x);
  const minY = Math.min(...containers.map(item => item.y), INITIAL_NOTE.y);
  const maxX = Math.max(...containers.map(item => item.x + item.w), INITIAL_NOTE.x + INITIAL_NOTE.w);
  const maxY = Math.max(...containers.map(item => item.y + item.h), INITIAL_NOTE.y + INITIAL_NOTE.h);
  const board = doc.boards[0];
  const ink = doc.drawing.find(item => item.id === INITIAL_INK.id);
  const districtEntries = Object.entries(doc.layout).filter(([key]) => key.startsWith('district:'));
  const membershipsPreserved = WORKSPACES.every(workspace =>
    doc.layout[workspace.path]?.d === INITIAL_LAYOUT[workspace.path].d);
  return {
    containerCount: containers.length,
    laneCount: new Set(containers.map(item => item.x)).size,
    bounds: { width: maxX - minX, height: maxY - minY, aspect: (maxX - minX) / (maxY - minY) },
    collisions,
    rowsAligned,
    rowOrder,
    membershipsPreserved,
    districtGeometryPersisted: districtEntries.length === GROUPS.length,
    boardMoved: board.x !== INITIAL_BOARD.x || board.y !== INITIAL_BOARD.y,
    boardCompacted: board.w < INITIAL_BOARD.w && board.h < INITIAL_BOARD.h,
    boardPosition: { x: board.x, y: board.y, w: board.w, h: board.h },
    noteUnchanged: doc.notes[0].x === INITIAL_NOTE.x && doc.notes[0].y === INITIAL_NOTE.y,
    inkCarried: Math.round(ink.x - INITIAL_INK.x) === Math.round(board.x - INITIAL_BOARD.x)
      && Math.round(ink.y - INITIAL_INK.y) === Math.round(board.y - INITIAL_BOARD.y),
    performance: {
      syncMs: arrangePerformance.syncMs,
      firstPaintMs: arrangePerformance.firstPaintMs,
      longTaskSupported: Boolean(longTaskObserver),
      longTasks: [...arrangePerformance.longTasks, ...(longTaskObserver?.takeRecords() || []).map(entry => entry.duration)],
    },
  };
}

function LayoutQualityCanvas() {
  const storeRef = useRef(null);
  if (!storeRef.current) {
    storeRef.current = createSceneStore(INITIAL_DOC, {
      persistScene: async () => ({ rev: 1 }), persistFiles: async () => ({ added: 0 }),
    });
  }
  const store = storeRef.current;
  probe.snapshot = () => store.get();
  const doc = useSyncExternalStore(
    useCallback(listener => store.subscribe(listener), [store]),
    useCallback(() => store.get(), [store]),
  );
  const focusRef = useRef(() => {});
  const actionsRef = useRef({});
  const arrangedRef = useRef(false);
  const expanded = useMemo(() => new Set(), []);

  const arrange = useCallback(() => {
    const target = Object.fromEntries(tidyLayoutEntries(store.get().layout).map(({ path, ...entry }) => [path, entry]));
    longTaskObserver?.takeRecords();
    Object.assign(arrangePerformance, { syncMs: null, firstPaintMs: null, longTasks: [] });
    const started = performance.now();
    probe.status = 'arranging';
    const applied = actionsRef.current.applyArrange?.(target);
    arrangePerformance.syncMs = performance.now() - started;
    if (!applied) { probe.status = 'fail'; return; }
    requestAnimationFrame(() => requestAnimationFrame(() => {
      arrangePerformance.firstPaintMs = performance.now() - started;
    }));
    arrangedRef.current = true;
    toast('已按活跃度整理街区与画板', 'ok', { label: '撤销', onClick: () => store.undo() });
    setTimeout(() => focusRef.current(null), 40);
  }, [store]);

  useEffect(() => {
    const readyTimer = setInterval(() => {
      if (!actionsRef.current.applyArrange) return;
      clearInterval(readyTimer);
      probe.ready = true;
      probe.status = 'idle';
    }, 20);
    return () => clearInterval(readyTimer);
  }, []);

  useEffect(() => {
    if (!arrangedRef.current) return undefined;
    const timer = setTimeout(() => {
      const report = collectReport(store.get());
      const pass = report.collisions.length === 0 && report.rowsAligned && report.membershipsPreserved
        && report.districtGeometryPersisted && report.boardMoved && report.boardCompacted
        && report.noteUnchanged && report.inkCarried && report.laneCount >= 2 && report.laneCount <= 4
        && report.bounds.aspect >= 1.2 && report.bounds.aspect <= 2.2
        && report.performance.syncMs <= 50 && report.performance.firstPaintMs <= 100
        && report.performance.longTaskSupported && report.performance.longTasks.filter(duration => duration >= 50).length === 0;
      probe.report = { ...report, pass };
      probe.status = pass ? 'complete' : 'fail';
      document.documentElement.dataset.layoutQualityStatus = pass ? 'pass' : 'fail';
    }, 760);
    return () => clearTimeout(timer);
  }, [doc.seq, store]);

  const onMoveNode = useCallback(entries => store.mutate(current => {
    const layout = { ...current.layout };
    for (const entry of entries || []) layout[entry.path] = { ...layout[entry.path], ...entry };
    return { ...current, layout };
  }), [store]);

  return h('div', { 'data-layout-quality': 'true', style: { position: 'fixed', inset: 0 } },
    h(FlowCanvas, {
      workspaces: WORKSPACES, sessionsByKey: SESSIONS_BY_KEY, edges: [], layout: doc.layout,
      canvas: doc, store, onMoveNode, onCanvasAction: () => true,
      onRenameSession: () => {}, onRenameWs: () => {}, selectedKey: null, onSelect: () => {},
      onChanged: () => {}, onArrange: arrange, focusRef, actionsRef, expanded, searching: false,
      onToggleExpand: () => {},
    }),
    h(UIHost),
    h('div', { className: 'island', style: {
      position: 'fixed', left: 18, top: 16, zIndex: 20, padding: '10px 14px', pointerEvents: 'none',
    } }, h('strong', null, '匿名整理场景'), h('small', { style: { marginLeft: 10, color: '#667085' } }, '多街区 · 画板 · 不等高工作区')),
    h('div', { style: { position: 'fixed', right: 18, top: 16, zIndex: 20 } },
      h(TopBar, { syncStatus: 'saved', pending: false, onArrange: arrange, onRescan: () => {}, onRefresh: () => {} })),
  );
}

export function mountLayoutQualityFixture(target) {
  localStorage.setItem('vp', JSON.stringify({ x: 70, y: 90, zoom: 0.18 }));
  createRoot(target).render(h(LayoutQualityCanvas));
}
