/**
 * [INPUT]: 已提交的 Excalidraw elements/BinaryFiles，依赖 React Flow ViewportPortal 与 Excalidraw SVG 导出器
 * [OUTPUT]: 对外提供 InkWorldLayer；沉层/浮层两张静态 SVG 与 React Flow 节点共用唯一 viewport transform
 * [POS]: 普通看板态的 committed ink compositor；只因绘图数据变化导出，视口/悬停/选中不会触发重绘
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import React, { useCallback, useEffect, useState } from 'react';
import { ViewportPortal } from '@xyflow/react';
import { splitDrawingPlanes } from './drawing.js';

const EXPORT_PADDING = 8;
const EMPTY_ELEMENTS = Object.freeze([]);
const EMPTY_FILES = Object.freeze({});

function SvgPlane({ name, snapshot }) {
  const hostRef = useCallback(host => {
    if (host && snapshot?.svg) host.replaceChildren(snapshot.svg);
  }, [snapshot]);

  if (!snapshot) return null;
  return (
    <div
      ref={hostRef}
      className={`ink-world-plane ink-world-${name}`}
      data-ink-plane={name}
      style={{ left: snapshot.x, top: snapshot.y }}
      aria-hidden="true"
    />
  );
}

export default function InkWorldLayer({ elements, files, hidden = false }) {
  const [snapshot, setSnapshot] = useState({ below: null, above: null });
  const committedElements = elements || EMPTY_ELEMENTS;
  const committedFiles = files || EMPTY_FILES;

  useEffect(() => {
    let current = true;
    const { below, above } = splitDrawingPlanes(committedElements);
    if (!below.length && !above.length) {
      setSnapshot({ below: null, above: null });
      return () => { current = false; };
    }

    const renderPlane = async (plane, mod) => {
      if (!plane.length) return null;
      const [minX, minY] = mod.getCommonBounds(plane);
      const svg = await mod.exportToSvg({
        elements: plane,
        files: committedFiles,
        exportPadding: EXPORT_PADDING,
        appState: {
          exportBackground: false,
          exportEmbedScene: false,
          viewBackgroundColor: 'transparent',
        },
      });
      svg.setAttribute('focusable', 'false');
      svg.style.display = 'block';
      svg.style.pointerEvents = 'none';
      return { svg, x: minX - EXPORT_PADDING, y: minY - EXPORT_PADDING };
    };

    // 旧的两平面保留到新的两平面全部准备好；一次 setState 在同一 React commit 中交接。
    import('@excalidraw/excalidraw')
      .then(mod => Promise.all([renderPlane(below, mod), renderPlane(above, mod)]))
      .then(([nextBelow, nextAbove]) => {
        if (current) setSnapshot({ below: nextBelow, above: nextAbove });
      })
      .catch(() => { /* 导出失败时保留上一份已提交快照，不用半份新图覆盖 */ });

    return () => { current = false; };
  }, [committedElements, committedFiles]);

  return (
    <ViewportPortal>
      <div className={`ink-world${hidden ? ' ink-world-hidden' : ''}`}>
        <SvgPlane name="below" snapshot={snapshot.below} />
        <SvgPlane name="above" snapshot={snapshot.above} />
      </div>
    </ViewportPortal>
  );
}
