/**
 * [INPUT]: 依赖 react、@xyflow/react 的 NodeResizer/Handle
 * [OUTPUT]: 对外提供 DistrictNode 自定义节点（React Flow node type: district，memo 化）
 * [POS]: canvas 的自动街区容器——与画板同一张皮（container-face），可选中、可连线、
 *        拉角/拉边调尺寸（下限=内容包络）、块内自由整理、仅标题栏可明确拖块搬家
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import React, { memo } from 'react';
import { NodeResizer, Handle, Position } from '@xyflow/react';

export default memo(function DistrictNode({ data, dragging, selected }) {
  return (
    <div
      className={`container-face ${selected ? 'sel' : ''}`}
      style={{
        width: '100%', height: '100%',
        '--face-fill': 'var(--board-fill)', '--face-line': 'var(--board-line)',
        cursor: 'default',
      }}
    >
      <NodeResizer
        minWidth={data._minW} minHeight={data._minH}
        isVisible
        lineStyle={{ borderColor: 'transparent', borderWidth: 6 }}
        handleStyle={{ width: 12, height: 12, borderRadius: 4, background: 'var(--accent)', border: '2px solid #fff' }}
        onResizeEnd={(_, p) => data.onResize(p)}
      />
      <Handle type="source" position={Position.Right} style={{ top: 30 }} />
      <Handle type="target" position={Position.Left} style={{ top: 30 }} />

      {/* ===== 街区路牌：蓝锚线 + 眉标 ===== */}
      <div className="container-drag-handle" title="拖动标题栏搬动整个街区"
        style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '18px 24px 12px', cursor: dragging ? 'grabbing' : 'grab' }}>
        <span style={{ width: 22, height: 3, background: 'var(--accent)', borderRadius: 2, opacity: 0.8 }} />
        <span className="eyebrow" style={{ fontSize: 11.5, color: 'var(--accent)', opacity: 0.9 }}>
          {data.name}
        </span>
        <span className="eyebrow">{data.count} 工作区</span>
      </div>
    </div>
  );
});
