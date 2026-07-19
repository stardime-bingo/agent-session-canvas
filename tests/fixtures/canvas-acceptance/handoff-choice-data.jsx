/**
 * [INPUT]: production HandoffLaunchChoices 与匿名接力数据
 * [OUTPUT]: Claude/Codex 双入口浏览器探针，记录每次选择产生的完整 launch payload
 * [POS]: 4518 ?mode=handoff-choice；不请求 API、不拉终端、不读写真实 data
 * [PROTOCOL]: 变更时更新此头部，然后检查 main.jsx/verify.py/README/web CLAUDE
 */
import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import '../../../web/src/theme.css';
import HandoffLaunchChoices from '../../../web/src/panels/HandoffLaunchChoices.jsx';

const HANDOFF = '# 匿名接力\n\n继续完成可复验的发布检查。';
const CWD = '/fixture/handoff-workspace';
const SOURCE_KEY = 'claude:fixture-handoff-source';
const probe = { ready: false, calls: [], contract: { handoff: HANDOFF, cwd: CWD, sourceKey: SOURCE_KEY } };
window.__HANDOFF_CHOICE__ = probe;

function HandoffChoiceFixture() {
  useEffect(() => { probe.ready = true; }, []);
  return (
    <main style={{ minHeight: '100vh', padding: 32, background: 'var(--bg-canvas)' }}>
      <section className="island" style={{ width: 560, padding: 18 }}>
        <div className="mono" style={{ fontSize: 11, color: 'var(--ink-faint)', marginBottom: 10 }}>
          HANDOFF · 选择接班工具
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <HandoffLaunchChoices
            handoff={HANDOFF}
            cwd={CWD}
            sourceKey={SOURCE_KEY}
            onLaunch={(tool, payload) => probe.calls.push({ tool, payload })}
          />
        </div>
      </section>
    </main>
  );
}

export function mountHandoffChoiceFixture(target) {
  createRoot(target).render(<HandoffChoiceFixture />);
}
