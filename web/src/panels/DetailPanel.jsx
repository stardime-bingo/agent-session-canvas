/**
 * [INPUT]: 依赖 react、api 的会话详情/动作接口、util 的展示函数、ui 的 Icon/toast/InlineEdit、menus 的 deleteSessionFlow、HandoffLaunchChoices 的双工具接班入口
 * [OUTPUT]: 对外提供 DetailPanel 组件：首屏=标题+一键续开+接力/元信息(醒目默认文件管理器入口)/删除，
 *           次级=聊了什么+最后停在哪里（尾部独立摘录）+运行实例；错误态自动退避重连
 * [POS]: panels 的右侧行动面板——画布是地图，这里是扳机。接力、定位与清理入口固定在内容长文之前
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { TOOL_META, STATUS_META, relTime, fmtSize, classifyDigestLine, handoffSkillPrompt } from '../util.js';
import { Icon, toast, InlineEdit } from '../ui.jsx';
import { deleteSessionFlow } from '../canvas/menus.jsx';
import HandoffLaunchChoices from './HandoffLaunchChoices.jsx';

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

function DigestView({ text, startCollapsed, fromEnd = false }) {
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
  const shown = full ? lines : (fromEnd ? lines.slice(-14) : lines.slice(0, 14));
  return (
    <div style={{ marginTop: 8 }}>
      <div style={{
        fontSize: 12, lineHeight: 1.6, background: 'var(--bg-deep)',
        border: '1px solid var(--line)', borderRadius: 8, padding: '8px 12px',
        maxHeight: full ? 420 : undefined, overflowY: full ? 'auto' : 'hidden',
      }}>
        {shown.map((l, i) => {
          const [kind, t] = classifyDigestLine(l);
          return <div key={i} style={LINE_STYLE[kind]}>{t}</div>;
        })}
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 5 }}>
        {lines.length > 14 && (
          <button className="btn ghost" style={{ fontSize: 11 }} onClick={() => setFull(f => !f)}>
            {full
              ? <><Icon name="up" size={10} /> {fromEnd ? '只看最后 14 行' : '只看开头'}</>
              : <><Icon name="down" size={10} /> 展开全部 {lines.length} 行</>}
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
    let retryTimer = null;
    setDetail(null); setErr(null);
    if (sessionKey) {
      api.session(sessionKey)
        .then(d => alive && setDetail(d))
        .catch(e => {
          if (!alive) return;
          setErr(e.message);
          retryTimer = setTimeout(() => { if (alive) setRetryN(n => n + 1); }, Math.min(1000 * 2 ** retryN, 15000));
        });
    }
    return () => { alive = false; clearTimeout(retryTimer); };
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
  const openDirectory = async () => {
    setBusy('reveal');
    try {
      await api.reveal(s.cwd);
      toast('已用默认文件管理器打开目录', 'ok');
    } catch (e) {
      toast(`打开目录失败：${e.message}`, 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div style={{
      width, height: '100%', flexShrink: 0, background: 'var(--bg-panel)',
      overflowY: 'auto',
      animation: 'slideIn 0.22s ease',
    }}>
      <style>{`@keyframes slideIn { from { transform: translateX(30px); opacity: 0; } }`}</style>

      {err ? (
        /* ===== 错误态：说清原因，后台自动退避重连，不把恢复责任交给用户 ===== */
        <div style={{ padding: 24 }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--danger)' }}>详情加载失败</div>
          <div className="mono" style={{ fontSize: 11.5, color: 'var(--ink-dim)', margin: '8px 0 14px', lineHeight: 1.6 }}>{err} · 正在自动重连…</div>
          <button className="btn" onClick={onClose}>关闭</button>
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

          {/* ===== 顶部行动区：接力、元信息与删除优先于长内容 ===== */}
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
              {/* 深档出口：拉起终端跑 bingo-agent-handoff 桥接救援——画布递精确地址，skill 出三件套 */}
              <button className="btn" disabled={busy} title="拉起 Claude 终端执行 bingo-agent-handoff 桥接救援：只读提取本会话，产出总汇报/施工接手/独立审计三件套"
                onClick={() => run('handoff-skill', () => api.launch({
                  tool: 'claude', cwd: s.cwd, mode: 'prompt',
                  prompt: handoffSkillPrompt(s), sourceKey: s.key,
                }), '已拉起终端：桥接救援生成交接三件套（血缘已记）')}>
                <Icon name="terminal" /> 交接三件套
              </button>
              {s.handoff && (
                <>
                  <button className="btn" onClick={() => { navigator.clipboard.writeText(s.handoff); toast('已复制接力提示词', 'ok'); }}>
                    <Icon name="copy" /> 复制
                  </button>
                  <HandoffLaunchChoices
                    handoff={s.handoff}
                    cwd={s.cwd}
                    sourceKey={s.key}
                    busy={busy}
                    onLaunch={(tool, payload) => run(
                      `launch-handoff-${tool}`,
                      () => api.launch(payload),
                      `已拉起 ${TOOL_META[tool].label}：接力新会话（血缘已记）`,
                    )}
                  />
                </>
              )}
            </div>
          </Section>

          <Section title="DETAIL · 元信息">
            <Row label="路径">
              <span className="detail-path-action">
                <span className="mono detail-path-value" title={s.cwd}>{s.cwd}</span>
                <button type="button" className="btn folder-open-btn" disabled={Boolean(busy)}
                  title="用电脑默认的文件管理器打开此目录" aria-label="用默认文件管理器打开目录"
                  onClick={openDirectory}>
                  <Icon name="folder" size={13} /> {busy === 'reveal' ? '正在打开…' : '打开目录'}
                </button>
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

          <Section title="DANGER · 删除">
            <button className="btn danger" disabled={busy}
              onClick={e => deleteSessionFlow(s, { x: e.clientX - 270, y: e.clientY - 130 }, () => { onChanged?.(); onClose(); })}>
              <Icon name="trash" /> 删除此会话
            </button>
          </Section>

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

          {/* ===== 会话落点：独立读取文件尾，默认从最后 14 行看起，不被开场摘录截断 ===== */}
          <Section title="STOP · 最后停在哪里">
            <div style={{ fontSize: 11.5, color: 'var(--ink-faint)', lineHeight: 1.6 }}>
              最近一次活动于 {relTime(s.updatedAt)}。下面按时间顺序保留会话停止前的对白、工具动作与报错：
            </div>
            {s.endingDigest ? (
              <DigestView text={s.endingDigest} fromEnd />
            ) : (
              <div style={{ marginTop: 8, fontSize: 12, color: 'var(--ink-faint)' }}>文件尾没有可展示的会话事件。</div>
            )}
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

        </>
      )}
    </div>
  );
}
