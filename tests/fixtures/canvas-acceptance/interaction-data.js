/**
 * [INPUT]: 依赖真实 FlowCanvas/scene-store/UIHost 与 4518 synthetic 数据；自研墨迹直渲，无故障注入
 * [OUTPUT]: 无 fetch 全内存交互画布 + 原生墨迹七链自动验收：冷渲/连发即时/工具武装/选择环/
 *           删除撤销/全局撤销/后台冲刷；window.__CANVAS_ACCEPTANCE__ 输出报告
 * [POS]: 仅由 ?mode=interaction 动态加载；证伪"文档变更到像素可见=一次 React commit"的宪法
 * [PROTOCOL]: 变更时更新此头部，然后检查 main.jsx/README/web/CLAUDE.md
 */
import React, { useCallback, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import '@xyflow/react/dist/style.css';
import '../../../web/src/theme.css';
import FlowCanvas from '../../../web/src/canvas/FlowCanvas.jsx';
import { createSceneStore } from '../../../web/src/scene-store.js';
import { translateDrawingElements } from '../../../web/src/canvas/drawing.js';
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
const below = { customData: { below: true } };
const INITIAL_DOC = {
  layout: { [WORKSPACE]: { d: `board:${BOARD_ID}`, x: 90, y: 100 } },
  edges: [],
  notes: [],
  boards: [{ id: BOARD_ID, x: 120, y: 100, w: 900, h: 650, name: '自动化运维区', color: 'blue' }],
  drawing: [
    element('fixture-landmark', 1060, 160, 180, 110, below),
    element('fixture-witness', 1280, 160, 160, 90, below),
  ],
  drawingFiles: {},
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

// setTimeout 轮询而非 rAF：隐藏窗格 rAF 会停摆（v23 教训），验收必须在后台标签页也能跑完
const tick = () => new Promise(resolve => setTimeout(resolve, 50));
async function waitFor(read, label, timeoutMs = 20000) {
  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    const value = read();
    if (value) return value;
    await tick();
  }
  throw new Error(`Timed out waiting for ${label}`);
}

const probeReport = { status: 'booting', report: null, run: null };
window.__CANVAS_ACCEPTANCE__ = probeReport;

function InteractionCanvas() {
  const flushedRef = useRef([]);
  const storeRef = useRef(null);
  if (!storeRef.current) {
    storeRef.current = createSceneStore(INITIAL_DOC, {
      persistScene: async scene => { flushedRef.current.push(scene); return { rev: flushedRef.current.length }; },
      persistFiles: async files => ({ added: Object.keys(files).length }),
    });
  }
  const store = storeRef.current;
  window.__FIXTURE_STORE__ = store;   // 夹具专用透视窗：只在 4518 隔离页存在
  const doc = useSyncExternalStore(
    useCallback(cb => store.subscribe(cb), [store]),
    useCallback(() => store.get(), [store]),
  );
  const [suite, setSuite] = useState({ status: 'idle', checks: null, details: null });
  const frameTestProbeRef = useRef(null);
  window.__FIXTURE_PROBE__ = frameTestProbeRef;   // 透视窗必须在声明之后（v23 TDZ 教训）
  const focusRef = useRef(() => {});
  const actionsRef = useRef({});
  const shellRef = useRef(null);
  const sessionsByKey = useMemo(() => ({ [SESSION_KEY]: SESSION }), []);

  // 与 App.handleCanvas 同语义：便签补丁式合并（打字流 coalesce 一步 undo），不存在第二套写法
  const onCanvasAction = useCallback((kind, payload) => {
    if (kind === 'setNote') {
      store.mutate(d => {
        const i = d.notes.findIndex(n => n.id === payload.id);
        if (i >= 0) {
          const patch = {};
          for (const k of ['x', 'y', 'text', 'color', 'w', 'h']) if (payload[k] !== undefined) patch[k] = payload[k];
          const notes = [...d.notes];
          notes[i] = { ...notes[i], ...patch };
          return { ...d, notes };
        }
        return { ...d, notes: [...d.notes, { id: payload.id || `note:${Date.now()}`, x: 0, y: 0, text: '', color: 'yellow', ...payload }] };
      }, payload.text !== undefined ? { coalesce: `note-text:${payload.id}` } : {});
    } else if (kind === 'delNote') {
      store.mutate(d => ({ ...d, notes: d.notes.filter(n => n.id !== payload) }));
    }
    return true;
  }, [store]);

  const runSuite = useCallback(async () => {
    const checks = {};
    const details = {};
    const probe = () => frameTestProbeRef.current;
    const dom = () => shellRef.current?.querySelectorAll('.ink-world [data-ink-element-id]').length ?? 0;   // 排除 MiniMapInk 缩略副本
    const landmarkX = () => store.get().drawing.find(el => el.id === 'fixture-landmark')?.x;
    try {
      // 1) 冷渲：文档元素直渲进 DOM，数量一致
      await waitFor(() => dom() === 2, 'cold render');
      checks.coldRender = true;

      // 2) 连发即时：两笔平移背靠背，文档同步推进、DOM 同 commit 跟上——没有任何门
      const before = store.get().seq;
      probe().mutateDrawing(els => translateDrawingElements(els, ['fixture-landmark'], 10, 0));
      probe().mutateDrawing(els => translateDrawingElements(els, ['fixture-landmark'], 10, 0));
      checks.rapidMutations = store.get().seq === before + 2 && landmarkX() === 1080;
      await waitFor(() => shellRef.current?.querySelector('.ink-world [data-ink-element-id="fixture-landmark"] rect')?.getAttribute('x') === '1080', 'dom sync');
      checks.domSync = true;

      // 3) 工具武装：freedraw 上捕获层，收工具即撤
      probe().setTool('freedraw');
      await waitFor(() => shellRef.current?.querySelector('.ink-input-layer'), 'input layer');
      checks.toolArm = true;
      probe().setTool('none');
      await waitFor(() => !shellRef.current?.querySelector('.ink-input-layer'), 'input layer gone');

      // 4) 选择环：select + 选中即画环
      probe().setTool('select');
      probe().setSelectedId('fixture-landmark');
      await waitFor(() => shellRef.current?.querySelector('.ink-world rect[stroke-dasharray]'), 'selection ring');
      checks.selectRing = true;
      probe().setTool('none');

      // 5) 删除+撤销：墓碑即刻消隐，undo 即刻复活
      probe().mutateDrawing(els => els.map(el => el.id === 'fixture-witness' ? { ...el, isDeleted: true } : el));
      await waitFor(() => dom() === 1, 'delete hides');
      store.undo();
      await waitFor(() => dom() === 2, 'undo revives');
      checks.deleteUndo = true;

      // 6) 全局撤销：平移一键回一步
      const seqBeforeUndo = store.get().seq;
      store.undo();
      checks.globalUndo = landmarkX() === 1070;
      details.undo = { seqBeforeUndo, xAfter: landmarkX() };

      // 7) 后台冲刷：防抖后 persist 收到最终文档，交互全程未等它
      await waitFor(() => flushedRef.current.length > 0, 'background flush', 5000);
      checks.backgroundFlush = flushedRef.current.at(-1).canvas.drawing.some(el => el.id === 'fixture-landmark');
      details.flushCount = flushedRef.current.length;

      const pass = Object.values(checks).every(Boolean);
      probeReport.status = pass ? 'complete' : 'fail';
      probeReport.report = { checks, details };
      document.documentElement.dataset.interactionStatus = pass ? 'pass' : 'fail';
      setSuite({ status: pass ? 'pass' : 'fail', checks, details });
    } catch (error) {
      probeReport.status = 'error';
      probeReport.report = { checks, error: error.message };
      document.documentElement.dataset.interactionStatus = 'error';
      setSuite({ status: 'error', checks, details: { error: error.message } });
    }
  }, [store]);

  probeReport.run = runSuite;

  return h('div', { ref: shellRef, style: { position: 'fixed', inset: 0 } },
    h(FlowCanvas, {
      workspaces: WORKSPACES,
      sessionsByKey,
      edges: [],
      layout: doc.layout,
      canvas: doc,
      store,
      onCanvasAction,
      onMoveNode: entries => store.mutate(d => {
        const layout = { ...d.layout };
        for (const entry of entries || []) layout[entry.path] = { ...layout[entry.path], ...entry };
        return { ...d, layout };
      }),
      onRenameSession: () => {},
      onRenameWs: () => {},
      selectedKey: null,
      onSelect: () => {},
      onChanged: () => {},
      onArrange: () => {},
      focusRef,
      actionsRef,
      expanded: useMemo(() => new Set(), []),
      searching: false,
      onToggleExpand: () => {},
      frameTestProbeRef,
    }),
    h(UIHost),
    h('aside', { className: 'fixture-hud', style: {
      position: 'fixed', right: 10, bottom: 10, zIndex: 99, maxWidth: 420,
      background: '#fff', border: '1px solid #d0d5dd', borderRadius: 10, padding: 10,
      font: '11px/1.5 ui-monospace, monospace', maxHeight: '46vh', overflow: 'auto',
    } },
      h('button', {
        type: 'button',
        'data-run-suite': 'true',
        onClick: () => { setSuite({ status: 'running', checks: null, details: null }); void runSuite(); },
        style: { marginBottom: 6 },
      }, '运行原生墨迹验收'),
      h('div', { 'data-suite-status': suite.status }, `status: ${suite.status}`),
      suite.checks && h('pre', null, JSON.stringify(suite.checks, null, 2)),
    ),
  );
}

export function mountInteractionFixture(target) {
  document.documentElement.dataset.interactionStatus = 'mounted';
  probeReport.status = 'mounted';
  createRoot(target).render(h(InteractionCanvas));
  if (new URLSearchParams(location.search).get('autorun') === '1') {
    setTimeout(() => probeReport.run?.(), 800);
  }
}
