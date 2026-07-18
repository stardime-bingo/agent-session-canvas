/**
 * [INPUT]: 依赖真实 FlowCanvas/scene-store/UIHost 与 4518 synthetic 数据；自研墨迹直渲，无故障注入
 * [OUTPUT]: 无 fetch 全内存交互画布 + 原生墨迹十三链自动验收：冷渲/连发即时/快捷键/框选多选/
 *           批量移动/缩放/旋转/复制粘贴/Alt 拖/删除撤销/后台冲刷；window.__CANVAS_ACCEPTANCE__ 输出报告
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
import { selectionBounds } from '../../../web/src/canvas/ink-selection.js';
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
    const input = () => shellRef.current?.querySelector('.ink-input-layer');
    const pointer = (type, point, extra = {}) => {
      const screen = probe().flowToScreen(point);
      input().dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId: 4518, pointerType: 'mouse', isPrimary: true,
        button: 0, buttons: type === 'pointerup' ? 0 : 1,
        clientX: screen.x, clientY: screen.y, ...extra,
      }));
    };
    const key = (value, extra = {}) => window.dispatchEvent(new KeyboardEvent('keydown', {
      key: value, bubbles: true, cancelable: true, ...extra,
    }));
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

      // 3) Figma 肌肉记忆：P 武装画笔、V 切回选择，真实 keydown 驱动 production listener
      key('p');
      await waitFor(() => shellRef.current?.querySelector('.ink-input-layer'), 'input layer');
      const penTool = probe().snapshot().tool;
      key('v');
      await waitFor(() => probe().snapshot().tool === 'select', 'select shortcut');
      checks.toolShortcuts = penTool === 'freedraw';

      // 4) 空白拖框选中两元素：合成 pointer 只存在 4518，真实 4517 永不坐标自动化
      pointer('pointerdown', { x: 1040, y: 140 });
      pointer('pointermove', { x: 1460, y: 310 });
      pointer('pointerup', { x: 1460, y: 310 });
      await waitFor(() => probe().snapshot().selectedIds.length === 2, 'marquee multi-select');
      checks.marqueeMultiSelect = !!shellRef.current?.querySelector('[data-ink-handle="se"]');

      // 5) 多选批量移动：一次 pointer 流、一次 coalesce undo 步
      pointer('pointerdown', { x: 1120, y: 200 });
      pointer('pointermove', { x: 1140, y: 220 });
      pointer('pointerup', { x: 1140, y: 220 });
      checks.groupMove = landmarkX() === 1100
        && store.get().drawing.find(el => el.id === 'fixture-witness')?.x === 1300;

      // 6) 右下手柄批量缩放：文档同步变化，选择保持同一组
      const beforeResize = selectionBounds(store.get().drawing, probe().snapshot().selectedIds);
      pointer('pointerdown', { x: beforeResize.maxX, y: beforeResize.maxY });
      pointer('pointermove', { x: beforeResize.maxX + 60, y: beforeResize.maxY + 40 });
      pointer('pointerup', { x: beforeResize.maxX + 60, y: beforeResize.maxY + 40 });
      const afterResize = selectionBounds(store.get().drawing, probe().snapshot().selectedIds);
      checks.resize = afterResize.maxX - beforeResize.maxX > 59 && afterResize.maxY - beforeResize.maxY > 39;

      // 7) 旋转手柄围绕共同中心旋转，两个元素角度同代推进
      const rotateBox = selectionBounds(store.get().drawing, probe().snapshot().selectedIds);
      const cx = (rotateBox.minX + rotateBox.maxX) / 2;
      const cy = (rotateBox.minY + rotateBox.maxY) / 2;
      pointer('pointerdown', { x: cx, y: rotateBox.minY - 28 });
      pointer('pointermove', { x: rotateBox.maxX + 28, y: cy });
      pointer('pointerup', { x: rotateBox.maxX + 28, y: cy });
      checks.rotate = store.get().drawing.filter(el => ['fixture-landmark', 'fixture-witness'].includes(el.id))
        .every(el => Math.abs(el.angle || 0) > 0.5);

      // 8) ClipboardEvent 走 production copy/paste 监听：元素与选择数同步翻倍
      const transfer = new DataTransfer();
      input().dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: transfer }));
      const beforePaste = store.get().drawing.length;
      input().dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
      await waitFor(() => probe().snapshot().selectedIds.length === 2, 'pasted selection');
      const pastedIds = probe().snapshot().selectedIds;
      checks.copyPaste = store.get().drawing.length === beforePaste + 2 && pastedIds.length === 2;

      // 9) Alt+拖只在首次真正移动时克隆，点击不制造幽灵副本
      const pasted = store.get().drawing.find(el => el.id === pastedIds[0]);
      const pastedBounds = selectionBounds(store.get().drawing, [pasted.id]);
      const px = (pastedBounds.minX + pastedBounds.maxX) / 2;
      const py = (pastedBounds.minY + pastedBounds.maxY) / 2;
      const beforeAlt = store.get().drawing.length;
      probe().setSelectedId(pasted.id);
      await waitFor(() => probe().snapshot().selectedIds.length === 1, 'single alt selection');
      pointer('pointerdown', { x: px, y: py }, { altKey: true });
      pointer('pointermove', { x: px + 24, y: py + 16 }, { altKey: true });
      pointer('pointerup', { x: px + 24, y: py + 16 }, { altKey: true });
      checks.altDrag = store.get().drawing.length === beforeAlt + 1 && probe().snapshot().selectedIds.length === 1;

      // 10) Delete + 全画布 undo：生产快捷键删除，store 历史原样复活
      await waitFor(() => dom() === store.get().drawing.length, 'alt clone dom commit');
      const beforeDelete = dom();
      details.delete = {
        beforeDom: beforeDelete,
        beforeDrawing: store.get().drawing.length,
        selectedIds: probe().snapshot().selectedIds,
        tool: probe().snapshot().tool,
      };
      key('Delete');
      try {
        await waitFor(() => dom() === beforeDelete - 1, 'delete hides');
      } finally {
        details.delete.afterDom = dom();
        details.delete.afterDrawing = store.get().drawing.length;
        details.delete.afterSelectedIds = probe().snapshot().selectedIds;
      }
      store.undo();
      await waitFor(() => dom() === beforeDelete, 'undo revives');
      checks.deleteUndo = true;

      // 11) 后台冲刷：防抖后 persist 收到最终文档，以上输入没有一步等待它
      await waitFor(() => flushedRef.current.length > 0, 'background flush', 5000);
      checks.backgroundFlush = flushedRef.current.at(-1).canvas.drawing.some(el => el.id === 'fixture-landmark');
      details.flushCount = flushedRef.current.length;

      // 12) 浏览器原生诊断由 main.jsx 统一收集；套件内也必须保持零错误/零警告
      checks.consoleClean = window.__CANVAS_CONSOLE_ERRORS__.length === 0
        && window.__CANVAS_CONSOLE_WARNINGS__.length === 0
        && window.__CANVAS_PAGE_ERRORS__.length === 0;

      const pass = Object.values(checks).every(Boolean);
      probeReport.status = pass ? 'complete' : 'fail';
      probeReport.report = { checks, details };
      document.documentElement.dataset.interactionStatus = pass ? 'pass' : 'fail';
      setSuite({ status: pass ? 'pass' : 'fail', checks, details });
    } catch (error) {
      probeReport.status = 'error';
      probeReport.report = { checks, details, error: error.message };
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
