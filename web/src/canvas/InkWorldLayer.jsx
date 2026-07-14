/**
 * [INPUT]: 已提交的 Excalidraw elements/BinaryFiles、事务 originalIds 与帧 revision，依赖 ViewportPortal/SVG 导出器
 * [OUTPUT]: 对外提供 InkWorldLayer；沉/浮静态 SVG 共用 RF 相机，并在新 SVG 已进入 DOM 后回报 snapshot ready
 * [POS]: committed ink compositor；编辑时只 hole-punch 事务原件，旧帧保留到完整新帧同次交接
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import React, { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { ViewportPortal } from '@xyflow/react';
import { drawingTransactionVisibleElements, splitDrawingPlanes } from './drawing.js';

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

export default function InkWorldLayer({ elements, files, excludedIds = EMPTY_ELEMENTS, revision = 0, onSnapshotReady, onSnapshotError }) {
  const [snapshot, setSnapshot] = useState({ below: null, above: null, revision: -1 });
  const committedElements = elements || EMPTY_ELEMENTS;
  const committedFiles = files || EMPTY_FILES;

  // ref callback 已把两张 SVG 放进 DOM；layout effect 再通知父层同步显隐 live draft，首 paint 前闭合交接。
  useLayoutEffect(() => {
    if (snapshot.revision === revision) onSnapshotReady?.(revision);
  }, [snapshot, revision, onSnapshotReady]);

  useEffect(() => {
    let current = true;
    const visible = drawingTransactionVisibleElements(committedElements, excludedIds);
    const { below, above } = splitDrawingPlanes(visible);
    if (!below.length && !above.length) {
      setSnapshot({ below: null, above: null, revision });
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
        if (current) setSnapshot({ below: nextBelow, above: nextAbove, revision });
      })
      .catch(error => {
        if (current) onSnapshotError?.(revision, error);   // 保留上一帧，不用半份新图覆盖
      });

    return () => { current = false; };
  }, [committedElements, committedFiles, excludedIds]);

  return (
    <ViewportPortal>
      <div className="ink-world">
        <SvgPlane name="below" snapshot={snapshot.below} />
        <SvgPlane name="above" snapshot={snapshot.above} />
      </div>
    </ViewportPortal>
  );
}
