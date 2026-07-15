/**
 * [INPUT]: 依赖 react-dom 的 createPortal、drawing 的 drawingBounds/isBelow，只接收已 paint 的 rendered world/revision
 * [OUTPUT]: 对外提供 MiniMapInk 组件：把同代绘图元素画进 React Flow 小地图——镜像其 svg viewBox，零重复投影数学
 * [POS]: canvas 的小地图墨迹层。缩略图是空间定向工具，区域底板是最有定向价值的地标（Miro 共识：小地图画一切）
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { drawingBounds, isBelow } from './drawing.js';

export default function MiniMapInk({ elements, revision, rootRef }) {
  const [host, setHost] = useState(null);
  const [viewBox, setViewBox] = useState(null);

  // 小地图的 svg viewBox 就是 flow 坐标窗：镜像它，投影永远与节点层一致
  useEffect(() => {
    const panel = rootRef.current?.querySelector('.react-flow__minimap');
    const svg = panel?.querySelector('svg');
    if (!panel || !svg) return;
    setHost(panel);
    const sync = () => setViewBox(svg.getAttribute('viewBox'));
    sync();
    const mo = new MutationObserver(sync);
    mo.observe(svg, { attributes: true, attributeFilter: ['viewBox'] });
    return () => { mo.disconnect(); setHost(null); };
  }, [rootRef]);

  if (!host || !viewBox || !elements?.length) return null;
  return createPortal(
    <svg className="mini-ink" viewBox={viewBox} data-rendered-revision={revision}>
      {elements.map(el => {
        if (!el || el.isDeleted || el.containerId) return null;
        const b = drawingBounds([el]);
        if (!b) return null;
        const filled = el.backgroundColor && el.backgroundColor !== 'transparent';
        return (
          <rect key={el.id} x={b.minX} y={b.minY} width={b.maxX - b.minX} height={b.maxY - b.minY}
            rx={8} fill={filled ? el.backgroundColor : 'none'}
            stroke={el.strokeColor || '#7c3aed'} strokeWidth={1.2} vectorEffect="non-scaling-stroke"
            opacity={isBelow(el) ? 0.45 : 0.7} />
        );
      })}
    </svg>,
    host,
  );
}
