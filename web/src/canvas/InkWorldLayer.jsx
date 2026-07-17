/**
 * [INPUT]: 已提交的 Excalidraw elements/BinaryFiles、事务 originalIds 与帧 revision，依赖 ViewportPortal/SVG 导出器；4518 可仅替换 exporter 做故障注入
 * [OUTPUT]: 对外提供 InkWorldLayer；沉/浮固定 z-order 槽内 hole SVG groups 以 1x 世界尺寸 + frame font capsule 共用 RF 相机并按签名复用，在新帧已进 DOM 后回报 visible rendered world/metrics
 * [POS]: committed ink compositor；编辑时只 hole-punch 事务原件，空槽 clear 不导出，所有 dirty/join groups 与字体胶囊就绪前保留旧完整帧，失败有界重试
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ViewportPortal } from '@xyflow/react';
import {
  drawingFontSignature, drawingFontWorkRoute, drawingFrameRetryDecision, drawingPlaneGroupPlan, drawingPlaneGroups, drawingPlaneSettledInFlight,
  drawingTransactionVisibleElements, splitDrawingPlanes,
} from './drawing.js';
import { installExportMarkers, markerExportElements } from './container-carry.js';

const EXPORT_PADDING = 8;
const EMPTY_ELEMENTS = Object.freeze([]);
const EMPTY_FILES = Object.freeze({});
const PLANE_NAMES = Object.freeze(['below', 'above']);
let excalidrawModulePromise = null;
const loadExcalidraw = () => {
  excalidrawModulePromise ||= import('@excalidraw/excalidraw').catch(error => {
    excalidrawModulePromise = null;
    throw error;
  });
  return excalidrawModulePromise;
};

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

export default function InkWorldLayer({ elements, files, excludedIds = EMPTY_ELEMENTS, revision = 0, generationId = null, onSnapshotReady, onSnapshotError, exporterProbe, retryToken = 0 }) {
  const [snapshot, setSnapshot] = useState({ below: [], above: [], fonts: '', revision: -1, metrics: null, world: null });
  const [retryRequest, setRetryRequest] = useState({ revision: -1, attempt: 1, token: 0 });
  const readyRef = useRef({ below: [], above: [] });
  const inFlightRef = useRef({ below: [], above: [] });
  const fontReadyRef = useRef({ signature: null, css: '' });
  const fontInFlightRef = useRef(null);
  const committedElements = elements || EMPTY_ELEMENTS;
  const committedFiles = files || EMPTY_FILES;

  // ref callback 已把整帧 groups 放进 DOM；layout effect 再通知父层同步显隐 live draft，首 paint 前闭合交接。
  useLayoutEffect(() => {
    if (snapshot.revision === revision) onSnapshotReady?.(revision, snapshot.metrics, snapshot.world);
  }, [snapshot, revision, onSnapshotReady]);

  useEffect(() => {
    let current = true;
    let retryTimer = null;
    const attempt = retryRequest.revision === revision && retryRequest.token === retryToken ? retryRequest.attempt : 1;
    const started = performance.now();
    const visible = drawingTransactionVisibleElements(committedElements, excludedIds);
    const planes = splitDrawingPlanes(committedElements);
    const textElements = visible.filter(element => element?.type === 'text');
    const fontSignature = drawingFontSignature(textElements);
    const fontRoute = drawingFontWorkRoute(
      fontReadyRef.current.signature, fontInFlightRef.current?.signature, fontSignature, !!textElements.length,
    );
    const groups = Object.fromEntries(PLANE_NAMES.map(name => [name, drawingPlaneGroups(
      planes[name], committedFiles, undefined, excludedIds,
    )]));
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
        cleared: plan.filter(group => group.route === 'clear').length
          + Math.max(0, readyRef.current[name].length - plan.length),
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

    const exportSvg = (exportElements, mod, skipInliningFonts, kind) => {
      const options = {
        elements: kind === 'group' ? markerExportElements(exportElements) : exportElements,
        files: committedFiles,
        exportPadding: EXPORT_PADDING,
        skipInliningFonts,
        appState: {
          exportBackground: false,
          exportEmbedScene: false,
          exportScale: 1,
          viewBackgroundColor: 'transparent',
        },
      };
      const delegate = nextOptions => mod.exportToSvg(nextOptions);
      return exporterProbe?.exportToSvg
        ? exporterProbe.exportToSvg({ revision, attempt, kind, elements: exportElements, options, delegate })
        : delegate(options);
    };

    const renderGroup = async (group, mod) => {
      const [minX, minY] = mod.getCommonBounds(group.elements);
      const svg = installExportMarkers(await exportSvg(group.elements, mod, true, 'group'));
      svg.setAttribute('focusable', 'false');
      svg.style.display = 'block';
      svg.style.pointerEvents = 'none';
      return { svg, x: minX - EXPORT_PADDING, y: minY - EXPORT_PADDING };
    };

    const renderFontCapsule = async mod => {
      const svg = await exportSvg(textElements, mod, false, 'font');
      return [...svg.querySelectorAll('style')]
        .filter(style => style.classList.contains('style-fonts') || style.textContent.includes('@font-face'))
        .map(style => style.textContent)
        .join('\n');
    };

    const startExport = (name, group) => {
      const promise = loadExcalidraw().then(mod => renderGroup(group, mod));
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
      const promise = loadExcalidraw().then(renderFontCapsule);
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
      if (group.route === 'clear') return Promise.resolve(null);
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
        world: { elements: visible, files: committedFiles, excludedIds, revision, generationId },
        metrics: {
          exported, joined, reused, cleared, groupCounts,
          font: {
            exported: Number(fontRoute === 'export'), joined: Number(fontRoute === 'join'),
            reused: Number(fontRoute === 'ready'), cleared: Number(fontRoute === 'clear'),
          },
          duration: performance.now() - started,
          attempt,
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
        if (!current) return;
        const decision = drawingFrameRetryDecision(attempt);
        onSnapshotError?.(revision, error, {
          attempt,
          willRetry: decision.retry,
          final: !decision.retry,
          excludedIds,
          generationId,
        });   // 保留上一帧，不用半份新图覆盖
        if (decision.retry) {
          retryTimer = setTimeout(() => {
            if (current) setRetryRequest({ revision, attempt: decision.nextAttempt, token: retryToken });
          }, decision.delayMs);
        }
      });

    return () => {
      current = false;
      clearTimeout(retryTimer);
    };
  }, [committedElements, committedFiles, excludedIds, revision, generationId, retryRequest, retryToken, onSnapshotError, exporterProbe]);

  return (
    <ViewportPortal>
      <div className="ink-world" data-rendered-revision={snapshot.revision}>
        {snapshot.fonts ? <style data-ink-fonts="true">{snapshot.fonts}</style> : null}
        {snapshot.below.map((group, index) => <SvgGroup key={`below-${index}`} name="below" index={index} snapshot={group} />)}
        {snapshot.above.map((group, index) => <SvgGroup key={`above-${index}`} name="above" index={index} snapshot={group} />)}
      </div>
    </ViewportPortal>
  );
}
