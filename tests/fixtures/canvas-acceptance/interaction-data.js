/**
 * [INPUT]: 依赖真实 FlowCanvas/UIHost、4518 synthetic 数据与只替换 Ink exporter 的故障探针
 * [OUTPUT]: 无 fetch 全内存交互画布；真实 cold/warm/late export、Suspense 并发、open/exit handoff 的具名可机读合约
 * [POS]: 仅由 ?mode=interaction 动态加载；不进入 performance 模式首屏闭包，不触碰真实 4517 数据
 * [PROTOCOL]: 变更时更新此头部，然后检查 main.jsx/README/web/CLAUDE.md
 */
import React, { Suspense, startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
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
const CHECK_NAMES = Object.freeze(['concurrent', 'revision', 'opening', 'closing', 'coldError', 'warmError', 'lateIsolation']);

const element = (id, x, y, width, height, extra = {}) => ({
  id, type: 'rectangle', x, y, width, height, angle: 0,
  strokeColor: '#155eef', backgroundColor: '#dbeafe', fillStyle: 'solid',
  strokeWidth: 2, strokeStyle: 'solid', roughness: 0, opacity: 70,
  roundness: { type: 3 }, seed: 4518, version: 1, versionNonce: 4518,
  index: null, isDeleted: false, groupIds: [], frameId: null, boundElements: null,
  updated: 1, link: null, locked: false, ...extra,
});
const below = { customData: { below: true } };
const COLD_ELEMENTS = Object.freeze([element('cold-hidden', 1060, 160, 180, 110, below)]);
const RECOVERY_ELEMENTS = Object.freeze([element('warm-visible-a', 1060, 160, 180, 110, below)]);
const WARM_TARGET_ELEMENTS = Object.freeze([element('warm-failed-b', 1280, 160, 180, 110, below)]);
const LATE_OLD_ELEMENTS = Object.freeze([element('late-old', 1060, 320, 180, 110, below)]);
const EDIT_ELEMENTS = Object.freeze([
  element('fixture-landmark', 1060, 160, 180, 110, below),
  element('fixture-witness', 1280, 160, 160, 90, below),
]);
const SPECULATIVE_ELEMENTS = Object.freeze([element('concurrent-speculative-b', 1060, 160, 180, 110, below)]);
const COMMITTED_ELEMENTS = Object.freeze([element('concurrent-committed-c', 1060, 160, 180, 110, below)]);

const INITIAL_CANVAS = {
  drawing: COLD_ELEMENTS,
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

const NEVER_SETTLES = new Promise(() => {});
const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));
const withTimeout = (promise, label, timeoutMs = 20000) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs)),
]);

async function waitFor(read, label, timeoutMs = 20000) {
  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    const value = read();
    if (value) return value;
    await nextFrame();
  }
  throw new Error(`Timed out waiting for ${label}`);
}

const revisionValue = value => (value === undefined || value === null || value === '' ? null : Number(value));
function frameDom(shell) {
  const root = shell?.querySelector('.canvas-root');
  return {
    rootRevision: revisionValue(root?.dataset.renderedRevision),
    requestedRevision: revisionValue(root?.dataset.requestedRevision),
    inkRevision: revisionValue(shell?.querySelector('.ink-world')?.dataset.renderedRevision),
    miniMapRevision: revisionValue(shell?.querySelector('.mini-ink')?.dataset.renderedRevision),
  };
}

function SpeculativeGenerationBarrier({ active, onRender }) {
  if (!active) return null;
  queueMicrotask(onRender);
  throw NEVER_SETTLES;
}

function createExporterController() {
  let mode = 'fail';
  let scenario = 'cold-error';
  let delayed = [];
  const calls = [];
  return {
    configure(nextMode, nextScenario) {
      mode = nextMode;
      scenario = nextScenario;
    },
    calls: () => calls.map(call => ({ ...call })),
    exportToSvg({ revision, attempt, kind, elements, options, delegate }) {
      const call = {
        scenario, mode, revision, attempt, kind,
        elementIds: elements.map(item => item.id),
        at: performance.now(),
      };
      calls.push(call);
      if (kind !== 'group' || mode === 'pass') return delegate(options);
      if (mode === 'fail') return Promise.reject(new Error(`${scenario} export rejected at attempt ${attempt}`));
      return new Promise((resolve, reject) => {
        delayed.push({ resolve, reject, delegate, options });
      });
    },
    async releaseDelayed() {
      const releases = delayed;
      delayed = [];
      await Promise.all(releases.map(async item => {
        try { item.resolve(await item.delegate(item.options)); } catch (error) { item.reject(error); }
      }));
    },
  };
}

const apiResources = () => performance.getEntriesByType('resource')
  .map(entry => entry.name)
  .filter(name => {
    try { return new URL(name).pathname.startsWith('/api'); } catch { return false; }
  });
const retryEvidence = calls => ({
  attempts: calls.map(call => call.attempt),
  delaysMs: calls.slice(1).map((call, index) => call.at - calls[index].at),
  expectedDelaysMs: [40, 80],
});
const retryTimingObserved = trace => trace.attempts.join(',') === '1,2,3'
  && trace.delaysMs.length === 2 && trace.delaysMs[0] >= 30 && trace.delaysMs[1] >= 65;

function InteractionCanvas() {
  const [canvas, setCanvas] = useState(INITIAL_CANVAS);
  const [layout, setLayout] = useState(INITIAL_LAYOUT);
  const [selectedKey, setSelectedKey] = useState(null);
  const [expanded, setExpanded] = useState(new Set());
  const [renderGeneration, setRenderGeneration] = useState('live');
  const [suiteResult, setSuiteResult] = useState(null);
  const shellRef = useRef(null);
  const frameTestProbeRef = useRef(null);
  const exporterControllerRef = useRef(null);
  const preflightRef = useRef(null);
  const suiteStartedRef = useRef(false);
  const concurrentHandledRef = useRef(false);
  const actionLogRef = useRef([]);
  const commitLogRef = useRef([]);
  const pointerUpAtRef = useRef(null);
  const openingTimerRef = useRef(null);
  const openingLatencyRef = useRef(null);
  const viewportRef = useRef('');
  const focusRef = useRef(() => {});
  const actionsRef = useRef({});
  const geometryPendingRef = useRef(false);
  if (!exporterControllerRef.current) exporterControllerRef.current = createExporterController();
  const sessionsByKey = useMemo(() => ({ [SESSION_KEY]: SESSION }), []);
  const inkExporterProbe = useMemo(() => ({
    exportToSvg: request => exporterControllerRef.current.exportToSvg(request),
  }), []);
  const flowCanvas = useMemo(() => ({
    ...canvas,
    drawing: renderGeneration === 'speculative-b' ? SPECULATIVE_ELEMENTS : canvas.drawing,
  }), [canvas, renderGeneration]);

  const record = useCallback((kind, payload) => {
    actionLogRef.current = [...actionLogRef.current, { kind, at: performance.now(), payload }].slice(-40);
  }, []);

  const onCanvasAction = useCallback(async (kind, payload) => {
    record(kind, payload);
    if (kind === 'drawingCommit') {
      const snapshot = { elements: payload.elements || [], files: payload.files || {} };
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

  // B 已执行 FlowCanvas render 后由 sibling 挂起；此时只调用 committed A 的 production open/exit。
  const onSpeculativeFlowCanvasRendered = useCallback(() => {
    if (concurrentHandledRef.current) return;
    concurrentHandledRef.current = true;
    queueMicrotask(async () => {
      try {
        const controller = exporterControllerRef.current;
        const before = frameTestProbeRef.current?.snapshot();
        const authorityStayedOnA = before?.requestedRevision === before?.renderedRevision
          && before?.hitRevision === before?.renderedRevision
          && before?.requestedElementIds.includes('fixture-landmark')
          && !before?.requestedElementIds.includes('concurrent-speculative-b');

        controller.configure('pass', 'opening');
        const openedOk = await withTimeout(
          frameTestProbeRef.current?.openDrawing('selection', 'fixture-landmark'),
          'production openDrawing',
        );
        const opened = await waitFor(() => {
          const state = frameTestProbeRef.current?.snapshot();
          return state?.penActive && state.drawVisible && !state.opening
            && state.renderedRevision > before.renderedRevision
            && !state.renderedElementIds.includes('fixture-landmark')
            && state.renderedElementIds.includes('fixture-witness') ? state : null;
        }, 'opening DOM-ready handoff');
        const openingEvent = opened.callbackEvents.find(event => event.type === 'ready'
          && event.source === 'ink-world' && event.revision === opened.renderedRevision);
        const openingExport = controller.calls().find(call => call.scenario === 'opening'
          && call.revision === opened.renderedRevision);
        const opening = {
          passed: openedOk === true && !!openingEvent && !!openingExport,
          fromRevision: before.renderedRevision,
          revision: opened.renderedRevision,
          event: openingEvent,
          export: openingExport,
        };

        controller.configure('pass', 'closing');
        const closedOk = await withTimeout(frameTestProbeRef.current?.exitDrawing(), 'production exitDrawing');
        const closed = await waitFor(() => {
          const state = frameTestProbeRef.current?.snapshot();
          return !state?.penActive && !state?.drawVisible && !state?.opening
            && state?.renderedRevision > opened.renderedRevision
            && state.renderedElementIds.includes('fixture-landmark')
            && state.renderedElementIds.includes('fixture-witness') ? state : null;
        }, 'closing DOM-ready handoff');
        const closingEvent = closed.callbackEvents.find(event => event.type === 'ready'
          && event.source === 'ink-world' && event.revision === closed.renderedRevision);
        const closingExport = controller.calls().find(call => call.scenario === 'closing'
          && call.revision === closed.renderedRevision);
        const closing = {
          passed: closedOk === true && !!closingEvent && !!closingExport,
          fromRevision: opened.renderedRevision,
          revision: closed.renderedRevision,
          event: closingEvent,
          export: closingExport,
        };

        controller.configure('pass', 'committed-c');
        flushSync(() => {
          setCanvas(current => ({ ...current, drawing: COMMITTED_ELEMENTS }));
          setRenderGeneration('committed-c');
        });
        const aligned = await waitFor(() => {
          const state = frameTestProbeRef.current?.snapshot();
          const dom = frameDom(shellRef.current);
          const revision = state?.requestedRevision;
          return state?.requestedElementIds.includes('concurrent-committed-c')
            && !state.requestedElementIds.includes('concurrent-speculative-b')
            && state.renderedRevision === revision && state.hitRevision === revision
            && dom.rootRevision === revision && dom.requestedRevision === revision
            && dom.inkRevision === revision && dom.miniMapRevision === revision
            ? { state, dom, revision } : null;
        }, 'root/MiniMap/ink-world/hit revision alignment');
        const concurrent = {
          passed: authorityStayedOnA && aligned.state.requestedElementIds.includes('concurrent-committed-c'),
          authorityStayedOnA,
          speculativeBRendered: true,
          speculativeBAbandoned: !aligned.state.requestedElementIds.includes('concurrent-speculative-b'),
        };
        concurrent.passed = concurrent.passed && concurrent.speculativeBRendered && concurrent.speculativeBAbandoned;
        const revision = {
          passed: opening.revision > opening.fromRevision
            && closing.revision > opening.revision
            && aligned.revision > closing.revision,
          finalRevision: aligned.revision,
          dom: aligned.dom,
        };
        const details = { ...preflightRef.current, concurrent, revision, opening, closing };
        const checks = Object.fromEntries(CHECK_NAMES.map(name => [name, details[name]?.passed === true]));
        setSuiteResult({ checks, details, callbackEvents: aligned.state.callbackEvents, exportCalls: controller.calls() });
      } catch (error) {
        const details = { ...preflightRef.current, fatal: error.message };
        const checks = Object.fromEntries(CHECK_NAMES.map(name => [name, details[name]?.passed === true]));
        setSuiteResult({ checks, details, callbackEvents: frameTestProbeRef.current?.snapshot()?.callbackEvents || [], exportCalls: exporterControllerRef.current.calls() });
      }
    });
  }, []);

  useEffect(() => {
    if (suiteStartedRef.current) return undefined;
    suiteStartedRef.current = true;
    let cancelled = false;
    (async () => {
      try {
        const controller = exporterControllerRef.current;
        const cold = await waitFor(() => {
          const state = frameTestProbeRef.current?.snapshot();
          return state?.framePhase === 'failed' && state.frameAttempt === 3 ? state : null;
        }, 'cold final export failure');
        const coldCalls = controller.calls().filter(call => call.scenario === 'cold-error');
        const coldTrace = retryEvidence(coldCalls);
        const coldErrors = cold.callbackEvents.filter(event => event.type === 'error'
          && event.source === 'ink-world' && event.revision === cold.requestedRevision);
        const coldError = {
          passed: cold.renderedRevision === null && cold.hitElementIds.length === 0
            && retryTimingObserved(coldTrace) && coldErrors.length === 3
            && coldErrors.at(-1)?.final === true && coldErrors.at(-1)?.willRetry === false,
          revision: cold.requestedRevision,
          phase: cold.framePhase,
          trace: coldTrace,
          events: coldErrors,
        };

        controller.configure('pass', 'cold-recovery');
        flushSync(() => setCanvas(current => ({ ...current, drawing: RECOVERY_ELEMENTS })));
        const recovered = await waitFor(() => {
          const state = frameTestProbeRef.current?.snapshot();
          return state?.framePhase === 'ready' && state.renderedElementIds.includes('warm-visible-a') ? state : null;
        }, 'cold recovery ready');

        controller.configure('fail', 'warm-error');
        flushSync(() => setCanvas(current => ({ ...current, drawing: WARM_TARGET_ELEMENTS })));
        const warm = await waitFor(() => {
          const state = frameTestProbeRef.current?.snapshot();
          return state?.framePhase === 'stale' && state.frameAttempt === 3 ? state : null;
        }, 'warm final export failure');
        const warmCalls = controller.calls().filter(call => call.scenario === 'warm-error');
        const warmTrace = retryEvidence(warmCalls);
        const warmErrors = warm.callbackEvents.filter(event => event.type === 'error'
          && event.source === 'ink-world' && event.revision === warm.requestedRevision);
        const warmError = {
          passed: warm.renderedRevision === recovered.renderedRevision
            && warm.hitRevision === recovered.renderedRevision
            && warm.renderedElementIds.includes('warm-visible-a')
            && !warm.renderedElementIds.includes('warm-failed-b')
            && retryTimingObserved(warmTrace) && warmErrors.length === 3
            && warmErrors.at(-1)?.final === true && warmErrors.at(-1)?.willRetry === false,
          requestedRevision: warm.requestedRevision,
          staleRevision: warm.renderedRevision,
          phase: warm.framePhase,
          trace: warmTrace,
          events: warmErrors,
        };

        controller.configure('delay', 'late-old');
        flushSync(() => setCanvas(current => ({ ...current, drawing: LATE_OLD_ELEMENTS })));
        const lateOldCall = await waitFor(() => controller.calls().find(call => call.scenario === 'late-old'), 'late export starts');
        controller.configure('pass', 'late-new');
        flushSync(() => setCanvas(current => ({ ...current, drawing: EDIT_ELEMENTS })));
        const lateNew = await waitFor(() => {
          const state = frameTestProbeRef.current?.snapshot();
          return state?.framePhase === 'ready'
            && state.renderedElementIds.includes('fixture-landmark')
            && state.renderedElementIds.includes('fixture-witness') ? state : null;
        }, 'newer frame wins delayed export');
        await controller.releaseDelayed();
        await nextFrame();
        await nextFrame();
        const afterLate = frameTestProbeRef.current?.snapshot();
        const lateReady = afterLate.callbackEvents.find(event => event.type === 'ready'
          && event.source === 'ink-world' && event.revision === lateOldCall.revision);
        const lateIsolation = {
          passed: !lateReady && afterLate.renderedRevision === lateNew.renderedRevision
            && afterLate.renderedElementIds.includes('fixture-landmark')
            && !afterLate.renderedElementIds.includes('late-old'),
          delayedRevision: lateOldCall.revision,
          winningRevision: lateNew.renderedRevision,
          lateReadyAccepted: !!lateReady,
        };

        preflightRef.current = { coldError, warmError, lateIsolation };
        if (!cancelled) startTransition(() => setRenderGeneration('speculative-b'));
      } catch (error) {
        if (!cancelled) {
          const details = { fatal: error.message };
          const checks = Object.fromEntries(CHECK_NAMES.map(name => [name, false]));
          setSuiteResult({ checks, details, callbackEvents: frameTestProbeRef.current?.snapshot()?.callbackEvents || [], exportCalls: exporterControllerRef.current.calls() });
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const publish = useCallback(() => {
    const drawing = canvas.drawing || [];
    const state = frameTestProbeRef.current?.snapshot();
    const dom = frameDom(shellRef.current);
    const errors = [...(window.__CANVAS_CONSOLE_ERRORS__ || [])];
    const warnings = [...(window.__CANVAS_CONSOLE_WARNINGS__ || [])];
    const pageErrors = [...(window.__CANVAS_PAGE_ERRORS__ || [])];
    const resources = apiResources();
    const checks = suiteResult?.checks || Object.fromEntries(CHECK_NAMES.map(name => [name, false]));
    const passed = CHECK_NAMES.every(name => checks[name] === true)
      && errors.length === 0 && warnings.length === 0 && pageErrors.length === 0 && resources.length === 0;
    const report = {
      mode: 'interaction',
      status: suiteResult ? (passed ? 'pass' : 'fail') : 'running',
      passed,
      checks,
      details: suiteResult?.details || null,
      callbackEvents: suiteResult?.callbackEvents || state?.callbackEvents || [],
      exportCalls: suiteResult?.exportCalls || exporterControllerRef.current.calls(),
      consoleErrors: errors,
      consoleWarnings: warnings,
      consoleTranscript: [...(window.__CANVAS_CONSOLE_TRANSCRIPT__ || [])],
      pageErrors,
      apiResources: resources,
      apiResourceCount: resources.length,
      renderedRevision: state?.renderedRevision ?? null,
      requestedRevision: state?.requestedRevision ?? null,
      hitRevision: state?.hitRevision ?? null,
      dom,
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
      pointerUpAt: pointerUpAtRef.current,
      drawingOpeningLatencyMs: openingLatencyRef.current,
    };
    window.__CANVAS_INTERACTION__ = report;
    const root = document.documentElement;
    root.dataset.acceptanceMode = 'interaction';
    root.dataset.interactionStatus = report.status;
    root.dataset.interactionPassed = String(report.passed);
    root.dataset.interactionChecks = JSON.stringify(report.checks);
    root.dataset.interactionConsoleErrors = String(report.consoleErrors.length);
    root.dataset.interactionConsoleWarnings = String(report.consoleWarnings.length);
    root.dataset.interactionPageErrors = String(report.pageErrors.length);
    root.dataset.interactionApiResources = String(report.apiResources.length);
    root.dataset.interactionReport = JSON.stringify(report);
  }, [canvas, selectedKey, suiteResult]);

  useEffect(() => { publish(); });
  useEffect(() => {
    window.addEventListener('canvas-acceptance-diagnostics', publish);
    return () => window.removeEventListener('canvas-acceptance-diagnostics', publish);
  }, [publish]);
  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return undefined;
    const readDom = () => {
      viewportRef.current = shell.querySelector('.react-flow__viewport')?.style.transform || '';
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
    observer.observe(shell, {
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'data-rendered-revision', 'data-requested-revision'],
    });
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
  h(Suspense, { fallback: h('div', { 'data-flow-suspended': 'true' }) },
    h(React.Fragment, null,
      h(FlowCanvas, {
        workspaces: WORKSPACES,
        sessionsByKey,
        edges: [],
        layout,
        canvas: flowCanvas,
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
        frameTestProbeRef,
        inkExporterProbe,
        onToggleExpand: target => setExpanded(current => {
          const next = new Set(current);
          if (next.has(target)) next.delete(target); else next.add(target);
          return next;
        }),
      }),
      h(SpeculativeGenerationBarrier, {
        active: renderGeneration === 'speculative-b',
        onRender: onSpeculativeFlowCanvasRendered,
      }))),
  h(UIHost),
  h('aside', { className: 'interaction-panel', 'data-interaction-panel': 'true' },
    h('strong', null, '4518 · LE-008 隔离审判'),
    h('span', null, suiteResult ? `结果：${Object.values(suiteResult.checks).every(Boolean) ? 'PASS' : 'FAIL'}` : '真实导出链运行中…'),
    h('span', null, `绘图 ${canvas.drawing.length} · commits ${commitLogRef.current.length}`),
    h('span', null, selectedKey ? `已选 ${selectedKey}` : '未选会话卡'),
  ));
}

export function mountInteractionFixture(target) {
  try { localStorage.vp = JSON.stringify({ x: 0, y: 0, zoom: 1 }); } catch { /* 4518 私有 origin 无法写也不影响隔离 */ }
  window.__CANVAS_INTERACTION_CONTRACT__ = Object.freeze({
    url: 'http://127.0.0.1:4518/?mode=interaction',
    read: 'window.__CANVAS_INTERACTION__',
    passWhen: [
      'passed === true',
      'checks.concurrent/revision/opening/closing/coldError/warmError/lateIsolation === true',
      'consoleErrors/consoleWarnings/pageErrors/apiResources are empty arrays',
    ],
  });
  createRoot(target).render(h(InteractionCanvas));
}
