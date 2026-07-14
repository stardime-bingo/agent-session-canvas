/**
 * [INPUT]: 依赖 api 的 contextPage/session/launch、util 的 classifyDigestLine/TOOL_META/relTime、ui 的 Icon/toast
 * [OUTPUT]: 对外提供 ContextFrame 组件：画布就地弹出的终端窗——打开停在最新输出，上滑倒序翻页直至会话开头，
 *           翻页滚动无跳补偿、回到最新浮钮、页级 memo + content-visibility 原生虚拟化
 * [POS]: panels 的第四岛——拉线落空或右键"打开会话上下文"的落点；像真终端一样只渲染视口、历史按需向上生长
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import React, { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { TOOL_META, relTime, fmtSize, classifyDigestLine } from '../util.js';
import { Icon, toast } from '../ui.jsx';

const W = () => Math.min(580, window.innerWidth - 24);
const clampPos = (x, y) => ({
  x: Math.max(12, Math.min(x ?? 80, window.innerWidth - W() - 12)),
  y: Math.max(12, Math.min(y ?? 80, window.innerHeight - 320)),
});

// 页级 memo：翻页只挂新页，已渲染的旧页一行都不重算
const Page = memo(function Page({ text }) {
  const lines = useMemo(() => text.split('\n').filter(l => l.trim()).map(classifyDigestLine), [text]);
  return lines.map(([kind, t], i) => <div key={i} className={`tl ${kind}`}>{t}</div>);
});

export default function ContextFrame({ frame, onClose, onOpenDetail }) {
  const [meta, setMeta] = useState(null);
  const [pages, setPages] = useState([]);          // 从早到晚；翻页向头部生长
  const [nextBefore, setNextBefore] = useState(null);
  const [atStart, setAtStart] = useState(false);
  const [older, setOlder] = useState(false);       // 正在向上读更早一页
  const [err, setErr] = useState(null);
  const [partial, setPartial] = useState(false);   // 旧 daemon 无分页端点时回退节选
  const [nearBottom, setNearBottom] = useState(true);
  const [retryN, setRetryN] = useState(0);
  const [pos, setPos] = useState(() => clampPos(frame.x, frame.y));
  const bodyRef = useRef(null);
  const prependRef = useRef(null);                 // 翻页前的 scrollHeight-scrollTop，layout 前补偿
  const olderRef = useRef(false);                  // 重入守卫：滚动事件成串来，翻页一次只飞一架

  useEffect(() => { setPos(clampPos(frame.x, frame.y)); }, [frame]);

  useEffect(() => {
    let alive = true;
    setMeta(null); setPages([]); setErr(null); setPartial(false);
    setAtStart(false); setNextBefore(null); setNearBottom(true);
    api.contextPage(frame.key)
      .then(d => {
        if (!alive) return;
        setMeta(d); setPages([{ text: d.text, off: d.prevOffset }]);
        setNextBefore(d.atStart ? null : d.prevOffset); setAtStart(d.atStart);
      })
      .catch(() => api.session(frame.key).then(s => {
        if (!alive) return;
        setPartial(true); setMeta(s);
        setPages([{ text: s.digest || '', off: 0 }]); setAtStart(true);
      }))
      .catch(e => alive && setErr(e.message));
    return () => { alive = false; };
  }, [frame.key, retryN]);

  const loadOlder = async () => {
    if (olderRef.current || atStart || nextBefore == null || partial) return;
    olderRef.current = true;
    setOlder(true);
    const b = bodyRef.current;
    prependRef.current = b ? b.scrollHeight - b.scrollTop : null;
    try {
      // 空页自动续跳：噪音密集区被过滤成空文本时直落下一页，
      // 一次上滑必须带回可读内容（8 页上限防巨响，进度照常推进）
      let before = nextBefore, start = false;
      const fresh = [];
      for (let hop = 0; hop < 8; hop++) {
        const d = await api.contextPage(frame.key, before);
        if (d.text.trim()) fresh.unshift({ text: d.text, off: d.prevOffset });
        before = d.prevOffset; start = d.atStart;
        if (start || d.text.trim()) break;
      }
      if (fresh.length) setPages(p => [...fresh, ...p]);
      else prependRef.current = null;
      setNextBefore(start ? null : before);
      setAtStart(start);
    } catch (e) {
      prependRef.current = null;
      toast(`加载更早历史失败：${e.message}`, 'error');
    } finally {
      olderRef.current = false;
      setOlder(false);
    }
  };

  // 翻页补偿：视野钉在原来的行；首页：像刚 attach 的终端停在最新输出
  useLayoutEffect(() => {
    const b = bodyRef.current;
    if (!b || !pages.length) return;
    if (prependRef.current != null) {
      b.scrollTop = b.scrollHeight - prependRef.current;
      prependRef.current = null;
    } else {
      b.scrollTop = b.scrollHeight;
    }
  }, [pages]);

  const onScroll = () => {
    const b = bodyRef.current;
    if (!b) return;
    if (b.scrollTop < 60) loadOlder();
    setNearBottom(b.scrollHeight - b.scrollTop - b.clientHeight < 300);
  };

  // Esc 在 capture 层只关此框，不许连坐清空画布选中
  useEffect(() => {
    const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  // 标题栏拖动：Pointer Capture 飞出窗口也不丢（capture 失败不许连坐拖动本身）
  const startDrag = e => {
    if (e.target.closest('button')) return;
    e.preventDefault();
    const el = e.currentTarget;
    try { el.setPointerCapture(e.pointerId); } catch { /* 非活跃 pointer（如合成事件）没有 capture 可言 */ }
    const sx = e.clientX - pos.x, sy = e.clientY - pos.y;
    const move = ev => setPos(clampPos(ev.clientX - sx, ev.clientY - sy));
    const up = () => {
      el.releasePointerCapture?.(e.pointerId);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };

  const resume = () => api
    .launch({ tool: meta.tool, cwd: meta.cwd, mode: 'resume', sessionId: meta.id })
    .then(() => toast('已拉起终端：续开会话', 'ok'))
    .catch(e => toast(`拉起失败：${e.message}`, 'error'));

  const copyAll = () => {
    navigator.clipboard.writeText(pages.map(p => p.text).join('\n'));
    toast('已复制当前加载的全部历史', 'ok');
  };

  // 已加载进度：从 nextBefore 反推——到头即全部
  const loadedPct = meta?.sizeBytes
    ? (atStart ? 100 : Math.max(1, Math.round((1 - (nextBefore ?? meta.sizeBytes) / meta.sizeBytes) * 100)))
    : null;

  return (
    <div className="term-frame island" style={{ left: pos.x, top: pos.y, width: W() }}>
      {/* ===== 标题栏：红绿灯 + 工具徽章 + 标题，整条可抓着走 ===== */}
      <div className="term-head" onPointerDown={startDrag} title="拖动移动 · Esc 关闭">
        <span className="term-light" style={{ background: '#f97066' }} />
        <span className="term-light" style={{ background: '#fdb022' }} />
        <span className="term-light" style={{ background: '#47cd89' }} />
        {meta && <span className={`badge ${meta.tool}`}>{TOOL_META[meta.tool]?.label}</span>}
        <span className="mono" style={{
          fontSize: 11.5, fontWeight: 600, flex: 1, minWidth: 0,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>{meta ? meta.title : '会话上下文'}</span>
        <button className="btn ghost" onClick={onClose} title="关闭（Esc）" style={{ padding: '1px 7px' }}><Icon name="x" size={12} /></button>
      </div>

      {/* ===== 终端体：打开停在最新，上滑向历史生长；视口外行由浏览器原生虚拟化 ===== */}
      <div className="term-body nowheel" ref={bodyRef} onScroll={onScroll} tabIndex={0}>
        {err ? (
          <div className="tl error">✗ 上下文加载失败：{err}
            <button className="btn ghost" style={{ marginLeft: 10, fontSize: 11 }} onClick={() => setRetryN(n => n + 1)}>重试</button>
          </div>
        ) : !pages.length ? (
          <div className="tl tool">▸ 正在连接会话现场…</div>
        ) : (
          <>
            {atStart ? <div className="tl head">── 会话开始 ──</div>
              : older ? <div className="tl tool">▸ 正在读取更早的历史…</div>
              : <div className="tl head term-more" onClick={loadOlder}>↑ 上滑或点击加载更早</div>}
            {pages.map(p => <Page key={p.off} text={p.text} />)}
            {partial && <div className="tl head">【节选】daemon 重启后升级为可上滑翻页的完整历史</div>}
          </>
        )}
      </div>
      {!nearBottom && (
        <button className="term-jump mono" onClick={() => { const b = bodyRef.current; if (b) b.scrollTop = b.scrollHeight; }}>
          ↓ 最新
        </button>
      )}

      {/* ===== 行动条：看完现场，一步接管 ===== */}
      {meta && (
        <div className="term-foot">
          <button className="btn primary" onClick={resume}><Icon name="play" /> 续开此会话</button>
          <button className="btn" onClick={() => onOpenDetail(meta.key)}><Icon name="panel" /> 详情面板</button>
          <button className="btn ghost" onClick={copyAll}><Icon name="copy" /> 复制</button>
          <span className="mono" style={{ marginLeft: 'auto', fontSize: 10, color: 'var(--ink-faint)' }}>
            {relTime(meta.updatedAt)} · {fmtSize(meta.sizeBytes || 0)}
            {loadedPct != null && ` · 已载 ${loadedPct === 100 ? '全部' : loadedPct + '%'}`}
          </span>
        </div>
      )}
    </div>
  );
}
