/**
 * [INPUT]: 4518 query(scenario) 与真实 FlowCanvas/InkWorldLayer/MiniMapInk
 * [OUTPUT]: 只含确定性内存场景响应和 exporter 故障注入的容器承载验收宿主；诊断只读取 production probe/DOM
 * [POS]: 无 API、无持久化、无复制 reducer/controller/frame coordinator 的生产集成夹具
 */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '@xyflow/react/dist/style.css';
import '../../../web/src/theme.css';
import FlowCanvas from '../../../web/src/canvas/FlowCanvas.jsx';
import { UIHost } from '../../../web/src/ui.jsx';

const scenario = new URLSearchParams(location.search).get('scenario') || 'normal';
const many = scenario === 'authority-conflict-800';
const noAnchor = scenario === 'no-anchor';
const BOARD_ID = 'b1';
const BOARD_FLOW_ID = `board:${BOARD_ID}`;
const EMPTY_SET = new Set();

const rectangle = (id, x, y, width = 30, height = 30) => ({
  id, type: 'rectangle', x, y, width, height, angle: 0,
  strokeColor: '#6941c6', backgroundColor: '#d9d6fe', fillStyle: 'solid',
  strokeWidth: 2, strokeStyle: 'solid', roughness: 0, opacity: 100,
  roundness: { type: 3 }, seed: 4518, version: 1, versionNonce: 4518,
  index: null, isDeleted: false, groupIds: [], frameId: null, boundElements: null,
  updated: 1, link: null, locked: false,
});

function initialElements() {
  if (many) {
    return [
      ...Array.from({ length: 799 }, (_, index) => rectangle(
        `shape-${index}`,
        125 + (index % 40) * 8,
        165 + Math.floor(index / 40) * 5,
        4,
        3,
      )),
      rectangle('shape-outside', 650, 180),
    ];
  }
  if (noAnchor) return [rectangle('shape-0', 650, 180), rectangle('shape-outside', 710, 180)];
  return [rectangle('shape-0', 180, 190, 46, 34), rectangle('shape-outside', 650, 180)];
}

function createInitialScene() {
  return {
    token: 'scene-1',
    stale: false,
    canvas: {
      drawing: initialElements(),
      drawingFiles: {},
      notes: [],
      boards: [{ id: BOARD_ID, x: 100, y: 100, w: 420, h: 300, name: '4518 承载验收', color: 'blue' }],
    },
  };
}

function App() {
  const [scene, setScene] = useState(createInitialScene);
  const [ready, setReady] = useState(false);
  const sceneRef = useRef(scene);
  const frameTestProbeRef = useRef(null);
  const focusRef = useRef(() => {});
  const actionsRef = useRef({});
  const geometryPendingRef = useRef(false);
  const sceneMutationPendingRef = useRef(0);
  const authorityReceiptRef = useRef(null);
  const diagnosticsRef = useRef({
    commits: 0,
    writes: 0,
    installs: 0,
    statusQueries: 0,
    drawingCommits: 0,
    failures: 0,
    opIds: [],
    baseTokens: [],
    exportCalls: [],
  });
  const commitAppliedRef = useRef(false);

  useLayoutEffect(() => {
    sceneRef.current = scene;
  }, [scene]);

  const inkExporterProbe = useMemo(() => ({
    exportToSvg(request) {
      const diagnostics = diagnosticsRef.current;
      const call = {
        revision: request.revision,
        attempt: request.attempt,
        kind: request.kind,
        elementIds: request.elements.map(element => element.id),
        afterCommit: commitAppliedRef.current,
      };
      diagnostics.exportCalls.push(call);
      if (scenario === 'normal' && call.afterCommit && call.kind === 'group') {
        return new Promise((resolve, reject) => {
          setTimeout(() => Promise.resolve(request.delegate(request.options)).then(resolve, reject), 400);
        });
      }
      if (scenario === 'export-retry' && call.afterCommit && call.kind === 'group' && diagnostics.failures < 3) {
        diagnostics.failures++;
        return Promise.reject(new Error(`4518 target export failure ${diagnostics.failures}`));
      }
      return request.delegate(request.options);
    },
  }), []);

  const installCarryResult = useCallback(result => {
    const current = sceneRef.current;
    const drawing = result.movedIds.length ? result.drawing : current.canvas.drawing;
    const boards = current.canvas.boards.map(board => board.id === BOARD_ID
      ? { ...board, x: result.container.x, y: result.container.y } : board);
    const next = {
      token: result.sceneToken,
      stale: false,
      canvas: { ...current.canvas, drawing, boards },
    };
    diagnosticsRef.current.installs++;
    commitAppliedRef.current = true;
    sceneRef.current = next;
    setScene(next);
  }, []);

  const onCanvasAction = useCallback((kind, payload) => {
    if (kind === 'containerCarryStatus') {
      const diagnostics = diagnosticsRef.current;
      diagnostics.statusQueries++;
      const result = authorityReceiptRef.current;
      const opId = typeof payload === 'string' ? payload : payload.opId;
      if (scenario === 'response-unknown' && result?.opId === opId) {
        installCarryResult(result);
        return Promise.resolve(result);
      }
      return Promise.resolve({ status: 'unknown' });
    }
    if (kind === 'sceneConflict') {
      const current = sceneRef.current;
      const next = { ...current, stale: true };
      sceneRef.current = next;
      setScene(next);
      return;
    }
    if (kind === 'drawingCommit') {
      diagnosticsRef.current.drawingCommits++;
      const current = sceneRef.current;
      const next = {
        ...current,
        canvas: { ...current.canvas, drawing: payload.elements, drawingFiles: payload.files },
      };
      sceneRef.current = next;
      setScene(next);
      return Promise.resolve(payload);
    }
    if (kind !== 'containerCarry') return false;

    const diagnostics = diagnosticsRef.current;
    diagnostics.commits++;
    diagnostics.opIds.push(payload.opId);
    diagnostics.baseTokens.push(payload.baseToken);
    if (scenario === 'authority-conflict-800' || payload.baseToken !== sceneRef.current.token) {
      const error = new Error('4518 second-client authority conflict');
      error.status = 409;
      error.code = 'SCENE_CONFLICT';
      return Promise.reject(error);
    }

    const current = sceneRef.current;
    const dx = payload.to.x - payload.from.x;
    const dy = payload.to.y - payload.from.y;
    const anchors = new Set(payload.anchorIds);
    const drawing = anchors.size
      ? current.canvas.drawing.map(element => anchors.has(element.id)
        ? { ...element, x: element.x + dx, y: element.y + dy, version: element.version + 1 }
        : element)
      : current.canvas.drawing;
    const token = `scene-${diagnostics.writes + 2}`;
    const result = {
      status: 'committed',
      opId: payload.opId,
      sceneToken: token,
      container: { kind: 'board', id: BOARD_FLOW_ID, x: payload.to.x, y: payload.to.y },
      drawing,
      movedIds: [...anchors],
    };
    diagnostics.writes++;
    authorityReceiptRef.current = result;
    if (scenario === 'response-unknown') return Promise.reject(new Error('4518 response lost after durable commit'));
    installCarryResult(result);
    return Promise.resolve(result);
  }, [installCarryResult]);

  useEffect(() => {
    const acceptance = {
      productionIntegration: true,
      scenario,
      snapshot() {
        const production = frameTestProbeRef.current?.snapshot?.() || {};
        const diagnostics = diagnosticsRef.current;
        const current = sceneRef.current;
        return {
          ...production,
          productionIntegration: true,
          scenario,
          ready,
          commitCount: diagnostics.commits,
          authorityWrites: diagnostics.writes,
          authorityInstalls: diagnostics.installs,
          statusQueryCount: diagnostics.statusQueries,
          drawingCommitCount: diagnostics.drawingCommits,
          injectedExportFailures: diagnostics.failures,
          opIds: [...diagnostics.opIds],
          baseTokens: [...diagnostics.baseTokens],
          exportCalls: diagnostics.exportCalls.map(call => ({ ...call, elementIds: [...call.elementIds] })),
          sceneToken: current.token,
          sceneStale: current.stale,
        };
      },
      openDrawing: () => frameTestProbeRef.current?.openDrawing?.('selection', 'shape-0'),
      attemptDrawingCommit: async () => {
        try {
          await frameTestProbeRef.current?.commitDrawing?.(base => ({
            elements: base.elements.map(element => element.id === 'shape-0'
              ? { ...element, version: element.version + 1 } : element),
            files: base.files,
          }));
          return true;
        } catch {
          return false;
        }
      },
    };
    window.__carryAcceptance = acceptance;
    return () => {
      if (window.__carryAcceptance === acceptance) delete window.__carryAcceptance;
    };
  }, [ready]);

  useEffect(() => {
    let frame;
    const poll = () => {
      const production = frameTestProbeRef.current?.snapshot?.();
      const main = document.querySelector('.ink-world [data-ink-element-id="shape-0"]');
      const mini = document.querySelector('.mini-ink [data-ink-element-id="shape-0"]');
      if (production?.renderedElementIds?.includes('shape-0') && main && mini) {
        setReady(true);
        return;
      }
      frame = requestAnimationFrame(poll);
    };
    frame = requestAnimationFrame(poll);
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <main data-app-ready={ready} style={{ position: 'relative', width: '100vw', height: '100vh', overflow: 'hidden' }}>
      <FlowCanvas
        workspaces={[]}
        sessionsByKey={{}}
        edges={[]}
        layout={{}}
        canvas={scene.canvas}
        sceneToken={scene.token}
        sceneStale={scene.stale}
        sceneMutationPendingRef={sceneMutationPendingRef}
        onMoveNode={() => {}}
        onCanvasAction={onCanvasAction}
        onRenameSession={() => {}}
        onRenameWs={() => {}}
        selectedKey={null}
        onSelect={() => {}}
        onChanged={() => {}}
        onArrange={() => {}}
        focusRef={focusRef}
        actionsRef={actionsRef}
        geometryPendingRef={geometryPendingRef}
        expanded={EMPTY_SET}
        searching={false}
        onToggleExpand={() => {}}
        frameTestProbeRef={frameTestProbeRef}
        inkExporterProbe={inkExporterProbe}
      />
      <output style={{
        position: 'absolute', left: 16, bottom: 16, zIndex: 20,
        padding: '6px 10px', borderRadius: 8, background: 'white',
      }}>
        {ready ? 'PASS 页面已启动' : '真实生产帧启动中'} · {scenario}
      </output>
      <UIHost />
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);
