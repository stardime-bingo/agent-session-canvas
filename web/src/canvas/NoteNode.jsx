/**
 * [INPUT]: 依赖 react、@xyflow/react 的 Handle/Position/NodeResizer、ui 的 Icon
 * [OUTPUT]: 对外提供 NoteNode 自定义节点（React Flow node type: note，memo 化）
 * [POS]: canvas 的用户便签——四色贴纸，可选中，新便签落地即入编辑态；
 *        删除走确认流（写了字的才打断），拉角调尺寸持久化，文字区 nodrag 防拖动冲突
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import React, { memo, useState, useEffect, useRef } from 'react';
import { Handle, Position, NodeResizer } from '@xyflow/react';
import { Icon } from '../ui.jsx';

const COLORS = {
  yellow: { bg: '#fef7c3', line: '#eaddb0', ink: '#713f12' },
  blue:   { bg: '#e0eaff', line: '#c7d7fe', ink: '#1e3a8a' },
  pink:   { bg: '#fce7f6', line: '#fcceee', ink: '#831843' },
  green:  { bg: '#d3f8df', line: '#aaf0c4', ink: '#14532d' },
};

export default memo(function NoteNode({ data, selected }) {
  const { note, onSetNote, onDelNote } = data;
  const [text, setText] = useState(note.text);
  const timer = useRef(null);
  const c = COLORS[note.color] || COLORS.yellow;
  // 新生便签（5 秒内诞生且还没写字）落地即入编辑态——贴上就能写，不用再点一下
  const isNewborn = useRef(!note.text && Date.now() - (+note.id.split(':')[1] || 0) < 5000).current;

  useEffect(() => setText(note.text), [note.id]);   // 换便签时同步，输入中不回灌

  // 卸载即灭火：防止删除后残留的防抖计时器把便签从坟里刨回来
  useEffect(() => () => clearTimeout(timer.current), []);

  // ---- 输入防抖落盘：停笔 600ms 只补丁 text 字段 ----
  const onInput = v => {
    setText(v);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => onSetNote({ id: note.id, text: v }), 600);
  };

  return (
    <div
      className={`note-face ${selected ? 'sel' : ''}`}
      style={{
        width: '100%', height: '100%',
        display: 'flex', flexDirection: 'column',
        '--face-fill': c.bg, '--face-line': c.line,
        borderRadius: 4, padding: '10px 12px 12px',
        boxShadow: '0 4px 14px rgba(16, 24, 40, 0.12)',
        cursor: 'grab',
      }}
    >
      <NodeResizer
        minWidth={170} minHeight={100}
        isVisible
        lineStyle={{ borderColor: 'transparent', borderWidth: 6 }}
        handleStyle={{ width: 10, height: 10, borderRadius: 3, background: c.ink, border: '2px solid #fff' }}
        onResizeEnd={(_, p) => onSetNote({
          id: note.id, x: Math.round(p.x), y: Math.round(p.y),
          w: Math.round(p.width), h: Math.round(p.height),
        })}
      />
      <Handle type="source" position={Position.Right} />
      <Handle type="target" position={Position.Left} />

      {/* ===== 头排即把手：只有色点和删除是 nodrag，其余区域都能抓着拖 ===== */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, flexShrink: 0 }}>
        {Object.entries(COLORS).map(([name, cc]) => (
          <span key={name} className="nodrag"
            onClick={() => onSetNote({ id: note.id, color: name })}
            style={{
              width: 11, height: 11, borderRadius: '50%', cursor: 'pointer',
              background: cc.bg, border: `1.5px solid ${name === note.color ? cc.ink : cc.line}`,
            }} />
        ))}
        <span style={{ flex: 1, minHeight: 14 }} title="按住拖动 · 右键可复制" />
        <span className="nodrag"
          onClick={e => onDelNote(note, { x: e.clientX, y: e.clientY })}
          style={{ cursor: 'pointer', color: c.ink, opacity: 0.55, lineHeight: 1, display: 'inline-flex' }}
          title="删除便签"><Icon name="trash" size={12} /></span>
      </div>

      <textarea
        className="nodrag nowheel"
        value={text}
        autoFocus={isNewborn}
        placeholder="写点什么…"
        onChange={e => onInput(e.target.value)}
        style={{
          flex: 1, width: '100%', border: 'none', outline: 'none', resize: 'none',
          background: 'transparent', color: c.ink,
          fontFamily: 'var(--sans)', fontSize: 13, lineHeight: 1.6,
        }}
      />
    </div>
  );
});
