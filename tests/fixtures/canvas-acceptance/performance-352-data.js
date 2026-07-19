/**
 * [INPUT]: 352 节点确定性匿名数据、真实 FlowCanvas/SceneStore、浏览器 held pointer
 * [OUTPUT]: production FlowCanvas 性能页；为街区/工作区/便签暴露 rAF 帧间隔、Long Task、拖动位移与诊断探针
 * [POS]: 仅由 4518 ?mode=performance-352 加载；不请求 API、不读写真实 data、不复制生产画布
 * [PROTOCOL]: 变更时更新此头部，然后检查 main.jsx/verify.py/README/web/CLAUDE.md
 */
import React, { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import '@xyflow/react/dist/style.css';
import '../../../web/src/theme.css';
import FlowCanvas from '../../../web/src/canvas/FlowCanvas.jsx';
import { createSceneStore } from '../../../web/src/scene-store.js';
import { UIHost } from '../../../web/src/ui.jsx';
import {
  createFlowPerformanceFixture,
  FLOW_PERFORMANCE_NODE_COUNT,
  FLOW_PERFORMANCE_NOTE_ID,
  FLOW_PERFORMANCE_WORKSPACE,
} from './fixture-data.js';

const h = React.createElement;
const FIXTURE = createFlowPerformanceFixture();
const DISTRICT_KEY = 'fixture / Perf352';
const INITIAL_DOC = {
  layout: {
    [FLOW_PERFORMANCE_WORKSPACE]: { d: DISTRICT_KEY, x: 26, y: 62 },
    [`district:${DISTRICT_KEY}`]: { x: 0, y: 0 },
  },
  edges: [],
  notes: [{
    id: FLOW_PERFORMANCE_NOTE_ID,
    x: 980,
    y: 80,
    w: 232,
    h: 128,
    text: '352 节点便签拖动目标',
    color: 'yellow',
  }],
  boards: [],
  drawing: [],
  drawingFiles: {},
};
const probe = { status: 'booting', report: null };
window.__CANVAS_ACCEPTANCE__ = probe;

const performanceState = {
  active: false,
  startedAt: 0,
  frames: [],
  positions: [],
  longTasks: [],
  pointerMoves: 0,
  target: null,
  lastFrameAt: null,
  rafId: 0,
};
let longTaskObserver = null;
try {
  longTaskObserver = new PerformanceObserver(list => {
    if (!performanceState.active) return;
    for (const entry of list.getEntries()) performanceState.longTasks.push(entry.duration);
  });
  longTaskObserver.observe({ type: 'longtask', buffered: true });
} catch { /* Long Task API unavailable is reported explicitly by the verifier. */ }

window.addEventListener('pointermove', () => {
  if (performanceState.active) performanceState.pointerMoves += 1;
}, true);

function sampleFrame(at) {
  if (!performanceState.active) return;
  if (performanceState.lastFrameAt !== null) performanceState.frames.push(at - performanceState.lastFrameAt);
  performanceState.lastFrameAt = at;
  const rect = performanceState.target?.getBoundingClientRect();
  if (rect) performanceState.positions.push({ at, x: rect.left, y: rect.top });
  performanceState.rafId = requestAnimationFrame(sampleFrame);
}

window.__FLOW_PERF_352__ = {
  longTaskSupported: Boolean(longTaskObserver),
  start(selector) {
    const target = document.querySelector(selector);
    if (!target) throw new Error(`performance target missing: ${selector}`);
    cancelAnimationFrame(performanceState.rafId);
    longTaskObserver?.takeRecords();
    Object.assign(performanceState, {
      active: true,
      startedAt: performance.now(),
      frames: [],
      positions: [],
      longTasks: [],
      pointerMoves: 0,
      target,
      lastFrameAt: null,
      rafId: 0,
    });
    performanceState.rafId = requestAnimationFrame(sampleFrame);
  },
  stop() {
    performanceState.active = false;
    cancelAnimationFrame(performanceState.rafId);
    for (const entry of longTaskObserver?.takeRecords() || []) performanceState.longTasks.push(entry.duration);
    return this.snapshot();
  },
  snapshot() {
    return {
      durationMs: performance.now() - performanceState.startedAt,
      frameIntervals: [...performanceState.frames],
      positions: [...performanceState.positions],
      longTasks: [...performanceState.longTasks],
      pointerMoves: performanceState.pointerMoves,
      longTaskSupported: Boolean(longTaskObserver),
    };
  },
};

function Performance352Canvas() {
  const storeRef = useRef(null);
  if (!storeRef.current) {
    storeRef.current = createSceneStore(INITIAL_DOC, {
      persistScene: async () => ({ rev: 1 }),
      persistFiles: async () => ({ added: 0 }),
    });
  }
  const store = storeRef.current;
  const doc = useSyncExternalStore(
    useCallback(cb => store.subscribe(cb), [store]),
    useCallback(() => store.get(), [store]),
  );
  const focusRef = useRef(() => {});
  const actionsRef = useRef({});
  const shellRef = useRef(null);
  const expanded = useMemo(() => new Set([FLOW_PERFORMANCE_WORKSPACE]), []);

  useEffect(() => {
    const timer = setTimeout(() => {
      const nodeCount = shellRef.current?.querySelectorAll('.react-flow__node').length || 0;
      const targets = {
        district: shellRef.current?.querySelectorAll('.react-flow__node-district .container-drag-handle').length || 0,
        workspace: shellRef.current?.querySelectorAll('.react-flow__node-workspace').length || 0,
        note: shellRef.current?.querySelectorAll('.react-flow__node-note').length || 0,
      };
      const pass = nodeCount === FLOW_PERFORMANCE_NODE_COUNT && Object.values(targets).every(count => count === 1);
      probe.status = pass ? 'complete' : 'fail';
      probe.report = { nodeCount, expectedNodeCount: FLOW_PERFORMANCE_NODE_COUNT, targets, pass };
      document.documentElement.dataset.performance352Status = pass ? 'pass' : 'fail';
    }, 250);
    return () => clearTimeout(timer);
  }, []);

  const onMoveNode = useCallback(entries => store.mutate(current => {
    const layout = { ...current.layout };
    for (const entry of entries || []) layout[entry.path] = { ...layout[entry.path], ...entry };
    return { ...current, layout };
  }), [store]);

  const onCanvasAction = useCallback((kind, payload) => {
    if (kind !== 'setNote') return true;
    store.mutate(current => ({
      ...current,
      notes: current.notes.map(note => note.id === payload.id ? { ...note, ...payload } : note),
    }));
    return true;
  }, [store]);

  return h('div', { ref: shellRef, style: { position: 'fixed', inset: 0 } },
    h(FlowCanvas, {
      workspaces: FIXTURE.workspaces,
      sessionsByKey: FIXTURE.sessionsByKey,
      edges: [],
      layout: doc.layout,
      canvas: doc,
      store,
      onMoveNode,
      onCanvasAction,
      onRenameSession: () => {},
      onRenameWs: () => {},
      selectedKey: null,
      onSelect: () => {},
      onChanged: () => {},
      onArrange: () => {},
      focusRef,
      actionsRef,
      expanded,
      searching: false,
      onToggleExpand: () => {},
    }),
    h(UIHost),
    h('aside', { style: {
      position: 'fixed', right: 10, top: 10, zIndex: 99, background: '#fff',
      border: '1px solid #d0d5dd', borderRadius: 10, padding: 10,
      font: '11px/1.5 ui-monospace, monospace', pointerEvents: 'none',
    } },
      h('b', null, '352-node production FlowCanvas'),
      h('div', { 'data-performance-352-status': probe.status }, `status: ${probe.status}`),
      h('div', null, 'targets: district / workspace / note'),
    ),
  );
}

export function mountPerformance352Fixture(target) {
  createRoot(target).render(h(Performance352Canvas));
}
