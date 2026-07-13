/**
 * [INPUT]: 依赖 react、@xyflow/react 的 Handle/Position、util 的展示函数、ui 的 InlineEdit/Icon
 * [OUTPUT]: 对外提供 WorkspaceNode 自定义节点（React Flow node type: workspace，memo 化）
 * [POS]: canvas 的工作区容器——玻璃面 + 工具占比条；worktree 红描边；可选中、双击就地改名、
 *        底部"展开/收起"入口让被折叠的会话永远有路可达
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import React, { memo } from 'react';
import { Handle, Position } from '@xyflow/react';
import { TOOL_META, relTime } from '../util.js';
import { InlineEdit, Icon } from '../ui.jsx';

export default memo(function WorkspaceNode({ data, dragging, selected }) {
  const ws = data.workspace;
  const total = Object.values(ws.tools).reduce((a, b) => a + b, 0);
  return (
    <div
      title={ws.path}
      className={`ws-card ${ws.parent ? 'wt' : ''} ${selected ? 'sel' : ''}`}
      style={{
        width: data.width, height: data.height,
        boxShadow: dragging ? 'var(--shadow-drag)' : undefined,
        cursor: dragging ? 'grabbing' : 'grab',
      }}
    >
      <Handle type="source" position={Position.Right} />
      <Handle type="target" position={Position.Left} />

      {/* ===== 容器头：目录名是主角，双击就地改名（仅看板显示） ===== */}
      <div style={{ padding: '12px 14px 9px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span style={{
            fontSize: 15, fontWeight: 700, letterSpacing: '0.01em',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flex: 1,
          }}>
            {ws.parent ? '⎇ ' : ''}
            <InlineEdit
              value={ws.name}
              editSignal={data.editSignal}
              onSave={data.onRename}
              title="双击改名（仅看板显示，不动真实目录）"
            />
          </span>
          <span className="mono" style={{ fontSize: 10, color: 'var(--ink-faint)', flexShrink: 0 }}>
            {relTime(ws.lastActivity)}
          </span>
        </div>

        {/* ===== 工具占比条：谁家天下一眼见底 ===== */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 7 }}>
          <div style={{ display: 'flex', height: 3, flex: 1, borderRadius: 2, overflow: 'hidden', background: 'var(--line)' }}>
            {Object.entries(ws.tools).map(([tool, n]) => (
              <div key={tool} style={{ width: `${(n / total) * 100}%`, background: TOOL_META[tool]?.color, opacity: 0.85 }} />
            ))}
          </div>
          {Object.entries(ws.tools).map(([tool, n]) => (
            <span key={tool} className="mono" style={{ fontSize: 10, fontWeight: 700, color: TOOL_META[tool]?.color }}>
              {n}
            </span>
          ))}
        </div>
      </div>

      {/* ===== 折叠入口：被藏起来的会话永远有路可达（搜索时全量直显无需入口） ===== */}
      {!data.searching && (data.hidden > 0 || data.expanded) && (
        <div
          className="ws-more nodrag mono"
          onClick={e => { e.stopPropagation(); data.onToggleExpand(); }}
          title={data.expanded ? '收起，只看最近 8 条' : '展开这个工作区的全部会话'}
        >
          {data.expanded
            ? <><Icon name="up" size={10} /> 收起</>
            : <><Icon name="down" size={10} /> 展开其余 {data.hidden} 条</>}
        </div>
      )}
    </div>
  );
});
