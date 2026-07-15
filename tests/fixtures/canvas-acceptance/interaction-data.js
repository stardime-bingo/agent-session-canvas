/**
 * [INPUT]: 依赖真实 FlowCanvas/UIHost 与 4518 synthetic 数据
 * [OUTPUT]: 挂载无 fetch、全内存的交互验收画布，并仅在 100ms 自动退场观察窗发布 pointerup→drawing-opening 延迟
 * [POS]: 仅由 ?mode=interaction 动态加载；不进入既有 performance 模式首屏闭包
 * [PROTOCOL]: 变更时更新此头部，然后检查 main.jsx/README/web/CLAUDE.md
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@xyflow/react/dist/style.css';
import '../../../web/src/theme.css';
import FlowCanvas from '../../../web/src/canvas/FlowCanvas.jsx';
import { UIHost } from '../../../web/src/ui.jsx';

const h = React.createElement;
const WORKSPACE = '/Users/fixture/AutomationOps';
const SESSION_KEY = 'codex:fixture-ops-session';
const BOARD_ID = 'fixture-automation-board';
const FIXED_TIME = '2026-07-15T04:00:00.000Z';

const element = (id, x, y, width, height, extra = {}) => ({
  id, type: 'rectangle', x, y, width, height, angle: 0,
  strokeColor: '#155eef', backgroundColor: '#dbeafe', fillStyle: 'solid',
  strokeWidth: 2, strokeStyle: 'solid', roughness: 0, opacity: 70,
  roundness: { type: 3 }, seed: 4518, version: 1, versionNonce: 4518,
  index: null, isDeleted: false, groupIds: [], frameId: null, boundElements: null,
  updated: 1, link: null, locked: false, ...extra,
});

const INITIAL_CANVAS = {
  drawing: [element('fixture-landmark', 1060, 160, 180, 110, { customData: { below: true } })],
  drawingFiles: {},
  notes: [],
  boards: [{ id: BOARD_ID, x: 120, y: 100, w: 900, h: 650, name: '自动化运维区', color: 'blue' }],
};
const INITIAL_LAYOUT = {
  [WORKSPACE]: { d: `board:${BOARD_ID}`, x: 90, y: 100 },
};
const SESSION = {
  key: SESSION_KEY, tool: 'codex', status: 'active', title: '验收：自动化运维会话卡',
  cwd: WORKSPACE, updatedAt: FIXED_TIME, kind: 'session', subagents: 0, runs: 1,
  summary: '', hasHandoff: false, gitBranch: 'main',
};
const WORKSPACES = [{
  path: WORKSPACE, name: '自动化运维', parent: null, tools: { codex: 1 },
  lastActivity: FIXED_TIME, sessionKeys: [SESSION_KEY], visibleKeys: [SESSION_KEY],
}];

const apiResourceCount = () => performance.getEntriesByType('resource')
  .filter(entry => {
    try { return new URL(entry.name).pathname.startsWith('/api'); } catch { return false; }
  }).length;

function InteractionCanvas() {
  const [canvas, setCanvas] = useState(INITIAL_CANVAS);
  const [layout, setLayout] = useState(INITIAL_LAYOUT);
  const [selectedKey, setSelectedKey] = useState(null);
  const [expanded, setExpanded] = useState(new Set());
  const shellRef = useRef(null);
  const actionLogRef = useRef([]);
  const commitLogRef = useRef([]);
  const pointerUpAtRef = useRef(null);
  const openingTimerRef = useRef(null);
  const openingLatencyRef = useRef(null);
  const viewportRef = useRef('');
  const focusRef = useRef(() => {});
  const actionsRef = useRef({});
  const geometryPendingRef = useRef(false);
  const sessionsByKey = useMemo(() => ({ [SESSION_KEY]: SESSION }), []);

  const record = useCallback((kind, payload) => {
    actionLogRef.current = [...actionLogRef.current, { kind, at: performance.now(), payload }].slice(-40);
  }, []);

  const onCanvasAction = useCallback(async (kind, payload) => {
    record(kind, payload);
    if (kind === 'drawingCommit') {
      const snapshot = {
        elements: payload.elements || [],
        files: payload.files || {},
      };
      commitLogRef.current = [...commitLogRef.current, {
        at: performance.now(),
        elements: snapshot.elements.map(item => ({ id: item.id, type: item.type, below: !!item.customData?.below })),
      }];
      setCanvas(current => ({ ...current, drawing: snapshot.elements, drawingFiles: snapshot.files }));
      return payload;
    }
    if (kind === 'setBoard') {
      setCanvas(current => {
        const id = payload.id || `fixture-board-${current.boards.length + 1}`;
        const next = { ...payload, id };
        const found = current.boards.some(board => board.id === id);
        return { ...current, boards: found ? current.boards.map(board => board.id === id ? { ...board, ...next } : board) : [...current.boards, next] };
      });
    } else if (kind === 'delBoard') {
      setCanvas(current => ({ ...current, boards: current.boards.filter(board => board.id !== payload) }));
    } else if (kind === 'setNote') {
      setCanvas(current => {
        const id = payload.id || `fixture-note-${current.notes.length + 1}`;
        const next = { ...payload, id };
        const found = current.notes.some(note => note.id === id);
        return { ...current, notes: found ? current.notes.map(note => note.id === id ? { ...note, ...next } : note) : [...current.notes, next] };
      });
    } else if (kind === 'delNote') {
      setCanvas(current => ({ ...current, notes: current.notes.filter(note => note.id !== payload) }));
    }
    return payload;
  }, [record]);

  const onMoveNode = useCallback(entries => {
    record('layoutBatch', entries);
    setLayout(current => {
      const next = { ...current };
      for (const entry of entries || []) next[entry.path] = { ...next[entry.path], ...entry };
      return next;
    });
  }, [record]);

  const publish = useCallback(() => {
    const drawing = canvas.drawing || [];
    const report = {
      mode: 'interaction', status: 'ready',
      drawingCount: drawing.length,
      planes: {
        below: drawing.filter(item => item.customData?.below).length,
        above: drawing.filter(item => !item.customData?.below).length,
      },
      drawing: drawing.map(item => ({ id: item.id, type: item.type, below: !!item.customData?.below })),
      actionLog: actionLogRef.current,
      commitLog: commitLogRef.current,
      selectedKey,
      viewport: viewportRef.current,
      apiResourceCount: apiResourceCount(),
      pointerUpAt: pointerUpAtRef.current,
      drawingOpeningLatencyMs: openingLatencyRef.current,
    };
    window.__CANVAS_INTERACTION__ = report;
    const root = document.documentElement;
    root.dataset.acceptanceMode = 'interaction';
    root.dataset.interactionStatus = report.status;
    root.dataset.interactionDrawingCount = String(report.drawingCount);
    root.dataset.interactionBelowCount = String(report.planes.below);
    root.dataset.interactionAboveCount = String(report.planes.above);
    root.dataset.interactionCommitCount = String(report.commitLog.length);
    root.dataset.interactionSelectedKey = report.selectedKey || '';
    root.dataset.interactionViewport = report.viewport;
    root.dataset.interactionApiCount = String(report.apiResourceCount);
    root.dataset.interactionOpeningMs = report.drawingOpeningLatencyMs == null ? '' : String(report.drawingOpeningLatencyMs);
    root.dataset.interactionReport = JSON.stringify(report);
  }, [canvas, selectedKey]);

  useEffect(() => { publish(); });
  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return undefined;
    const readDom = () => {
      const viewport = shell.querySelector('.react-flow__viewport');
      viewportRef.current = viewport?.style.transform || '';
      const root = shell.querySelector('.canvas-root');
      if (root?.classList.contains('drawing-opening') && pointerUpAtRef.current != null) {
        const latency = performance.now() - pointerUpAtRef.current;
        openingLatencyRef.current = latency <= 100 ? latency : null;
        pointerUpAtRef.current = null;
        if (openingTimerRef.current != null) window.clearTimeout(openingTimerRef.current);
        openingTimerRef.current = null;
      }
      publish();
    };
    const observer = new MutationObserver(readDom);
    observer.observe(shell, { subtree: true, attributes: true, attributeFilter: ['class', 'style'] });
    readDom();
    return () => observer.disconnect();
  }, [publish]);
  useEffect(() => () => {
    if (openingTimerRef.current != null) window.clearTimeout(openingTimerRef.current);
  }, []);

  const onPointerUpCapture = useCallback(event => {
    if (!event.target.closest?.('.draw-layer')) return;
    if (openingTimerRef.current != null) window.clearTimeout(openingTimerRef.current);
    const pointerUpAt = performance.now();
    pointerUpAtRef.current = pointerUpAt;
    openingLatencyRef.current = null;
    openingTimerRef.current = window.setTimeout(() => {
      if (pointerUpAtRef.current !== pointerUpAt) return;
      pointerUpAtRef.current = null;
      openingTimerRef.current = null;
      publish();
    }, 100);
    publish();
  }, [publish]);

  return h('div', {
    ref: shellRef,
    className: 'fixture-interaction',
    onPointerUpCapture,
    style: { position: 'relative', width: '100%', height: '100%' },
  },
  h(FlowCanvas, {
    workspaces: WORKSPACES,
    sessionsByKey,
    edges: [],
    layout,
    canvas,
    onMoveNode,
    onCanvasAction,
    onRenameSession: () => {},
    onRenameWs: () => {},
    selectedKey,
    onSelect: key => { setSelectedKey(key); record('select', key); },
    onChanged: () => record('changed', null),
    onArrange: () => record('arrange', null),
    focusRef,
    actionsRef,
    geometryPendingRef,
    expanded,
    searching: false,
    onToggleExpand: path => setExpanded(current => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    }),
  }),
  h(UIHost),
  h('aside', { className: 'interaction-panel', 'data-interaction-panel': 'true' },
    h('strong', null, '4518 · 交互隔离画布'),
    h('span', null, `绘图 ${canvas.drawing.length} · commits ${commitLogRef.current.length}`),
    h('span', null, selectedKey ? `已选 ${selectedKey}` : '未选会话卡'),
    h('span', null, openingLatencyRef.current == null ? '退场延迟：待测' : `退场延迟：${openingLatencyRef.current.toFixed(1)}ms`),
  ));
}

export function mountInteractionFixture(target) {
  try { localStorage.vp = JSON.stringify({ x: 0, y: 0, zoom: 1 }); } catch { /* 4518 私有 origin 无法写也不影响隔离 */ }
  createRoot(target).render(h(InteractionCanvas));
}
