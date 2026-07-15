/**
 * [INPUT]: 已提交的 Excalidraw elements/BinaryFiles、事务 originalIds 与帧 revision，依赖 ViewportPortal/SVG 导出器
 * [OUTPUT]: 对外提供 InkWorldLayer；沉/浮连续 z-order SVG groups + frame font capsule 共用 RF 相机并按签名复用，在新帧已进 DOM 后回报 ready/metrics
 * [POS]: committed ink compositor；编辑时只 hole-punch 事务原件，所有 dirty/join groups 与字体胶囊就绪前保留旧完整帧
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ViewportPortal } from '@xyflow/react';
import {
  drawingFontSignature, drawingFontWorkRoute, drawingPlaneGroupPlan, drawingPlaneGroups, drawingPlaneSettledInFlight,
  drawingTransactionVisibleElements, splitDrawingPlanes,
} from './drawing.js';

const EXPORT_PADDING = 8;
const EMPTY_ELEMENTS = Object.freeze([]);
const EMPTY_FILES = Object.freeze({});
const PLANE_NAMES = Object.freeze(['below', 'above']);

function SvgGroup({ name, index, snapshot }) {
  const hostRef = useCallback(host => {
    if (host && snapshot?.svg) host.replaceChildren(snapshot.svg);
  }, [snapshot]);

  if (!snapshot) return null;
  return (
    <div
      ref={hostRef}
      className={`ink-world-plane ink-world-${name}`}
      data-ink-plane={name}
      data-ink-group={index}
      style={{ left: snapshot.x, top: snapshot.y }}
      aria-hidden="true"
    />
  );
}

export default function InkWorldLayer({ elements, files, excludedIds = EMPTY_ELEMENTS, revision = 0, onSnapshotReady, onSnapshotError }) {
  const [snapshot, setSnapshot] = useState({ below: [], above: [], fonts: '', revision: -1, metrics: null });
  const readyRef = useRef({ below: [], above: [] });
  const inFlightRef = useRef({ below: [], above: [] });
  const fontReadyRef = useRef({ signature: null, css: '' });
  const fontInFlightRef = useRef(null);
  const committedElements = elements || EMPTY_ELEMENTS;
  const committedFiles = files || EMPTY_FILES;

  // ref callback 已把整帧 groups 放进 DOM；layout effect 再通知父层同步显隐 live draft，首 paint 前闭合交接。
  useLayoutEffect(() => {
    if (snapshot.revision === revision) onSnapshotReady?.(revision, snapshot.metrics);
  }, [snapshot, revision, onSnapshotReady]);

  useEffect(() => {
    let current = true;
    const started = performance.now();
    const visible = drawingTransactionVisibleElements(committedElements, excludedIds);
    const planes = splitDrawingPlanes(visible);
    const textElements = visible.filter(element => element?.type === 'text');
    const fontSignature = drawingFontSignature(textElements);
    const fontRoute = drawingFontWorkRoute(
      fontReadyRef.current.signature, fontInFlightRef.current?.signature, fontSignature, !!textElements.length,
    );
    const groups = Object.fromEntries(PLANE_NAMES.map(name => [name, drawingPlaneGroups(planes[name], committedFiles)]));
    const plans = Object.fromEntries(PLANE_NAMES.map(name => [name, drawingPlaneGroupPlan(
      readyRef.current[name], inFlightRef.current[name], groups[name],
    )]));
    const groupCounts = Object.fromEntries(PLANE_NAMES.map(name => {
      const plan = plans[name];
      return [name, {
        total: plan.length,
        exported: plan.filter(group => group.route === 'export').length,
        joined: plan.filter(group => group.route === 'join').length,
        reused: plan.filter(group => group.route === 'ready').length,
        cleared: Math.max(0, readyRef.current[name].length - plan.length),
      }];
    }));
    const planeRoute = name => {
      const counts = groupCounts[name];
      if (counts.exported) return 'export';
      if (counts.joined) return 'join';
      if (counts.cleared) return 'clear';
      return 'ready';
    };
    const exported = PLANE_NAMES.filter(name => planeRoute(name) === 'export');
    const joined = PLANE_NAMES.filter(name => planeRoute(name) === 'join');
    const reused = PLANE_NAMES.filter(name => planeRoute(name) === 'ready');
    const cleared = PLANE_NAMES.filter(name => planeRoute(name) === 'clear');

    const exportSvg = (exportElements, mod, skipInliningFonts) => mod.exportToSvg({
      elements: exportElements,
      files: committedFiles,
      exportPadding: EXPORT_PADDING,
      skipInliningFonts,
      appState: {
        exportBackground: false,
        exportEmbedScene: false,
        viewBackgroundColor: 'transparent',
      },
    });

    const renderGroup = async (group, mod) => {
      const [minX, minY] = mod.getCommonBounds(group.elements);
      const svg = await exportSvg(group.elements, mod, true);
      svg.setAttribute('focusable', 'false');
      svg.style.display = 'block';
      svg.style.pointerEvents = 'none';
      return { svg, x: minX - EXPORT_PADDING, y: minY - EXPORT_PADDING };
    };

    const renderFontCapsule = async mod => {
      const svg = await exportSvg(textElements, mod, false);
      return [...svg.querySelectorAll('style')]
        .filter(style => style.classList.contains('style-fonts') || style.textContent.includes('@font-face'))
        .map(style => style.textContent)
        .join('\n');
    };

    let modulePromise = null;
    const startExport = (name, group) => {
      modulePromise ||= import('@excalidraw/excalidraw');
      const promise = modulePromise.then(mod => renderGroup(group, mod));
      const planeInFlight = [...inFlightRef.current[name]];
      planeInFlight[group.index] = { signature: group.signature, promise };
      inFlightRef.current = {
        ...inFlightRef.current,
        [name]: planeInFlight,
      };
      const settle = () => {
        const before = inFlightRef.current[name][group.index];
        const after = drawingPlaneSettledInFlight(before, promise);
        if (after === before) return;
        const nextPlane = [...inFlightRef.current[name]];
        nextPlane[group.index] = after;
        inFlightRef.current = { ...inFlightRef.current, [name]: nextPlane };
      };
      promise.then(settle, settle);
      return promise;
    };

    const startFontExport = () => {
      modulePromise ||= import('@excalidraw/excalidraw');
      const promise = modulePromise.then(renderFontCapsule);
      fontInFlightRef.current = { signature: fontSignature, promise };
      const settle = () => {
        fontInFlightRef.current = drawingPlaneSettledInFlight(fontInFlightRef.current, promise);
      };
      promise.then(settle, settle);
      return promise;
    };

    const work = Object.fromEntries(PLANE_NAMES.map(name => [name, Promise.all(plans[name].map(group => {
      if (group.route === 'ready') return Promise.resolve(group.ready.snapshot);
      if (group.route === 'join') return group.inFlight.promise;
      return startExport(name, group);
    }))]));
    const fontWork = fontRoute === 'ready' ? Promise.resolve(fontReadyRef.current.css)
      : fontRoute === 'clear' ? Promise.resolve('')
        : fontRoute === 'join' ? fontInFlightRef.current.promise
          : startFontExport();

    const commitFrame = (rendered, fontCss) => {
      if (!current) return;
      const nextReady = Object.fromEntries(PLANE_NAMES.map(name => [name, groups[name].map((group, index) => ({
        signature: group.signature, snapshot: rendered[name][index],
      }))]));
      readyRef.current = nextReady;
      fontReadyRef.current = { signature: fontSignature, css: fontCss };
      setSnapshot({
        below: rendered.below,
        above: rendered.above,
        fonts: fontCss,
        revision,
        metrics: {
          exported, joined, reused, cleared, groupCounts,
          font: {
            exported: Number(fontRoute === 'export'), joined: Number(fontRoute === 'join'),
            reused: Number(fontRoute === 'ready'), cleared: Number(fontRoute === 'clear'),
          },
          duration: performance.now() - started,
        },
      });
    };

    // ready 零导出、同签名在途 join；所有组与字体胶囊完成后一次 commit，迟到世代丢弃。
    Promise.all([
      Promise.all(PLANE_NAMES.map(async name => [name, await work[name]])),
      fontWork,
    ])
      .then(([entries, fontCss]) => commitFrame(Object.fromEntries(entries), fontCss))
      .catch(error => {
        if (current) onSnapshotError?.(revision, error);   // 保留上一帧，不用半份新图覆盖
      });

    return () => { current = false; };
  }, [committedElements, committedFiles, excludedIds, revision, onSnapshotError]);

  return (
    <ViewportPortal>
      <div className="ink-world">
        {snapshot.fonts ? <style data-ink-fonts="true">{snapshot.fonts}</style> : null}
        {snapshot.below.map((group, index) => <SvgGroup key={`below-${index}`} name="below" index={index} snapshot={group} />)}
        {snapshot.above.map((group, index) => <SvgGroup key={`above-${index}`} name="above" index={index} snapshot={group} />)}
      </div>
    </ViewportPortal>
  );
}
