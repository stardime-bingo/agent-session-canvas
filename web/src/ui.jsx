/**
 * [INPUT]: 依赖 react
 * [OUTPUT]: 对外提供 Icon 单色图标集（含绘图选择/画笔/终端/滚轮模式三态）、支持撤销动作的 toast()、confirmPop()、<UIHost/>、<InlineEdit/> 就地改名
 * [POS]: web 的 UI 原子库——自绘轻提示/确认弹层/行内编辑，全面取代原生 alert/confirm/prompt 与 emoji 图标
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import React, { useEffect, useRef, useState } from 'react';

// ============================================================
//  图标集：单色 stroke SVG，随字色（currentColor），一处定义全站共用
// ============================================================
const PATHS = {
  note:    <><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M14 20v-4a2 2 0 0 1 2-2h4"/></>,
  board:   <><rect x="3" y="5" width="18" height="14" rx="3" strokeDasharray="4 3"/></>,
  cursor:  <path d="M5 3l14 9-6 1.5L9.5 20 5 3z"/>,
  pen:     <><path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><path d="M2 2l7.586 7.586"/><circle cx="11" cy="11" r="2"/></>,
  fit:     <><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/><path d="M8 21H5a2 2 0 0 1-2-2v-3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></>,
  tidy:    <><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></>,
  tag:     <><path d="M12 2H2v10l9.29 9.29a1 1 0 0 0 1.42 0l8.58-8.58a1 1 0 0 0 0-1.42L12 2z"/><circle cx="7" cy="7" r="1.5"/></>,
  refresh: <><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 3v6h-6"/></>,
  play:    <path d="M6 4l14 8-14 8V4z"/>,
  plus:    <><path d="M12 5v14"/><path d="M5 12h14"/></>,
  edit:    <><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></>,
  trash:   <><path d="M3 6h18"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></>,
  folder:  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2v11z"/>,
  copy:    <><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></>,
  x:       <><path d="M18 6L6 18"/><path d="M6 6l12 12"/></>,
  focus:   <><circle cx="12" cy="12" r="3"/><path d="M12 2v4"/><path d="M12 18v4"/><path d="M2 12h4"/><path d="M18 12h4"/></>,
  handoff: <><path d="M4 12h12"/><path d="M11 6l6 6-6 6"/><path d="M20 5v14"/></>,
  spark:   <path d="M12 2l2.4 7.2L22 12l-7.6 2.8L12 22l-2.4-7.2L2 12l7.6-2.8L12 2z"/>,
  panel:   <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/></>,
  chevL:   <path d="M15 6l-6 6 6 6"/>,
  chevR:   <path d="M9 6l6 6-6 6"/>,
  down:    <path d="M6 9l6 6 6-6"/>,
  up:      <path d="M6 15l6-6 6 6"/>,
  link:    <><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></>,
  terminal:<><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3"/><path d="M13 15h4"/></>,
  mouse:   <><rect x="6" y="3" width="12" height="18" rx="6"/><path d="M12 7v3"/></>,
  trackpad:<><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 14h18"/><path d="M12 14v5"/></>,
  wheelAuto:<><circle cx="12" cy="12" r="8" strokeDasharray="4 3.2"/><circle cx="12" cy="12" r="2"/></>,
};

export const Icon = ({ name, size = 13, style }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
    strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
    style={{ flexShrink: 0, verticalAlign: '-1.5px', ...style }} aria-hidden>
    {PATHS[name]}
  </svg>
);

// ============================================================
//  单例总线：模块级函数直驱 UIHost——调用方一行代码，无需接线
// ============================================================
let pushToast = () => {};
let openConfirm = () => Promise.resolve(false);

/** 轻提示：第三参可给 { label, onClick }，用于整理这类可逆动作。 */
export const toast = (msg, type = 'info', action = null) => pushToast(msg, type, action);

/** 自绘确认弹层：confirmPop({ x, y, text, detail?, yesLabel?, danger? }) → Promise<boolean>
    坐标缺省时落屏幕中上——键盘触发的删除也有处安身 */
export const confirmPop = opts => openConfirm(opts);

export function UIHost() {
  const [toasts, setToasts] = useState([]);
  const [cf, setCf] = useState(null);

  useEffect(() => {
    pushToast = (msg, type, action) => {
      const id = Date.now() + Math.random();
      setToasts(t => [...t.slice(-2), { id, msg, type, action }]);
      setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 3400);
    };
    openConfirm = opts => new Promise(resolve => {
      setCf({ yesLabel: '确认', ...opts, resolve });
    });
    return () => { pushToast = () => {}; openConfirm = () => Promise.resolve(false); };
  }, []);

  const settle = ok => { cf.resolve(ok); setCf(null); };

  // 确认层键盘：Esc=取消 Enter=确认；capture 阻断，不许连坐关闭下层面板
  useEffect(() => {
    if (!cf) return;
    const onKey = e => {
      if (e.key === 'Escape') { e.stopPropagation(); settle(false); }
      else if (e.key === 'Enter') { e.stopPropagation(); settle(true); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [cf]);

  const W = 264;
  const pos = cf && {
    left: Math.max(10, Math.min(cf.x ?? (window.innerWidth - W) / 2, window.innerWidth - W - 10)),
    top: Math.max(10, Math.min(cf.y ?? window.innerHeight * 0.32, window.innerHeight - 150)),
  };

  return (
    <>
      {/* ===== 确认弹层 ===== */}
      {cf && (
        <>
          <div className="confirm-veil" onClick={() => settle(false)} onContextMenu={e => { e.preventDefault(); settle(false); }} />
          <div className="confirm-pop" style={{ ...pos, width: W }}>
            <div className="confirm-text">{cf.text}</div>
            {cf.detail && <div className="confirm-detail">{cf.detail}</div>}
            <div className="confirm-btns">
              <button className="btn" onClick={() => settle(false)}>取消</button>
              <button className={`btn ${cf.danger ? 'danger' : 'primary'}`} autoFocus onClick={() => settle(true)}>
                {cf.yesLabel}
              </button>
            </div>
          </div>
        </>
      )}
      {/* ===== 轻提示栈 ===== */}
      {toasts.length > 0 && (
        <div className="toast-stack">
          {toasts.map(t => (
            <div key={t.id} className={`toast ${t.type}`}>
              <span>{t.msg}</span>
              {t.action && (
                <button className="toast-action" onClick={() => {
                  setToasts(xs => xs.filter(x => x.id !== t.id));
                  t.action.onClick();
                }}>{t.action.label}</button>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

// ============================================================
//  就地改名：显示态是普通文字，双击（或外部 editSignal）变输入框
//  Enter/失焦 提交，Esc 取消——画布节点与面板共用一套
// ============================================================
export function InlineEdit({ value, onSave, editSignal = 0, placeholder, className = '', style, inputStyle, title }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const cancelled = useRef(false);

  useEffect(() => { if (editSignal > 0) { setDraft(value); setEditing(true); } }, [editSignal]);

  const commit = () => {
    setEditing(false);
    const v = draft.trim();
    if (!cancelled.current && v && v !== value) onSave(v);
    cancelled.current = false;
  };

  if (!editing) {
    return (
      <span
        className={className} style={{ cursor: 'text', ...style }} title={title || '双击改名'}
        onDoubleClick={e => { e.stopPropagation(); setDraft(value); setEditing(true); }}
      >{value}</span>
    );
  }
  return (
    <input
      className={`inline-edit nodrag nopan nowheel ${className}`}
      style={inputStyle}
      value={draft} placeholder={placeholder} autoFocus
      onFocus={e => e.target.select()}
      onChange={e => setDraft(e.target.value)}
      onPointerDown={e => e.stopPropagation()}
      onDoubleClick={e => e.stopPropagation()}
      onKeyDown={e => {
        e.stopPropagation();   // 输入期间不许触发画布快捷键 / 全局 Esc
        if (e.key === 'Enter') e.target.blur();
        else if (e.key === 'Escape') { cancelled.current = true; e.target.blur(); }
      }}
      onBlur={commit}
    />
  );
}
