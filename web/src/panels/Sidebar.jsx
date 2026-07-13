/**
 * [INPUT]: 依赖 react、util 的 relTime/TOOL_META/STATUS_META、ui 的 InlineEdit/Icon
 * [OUTPUT]: 对外提供 Sidebar 组件——左侧漂浮岛：品牌/统计/搜索/三组过滤/工作区清单
 * [POS]: panels 的导航岛。单击定位、双击就地改名（不再有原生弹窗）、⟨ 收回；清单空时给一句实话
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import React from 'react';
import { relTime, TOOL_META, STATUS_META } from '../util.js';
import { InlineEdit, Icon } from '../ui.jsx';

const RANGES = [['7d', '7天'], ['30d', '30天'], ['all', '全部']];

export default function Sidebar({ stats, live, filters, setFilters, workspaces, onFocus, onCollapse, onRenameWs }) {
  const toggle = (field, value) => setFilters(f => {
    const next = new Set(f[field]);
    next.has(value) ? next.delete(value) : next.add(value);
    return { ...f, [field]: next };
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minWidth: 0 }}>
      {/* ===== 品牌区 ===== */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '13px 14px 8px' }}>
        <span className={`dot ${live ? 'active' : 'stale'}`} title={live ? '实时监听中' : '连接断开'} />
        <span style={{ fontSize: 14, fontWeight: 700, letterSpacing: '0.02em', whiteSpace: 'nowrap' }}>
          AGENT 指挥塔
        </span>
        <span className="mono" style={{ fontSize: 10.5, color: 'var(--ink-faint)', whiteSpace: 'nowrap' }}
          title={stats.hidden ? `已滤噪音：子智能体 ${stats.hidden.subagent} · 空会话 ${stats.hidden.empty}` : ''}>
          {stats.total} · <span style={{ color: 'var(--ok)' }}>{stats.byStatus?.active || 0}</span>
        </span>
        <span onClick={onCollapse} title="收回导航岛"
          style={{ marginLeft: 'auto', cursor: 'pointer', color: 'var(--ink-faint)', display: 'inline-flex' }}>
          <Icon name="chevL" size={14} />
        </span>
      </div>

      {/* ===== 搜索 ===== */}
      <div style={{ padding: '0 12px 8px' }}>
        <input
          id="cmd-search" className="search" placeholder="搜索会话 / 工作区…（/）"
          style={{ height: 30 }}
          value={filters.q}
          onChange={e => setFilters(f => ({ ...f, q: e.target.value }))}
        />
      </div>

      {/* ===== 过滤三组 ===== */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, padding: '0 12px 6px' }}>
        {['claude', 'codex'].map(t => (
          <button key={t} className={`chip ${filters.tools.has(t) ? 'on' : ''}`} onClick={() => toggle('tools', t)}>
            {t.toUpperCase()}
          </button>
        ))}
        {Object.entries(STATUS_META).map(([k, label]) => (
          <button key={k} className={`chip ${filters.statuses.has(k) ? 'on' : ''}`} onClick={() => toggle('statuses', k)}>
            {label}
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 5, padding: '0 12px 10px', borderBottom: '1px solid var(--line)' }}>
        {RANGES.map(([k, label]) => (
          <button key={k} className={`chip ${filters.range === k ? 'on' : ''}`} onClick={() => setFilters(f => ({ ...f, range: k }))}>
            {label}
          </button>
        ))}
      </div>

      {/* ===== 工作区清单 ===== */}
      <div className="mono" style={{ padding: '8px 14px 4px', fontSize: 10, color: 'var(--ink-faint)', letterSpacing: '0.1em' }}>
        WORKSPACES · {workspaces.length}
      </div>
      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        {workspaces.length === 0 && (
          <div style={{ padding: '10px 14px', fontSize: 11.5, color: 'var(--ink-faint)', lineHeight: 1.6 }}>
            当前筛选下没有工作区——试试清空搜索或放宽筛选。
          </div>
        )}
        {workspaces.map(ws => (
          <div
            key={ws.path}
            onClick={() => onFocus(ws.path)}
            title={`${ws.path}\n单击定位 · 双击名字改名`}
            style={{ padding: '7px 14px', cursor: 'pointer', transition: 'background 0.12s' }}
            onMouseEnter={e => e.currentTarget.style.background = 'var(--bg-hover)'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
          >
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
              <span style={{
                fontSize: 12.5, fontWeight: 500, flex: 1,
                whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
              }} onDoubleClick={e => e.stopPropagation()}>
                {ws.parent ? '⎇ ' : ''}
                <InlineEdit
                  value={ws.name}
                  onSave={name => onRenameWs(ws.path, name)}
                  title="双击改名（仅看板显示，不动真实目录）"
                />
              </span>
              <span className="mono" style={{ fontSize: 9.5, color: 'var(--ink-faint)', flexShrink: 0 }}>
                {relTime(ws.lastActivity)}
              </span>
            </div>
            <div style={{ display: 'flex', gap: 6, marginTop: 2 }}>
              {Object.entries(ws.tools).map(([tool, n]) => (
                <span key={tool} className="mono" style={{ fontSize: 9.5, color: TOOL_META[tool]?.color }}>
                  {TOOL_META[tool]?.label} {n}
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
