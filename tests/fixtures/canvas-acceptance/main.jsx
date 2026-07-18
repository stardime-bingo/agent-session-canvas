/**
 * [INPUT]: 4518 query(mode=performance|interaction, size=300|800) 与真实画布组件
 * [OUTPUT]: performance=InkLayer 直渲 N 元素的挂载耗时与 DOM 完整性报告；
 *           interaction=动态加载真实 FlowCanvas 全内存验收页；共享 console/page error 原始 transcript
 * [POS]: 4518 验收夹具入口。自研墨迹后没有导出管线可测——渲染完整性与挂载耗时就是全部性能合同
 * [PROTOCOL]: 变更时更新此头部，然后检查 interaction-data/README/web/CLAUDE.md
 */
import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ReactFlow, ReactFlowProvider } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import '../../../web/src/theme.css';
import InkLayer from '../../../web/src/canvas/InkLayer.jsx';
import { createCanvasAcceptanceElements } from './fixture-data.js';

const params = new URLSearchParams(location.search);
const MODE = params.get('mode') === 'interaction' ? 'interaction' : 'performance';
const SIZE = Number(params.get('size')) === 800 ? 800 : 300;

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

function PerformanceCanvas() {
  const [report, setReport] = useState({ size: SIZE, phase: 'mounting' });
  const startedRef = useRef(performance.now());
  const elements = useRef(createCanvasAcceptanceElements(SIZE)).current;

  useEffect(() => {
    // 直渲即完整：DOM 元素数与文档一致就是通过——没有导出、没有帧、没有等待
    const t = setTimeout(() => {
      const domCount = document.querySelectorAll('[data-ink-element-id]').length;
      const expected = elements.filter(el => !el.isDeleted).length;
      const mountMs = Math.round(performance.now() - startedRef.current);
      const pass = domCount === expected && CONSOLE_ERRORS.length === 0 && PAGE_ERRORS.length === 0;
      const final = { size: SIZE, domCount, expected, mountMs, pass };
      probe.status = pass ? 'complete' : 'fail';
      probe.report = final;
      setReport(final);
      window.dispatchEvent(new CustomEvent('canvas-acceptance-complete', { detail: final }));
    }, 200);
    return () => clearTimeout(t);
  }, [elements]);

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
} else {
  createRoot(document.getElementById('root')).render(
    <ReactFlowProvider><PerformanceCanvas /></ReactFlowProvider>,
  );
}
