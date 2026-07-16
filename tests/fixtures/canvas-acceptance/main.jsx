/**
 * [INPUT]: 4518 query(mode=performance|interaction, size=300|800, autorun=0|1) 与真实画布组件
 * [OUTPUT]: paint 后性能报告/探针（含 DOM/rendered world revision 原子交接与 300/800 hole 开合局部分组指标）；interaction 动态加载真实 FlowCanvas 全内存验收页并共享 console/page error 原始 transcript
 * [POS]: 无 API/无持久化的画布验收路由；performance 首屏闭包不静态引入 FlowCanvas
 * [PROTOCOL]: 变更时更新此头部，然后检查 README/web/CLAUDE.md
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ReactFlow, ReactFlowProvider } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import '../../../web/src/theme.css';
import {
  ACCEPTANCE_REDLINES, ACCEPTANCE_SAMPLES, createCanvasAcceptanceElements, mutateBelowPlane, mutateEarlyUniqueText,
} from './fixture-data.js';
import InkWorldLayer from '../../../web/src/canvas/InkWorldLayer.jsx';

const BOOT_STARTED = performance.now();
const params = new URLSearchParams(location.search);
const MODE = params.get('mode') === 'interaction' ? 'interaction' : 'performance';
const SIZE = Number(params.get('size')) === 800 ? 800 : 300;
const AUTORUN = params.get('autorun') !== '0';
const LONG_TASKS = [];
const PAGE_ERRORS = [];
const CONSOLE_ERRORS = [];
const CONSOLE_WARNINGS = [];
const CONSOLE_TRANSCRIPT = [];
window.__CANVAS_PAGE_ERRORS__ = PAGE_ERRORS;
window.__CANVAS_CONSOLE_ERRORS__ = CONSOLE_ERRORS;
window.__CANVAS_CONSOLE_WARNINGS__ = CONSOLE_WARNINGS;
window.__CANVAS_CONSOLE_TRANSCRIPT__ = CONSOLE_TRANSCRIPT;
const originalConsoleError = console.error.bind(console);
const originalConsoleWarn = console.warn.bind(console);
const notifyDiagnosticsChanged = () => window.dispatchEvent(new Event('canvas-acceptance-diagnostics'));
const consoleValue = value => {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value); } catch { return String(value); }
};
const captureConsole = (level, args) => {
  const entry = { level, at: performance.now(), args: args.map(consoleValue) };
  CONSOLE_TRANSCRIPT.push(entry);
  (level === 'error' ? CONSOLE_ERRORS : CONSOLE_WARNINGS).push(entry);
  notifyDiagnosticsChanged();
};
console.error = (...args) => {
  captureConsole('error', args);
  originalConsoleError(...args);
};
console.warn = (...args) => {
  captureConsole('warn', args);
  originalConsoleWarn(...args);
};
const LONG_TASK_SUPPORTED = PerformanceObserver.supportedEntryTypes?.includes('longtask') === true;
const probe = { status: 'booting', report: null, run: null };
window.__CANVAS_ACCEPTANCE__ = probe;

if (LONG_TASK_SUPPORTED) {
  new PerformanceObserver(list => {
    for (const entry of list.getEntries()) LONG_TASKS.push({ startTime: entry.startTime, duration: entry.duration });
  }).observe({ type: 'longtask', buffered: true });
}
window.addEventListener('error', event => {
  PAGE_ERRORS.push(event.message || event.error?.message || 'window error');
  notifyDiagnosticsChanged();
});
window.addEventListener('unhandledrejection', event => {
  PAGE_ERRORS.push(String(event.reason?.message || event.reason));
  notifyDiagnosticsChanged();
});

const p95 = values => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
};
const summarize = values => ({ p95: p95(values), max: values.length ? Math.max(...values) : 0 });
const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));
const afterPaint = async () => {
  await nextFrame();
  await nextFrame();
};
const ProbeNode = () => <div data-flow-anchor="true" />;

async function measureViewportDrift(instance) {
  const drift = [], frameGaps = [];
  let last = performance.now();
  for (let index = 0; index < 60; index++) {
    await instance.setViewport({
      x: 40 + Math.sin(index / 5) * 130,
      y: 55 + Math.cos(index / 7) * 100,
      zoom: 0.3 + (index % 20) * 0.025,
    }, { duration: 0 });
    await nextFrame();
    const now = performance.now();
    frameGaps.push(now - last);
    last = now;
    const ink = document.querySelector('[data-ink-plane="below"]')?.getBoundingClientRect();
    const node = document.querySelector('.react-flow__node[data-id="probe"]')?.getBoundingClientRect();
    if (ink && node) drift.push(Math.max(Math.abs(ink.left - node.left), Math.abs(ink.top - node.top)));
  }
  return { drift: summarize(drift), frameGaps: summarize(frameGaps), samples: drift.length };
}

function AcceptanceCanvas() {
  const initialElements = useMemo(() => createCanvasAcceptanceElements(SIZE), []);
  const initialWorld = useRef({ elements: initialElements, files: {}, excludedIds: [], revision: 1 });
  const worldRef = useRef(initialWorld.current);
  const revisionRef = useRef(1);
  const waitersRef = useRef(new Map());
  const settlingRevisionsRef = useRef(new Set());
  const readiesRef = useRef([]);
  const instanceRef = useRef(null);
  const runSuiteRef = useRef(null);
  const startedRef = useRef(false);
  const [world, setWorld] = useState(initialWorld.current);
  const [view, setView] = useState({ status: 'booting', report: null });
  const nodeTypes = useMemo(() => ({ probe: ProbeNode }), []);
  const nodes = useMemo(() => [{
    id: 'probe', type: 'probe', position: { x: -8, y: -8 }, data: {},
    style: { width: 1, height: 1, padding: 0, border: 0 }, selectable: false, draggable: false,
  }], []);

  const publish = useCallback((status, report) => {
    probe.status = status;
    probe.report = report;
    document.documentElement.dataset.acceptanceStatus = status;
    document.documentElement.dataset.acceptanceSize = String(SIZE);
    document.documentElement.dataset.acceptanceReport = JSON.stringify(report || {});
    setView({ status, report });
    if (status === 'pass' || status === 'fail' || status === 'error') {
      window.dispatchEvent(new CustomEvent('canvas-acceptance-complete', { detail: report }));
    }
  }, []);

  const requestSnapshot = useCallback((elements, kind, started = performance.now(), excludedIds = []) => {
    const revision = ++revisionRef.current;
    const next = { elements, files: {}, excludedIds, revision };
    worldRef.current = next;
    return new Promise(resolve => {
      waitersRef.current.set(revision, { kind, started, resolve });
      setWorld(next);
    });
  }, []);

  const onSnapshotReady = useCallback((revision, metrics, renderedWorld) => {
    if (settlingRevisionsRef.current.has(revision)) return;
    const waiter = waitersRef.current.get(revision);
    if (!waiter) return;
    settlingRevisionsRef.current.add(revision);
    waitersRef.current.delete(revision);
    const domReadyAt = performance.now();
    afterPaint().then(() => {
      const paintSampleAt = performance.now();
      const domRevision = Number(document.querySelector('.ink-world')?.dataset.renderedRevision);
      const result = {
        revision, kind: waiter?.kind || 'untracked', metrics,
        renderedRevision: renderedWorld?.revision,
        domRevision,
        renderedElementCount: renderedWorld?.elements?.length,
        atomic: renderedWorld?.revision === revision && domRevision === revision,
        sampledAfterPaint: true,
        timingBoundary: 'dom-ready+double-rAF-paint',
        domReadyAt,
        paintSampleAt,
        started: waiter?.started ?? paintSampleAt,
        ended: paintSampleAt,
        duration: paintSampleAt - (waiter?.started ?? paintSampleAt),
      };
      readiesRef.current.push(result);
      settlingRevisionsRef.current.delete(revision);
      document.documentElement.dataset.lastReady = JSON.stringify(result);
      waiter.resolve(result);
      if (waiter.kind === 'cold-join' && AUTORUN && !startedRef.current) {
        setTimeout(() => runSuiteRef.current?.(result), 0);
      }
    });
  }, []);

  const onSnapshotError = useCallback((revision, error, result) => {
    if (result?.final === false) return;
    publish('error', { size: SIZE, revision, error: error.message, pageErrors: PAGE_ERRORS });
  }, [publish]);

  const runSuite = useCallback(async cold => {
    if (startedRef.current) return probe.report;
    startedRef.current = true;
    publish('running', { size: SIZE, phase: 'warm snapshots' });
    const readyReuse = await requestSnapshot(worldRef.current.elements, 'ready-reuse');
    const holeTarget = worldRef.current.elements.find(element => element.customData?.below && element.type !== 'text');
    const holeOpen = await requestSnapshot(worldRef.current.elements, 'hole-open', performance.now(), [holeTarget.id]);
    const holeClose = await requestSnapshot(worldRef.current.elements, 'hole-close');
    const warm = [];
    let elements = worldRef.current.elements;
    for (let index = 0; index < ACCEPTANCE_SAMPLES; index++) {
      elements = mutateBelowPlane(elements, index);
      warm.push(await requestSnapshot(elements, `warm-${index + 1}`));
    }
    elements = mutateEarlyUniqueText(elements);
    const fontChange = await requestSnapshot(elements, 'font-change');
    const fontReadyReuse = await requestSnapshot(elements, 'font-ready-reuse');
    await new Promise(resolve => setTimeout(resolve, 80));
    const drift = await measureViewportDrift(instanceRef.current);
    const durations = warm.map(sample => sample.duration);
    const warmWindow = { start: warm[0].started, end: warm.at(-1).ended };
    const warmLongTasks = LONG_TASKS.filter(task => task.startTime >= warmWindow.start && task.startTime <= warmWindow.end + 20);
    const coldLongTasks = LONG_TASKS.filter(task => task.startTime >= BOOT_STARTED && task.startTime <= cold.ended + 20);
    const redline = ACCEPTANCE_REDLINES[SIZE];
    const warmSummary = summarize(durations);
    const metricsCorrect = warm.every(sample => (
      sample.metrics?.exported?.join(',') === 'below'
      && sample.metrics?.joined?.length === 0
      && sample.metrics?.reused?.join(',') === 'above'
      && sample.metrics?.font?.reused === 1
    ));
    const groupMetricsCorrect = warm.every(sample => {
      const below = sample.metrics?.groupCounts?.below;
      const above = sample.metrics?.groupCounts?.above;
      return below?.exported === 1 && below?.joined === 0 && below?.reused === below?.total - 1
        && above?.exported === 0 && above?.joined === 0 && above?.reused === above?.total;
    });
    const coldGroups = cold.metrics?.groupCounts;
    const readyGroups = readyReuse.metrics?.groupCounts;
    const checks = {
      longTaskApi: LONG_TASK_SUPPORTED,
      cold: cold.duration <= redline.coldMax,
      coldJoinedWithoutDuplicate: cold.metrics?.exported?.length === 0
        && cold.metrics?.joined?.includes('below') && cold.metrics?.joined?.includes('above')
        && coldGroups?.below?.joined === coldGroups?.below?.total && coldGroups?.below?.total > 1
        && coldGroups?.above?.joined === coldGroups?.above?.total && coldGroups?.above?.total > 1
        && cold.metrics?.font?.joined === 1,
      readyReuse: readyReuse.metrics?.exported?.length === 0
        && readyReuse.metrics?.joined?.length === 0 && readyReuse.metrics?.reused?.length === 2
        && readyGroups?.below?.reused === readyGroups?.below?.total
        && readyGroups?.above?.reused === readyGroups?.above?.total
        && readyReuse.metrics?.font?.reused === 1,
      renderedRevisionAtomic: [cold, readyReuse, holeOpen, holeClose, ...warm, fontChange, fontReadyReuse]
        .every(sample => sample.atomic && sample.renderedRevision === sample.revision && sample.domRevision === sample.revision),
      sampledAfterPaint: [cold, readyReuse, holeOpen, holeClose, ...warm, fontChange, fontReadyReuse]
        .every(sample => sample.sampledAfterPaint === true),
      holeOpenCloseLocal: [holeOpen, holeClose].every(sample => {
        const below = sample.metrics?.groupCounts?.below;
        const above = sample.metrics?.groupCounts?.above;
        return below?.exported === 1 && below?.joined === 0 && below?.reused === below?.total - 1
          && above?.exported === 0 && above?.joined === 0 && above?.reused === above?.total
          && sample.metrics?.font?.reused === 1;
      }) && holeOpen.renderedElementCount === SIZE - 1 && holeClose.renderedElementCount === SIZE,
      singleDirtyPlane: metricsCorrect,
      singleDirtyGroup: groupMetricsCorrect,
      fontCapsuleDirty: fontChange.metrics?.font?.exported === 1
        && fontChange.metrics?.exported?.join(',') === 'below',
      fontCapsuleReady: fontReadyReuse.metrics?.font?.reused === 1
        && fontReadyReuse.metrics?.exported?.length === 0
        && fontReadyReuse.metrics?.reused?.length === 2,
      warmP95: warmSummary.p95 <= redline.warmP95,
      warmMax: warmSummary.max <= redline.warmMax,
      warmLongTask: Math.max(0, ...warmLongTasks.map(task => task.duration)) <= redline.longTaskMax,
      viewportDrift: drift.samples === 60 && drift.drift.p95 <= ACCEPTANCE_REDLINES.driftP95
        && drift.drift.max <= ACCEPTANCE_REDLINES.driftMax,
      frameCadence: drift.frameGaps.p95 <= ACCEPTANCE_REDLINES.rafP95
        && drift.frameGaps.max <= ACCEPTANCE_REDLINES.rafMax,
      pageErrors: PAGE_ERRORS.length === 0,
      consoleErrors: CONSOLE_ERRORS.length === 0,
      consoleWarnings: CONSOLE_WARNINGS.length === 0,
    };
    const report = {
      size: SIZE,
      samples: ACCEPTANCE_SAMPLES,
      longTaskSupported: LONG_TASK_SUPPORTED,
      redline,
      cold: { duration: cold.duration, metrics: cold.metrics, longTasks: coldLongTasks },
      readyReuse: { duration: readyReuse.duration, metrics: readyReuse.metrics },
      holeOpen: { duration: holeOpen.duration, metrics: holeOpen.metrics, renderedElementCount: holeOpen.renderedElementCount },
      holeClose: { duration: holeClose.duration, metrics: holeClose.metrics, renderedElementCount: holeClose.renderedElementCount },
      fontChange: { duration: fontChange.duration, metrics: fontChange.metrics },
      fontReadyReuse: { duration: fontReadyReuse.duration, metrics: fontReadyReuse.metrics },
      warm: { ...warmSummary, samples: warm.map(sample => ({ duration: sample.duration, metrics: sample.metrics })), longTasks: warmLongTasks },
      groupCounts: {
        cold: cold.metrics?.groupCounts,
        readyReuse: readyReuse.metrics?.groupCounts,
        holeOpen: holeOpen.metrics?.groupCounts,
        holeClose: holeClose.metrics?.groupCounts,
        warm: warm.map(sample => sample.metrics?.groupCounts),
      },
      viewport: drift,
      checks,
      readies: readiesRef.current.length,
      pageErrors: [...PAGE_ERRORS],
      consoleErrors: [...CONSOLE_ERRORS],
      consoleWarnings: [...CONSOLE_WARNINGS],
    };
    const status = Object.values(checks).every(Boolean) ? 'pass' : 'fail';
    publish(status, report);
    return report;
  }, [publish, requestSnapshot]);
  runSuiteRef.current = runSuite;
  probe.run = () => runSuiteRef.current?.(readiesRef.current.find(item => item.kind === 'cold-join'));

  useEffect(() => {
    publish('running', { size: SIZE, phase: 'cold join' });
    const timer = setTimeout(() => { requestSnapshot(worldRef.current.elements, 'cold-join', BOOT_STARTED); }, 0);
    return () => clearTimeout(timer);
  }, [publish, requestSnapshot]);

  return (
    <div className="fixture-shell">
      <div className="fixture-flow">
        <ReactFlow
          nodes={nodes}
          edges={[]}
          nodeTypes={nodeTypes}
          onInit={instance => { instanceRef.current = instance; }}
          defaultViewport={{ x: 40, y: 55, zoom: 0.35 }}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          panOnDrag={false}
          panOnScroll={false}
          zoomOnScroll={false}
          zoomOnPinch={false}
          zoomOnDoubleClick={false}
          proOptions={{ hideAttribution: true }}
        >
          <InkWorldLayer
            elements={world.elements}
            files={world.files}
            excludedIds={world.excludedIds}
            revision={world.revision}
            onSnapshotReady={onSnapshotReady}
            onSnapshotError={onSnapshotError}
          />
        </ReactFlow>
      </div>
      <aside className="fixture-panel" data-acceptance-panel="true">
        <h1>Canvas acceptance · {SIZE} elements</h1>
        <span className="fixture-status" data-status={view.status}>{view.status}</span>
        <pre>{JSON.stringify(view.report, null, 2)}</pre>
      </aside>
    </div>
  );
}

if (MODE === 'interaction') {
  import('./interaction-data.js')
    .then(module => module.mountInteractionFixture(document.getElementById('root')))
    .catch(error => {
      PAGE_ERRORS.push(error.message);
      document.documentElement.dataset.interactionStatus = 'error';
      document.getElementById('root').textContent = `interaction fixture failed: ${error.message}`;
    });
} else {
  createRoot(document.getElementById('root')).render(
    <ReactFlowProvider><AcceptanceCanvas /></ReactFlowProvider>,
  );
}
