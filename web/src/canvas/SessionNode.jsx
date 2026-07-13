/**
 * [INPUT]: 依赖 react、@xyflow/react 的 Handle、util 的 TOOL_META/relTime、ui 的 InlineEdit
 * [OUTPUT]: 对外提供 SessionNode 自定义节点（React Flow node type: session，memo 化）
 * [POS]: canvas 的会话卡片原子——玻璃面 + 工具色脊柱 + 人话标题两行；hover 提边、选中蓝锚、双击就地改名
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import React, { memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import { TOOL_META, relTime } from '../util.js';
import { InlineEdit } from '../ui.jsx';

export default memo(function SessionNode({ data, selected }) {
  const s = data.session;
  const tool = TOOL_META[s.tool];
  return (
    <div
      className={`session-card ${selected ? 'sel' : ''}`}
      style={{
        width: data.width, height: data.height,
        borderLeft: `3px solid ${tool.color}`,        // 工具色脊柱：珊瑚=Claude 青=Codex
        padding: '8px 10px 7px 11px',
        display: 'flex', flexDirection: 'column', gap: 4,
      }}
    >
      <Handle type="source" position={Position.Right} />
      <Handle type="target" position={Position.Left} />
      {/* ===== 标题：人话优先，最多两行；双击就地改名（同步回工具本体） ===== */}
      <div style={{ fontSize: 12.5, fontWeight: 600, lineHeight: 1.4, flex: 1, minHeight: 0, overflow: 'hidden' }}>
        <InlineEdit
          value={s.title}
          editSignal={data.editSignal}
          onSave={data.onRename}
          title="双击改名（同步回 Claude Code / Codex 本体）"
          style={{
            display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
            overflow: 'hidden', wordBreak: 'break-all',
          }}
        />
      </div>

      {/* ===== 元信息一行 ===== */}
      <div className="mono" style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 10, color: 'var(--ink-faint)' }}>
        <span className={`dot ${s.status}`} />
        <span style={{ color: tool.color, fontWeight: 700 }}>{tool.label}</span>
        <span>{relTime(s.updatedAt)}</span>
        {s.kind === 'automation' && (
          <span title="定时自动化任务（已聚合全部运行实例）" style={{ color: 'var(--accent)', fontWeight: 700 }}>
            ⚙ {s.runs > 1 ? `${s.runs} 次运行` : '自动化'}
          </span>
        )}
        {s.subagents > 0 && (
          <span title={`此会话派出过 ${s.subagents} 个子智能体分身作战`} style={{ color: '#7c3aed', fontWeight: 700 }}>
            ⛛ ×{s.subagents}
          </span>
        )}
        {s.gitBranch && s.gitBranch !== 'main' && s.gitBranch !== 'HEAD' && (
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 90 }}>⎇ {s.gitBranch}</span>
        )}
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 5 }}>
          {s.summary && <span title="已有 AI 摘要">◈</span>}
          {s.hasHandoff && <span title="已有接力提示词" style={{ color: 'var(--ok)' }}>⇥</span>}
        </span>
      </div>
    </div>
  );
});
