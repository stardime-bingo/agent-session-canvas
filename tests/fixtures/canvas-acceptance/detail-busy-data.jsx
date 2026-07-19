/**
 * [INPUT]: production DetailPanel、匿名会话与可控的 handoff Promise
 * [OUTPUT]: 详情面板 AI 忙碌态浏览器夹具；真实点击后保持请求悬挂，供鼠标/状态点/Reduced Motion 取证
 * [POS]: 仅由 4518 ?mode=detail-busy 加载；不请求 API、不读取或改写 4517/data
 * [PROTOCOL]: 变更时更新 main.jsx/verify.py/README/web CLAUDE
 */
import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import '../../../web/src/theme.css';
import { api } from '../../../web/src/api.js';
import DetailPanel from '../../../web/src/panels/DetailPanel.jsx';
import { UIHost } from '../../../web/src/ui.jsx';

const SESSION = Object.freeze({
  key: 'codex:fixture-detail-busy',
  id: 'fixture-detail-busy',
  tool: 'codex',
  status: 'active',
  title: '整理发布前证据',
  cwd: '/fixture/anonymous-workspace',
  gitBranch: 'main',
  updatedAt: new Date().toISOString(),
  sizeBytes: 4096,
  turns: 18,
  handoff: null,
  summary: null,
  digest: '用户：确认最后一轮界面\n助手：正在收口状态反馈',
  endingDigest: '助手：等待最终验收',
  runs: 1,
  runFiles: [],
});

const probe = { ready: false, handoffCalls: 0 };
window.__DETAIL_BUSY__ = probe;

api.session = async () => SESSION;
api.handoff = async () => {
  probe.handoffCalls += 1;
  await new Promise(() => {});
};

function DetailBusyFixture() {
  useEffect(() => { probe.ready = true; }, []);
  return (
    <main style={{ height: '100vh', display: 'flex', justifyContent: 'flex-end', background: 'var(--bg-canvas)' }}>
      <section className="island" style={{ height: 'calc(100vh - 32px)', margin: 16, overflow: 'hidden' }}>
        <DetailPanel
          width={480}
          sessionKey={SESSION.key}
          onClose={() => {}}
          onCollapse={() => {}}
          onChanged={() => {}}
        />
      </section>
      <UIHost />
    </main>
  );
}

export function mountDetailBusyFixture(target) {
  createRoot(target).render(<DetailBusyFixture />);
}
