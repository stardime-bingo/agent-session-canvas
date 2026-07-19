/**
 * [INPUT]: 4518 query(mode=performance|interaction|performance-352|hero|handoff-choice|detail-busy|layout-quality, size=300|800) 与真实画布组件
 * [OUTPUT]: performance=InkLayer 直渲 N 元素的挂载、20 次更新帧与 DOM 完整性报告；
 *           interaction=动态加载真实 FlowCanvas 全内存验收页；performance-352=真实 FlowCanvas 拖动取证页；
 *           hero=production FlowCanvas 匿名产品截图页；handoff-choice=production 接力工具双入口；detail-busy=详情 AI 忙碌反馈；layout-quality=智能整理视觉/行为验收；
 *           共享 console/page error 原始 transcript
 * [POS]: 4518 验收夹具入口。自研墨迹后没有导出管线可测——渲染完整性、挂载与更新帧就是性能合同
 * [PROTOCOL]: 变更时更新此头部，然后检查 interaction-data/README/web/CLAUDE.md
 */
import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ReactFlow, ReactFlowProvider } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import '../../../web/src/theme.css';
import InkLayer from '../../../web/src/canvas/InkLayer.jsx';
import {
  ACCEPTANCE_REDLINES,
  ACCEPTANCE_SAMPLES,
  createCanvasAcceptanceElements,
  mutateBelowPlane,
  mutateEarlyUniqueText,
} from './fixture-data.js';

const params = new URLSearchParams(location.search);
const MODE = ['interaction', 'performance-352', 'hero', 'handoff-choice', 'detail-busy', 'layout-quality'].includes(params.get('mode'))
  ? params.get('mode')
  : 'performance';
const SIZE = Number(params.get('size')) === 800 ? 800 : 300;
const MOUNT_BUDGET_MS = Object.freeze({ 300: 900, 800: 1600 });

const PAGE_ERRORS = [];
const CONSOLE_ERRORS = [];
const CONSOLE_WARNINGS = [];
const CONSOLE_TRANSCRIPT = [];
window.__CANVAS_PAGE_ERRORS__ = PAGE_ERRORS;
window.__CANVAS_CONSOLE_ERRORS__ = CONSOLE_ERRORS;
window.__CANVAS_CONSOLE_WARNINGS__ = CONSOLE_WARNINGS;
window.__CANVAS_CONSOLE_TRANSCRIPT__ = CONSOLE_TRANSCRIPT;

for (const level of ['error', 'warn']) {
  const original = console[level].bind(console);
  console[level] = (...args) => {
    const entry = { level, at: performance.now(), text: args.map(String).join(' ') };
    CONSOLE_TRANSCRIPT.push(entry);
    (level === 'error' ? CONSOLE_ERRORS : CONSOLE_WARNINGS).push(entry.text);
    original(...args);
  };
}
window.addEventListener('error', event => PAGE_ERRORS.push(event.message));
window.addEventListener('unhandledrejection', event => PAGE_ERRORS.push(String(event.reason?.message || event.reason)));

const probe = { status: 'booting', report: null, run: null };
window.__CANVAS_ACCEPTANCE__ = probe;

const nextFrame = () => new Promise(resolve => requestAnimationFrame(resolve));
const percentile = (values, fraction) => {
  const ordered = [...values].sort((a, b) => a - b);
  return ordered[Math.min(ordered.length - 1, Math.max(0, Math.ceil(ordered.length * fraction) - 1))] || 0;
};

function PerformanceCanvas() {
  const [report, setReport] = useState({ size: SIZE, phase: 'mounting' });
  const startedRef = useRef(performance.now());
  const [elements, setElements] = useState(() => createCanvasAcceptanceElements(SIZE));

  useEffect(() => {
    let alive = true;
    const longTasks = [];
    let observer = null;
    try {
      observer = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) longTasks.push(entry.duration);
      });
      observer.observe({ type: 'longtask', buffered: true });
    } catch { /* verifier 会把不支持明确记入报告。 */ }

    const run = async () => {
      await nextFrame();
      await nextFrame();
      if (!alive) return;
      const domCount = document.querySelectorAll('[data-ink-element-id]').length;
      const expected = elements.filter(el => !el.isDeleted).length;
      const mountMs = Math.round(performance.now() - startedRef.current);
      const budgetMs = MOUNT_BUDGET_MS[SIZE];
      const updateFrames = [];
      let current = elements;
      for (let tick = 1; tick <= ACCEPTANCE_SAMPLES; tick++) {
        const started = performance.now();
        current = mutateBelowPlane(current, tick);
        if (tick === ACCEPTANCE_SAMPLES) current = mutateEarlyUniqueText(current);
        setElements(current);
        await nextFrame();
        updateFrames.push(performance.now() - started);
      }
      await nextFrame();
      for (const entry of observer?.takeRecords() || []) longTasks.push(entry.duration);
      const finalDomCount = document.querySelectorAll('[data-ink-element-id]').length;
      const earlyText = [...document.querySelectorAll('[data-ink-element-id] text')]
        .some(node => node.textContent === 'Early unique Z');
      const redline = ACCEPTANCE_REDLINES[SIZE];
      const warmP95Ms = percentile(updateFrames, 0.95);
      const warmMaxMs = Math.max(...updateFrames, 0);
      const maxLongTaskMs = Math.max(...longTasks, 0);
      const pass = domCount === expected && finalDomCount === expected && earlyText
        && mountMs <= budgetMs
        && warmP95Ms <= redline.warmP95 && warmMaxMs <= redline.warmMax
        && maxLongTaskMs <= redline.longTaskMax
        && CONSOLE_ERRORS.length === 0 && CONSOLE_WARNINGS.length === 0 && PAGE_ERRORS.length === 0;
      const final = {
        size: SIZE,
        domCount: finalDomCount,
        expected,
        mountMs,
        budgetMs,
        samples: updateFrames.length,
        warmP95Ms: Number(warmP95Ms.toFixed(3)),
        warmMaxMs: Number(warmMaxMs.toFixed(3)),
        maxLongTaskMs: Number(maxLongTaskMs.toFixed(3)),
        longTaskSupported: Boolean(observer),
        earlyTextUpdated: earlyText,
        redline,
        pass,
      };
      probe.status = pass ? 'complete' : 'fail';
      probe.report = final;
      document.documentElement.dataset.acceptanceStatus = pass ? 'pass' : 'fail';
      document.documentElement.dataset.acceptanceReport = JSON.stringify(final);
      setReport(final);
      window.dispatchEvent(new CustomEvent('canvas-acceptance-complete', { detail: final }));
    };
    void run();
    return () => { alive = false; observer?.disconnect(); };
  }, []); // 首次挂载后独立跑完 20 次；测试自身 setElements 不得重启套件

  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <ReactFlow nodes={[]} edges={[]} defaultViewport={{ x: 40, y: 40, zoom: 0.5 }} minZoom={0.05}>
        <InkLayer elements={elements} files={{}} selectedId={null} />
      </ReactFlow>
      <aside style={{
        position: 'fixed', right: 10, top: 10, zIndex: 99, background: '#fff',
        border: '1px solid #d0d5dd', borderRadius: 10, padding: 10, font: '12px ui-monospace',
      }}>
        <b>Canvas acceptance · {SIZE} elements</b>
        <span className="fixture-status" data-status={probe.status}> {probe.status}</span>
        <pre>{JSON.stringify(report, null, 2)}</pre>
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
} else if (MODE === 'performance-352') {
  import('./performance-352-data.js')
    .then(module => module.mountPerformance352Fixture(document.getElementById('root')))
    .catch(error => {
      PAGE_ERRORS.push(error.message);
      document.documentElement.dataset.performance352Status = 'error';
      document.getElementById('root').textContent = `performance fixture failed: ${error.message}`;
    });
} else if (MODE === 'hero') {
  import('./hero-data.js')
    .then(module => module.mountHeroFixture(document.getElementById('root')))
    .catch(error => {
      PAGE_ERRORS.push(error.message);
      document.documentElement.dataset.heroStatus = 'error';
      document.getElementById('root').textContent = `hero fixture failed: ${error.message}`;
    });
} else if (MODE === 'handoff-choice') {
  import('./handoff-choice-data.jsx')
    .then(module => module.mountHandoffChoiceFixture(document.getElementById('root')))
    .catch(error => {
      PAGE_ERRORS.push(error.message);
      document.documentElement.dataset.handoffChoiceStatus = 'error';
      document.getElementById('root').textContent = `handoff choice fixture failed: ${error.message}`;
    });
} else if (MODE === 'detail-busy') {
  import('./detail-busy-data.jsx')
    .then(module => module.mountDetailBusyFixture(document.getElementById('root')))
    .catch(error => {
      PAGE_ERRORS.push(error.message);
      document.documentElement.dataset.detailBusyStatus = 'error';
      document.getElementById('root').textContent = `detail busy fixture failed: ${error.message}`;
    });
} else if (MODE === 'layout-quality') {
  import('./layout-quality-data.js')
    .then(module => module.mountLayoutQualityFixture(document.getElementById('root')))
    .catch(error => {
      PAGE_ERRORS.push(error.message);
      document.documentElement.dataset.layoutQualityStatus = 'error';
      document.getElementById('root').textContent = `layout quality fixture failed: ${error.message}`;
    });
} else {
  createRoot(document.getElementById('root')).render(
    <ReactFlowProvider><PerformanceCanvas /></ReactFlowProvider>,
  );
}
