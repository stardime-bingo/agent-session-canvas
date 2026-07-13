/**
 * [INPUT]: 依赖 react、api 的会话详情/动作接口、util 的展示函数、ui 的 Icon/toast/InlineEdit、menus 的 deleteSessionFlow
 * [OUTPUT]: 对外提供 DetailPanel 组件：首屏=标题+一键续开+这会话聊了什么（摘要/原文摘录托底），
 *           次级=接力/运行实例/元信息，删除收底；错误态可重试
 * [POS]: panels 的右侧行动面板——画布是地图，这里是扳机。信息层次铁律：内容先于按钮，按钮先于元数据
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { TOOL_META, STATUS_META, relTime, fmtSize } from '../util.js';
import { Icon, toast, InlineEdit } from '../ui.jsx';
import { deleteSessionFlow } from '../canvas/menus.jsx';

const Row = ({ label, children }) => (
  <div style={{ display: 'flex', gap: 10, fontSize: 12, lineHeight: 1.8 }}>
    <span className="mono" style={{ color: 'var(--ink-faint)', width: 44, flexShrink: 0, fontSize: 10.5, paddingTop: 2 }}>{label}</span>
    <span style={{ color: 'var(--ink-dim)', wordBreak: 'break-all', minWidth: 0 }}>{children}</span>
  </div>
);

const Section = ({ title, children }) => (
  <div style={{ borderTop: '1px solid var(--line)', padding: '12px 16px' }}>
    <div className="mono" style={{ fontSize: 10, color: 'var(--ink-faint)', letterSpacing: '0.1em', marginBottom: 8 }}>{title}</div>
    {children}
  </div>
);

// ============================================================
//  对话摘录：把 digest 事件流渲染成有层次的对白——
//  用户蓝、助手灰、工具轨迹淡、报错红，谁说的一眼分明
// ============================================================
const LINE_STYLE = {
  head: { margin: '8px 0 3px', fontSize: 10, letterSpacing: '0.08em', color: 'var(--ink-faint)', fontFamily: 'var(--mono)' },
  user: { borderLeft: '2px solid var(--accent)', paddingLeft: 8, color: 'var(--ink)', fontWeight: 500, margin: '5px 0' },
  assistant: { borderLeft: '2px solid var(--line-strong)', paddingLeft: 8, color: 'var(--ink-dim)', margin: '5px 0' },
  tool: { color: 'var(--ink-faint)', fontFamily: 'var(--mono)', fontSize: 10.5, margin: '2px 0 2px 10px' },
  error: { color: 'var(--danger)', fontFamily: 'var(--mono)', fontSize: 10.5, margin: '3px 0 3px 10px' },
};

function classify(line) {
  if (line.startsWith('【')) return ['head', line];
  if (line.startsWith('[用户]')) return ['user', line.slice(4).trim()];
  if (line.startsWith('[助手]')) return ['assistant', line.slice(4).trim()];
  const t = line.trim();
  if (t.startsWith('▸')) return ['tool', t];
  if (t.startsWith('✗')) return ['error', t];
  return ['assistant', line];
}

function DigestView({ text, startCollapsed }) {
  const [open, setOpen] = useState(!startCollapsed);
  const [full, setFull] = useState(false);
  const lines = useMemo(() => (text || '').split('\n').filter(l => l.trim()), [text]);
  if (!lines.length) return null;

  if (!open) {
    return (
      <button className="btn ghost" style={{ marginTop: 8, fontSize: 11.5 }} onClick={() => setOpen(true)}>
        <Icon name="down" size={11} /> 查看原文对话摘录（{lines.length} 行）
      </button>
    );
  }
  const shown = full ? lines : lines.slice(0, 14);
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{
        fontSize: 12, lineHeight: 1.6, background: 'var(--bg-deep)',
        border: '1px solid var(--line)', borderRadius: 8, padding: '8px 12px',
        maxHeight: full ? 420 : undefined, overflowY: full ? 'auto' : 'hidden',
      }}>
        {shown.map((l, i) => {
          const [kind, t] = classify(l);
          return <div key={i} style={LINE_STYLE[kind]}>{t}</div>;
        })}
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 5 }}>
        {lines.length > 14 && (
          <button className="btn ghost" style={{ fontSize: 11 }} onClick={() => setFull(f => !f)}>
            {full ? <><Icon name="up" size={10} /> 只看开头</> : <><Icon name="down" size={10} /> 展开全部 {lines.length} 行</>}
          </button>
        )}
        {startCollapsed && (
          <button className="btn ghost" style={{ fontSize: 11 }} onClick={() => { setOpen(false); setFull(false); }}>
            收起摘录
          </button>
        )}
      </div>
    </div>
  );
}

export default function DetailPanel({ width = 400, sessionKey, onClose, onCollapse, onChanged }) {
  const [detail, setDetail] = useState(null);
  const [err, setErr] = useState(null);
  const [retryN, setRetryN] = useState(0);
  const [busy, setBusy] = useState(null);
  const [renameSignal, setRenameSignal] = useState(0);

  useEffect(() => {
    // alive 守卫：快速切换会话时，慢返的旧请求不许覆盖新会话详情
    let alive = true;
    setDetail(null); setErr(null);
    if (sessionKey) {
      api.session(sessionKey)
        .then(d => alive && setDetail(d))
        .catch(e => alive && setErr(e.message));
    }
    return () => { alive = false; };
  }, [sessionKey, retryN]);

  if (!sessionKey) return null;

  // ---- 动作统一走 run：忙碌态、错误提示、完成后刷新，一处处理 ----
  const run = async (name, fn, doneMsg) => {
    setBusy(name);
    try {
      const r = await fn();
      if (doneMsg) toast(doneMsg, 'ok');
      onChanged?.();
      setDetail(await api.session(sessionKey));
      return r;
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      setBusy(null);
    }
  };

  const s = detail;
  return (
    <div style={{
      width, height: '100%', flexShrink: 0, background: 'var(--bg-panel)',
      overflowY: 'auto',
      animation: 'slideIn 0.22s ease',
    }}>
      <style>{`@keyframes slideIn { from { transform: translateX(30px); opacity: 0; } }`}</style>

      {err ? (
        /* ===== 错误态：说清原因，给条重试的路 ===== */
        <div style={{ padding: 24 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--danger)' }}>详情加载失败</div>
          <div className="mono" style={{ fontSize: 11.5, color: 'var(--ink-dim)', margin: '8px 0 14px', lineHeight: 1.6 }}>{err}</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn primary" onClick={() => setRetryN(n => n + 1)}><Icon name="refresh" /> 重试</button>
            <button className="btn" onClick={onClose}>关闭</button>
          </div>
        </div>
      ) : !s ? (
        <div className="mono" style={{ padding: 24, color: 'var(--ink-faint)', fontSize: 12 }}>加载中…</div>
      ) : (
        <>
          {/* ===== 头部：状态 + 标题（就地改名） + 收回/关闭 ===== */}
          <div style={{ padding: '14px 16px 10px', display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <span className={`badge ${s.tool}`}>{TOOL_META[s.tool].label}</span>
                <span className={`dot ${s.status}`} />
                <span className="mono" style={{ fontSize: 10.5, color: 'var(--ink-faint)' }}>{STATUS_META[s.status]}</span>
              </div>
              <div style={{ fontSize: 15, fontWeight: 700, lineHeight: 1.4, display: 'flex', gap: 6, alignItems: 'baseline' }}>
                <InlineEdit
                  value={s.title}
                  editSignal={renameSignal}
                  onSave={t => run('rename', () => api.rename(s.key, t), '已重命名并同步本体')}
                  title="双击改名（同步回 Claude Code / Codex 本体）"
                  style={{ minWidth: 0 }}
                />
                <span onClick={() => setRenameSignal(n => n + 1)} title="改名（同步回工具本体）"
                  style={{ cursor: 'pointer', color: 'var(--ink-faint)', flexShrink: 0, display: 'inline-flex' }}>
                  <Icon name="edit" size={12} />
                </span>
              </div>
            </div>
            <button className="btn ghost" onClick={onCollapse} title="收回面板（保留选中）" style={{ padding: '2px 8px' }}><Icon name="chevR" /></button>
            <button className="btn ghost" onClick={onClose} title="关闭并取消选中" style={{ padding: '2px 8px' }}><Icon name="x" /></button>
          </div>

          {/* ===== 黄金位：一键拉起 ===== */}
          <div style={{ padding: '0 16px 14px', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn primary" disabled={busy}
              onClick={() => run('resume', () => api.launch({ tool: s.tool, cwd: s.cwd, mode: 'resume', sessionId: s.id }), '已拉起终端：续开会话')}>
              <Icon name="play" /> 续开此会话
            </button>
            <button className="btn" disabled={busy}
              onClick={() => run('new', () => api.launch({ tool: s.tool, cwd: s.cwd, mode: 'new' }), '已拉起终端：新会话')}>
              <Icon name="plus" /> 同工作区新会话
            </button>
          </div>

          {/* ===== 这会话聊了什么：有摘要给结论，没摘要给原文摘录托底 ===== */}
          <Section title="CONTEXT · 聊了什么">
            {s.summary ? (
              <>
                <div style={{ fontSize: 12.5, color: 'var(--ink-dim)', lineHeight: 1.7 }}>
                  {s.summary.summary || s.summary.title}
                  <div style={{ display: 'flex', gap: 5, marginTop: 7, flexWrap: 'wrap' }}>
                    {(s.summary.tags || []).map(t => <span key={t} className="chip on" style={{ cursor: 'default' }}>{t}</span>)}
                    {s.summary.outcome && <span className="chip" style={{ cursor: 'default' }}>{s.summary.outcome}</span>}
                  </div>
                </div>
                <DigestView text={s.digest} startCollapsed />
              </>
            ) : (
              <>
                <div style={{ fontSize: 11.5, color: 'var(--ink-faint)' }}>还没有 AI 摘要——先看从会话原文抽出的对白与行动轨迹：</div>
                <DigestView text={s.digest} />
              </>
            )}
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button className="btn" disabled={busy}
                onClick={() => run('summarize', () => api.summarize(s.key), '摘要已生成')}>
                {busy === 'summarize' ? '◈ 蒸馏中…' : <><Icon name="spark" /> {s.summary ? '更新摘要' : '生成摘要'}</>}
              </button>
              <button className="btn" disabled={busy} title="AI 只给这一个会话精工起名（不覆盖你手动起的名）"
                onClick={() => run('ai-name', () => api.aiName(s.key), 'AI 已起名')}>
                {busy === 'ai-name' ? '✎ 起名中…' : <><Icon name="tag" /> AI 起名</>}
              </button>
            </div>
          </Section>

          {/* ===== 接力：交棒给下一个 Agent ===== */}
          <Section title="HANDOFF · 接力提示词">
            {s.handoff ? (
              <pre style={{
                fontSize: 11.5, fontFamily: 'var(--sans)', whiteSpace: 'pre-wrap',
                color: 'var(--ink-dim)', background: 'var(--bg-deep)',
                border: '1px solid var(--line)', borderRadius: 6,
                padding: 10, maxHeight: 220, overflowY: 'auto', lineHeight: 1.65,
              }}>{s.handoff}</pre>
            ) : (
              <div style={{ fontSize: 12, color: 'var(--ink-faint)' }}>尚未生成——生成后可一键带着它开新会话</div>
            )}
            <div style={{ display: 'flex', gap: 8, marginTop: 9, flexWrap: 'wrap' }}>
              <button className="btn" disabled={busy}
                onClick={() => run('handoff', () => api.handoff(s.key), '接力提示词已生成')}>
                {busy === 'handoff' ? '⇥ 蒸馏中…' : <><Icon name="handoff" /> {s.handoff ? '重新生成' : '生成接力提示词'}</>}
              </button>
              {s.handoff && (
                <>
                  <button className="btn" onClick={() => { navigator.clipboard.writeText(s.handoff); toast('已复制接力提示词', 'ok'); }}>
                    <Icon name="copy" /> 复制
                  </button>
                  <button className="btn primary" disabled={busy}
                    onClick={() => run('launch-handoff', () => api.launch({ tool: s.tool, cwd: s.cwd, mode: 'prompt', prompt: s.handoff, sourceKey: s.key }), '已拉起：接力新会话（血缘已记）')}>
                    <Icon name="play" /> 带接力开新会话
                  </button>
                </>
              )}
            </div>
          </Section>

          {/* ===== 自动化聚合卡：每一次运行都有据可查 ===== */}
          {s.runs > 1 && s.runFiles?.length > 0 && (
            <Section title={`RUNS · ${s.runs} 次运行实例`}>
              <div className="mono" style={{ fontSize: 10.5, color: 'var(--ink-dim)', lineHeight: 1.9, maxHeight: 150, overflowY: 'auto' }}>
                {[...s.runFiles].reverse().map((f, i) => (
                  <div key={f} style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                    title={f}>
                    {i === 0 ? '▸ ' : '· '}{f.split('/').pop().replace('.jsonl', '')}{i === 0 ? '（此卡代表）' : ''}
                  </div>
                ))}
              </div>
            </Section>
          )}

          {/* ===== 元信息：次级细节居后 ===== */}
          <Section title="DETAIL · 元信息">
            <Row label="路径">
              <span style={{ cursor: 'pointer' }} title="在 Finder 打开"
                onClick={() => api.reveal(s.cwd).then(() => toast('已在 Finder 打开', 'ok')).catch(e => toast(e.message, 'error'))}>
                {s.cwd} <Icon name="folder" size={10} />
              </span>
            </Row>
            {s.gitBranch && <Row label="分支"><span className="mono">⎇ {s.gitBranch}</span></Row>}
            <Row label="活动">{relTime(s.updatedAt)} · {fmtSize(s.sizeBytes)} · ~{s.turns} 轮</Row>
            <Row label="ID">
              <span className="mono" style={{ fontSize: 10.5, cursor: 'pointer' }} title="点击复制会话 ID"
                onClick={() => { navigator.clipboard.writeText(s.id); toast('已复制会话 ID', 'ok'); }}>
                {s.id} <Icon name="copy" size={10} />
              </span>
            </Row>
          </Section>

          {/* ===== 危险区：删除 = 移入废纸篓（自绘确认，活跃门禁二次确认） ===== */}
          <Section title="DANGER · 删除">
            <button className="btn danger" disabled={busy}
              onClick={e => deleteSessionFlow(s, { x: e.clientX - 270, y: e.clientY - 130 }, () => { onChanged?.(); onClose(); })}>
              <Icon name="trash" /> 删除此会话
            </button>
          </Section>
        </>
      )}
    </div>
  );
}
