/**
 * [INPUT]: 场景文档的 drawing/drawingFiles、选中 ids、ink.js/ink-selection.js 纯函数；@xyflow/react 的 ViewportPortal
 * [OUTPUT]: 对外提供 InkLayer——把元素直接渲染成 SVG（沉/浮两平面），与卡片共用唯一 RF 相机；
 *           每个元素带 data-ink-element-id（承载桥/命中共用），选中元素画选择环
 * [POS]: canvas 的自研墨迹渲染层。没有导出、没有帧、没有交接——React 渲染就是全部管线，
 *        文档变更到像素可见 = 一次 React commit
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import React, { memo } from 'react';
import { ViewportPortal } from '@xyflow/react';
import { committedDrawingElements } from './drawing.js';
import { arrowPath, diamondPath, freedrawPath, INK_FONT } from './ink.js';
import { selectionBounds, selectionHandlePoints } from './ink-selection.js';

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
    shape = url ? (
      <image href={url} x={el.x} y={el.y} width={el.width} height={el.height} preserveAspectRatio="none" />
    ) : (
      <g>
        <rect x={el.x} y={el.y} width={el.width} height={el.height} rx={10}
          fill={el.customData?.importError ? '#fef3f2' : '#f2f4f7'} stroke={el.customData?.importError ? '#f97066' : '#98a2b3'}
          strokeWidth={1.5} strokeDasharray="7 5" />
        <text x={el.x + el.width / 2} y={el.y + el.height / 2} textAnchor="middle" dominantBaseline="middle"
          fill={el.customData?.importError ? '#b42318' : '#667085'} stroke="none" fontSize="14" fontFamily={INK_FONT}>
          {el.customData?.importError ? '图片导入失败' : '正在导入图片…'}
        </text>
      </g>
    );
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

// 同一选择框承载单选/多选、八向缩放与旋转；命中仍由 InkTools 的 flow 几何负责。
function SelectionRing({ elements, selectedIds }) {
  const b = selectionBounds(elements, selectedIds);
  if (!b) return null;
  const pad = 6;
  const box = { minX: b.minX - pad, minY: b.minY - pad, maxX: b.maxX + pad, maxY: b.maxY + pad };
  const handles = selectionHandlePoints(b);
  return (
    <svg style={{ position: 'absolute', left: 0, top: 0, overflow: 'visible', pointerEvents: 'none' }}
      width="1" height="1" aria-hidden="true">
      <rect x={box.minX} y={box.minY} width={box.maxX - box.minX} height={box.maxY - box.minY}
        fill="none" stroke="#155eef" strokeWidth={1.5} rx={4} vectorEffect="non-scaling-stroke" />
      <line x1={handles.n[0]} y1={handles.n[1]} x2={handles.rotate[0]} y2={handles.rotate[1]}
        stroke="#155eef" strokeWidth={1.25} vectorEffect="non-scaling-stroke" />
      {Object.entries(handles).map(([handle, [x, y]]) => (
        <circle key={handle} data-ink-handle={handle} cx={x} cy={y} r={handle === 'rotate' ? 4.5 : 4}
          fill="#fff" stroke="#155eef" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
      ))}
    </svg>
  );
}

export default function InkLayer({ elements, files, selectedId, selectedIds, hideIds }) {
  const alive = committedDrawingElements(elements);
  const hidden = hideIds?.size ? alive.filter(el => !hideIds.has(el.id)) : alive;
  const below = hidden.filter(el => el.customData?.below);
  const above = hidden.filter(el => !el.customData?.below);
  const selection = selectedIds || (selectedId ? [selectedId] : []);
  return (
    <ViewportPortal>
      {/* 沉层垫底：zIndex 由 DOM 顺序天然决定——portal 内容先于节点渲染即在下方 */}
      <div className="ink-world" data-ink-native="true" style={{ pointerEvents: 'none' }}>
        <InkPlane elements={below} files={files} name="below" />
        <InkPlane elements={above} files={files} name="above" />
        <SelectionRing elements={alive} selectedIds={selection} />
      </div>
    </ViewportPortal>
  );
}
