/**
 * [INPUT]: 依赖真实 FlowCanvas/scene-store/UIHost 与 4518 synthetic 数据；真实 exportToSvg，无故障注入
 * [OUTPUT]: 无 fetch 全内存交互画布 + SceneStore 新合同七链自动验收：冷帧/连发不拒/选中洞/退出还原/
 *           新建编辑器挂载/全局撤销/后台冲刷；window.__CANVAS_ACCEPTANCE__ 输出报告
 * [POS]: 仅由 ?mode=interaction 动态加载；证伪"交互路径零等待、帧只是订阅者"的宪法
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
    try {
      // 1) 冷帧：世界帧追上文档 seq，墨迹平面进 DOM
      await waitFor(() => {
        const s = probe()?.snapshot();
        return s && s.renderedRevision !== null && s.renderedRevision >= s.docSeq;
      }, 'cold frame');
      checks.coldFrame = !!shellRef.current?.querySelector('.ink-world-plane');

      // 2) 连发不拒：帧在飞时立刻发第二笔，两笔全部落文档，帧最终追平——没有任何门
      const before = store.get().seq;
      probe().mutateDrawing(els => translateDrawingElements(els, ['fixture-landmark'], 10, 0));
      probe().mutateDrawing(els => translateDrawingElements(els, ['fixture-landmark'], 10, 0));
      const afterTwo = store.get().seq;
      const applied = store.get().drawing.find(el => el.id === 'fixture-landmark').x === 1080;
      await waitFor(() => probe().snapshot().renderedRevision >= afterTwo, 'frame catch-up');
      checks.rapidMutations = afterTwo === before + 2 && applied;
      details.rapidMutations = { before, afterTwo, applied };

      // 3) 选中开编辑：目标闭包挖洞，世界帧不再含 landmark，编辑器显形
      const opened = await probe().openDrawing('selection', 'fixture-landmark');
      await waitFor(() => probe().snapshot().drawVisible, 'editor visible');
      const holeState = probe().snapshot();
      checks.openSelection = opened === true
        && holeState.excludedIds.includes('fixture-landmark')
        && !holeState.renderedElementIds.includes('fixture-landmark')
        && holeState.renderedElementIds.includes('fixture-witness');
      details.openSelection = holeState;

      // 4) 退出：洞补回，世界重含 landmark，会话归 idle
      const closed = await probe().exitDrawing();
      await waitFor(() => {
        const s = probe().snapshot();
        return !s.penActive && s.renderedElementIds.includes('fixture-landmark');
      }, 'exit restore');
      checks.exitRestores = closed === true && probe().snapshot().sessionPhase === 'idle';

      // 5) 新建：空事务挂载真实 Excalidraw，快速进出走无洞快路径
      await probe().openDrawing('freedraw');
      await waitFor(() => shellRef.current?.querySelector('.excalidraw'), 'excalidraw mount');
      checks.editorMounts = !!shellRef.current.querySelector('.excalidraw');
      const exitStarted = performance.now();
      await probe().exitDrawing();
      checks.emptyExitFast = performance.now() - exitStarted < 500 && !probe().snapshot().penActive;

      // 6) 全局撤销：两步平移一键回一步，帧照常追平
      const seqBeforeUndo = store.get().seq;
      const xBefore = store.get().drawing.find(el => el.id === 'fixture-landmark')?.x;
      const canUndo = store.canUndo();
      const didUndo = store.undo();
      const xAfter = store.get().drawing.find(el => el.id === 'fixture-landmark')?.x;
      details.undo = { seqBeforeUndo, canUndo, didUndo, xBefore, xAfter };
      const undone = xAfter === 1070;
      await waitFor(() => probe().snapshot().renderedRevision >= seqBeforeUndo + 1, 'undo frame');
      checks.globalUndo = undone;

      // 7) 后台冲刷：防抖后 persist 收到最终文档，交互全程未等它
      await waitFor(() => flushedRef.current.length > 0, 'background flush', 5000);
      const lastFlush = flushedRef.current.at(-1);
      checks.backgroundFlush = lastFlush.canvas.drawing.some(el => el.id === 'fixture-landmark');
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
      }, '运行新合同验收'),
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
