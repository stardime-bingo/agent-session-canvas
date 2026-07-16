/**
 * [INPUT]: 4518 query(scenario) 与真实 FlowCanvas/InkWorldLayer/MiniMapInk、production batch executor
 * [OUTPUT]: 只含确定性内存场景响应和 exporter 故障注入的 direct/batch 容器承载验收宿主；诊断只读取 production probe/DOM
 * [POS]: 无 API、无持久化、无复制 reducer/controller/frame coordinator 的生产集成夹具
 */
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import '@xyflow/react/dist/style.css';
import '../../../web/src/theme.css';
import FlowCanvas from '../../../web/src/canvas/FlowCanvas.jsx';
import { createSceneMutationQueue, executeBatchArrange } from '../../../web/src/canvas/container-carry.js';
import { tidyLayoutEntries } from '../../../web/src/canvas/layout.js';
import { UIHost } from '../../../web/src/ui.jsx';
import { applyBatchCarry } from '../../../shared/canvas-carry.mjs';

const scenario = new URLSearchParams(location.search).get('scenario') || 'normal';
const many = scenario === 'authority-conflict-800';
const noAnchor = scenario === 'no-anchor';
const batchScenario = scenario.startsWith('batch-');
const BOARD_ID = 'b1';
const BOARD_FLOW_ID = `board:${BOARD_ID}`;
const WORKSPACE_PATH = '/Users/fixture/batch-project';
const DISTRICT_ID = 'batch-project';
const DISTRICT_FLOW_ID = `district:${DISTRICT_ID}`;
const SESSION_KEY = 'codex:4518-batch';
const EMPTY_SET = new Set();
const WORKSPACES = [{
  path: WORKSPACE_PATH,
  name: 'batch-project',
  parent: null,
  tools: { codex: 1 },
  lastActivity: '2026-07-17T00:00:00.000Z',
  visibleKeys: [SESSION_KEY],
}];
const SESSIONS = {
  [SESSION_KEY]: {
    key: SESSION_KEY,
    cwd: WORKSPACE_PATH,
    title: '4518 batch carry fixture',
    tool: 'codex',
    status: 'active',
    updatedAt: '2026-07-17T00:00:00.000Z',
    kind: 'session',
    runs: 1,
    subagents: 0,
  },
};
const initialLayout = () => ({
  [WORKSPACE_PATH]: { d: DISTRICT_ID, x: 26, y: 62 },
  [DISTRICT_FLOW_ID]: { x: 760, y: 100, w: 420, h: 300 },
});
const tidyLayout = layout => Object.fromEntries(
  tidyLayoutEntries(layout).map(({ path, ...entry }) => [path, entry]),
);

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
  if (batchScenario) return [rectangle('shape-0', 180, 190, 46, 34), rectangle('shape-outside', 840, 190)];
  return [rectangle('shape-0', 180, 190, 46, 34), rectangle('shape-outside', 650, 180)];
}

function createInitialScene() {
  return {
    token: 'scene-1',
    stale: false,
    layout: initialLayout(),
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
  const batchUndoRef = useRef(null);
  const batchSequenceRef = useRef(0);
  const sceneMutationQueueRef = useRef(null);
  if (!sceneMutationQueueRef.current) {
    sceneMutationQueueRef.current = createSceneMutationQueue();
    sceneMutationQueueRef.current.adoptAuthority('scene-1');
  }
  const sceneMutationQueue = sceneMutationQueueRef.current;
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
    batchAction: 'idle',
    batchPlans: [],
    batchOutcomes: [],
    responseLosses: 0,
    reactSnapshots: [],
  });
  const commitAppliedRef = useRef(false);

  useLayoutEffect(() => {
    sceneRef.current = scene;
    if (batchScenario) {
      diagnosticsRef.current.reactSnapshots.push({
        token: scene.token,
        districtLayout: scene.layout[DISTRICT_FLOW_ID] || null,
        drawing: scene.canvas.drawing.map(({ id, x, y, version }) => ({ id, x, y, version })),
      });
    }
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
      if ((scenario === 'export-retry' || scenario === 'batch-export-retry')
        && call.afterCommit && call.kind === 'group' && diagnostics.failures < 3) {
        diagnostics.failures++;
        return Promise.reject(new Error(`4518 target export failure ${diagnostics.failures}`));
      }
      if ((scenario === 'normal' || batchScenario)
        && call.afterCommit && call.kind === 'group') {
        return new Promise((resolve, reject) => {
          setTimeout(() => Promise.resolve(request.delegate(request.options)).then(resolve, reject), 400);
        });
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
      layout: current.layout,
      canvas: { ...current.canvas, drawing, boards },
    };
    diagnosticsRef.current.installs++;
    commitAppliedRef.current = true;
    sceneRef.current = next;
    setScene(next);
  }, []);

  const installBatchResult = useCallback(result => {
    const current = sceneRef.current;
    const next = {
      token: result.sceneToken,
      stale: false,
      layout: result.layout,
      canvas: { ...current.canvas, drawing: result.drawing },
    };
    diagnosticsRef.current.installs++;
    commitAppliedRef.current = true;
    sceneRef.current = next;
    setScene(next);
  }, []);

  const commitBatch = useCallback(command => {
    const diagnostics = diagnosticsRef.current;
    diagnostics.commits++;
    diagnostics.opIds.push(command.opId);
    diagnostics.baseTokens.push(command.baseToken);
    if (command.baseToken !== sceneRef.current.token) {
      const error = new Error('4518 batch authority conflict');
      error.status = 409;
      error.code = 'SCENE_CONFLICT';
      return Promise.reject(error);
    }
    const movedIds = command.moves.flatMap(move => move.anchorIds);
    const result = {
      status: 'committed',
      opId: command.opId,
      sceneToken: `scene-${diagnostics.writes + 2}`,
      layout: command.layout,
      moves: command.moves,
      movedIds,
      drawing: applyBatchCarry(sceneRef.current.canvas.drawing, command.moves),
    };
    diagnostics.writes++;
    authorityReceiptRef.current = result;
    if (scenario === 'batch-response-unknown' && diagnostics.responseLosses === 0) {
      diagnostics.responseLosses++;
      return Promise.reject(new Error('4518 batch response lost after durable commit'));
    }
    return Promise.resolve(result);
  }, []);

  const queryBatchStatus = useCallback(opId => {
    diagnosticsRef.current.statusQueries++;
    const receipt = authorityReceiptRef.current;
    return Promise.resolve(receipt?.opId === opId ? receipt : { status: 'unknown', opId });
  }, []);

  const executeFixtureBatch = useCallback(async (kind, nextLayout) => {
    const diagnostics = diagnosticsRef.current;
    diagnostics.batchAction = `${kind}:planning`;
    const plan = actionsRef.current.planArrangeBatch?.(nextLayout);
    if (!plan) throw new Error('4518 production batch planner is not ready');
    const opId = `batch-${++batchSequenceRef.current}`;
    diagnostics.batchPlans.push({
      kind,
      opId,
      moves: plan.moves.map(move => ({
        containerId: move.containerId,
        from: move.from,
        to: move.to,
        anchorIds: [...move.anchorIds],
      })),
    });
    diagnostics.batchAction = `${kind}:committing`;
    try {
      const outcome = await executeBatchArrange({
        queue: sceneMutationQueue,
        plan,
        baseToken: sceneMutationQueue.authorityRef.current || sceneRef.current.token,
        opId,
        commit: commitBatch,
        queryStatus: queryBatchStatus,
        present: result => actionsRef.current.presentBatchCarryResult?.(result),
        install: installBatchResult,
        flush: flushSync,
      });
      diagnostics.batchOutcomes.push({ kind, opId, status: outcome.presentation.status });
      diagnostics.batchAction = `${kind}:${outcome.presentation.status}`;
      return outcome;
    } catch (error) {
      diagnostics.batchOutcomes.push({ kind, opId, status: 'failed', code: error.code || null });
      diagnostics.batchAction = `${kind}:failed`;
      throw error;
    }
  }, [commitBatch, installBatchResult, queryBatchStatus, sceneMutationQueue]);

  const arrangeBatch = useCallback(async () => {
    const snapshot = structuredClone(sceneRef.current.layout);
    const outcome = await executeFixtureBatch('arrange', tidyLayout(snapshot));
    batchUndoRef.current = snapshot;
    return outcome;
  }, [executeFixtureBatch]);

  const undoBatch = useCallback(() => {
    if (!batchUndoRef.current) throw new Error('4518 batch undo is not armed');
    return executeFixtureBatch('undo', batchUndoRef.current);
  }, [executeFixtureBatch]);

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
          layout: structuredClone(current.layout),
          drawing: current.canvas.drawing.map(({ id, x, y, version }) => ({ id, x, y, version })),
          batchAction: diagnostics.batchAction,
          batchPlans: structuredClone(diagnostics.batchPlans),
          batchOutcomes: structuredClone(diagnostics.batchOutcomes),
          responseLosses: diagnostics.responseLosses,
          reactSnapshots: structuredClone(diagnostics.reactSnapshots),
          bridgeCount: document.querySelectorAll('.ink-carry-anchor').length,
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
      arrangeBatch,
      undoBatch,
    };
    window.__carryAcceptance = acceptance;
    return () => {
      if (window.__carryAcceptance === acceptance) delete window.__carryAcceptance;
    };
  }, [arrangeBatch, ready, undoBatch]);

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
        workspaces={WORKSPACES}
        sessionsByKey={SESSIONS}
        edges={[]}
        layout={scene.layout}
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
      {batchScenario && (
        <div style={{ position: 'absolute', right: 16, bottom: 16, zIndex: 20, display: 'flex', gap: 8 }}>
          <button type="button" className="batch-arrange" onClick={() => void arrangeBatch()}>
            真实批量整理
          </button>
          <button type="button" className="batch-undo" onClick={() => void undoBatch()}>
            真实批量撤销
          </button>
        </div>
      )}
      <UIHost />
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);
