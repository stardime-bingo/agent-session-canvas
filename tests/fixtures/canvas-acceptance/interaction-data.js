/**
 * [INPUT]: 依赖真实 FlowCanvas/UIHost、4518 synthetic 数据与只替换 Ink exporter 的故障探针
 * [OUTPUT]: 无 fetch 全内存交互画布；LE-012 drawingCommit receipt、七项自动链与按 run token/call 起点/closing revision 隔离的只读 rAF+timer 双时钟相机尾窗人工证伪
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
const CAMERA_TAIL_PROOF_TIMEOUT_MS = 20000;
const CAMERA_TAIL_OBSERVER_POLL_MS = 25;

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
  let runToken = null;
  let delayed = [];
  const calls = [];
  return {
    configure(nextMode, nextScenario, nextRunToken = null) {
      mode = nextMode;
      scenario = nextScenario;
      runToken = nextRunToken;
    },
    calls: () => calls.map(call => ({ ...call })),
    exportToSvg({ revision, attempt, kind, elements, options, delegate }) {
      const call = {
        callIndex: calls.length,
        scenario, runToken, mode, revision, attempt, kind,
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

function cameraTailRunCurrent(current, run) {
  return !!current && current === run && current.runToken === run?.runToken;
}

function cameraTailObservationStep(state, source, phase) {
  const validSource = source === 'raf' || source === 'timer' ? source : null;
  const rafTicks = (Number.isInteger(state?.rafTicks) ? state.rafTicks : 0) + (source === 'raf' ? 1 : 0);
  const timerTicks = (Number.isInteger(state?.timerTicks) ? state.timerTicks : 0) + (source === 'timer' ? 1 : 0);
  const capture = !!validSource && phase === 'resuming' && state?.resumingHandled !== true;
  return {
    resumingHandled: state?.resumingHandled === true || capture,
    observerSource: capture ? validSource : state?.observerSource || null,
    rafTicks,
    timerTicks,
    capture,
  };
}

function cancelCameraTailObservation(run) {
  if (!run) return;
  if (run.rafId != null) window.cancelAnimationFrame(run.rafId);
  run.rafId = null;
  if (run.pollId != null) window.clearTimeout(run.pollId);
  run.pollId = null;
  if (run.waitTimeoutId != null) window.clearTimeout(run.waitTimeoutId);
  run.waitTimeoutId = null;
}

function cameraTailCallForRun(calls, run) {
  if (!run || !Number.isInteger(run.callStartIndex) || !Number.isFinite(run.closingRevision)) return null;
  return calls.slice(run.callStartIndex).find(call => call.scenario === run.scenario
    && call.runToken === run.runToken
    && call.mode === 'delay'
    && call.kind === 'group'
    && call.revision === run.closingRevision) || null;
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
const finiteViewport = viewport => !!viewport
  && ['x', 'y', 'zoom'].every(key => Number.isFinite(viewport[key]));
const initialCameraTailProof = (status = 'idle', error = null) => ({
  status,
  passed: false,
  buttonArmed: false,
  fixtureDispatchedInput: false,
  phaseAtExit: null,
  resumingObserved: false,
  observerSource: null,
  armVisibility: null,
  captureVisibility: null,
  rafTicks: 0,
  timerTicks: 0,
  exitBeforeResumeReady: false,
  exportDelayed: false,
  exportReleased: false,
  cameraAlignDelta: 0,
  viewportWriteDelta: 0,
  shieldSamples: [],
  nodePointerDelta: 0,
  pointerActiveObserved: false,
  acquisitionDelta: 0,
  cleanupDelta: 0,
  final: null,
  error,
});

function InteractionCanvas() {
  const [canvas, setCanvas] = useState(INITIAL_CANVAS);
  const [layout, setLayout] = useState(INITIAL_LAYOUT);
  const [sceneToken, setSceneToken] = useState('fixture-scene-1');
  const [selectedKey, setSelectedKey] = useState(null);
  const [expanded, setExpanded] = useState(new Set());
  const [renderGeneration, setRenderGeneration] = useState('live');
  const [suiteResult, setSuiteResult] = useState(null);
  const [cameraTailStatus, setCameraTailStatus] = useState('idle');
  const shellRef = useRef(null);
  const frameTestProbeRef = useRef(null);
  const exporterControllerRef = useRef(null);
  const preflightRef = useRef(null);
  const suiteStartedRef = useRef(false);
  const concurrentHandledRef = useRef(false);
  const actionLogRef = useRef([]);
  const commitLogRef = useRef([]);
  const sceneTokenSequenceRef = useRef(1);
  const pointerUpAtRef = useRef(null);
  const openingTimerRef = useRef(null);
  const openingLatencyRef = useRef(null);
  const viewportRef = useRef('');
  const cameraShieldFramesRef = useRef(0);
  const nodePointerDownRef = useRef(0);
  const cameraTailProofRef = useRef(initialCameraTailProof());
  const cameraTailRunRef = useRef(null);
  const cameraTailRunTokenRef = useRef(0);
  const cameraTailMountedRef = useRef(true);
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
      if (!payload?.next || !payload?.previousSuccessful) {
        throw new Error('4518 drawingCommit requires { next, previousSuccessful }');
      }
      const snapshot = payload.next;
      commitLogRef.current = [...commitLogRef.current, {
        at: performance.now(),
        elements: snapshot.elements.map(item => ({ id: item.id, type: item.type, below: !!item.customData?.below })),
      }];
      setCanvas(current => ({ ...current, drawing: snapshot.elements, drawingFiles: snapshot.files }));
      const nextSceneToken = `fixture-scene-${++sceneTokenSequenceRef.current}`;
      setSceneToken(nextSceneToken);
      return {
        status: 'committed',
        sceneToken: nextSceneToken,
        drawing: snapshot.elements,
      };
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

  const writeCameraTailProof = useCallback((run, patch, status = null, replace = false) => {
    if (!cameraTailRunCurrent(cameraTailRunRef.current, run)) return false;
    const nextStatus = status || cameraTailProofRef.current.status;
    cameraTailProofRef.current = { ...(replace ? {} : cameraTailProofRef.current), ...patch, status: nextStatus };
    if (status && cameraTailMountedRef.current) setCameraTailStatus(status);
    return true;
  }, []);

  const cleanupCameraTailRun = useCallback(run => {
    if (!run) return Promise.resolve();
    if (run.cleanupPromise) return run.cleanupPromise;
    run.cancelled = true;
    run.cancelResolve?.();
    cancelCameraTailObservation(run);
    const controller = exporterControllerRef.current;
    controller.configure('pass', `${run.scenario}-cleanup`, run.runToken);
    run.cleanupPromise = Promise.resolve()
      .then(() => controller.releaseDelayed())
      .catch(error => { run.cleanupError = error?.message || String(error); });
    return run.cleanupPromise;
  }, []);

  const failCameraTailRun = useCallback(async (run, error) => {
    if (!run || run.finished) return;
    run.finished = true;
    await cleanupCameraTailRun(run);
    if (!cameraTailMountedRef.current || !cameraTailRunCurrent(cameraTailRunRef.current, run)) return;
    writeCameraTailProof(run, { passed: false, error: error?.message || String(error) }, 'FAIL');
  }, [cleanupCameraTailRun, writeCameraTailProof]);

  const finishCameraTailRun = useCallback(async run => {
    try {
      if (!cameraTailRunCurrent(cameraTailRunRef.current, run)) return;
      const controller = exporterControllerRef.current;
      const delayedCall = await (async () => {
        while (!run.cancelled && cameraTailRunCurrent(cameraTailRunRef.current, run)) {
          const production = frameTestProbeRef.current?.snapshot();
          if (production?.handoffPhase === 'closing' && Number.isFinite(production.handoffRevision)) {
            run.closingRevision = production.handoffRevision;
          }
          const call = cameraTailCallForRun(controller.calls(), run);
          if (call) return call;
          await nextFrame();
        }
        return null;
      })();
      if (!delayedCall || run.cancelled || !cameraTailRunCurrent(cameraTailRunRef.current, run)) return;
      const dirtySelectionExport = run.selectionHoleIds.some(id => delayedCall.elementIds.includes(id));
      if (!dirtySelectionExport) throw new Error(`${run.scenario} 未导出 selection closing 恢复的目标元素`);

      writeCameraTailProof(run, {
        exportDelayed: true,
        export: delayedCall,
        runToken: run.runToken,
        scenario: run.scenario,
        callStartIndex: run.callStartIndex,
        closingRevision: run.closingRevision,
      }, 'closing');
      const shieldSamples = [];
      for (let index = 0; index < 3; index++) {
        await nextFrame();
        if (run.cancelled || !cameraTailRunCurrent(cameraTailRunRef.current, run)) return;
        shieldSamples.push(frameTestProbeRef.current?.snapshot()?.cameraShield === true);
      }
      const held = frameTestProbeRef.current?.snapshot();
      const cameraAlignDelta = (held?.cameraAlignCount || 0) - run.baseline.cameraAlignCount;
      const viewportWriteDelta = (held?.cameraViewportWriteCount || 0) - run.baseline.cameraViewportWriteCount;
      const nodePointerDelta = nodePointerDownRef.current - run.baselineNodePointerDown;
      writeCameraTailProof(run, {
        shieldSamples,
        cameraAlignDelta,
        viewportWriteDelta,
        nodePointerDelta,
        pointerActiveObserved: cameraTailProofRef.current.pointerActiveObserved,
        acquisitionDelta: (held?.pointerAcquisitionCount || 0) - run.baseline.pointerAcquisitionCount,
        cleanupDelta: (held?.pointerCleanupCount || 0) - run.baseline.pointerCleanupCount,
      });
      if (!shieldSamples.every(Boolean)) throw new Error('delayed closing 未连续保持 3 帧输入盾');

      if (!cameraTailRunCurrent(cameraTailRunRef.current, run)) return;
      controller.configure('pass', `${run.scenario}-release`, run.runToken);
      await controller.releaseDelayed();
      if (run.cancelled || !cameraTailRunCurrent(cameraTailRunRef.current, run)) return;
      writeCameraTailProof(run, { exportReleased: true });

      const exitSettled = await Promise.race([run.exitPromise, run.cancelPromise]);
      if (run.cancelled || exitSettled?.cancelled || !cameraTailRunCurrent(cameraTailRunRef.current, run)) return;
      if (!exitSettled?.ok) throw exitSettled?.error || new Error('production exitDrawing rejected');
      if (exitSettled.value !== true) throw new Error('production exitDrawing 未成功收口');

      const final = await (async () => {
        while (!run.cancelled && cameraTailRunCurrent(cameraTailRunRef.current, run)) {
          const state = frameTestProbeRef.current?.snapshot();
          if (state && !state.penActive && !state.opening && state.cameraPhase === 'live'
            && state.cameraShield === false && state.pointerResourceActive === false
            && finiteViewport(state.viewport)) return state;
          await nextFrame();
        }
        return null;
      })();
      if (!final || run.cancelled || !cameraTailRunCurrent(cameraTailRunRef.current, run)) return;

      const finalAlignDelta = final.cameraAlignCount - run.baseline.cameraAlignCount;
      const finalViewportWriteDelta = final.cameraViewportWriteCount - run.baseline.cameraViewportWriteCount;
      const acquisitionDelta = final.pointerAcquisitionCount - run.baseline.pointerAcquisitionCount;
      const cleanupDelta = final.pointerCleanupCount - run.baseline.pointerCleanupCount;
      const finalNodePointerDelta = nodePointerDownRef.current - run.baselineNodePointerDown;
      const finalSnapshot = {
        penActive: final.penActive,
        opening: final.opening,
        phase: final.cameraPhase,
        shield: final.cameraShield,
        pointerResourceActive: final.pointerResourceActive,
        viewport: final.viewport,
        viewportFinite: finiteViewport(final.viewport),
      };
      const proof = {
        ...cameraTailProofRef.current,
        cameraAlignDelta: finalAlignDelta,
        viewportWriteDelta: finalViewportWriteDelta,
        nodePointerDelta: finalNodePointerDelta,
        acquisitionDelta,
        cleanupDelta,
        final: finalSnapshot,
      };
      const failures = [
        proof.phaseAtExit !== 'resuming' && 'exit phase 不是 resuming',
        !proof.resumingObserved && '未观察到 resuming',
        !proof.exitBeforeResumeReady && 'exit 未抢在 resume-ready 前',
        proof.cameraAlignDelta !== 1 && 'camera align 增量不是 1',
        !(proof.viewportWriteDelta > 0) && '没有 RF viewport 写入',
        proof.nodePointerDelta !== 0 && '输入穿透到节点',
        !(proof.acquisitionDelta > 0) && '没有真实 pointer 资源获取',
        proof.cleanupDelta !== proof.acquisitionDelta && 'pointer 获取与 cleanup 未配平',
        proof.shieldSamples.length < 3 || !proof.shieldSamples.every(Boolean) ? '输入盾连续帧不足' : false,
        !proof.exportDelayed && 'dirty closing export 未 delay',
        !proof.exportReleased && 'delayed export 未 release',
        !proof.final?.viewportFinite && '最终 viewport 非有限数',
      ].filter(Boolean);
      if (failures.length) throw new Error(failures.join('；'));

      run.finished = true;
      writeCameraTailProof(run, { ...proof, passed: true, error: null }, 'PASS');
      await cleanupCameraTailRun(run);
    } catch (error) {
      await failCameraTailRun(run, error);
    }
  }, [cleanupCameraTailRun, failCameraTailRun, writeCameraTailProof]);

  const armCameraTailProof = useCallback(async () => {
    const previous = cameraTailRunRef.current;
    if (previous) await cleanupCameraTailRun(previous);
    const controller = exporterControllerRef.current;
    const runToken = ++cameraTailRunTokenRef.current;
    const run = {
      runToken,
      scenario: `camera-tail-exit-${runToken}`,
      callStartIndex: controller.calls().length,
      closingRevision: null,
      cancelled: false,
      finished: false,
      resumingHandled: false,
      observerSource: null,
      rafTicks: 0,
      timerTicks: 0,
      rafId: null,
      pollId: null,
      waitTimeoutId: null,
      cleanupPromise: null,
    };
    run.cancelPromise = new Promise(resolve => { run.cancelResolve = () => resolve({ cancelled: true }); });
    cameraTailRunRef.current = run;
    const state = frameTestProbeRef.current?.snapshot();
    const renderedIds = new Set(state?.renderedElementIds || []);
    const selectionHoleIds = (canvas.drawing || [])
      .filter(item => !item.isDeleted && !renderedIds.has(item.id))
      .map(item => item.id);
    const baseSuitePassed = !!suiteResult
      && CHECK_NAMES.every(name => suiteResult.checks?.[name] === true);
    const eligible = baseSuitePassed && state?.penActive === true && state?.drawVisible === true
      && state?.opening === false && state?.cameraPhase === 'live'
      && state?.framePhase === 'ready' && selectionHoleIds.length > 0;
    if (!eligible) {
      run.finished = true;
      writeCameraTailProof(run, {
        ...initialCameraTailProof('FAIL',
          '请先等七项基础验收 PASS，再用「选绘图」命中 synthetic 形状并等局部 selection 事务进入 live'),
        runToken: run.runToken,
        scenario: run.scenario,
        callStartIndex: run.callStartIndex,
      }, 'FAIL', true);
      await cleanupCameraTailRun(run);
      return;
    }

    run.baseline = state;
    run.baselineNodePointerDown = nodePointerDownRef.current;
    run.selectionHoleIds = selectionHoleIds;
    run.armVisibility = {
      visibilityState: document.visibilityState,
      hasFocus: document.hasFocus(),
    };
    controller.configure('pass', `${run.scenario}-armed`, run.runToken);
    writeCameraTailProof(run, {
      ...initialCameraTailProof('armed'),
      buttonArmed: true,
      selectionHoleIds,
      runToken: run.runToken,
      scenario: run.scenario,
      callStartIndex: run.callStartIndex,
      armVisibility: run.armVisibility,
    }, 'armed', true);
    run.waitTimeoutId = window.setTimeout(() => {
      if (!cameraTailRunCurrent(cameraTailRunRef.current, run)) return;
      void failCameraTailRun(run, new Error('尾窗证伪超时：未在真实手工具导航后观察到 resuming/closing 收口'));
    }, CAMERA_TAIL_PROOF_TIMEOUT_MS);

    const observe = (activeRun, source) => {
      if (activeRun !== run) return;
      if (run.cancelled || run.finished || !cameraTailRunCurrent(cameraTailRunRef.current, run)) return;
      const current = frameTestProbeRef.current?.snapshot();
      const observation = cameraTailObservationStep(run, source, current?.cameraPhase);
      run.rafTicks = observation.rafTicks;
      run.timerTicks = observation.timerTicks;
      if (current?.pointerResourceActive && !cameraTailProofRef.current.pointerActiveObserved) {
        writeCameraTailProof(run, { pointerActiveObserved: true });
      }
      if (!observation.capture) return;
      run.resumingHandled = observation.resumingHandled;
      run.observerSource = observation.observerSource;
      const captureVisibility = {
        visibilityState: document.visibilityState,
        hasFocus: document.hasFocus(),
      };
      cancelCameraTailObservation(run);
      controller.configure('delay', run.scenario, run.runToken);
      writeCameraTailProof(run, {
        phaseAtExit: current.cameraPhase,
        resumingObserved: true,
        observerSource: run.observerSource,
        armVisibility: run.armVisibility,
        captureVisibility,
        rafTicks: run.rafTicks,
        timerTicks: run.timerTicks,
        cameraAlignDelta: current.cameraAlignCount - run.baseline.cameraAlignCount,
        viewportWriteDelta: current.cameraViewportWriteCount - run.baseline.cameraViewportWriteCount,
      }, 'resuming');
      const exitAttempt = frameTestProbeRef.current?.exitDrawing();
      const afterExit = frameTestProbeRef.current?.snapshot();
      run.exitPromise = Promise.resolve(exitAttempt).then(
        value => ({ ok: true, value }),
        error => ({ ok: false, error }),
      );
      writeCameraTailProof(run, {
        exitBeforeResumeReady: current.cameraPhase === 'resuming'
          && afterExit?.cameraPhase === 'live'
          && afterExit?.cameraAlignCount === current.cameraAlignCount,
      });
      void finishCameraTailRun(run);
    };
    const scheduleRaf = () => {
      run.rafId = requestAnimationFrame(() => {
        run.rafId = null;
        observe(run, 'raf');
        if (!run.cancelled && !run.finished && !run.resumingHandled
          && cameraTailRunCurrent(cameraTailRunRef.current, run)) scheduleRaf();
      });
    };
    const schedulePoll = () => {
      run.pollId = window.setTimeout(() => {
        run.pollId = null;
        observe(run, 'timer');
        if (!run.cancelled && !run.finished && !run.resumingHandled
          && cameraTailRunCurrent(cameraTailRunRef.current, run)) schedulePoll();
      }, CAMERA_TAIL_OBSERVER_POLL_MS);
    };
    scheduleRaf();
    schedulePoll();
  }, [canvas.drawing, cleanupCameraTailRun, failCameraTailRun, finishCameraTailRun, suiteResult, writeCameraTailProof]);

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
      manualProof: {
        cameraTailExit: cameraTailProofRef.current,
      },
      manualPassWhen: [
        'cameraTailExit.status/passed === PASS/true',
        'buttonArmed === true and fixtureDispatchedInput === false',
        'phaseAtExit === resuming and exitBeforeResumeReady === true',
        'dirty export delayed/released; >=3 consecutive shield samples are true',
        'align delta === 1; pointer acquisition/cleanup balanced; final live and finite',
      ],
      camera: {
        phase: state?.cameraPhase || null,
        shield: !!state?.cameraShield,
        shieldFrames: cameraShieldFramesRef.current,
        alignCount: state?.cameraAlignCount || 0,
        viewportWriteCount: state?.cameraViewportWriteCount || 0,
        pointerAcquisitionCount: state?.pointerAcquisitionCount || 0,
        pointerCleanupCount: state?.pointerCleanupCount || 0,
        pointerResourceActive: !!state?.pointerResourceActive,
        viewport: state?.viewport || null,
        zoomControlCount: shellRef.current?.querySelectorAll('[data-drawing-zoom]').length || 0,
        nodePointerDown: nodePointerDownRef.current,
      },
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
    root.dataset.cameraTailStatus = cameraTailStatus;
    root.dataset.interactionReport = JSON.stringify(report);
  }, [cameraTailStatus, canvas, selectedKey, suiteResult]);

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
      if (root?.querySelector('[data-drawing-camera-shield]')) cameraShieldFramesRef.current++;
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
  useEffect(() => {
    cameraTailMountedRef.current = true;
    return () => {
      cameraTailMountedRef.current = false;
      const run = cameraTailRunRef.current;
      if (run) void cleanupCameraTailRun(run);
      if (openingTimerRef.current != null) window.clearTimeout(openingTimerRef.current);
    };
  }, [cleanupCameraTailRun]);

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

  const onPointerDownCapture = useCallback(event => {
    if (event.target.closest?.('.react-flow__node')) nodePointerDownRef.current++;
  }, []);

  return h('div', {
    ref: shellRef,
    className: 'fixture-interaction',
    onPointerDownCapture,
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
        sceneToken,
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
    h('strong', null, '4518 · 绘图融合隔离审判'),
    h('span', null, suiteResult ? `结果：${Object.values(suiteResult.checks).every(Boolean) ? 'PASS' : 'FAIL'}` : '真实导出链运行中…'),
    h('button', {
      type: 'button',
      'data-camera-tail-exit-arm': 'true',
      disabled: ['armed', 'resuming', 'closing'].includes(cameraTailStatus),
      onClick: armCameraTailProof,
      style: { pointerEvents: 'auto', minHeight: 30 },
    }, `尾窗证伪：${cameraTailStatus}`),
    h('span', { 'data-camera-tail-status': cameraTailStatus },
      cameraTailStatus === 'idle'
        ? '先用选绘图打开 synthetic 形状，再武装并用真实手工具拖动'
        : cameraTailStatus === 'armed' ? 'watcher 已武装，等待真实手工具导航'
          : cameraTailStatus === 'resuming' ? '已捕捉 resuming，同步退出'
            : cameraTailStatus === 'closing' ? 'dirty closing 已延迟，正在采样输入盾'
              : cameraTailProofRef.current.error || `尾窗证伪 ${cameraTailStatus}`),
    h('span', null, `绘图 ${canvas.drawing.length} · commits ${commitLogRef.current.length}`),
    h('span', null, selectedKey ? `已选 ${selectedKey}` : '未选会话卡'),
  ));
}

export function mountInteractionFixture(target) {
  try { localStorage.vp = JSON.stringify({ x: 0, y: 0, zoom: 1 }); } catch { /* 4518 私有 origin 无法写也不影响隔离 */ }
  window.__CANVAS_INTERACTION_CONTRACT__ = Object.freeze({
    url: 'http://127.0.0.1:4518/?mode=interaction',
    read: 'window.__CANVAS_INTERACTION__',
    computerUseEvidence: Object.freeze({
      source: 'current screenshot',
      diagnosticsSource: 'read-only CDP window.__CANVAS_INTERACTION__',
      stagesPerRound: Object.freeze(['address', 'selection', 'tail']),
      rounds: 3,
      artifactKind: 'computer-use-screenshot',
    }),
    passWhen: [
      'passed === true',
      'checks.concurrent/revision/opening/closing/coldError/warmError/lateIsolation === true',
      'consoleErrors/consoleWarnings/pageErrors/apiResources are empty arrays',
    ],
    manualPassWhen: [
      'manualProof.cameraTailExit.status === PASS and passed === true',
      'Computer Use opens selection and performs the real hand-tool drag; fixture dispatches no input',
    ],
  });
  createRoot(target).render(h(InteractionCanvas));
}
