/**
 * [INPUT]: 依赖 react、@xyflow/react 的 NodeResizer/Handle、ui 的 InlineEdit/Icon
 * [OUTPUT]: 对外提供 BoardNode 自定义节点（React Flow node type: board，memo 化）与 BOARD_COLORS 色表
 * [POS]: canvas 的用户自建画板——五色一等容器，仅标题栏搬家，可选中可连线，拉角调大小、双击就地改名、
 *        删除走自绘确认流（成员自动回原街区）
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import React, { memo } from 'react';
import { NodeResizer, Handle, Position } from '@xyflow/react';
import { InlineEdit, Icon } from '../ui.jsx';

export const BOARD_COLORS = {
  blue:  { fill: '#e9f0fd', line: 'rgba(21, 94, 239, 0.28)', ink: '#155eef' },
  green: { fill: '#e3f6ec', line: 'rgba(18, 183, 106, 0.32)', ink: '#0e9384' },
  amber: { fill: '#fdf3df', line: 'rgba(220, 150, 20, 0.32)', ink: '#b54708' },
  pink:  { fill: '#fdeef6', line: 'rgba(238, 90, 160, 0.32)', ink: '#c11574' },
  gray:  { fill: '#f0f2f5', line: 'rgba(70, 80, 100, 0.28)', ink: '#475467' },
};

export default memo(function BoardNode({ data, dragging, selected }) {
  const { board, count, onSetBoard, onDelBoard } = data;
  const c = BOARD_COLORS[board.color] || BOARD_COLORS.blue;
  return (
    <div
      className={`container-face ${selected ? 'sel' : ''}`}
      style={{
        width: '100%', height: '100%',
        '--face-fill': c.fill, '--face-line': c.line,
        cursor: 'default',
      }}
    >
      <NodeResizer
        minWidth={380} minHeight={240}
        isVisible
        lineStyle={{ borderColor: 'transparent', borderWidth: 6 }}
        handleStyle={{ width: 12, height: 12, borderRadius: 4, background: c.ink, border: '2px solid #fff' }}
        onResizeEnd={(_, p) => onSetBoard({
          id: board.id, x: Math.round(p.x), y: Math.round(p.y),
          w: Math.round(p.width), h: Math.round(p.height),
        })}
      />
      <Handle type="source" position={Position.Right} style={{ top: 30 }} />
      <Handle type="target" position={Position.Left} style={{ top: 30 }} />

      {/* ===== 画板路牌：锚线 + 就地改名 + 五色盘 + 删除 ===== */}
      <div className="container-drag-handle" title="拖动标题栏搬动画板（成员仅在明确搬家时跟随）"
        style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '18px 24px 12px', cursor: dragging ? 'grabbing' : 'grab' }}>
        <span style={{ width: 22, height: 3, background: c.ink, borderRadius: 2, opacity: 0.8 }} />
        <span className="eyebrow nodrag" style={{ fontSize: 11.5, color: c.ink, opacity: 0.9 }}>
          <InlineEdit
            value={board.name}
            editSignal={data.editSignal}
            onSave={name => onSetBoard({ id: board.id, name })}
            title="双击改名"
          />
        </span>
        <span className="eyebrow">{count} 工作区</span>

        <span className="nodrag" style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
          {Object.entries(BOARD_COLORS).map(([name, cc]) => (
            <span key={name}
              onClick={() => onSetBoard({ id: board.id, color: name })}
              title="换个颜色"
              style={{
                width: 12, height: 12, borderRadius: '50%', cursor: 'pointer',
                background: cc.fill, border: `1.5px solid ${name === (board.color || 'blue') ? cc.ink : cc.line}`,
              }} />
          ))}
          <span
            onClick={e => onDelBoard(board, { x: e.clientX, y: e.clientY })}
            style={{ cursor: 'pointer', color: 'var(--ink-faint)', lineHeight: 1, marginLeft: 4, display: 'inline-flex' }}
            title="删除画板（成员自动回原街区）"><Icon name="trash" size={12} /></span>
        </span>
      </div>
    </div>
  );
});
