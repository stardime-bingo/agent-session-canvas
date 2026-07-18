/**
 * [INPUT]: 场景文档的 drawing/drawingFiles、选中 id、ink.js 的路径纯函数；@xyflow/react 的 ViewportPortal
 * [OUTPUT]: 对外提供 InkLayer——把元素直接渲染成 SVG（沉/浮两平面），与卡片共用唯一 RF 相机；
 *           每个元素带 data-ink-element-id（承载桥/命中共用），选中元素画选择环
 * [POS]: canvas 的自研墨迹渲染层。没有导出、没有帧、没有交接——React 渲染就是全部管线，
 *        文档变更到像素可见 = 一次 React commit
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import React, { memo } from 'react';
import { ViewportPortal } from '@xyflow/react';
import { committedDrawingElements, drawingBounds } from './drawing.js';
import { arrowPath, diamondPath, freedrawPath, INK_FONT } from './ink.js';

const fill = el => el.backgroundColor && el.backgroundColor !== 'transparent' ? el.backgroundColor : 'none';
const rotation = el => el.angle
  ? `rotate(${(el.angle * 180) / Math.PI} ${el.x + (el.width || 0) / 2} ${el.y + (el.height || 0) / 2})`
  : undefined;

function InkElement({ el, files }) {
  const stroke = el.strokeColor || '#1e1e1e';
  const common = {
    stroke, strokeWidth: el.strokeWidth || 2, fill: fill(el),
    strokeLinecap: 'round', strokeLinejoin: 'round',
  };
  let shape = null;
  if (el.type === 'freedraw') {
    shape = <path d={freedrawPath(el.points)} {...common} fill="none" />;
  } else if (el.type === 'line' || el.type === 'arrow') {
    const abs = el.points.map(([px, py]) => [el.x + px, el.y + py]);
    shape = <path d={el.type === 'arrow' ? arrowPath(abs) : abs.map(([x, y], i) => `${i ? 'L' : 'M'} ${x} ${y}`).join(' ')} {...common} fill="none" />;
  } else if (el.type === 'rectangle') {
    shape = <rect x={el.x} y={el.y} width={el.width} height={el.height} rx={el.roundness ? 8 : 0} {...common} />;
  } else if (el.type === 'ellipse') {
    shape = <ellipse cx={el.x + el.width / 2} cy={el.y + el.height / 2} rx={el.width / 2} ry={el.height / 2} {...common} />;
  } else if (el.type === 'diamond') {
    shape = <g transform={`translate(${el.x} ${el.y})`}><path d={diamondPath(el.width, el.height)} {...common} /></g>;
  } else if (el.type === 'text') {
    const size = el.fontSize || 20;
    shape = (
      <text x={el.x} y={el.y} fill={stroke} stroke="none"
        fontSize={size} fontFamily={INK_FONT} style={{ whiteSpace: 'pre', userSelect: 'none' }}>
        {String(el.text || '').split('\n').map((line, i) => (
          <tspan key={i} x={el.x} dy={i === 0 ? size : size * 1.3}>{line}</tspan>
        ))}
      </text>
    );
  } else if (el.type === 'image') {
    const url = files?.[el.fileId]?.dataURL;
    shape = url ? <image href={url} x={el.x} y={el.y} width={el.width} height={el.height} preserveAspectRatio="none" /> : null;
  }
  if (!shape) return null;
  return (
    <g data-ink-element-id={el.id} transform={rotation(el)} opacity={(el.opacity ?? 100) / 100}>
      {shape}
    </g>
  );
}

const InkPlane = memo(function InkPlane({ elements, files, name }) {
  if (!elements.length) return null;
  return (
    <svg className={`ink-svg ink-svg-${name}`} data-ink-plane={name}
      style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible', pointerEvents: 'none' }}
      width="1" height="1" aria-hidden="true">
      {elements.map(el => <InkElement key={el.id} el={el} files={files} />)}
    </svg>
  );
});

// 选择环：贴着元素包围盒的呼吸描边——选中态一眼可见，双击提示文字编辑
function SelectionRing({ element }) {
  if (!element) return null;
  const b = drawingBounds([element]);
  if (!b) return null;
  const pad = 6;
  return (
    <svg style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible', pointerEvents: 'none' }}
      width="1" height="1" aria-hidden="true">
      <rect x={b.minX - pad} y={b.minY - pad} width={b.maxX - b.minX + pad * 2} height={b.maxY - b.minY + pad * 2}
        fill="none" stroke="#155eef" strokeWidth={1.5} strokeDasharray="6 4" rx={6} />
    </svg>
  );
}

export default function InkLayer({ elements, files, selectedId, hideIds }) {
  const alive = committedDrawingElements(elements);
  const hidden = hideIds?.size ? alive.filter(el => !hideIds.has(el.id)) : alive;
  const below = hidden.filter(el => el.customData?.below);
  const above = hidden.filter(el => !el.customData?.below);
  const selected = selectedId ? alive.find(el => el.id === selectedId) : null;
  return (
    <ViewportPortal>
      {/* 沉层垫底：zIndex 由 DOM 顺序天然决定——portal 内容先于节点渲染即在下方 */}
      <div className="ink-world" data-ink-native="true" style={{ pointerEvents: 'none' }}>
        <InkPlane elements={below} files={files} name="below" />
        <InkPlane elements={above} files={files} name="above" />
        <SelectionRing element={selected} />
      </div>
    </ViewportPortal>
  );
}
