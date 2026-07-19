/**
 * [INPUT]: 元素数量 300/800、352 节点 FlowCanvas 规模与确定性序号
 * [OUTPUT]: 确定性双平面自研墨迹元素，以及含真实密度状态点/关系线/画板/墨迹的 352 节点性能验收数据
 * [POS]: 4518 无持久化验收数据真相；不读真实 canvas/layout
 * [PROTOCOL]: 变更时更新此头部，然后检查 README/web/CLAUDE.md
 */


const COLORS = ['#dbeafe', '#dcfce7', '#fef3c7', '#fce7f3'];

export const FLOW_PERFORMANCE_NODE_COUNT = 352;
export const FLOW_PERFORMANCE_WORKSPACE_COUNT = 12;
export const FLOW_PERFORMANCE_BOARD_COUNT = 3;
export const FLOW_PERFORMANCE_ACTIVE_SESSION_COUNT = 171;
export const FLOW_PERFORMANCE_DISTRICT = '/fixture';
export const FLOW_PERFORMANCE_WORKSPACE = '/fixture/perf-352/workspace-01';
export const FLOW_PERFORMANCE_NOTE_ID = 'note:perf-352';

export function createFlowPerformanceFixture() {
  const sessionCount = FLOW_PERFORMANCE_NODE_COUNT
    - 1 - FLOW_PERFORMANCE_WORKSPACE_COUNT - FLOW_PERFORMANCE_BOARD_COUNT - 1;
  const keys = Array.from({ length: sessionCount }, (_, index) => `codex:perf-352-${index}`);
  const workspacePaths = Array.from(
    { length: FLOW_PERFORMANCE_WORKSPACE_COUNT },
    (_, index) => `/fixture/perf-352/workspace-${String(index + 1).padStart(2, '0')}`,
  );
  const sessionsByKey = Object.fromEntries(keys.map((key, index) => [key, {
    key,
    tool: index % 2 ? 'claude' : 'codex',
    status: index < FLOW_PERFORMANCE_ACTIVE_SESSION_COUNT ? 'active' : 'done',
    title: `匿名性能会话 ${String(index + 1).padStart(3, '0')}`,
    cwd: workspacePaths[index % workspacePaths.length],
    updatedAt: '2026-07-19T00:00:00.000Z',
    kind: 'session',
    subagents: 0,
    runs: 1,
    summary: '',
    hasHandoff: false,
    gitBranch: index % 9 === 0 ? 'feat/anonymous-fixture' : 'main',
  }]));
  const workspaces = workspacePaths.map((workspacePath, index) => {
    const workspaceKeys = keys.filter(key => sessionsByKey[key].cwd === workspacePath);
    return {
      path: workspacePath,
      name: `匿名工作区 ${String(index + 1).padStart(2, '0')}`,
      parent: null,
      tools: {
        codex: workspaceKeys.filter(key => sessionsByKey[key].tool === 'codex').length,
        claude: workspaceKeys.filter(key => sessionsByKey[key].tool === 'claude').length,
      },
      lastActivity: `2026-07-19T${String(23 - index).padStart(2, '0')}:00:00.000Z`,
      sessionKeys: workspaceKeys,
      visibleKeys: workspaceKeys,
    };
  });
  const edges = Array.from({ length: 12 }, (_, index) => ({
    type: ['worktree', 'family', 'handoff'][index % 3],
    from: keys[index],
    to: keys[index + 24],
  }));
  const manualEdges = Array.from({ length: 10 }, (_, index) => ({
    id: `manual:perf-352-${index}`,
    from: keys[index + 48],
    to: keys[index + 72],
  }));
  const boards = Array.from({ length: FLOW_PERFORMANCE_BOARD_COUNT }, (_, index) => ({
    id: `perf-board-${index + 1}`,
    title: `匿名画板 ${index + 1}`,
    x: 1720,
    y: index * 460,
    w: 520,
    h: 360,
    color: ['blue', 'green', 'yellow'][index],
  }));
  const drawing = [
    {
      id: 'perf-ink-below', type: 'rectangle', x: 1740, y: 30, width: 450, height: 290,
      angle: 0, strokeColor: '#155eef', backgroundColor: '#e9f0fd', strokeWidth: 2,
      opacity: 72, isDeleted: false, customData: { below: true },
    },
    {
      id: 'perf-ink-arrow', type: 'arrow', x: 1820, y: 560, width: 260, height: 110,
      angle: 0, points: [[0, 0], [260, 110]], strokeColor: '#12b76a',
      backgroundColor: 'transparent', strokeWidth: 3, opacity: 100, isDeleted: false,
    },
    {
      id: 'perf-ink-text', type: 'text', x: 1790, y: 1010, width: 240, height: 32,
      angle: 0, text: '真实拓扑性能闸门', fontSize: 24, strokeColor: '#101828',
      backgroundColor: 'transparent', strokeWidth: 1, opacity: 100, isDeleted: false,
    },
  ];
  return { keys, sessionsByKey, workspaces, workspacePaths, edges, manualEdges, boards, drawing };
}

const baseElement = (id, index, below) => ({
  id,
  x: (index % 32) * 120,
  y: Math.floor(index / 32) * 80,
  width: 96,
  height: 56,
  angle: 0,
  strokeColor: '#334155',
  backgroundColor: COLORS[index % COLORS.length],
  fillStyle: 'solid',
  strokeWidth: 1,
  strokeStyle: 'solid',
  roughness: 0,
  opacity: 82,
  roundness: null,
  seed: index + 1,
  version: 1,
  versionNonce: 100000 + index,
  index: null,
  isDeleted: false,
  groupIds: [],
  frameId: null,
  boundElements: null,
  updated: 1,
  link: null,
  locked: false,
  customData: below ? { below: true } : undefined,
});

export function createCanvasAcceptanceElements(size) {
  if (size !== 300 && size !== 800) throw new Error(`unsupported fixture size: ${size}`);
  return Array.from({ length: size }, (_, index) => {
    const below = index % 2 === 0;
    const base = baseElement(`fixture-${size}-${index}`, index, below);
    if (index % 5 === 4) {
      const text = index === 4 ? 'Early unique Q' : `Automation zone ${index}`;
      return {
        ...base,
        type: 'text',
        width: 104,
        height: 24,
        backgroundColor: 'transparent',
        fontSize: 18,
        fontFamily: index === 4 ? 1 : 5,
        text,
        originalText: text,
        textAlign: 'left',
        verticalAlign: 'top',
        containerId: null,
        autoResize: true,
        lineHeight: 1.25,
      };
    }
    return { ...base, type: ['rectangle', 'ellipse', 'diamond'][index % 3] };
  });
}

export function mutateBelowPlane(elements, tick) {
  const index = elements.findIndex(element => element.customData?.below && element.type !== 'text');
  return elements.map((element, current) => current === index ? {
    ...element,
    x: element.x + (tick % 2 ? 1 : -1),
    version: element.version + 1,
    versionNonce: element.versionNonce + 7919 + tick,
  } : element);
}

export function mutateEarlyUniqueText(elements) {
  return elements.map(element => element.id.endsWith('-4') ? {
    ...element,
    text: 'Early unique Z',
    originalText: 'Early unique Z',
    version: element.version + 1,
    versionNonce: element.versionNonce + 104729,
  } : element);
}

export const ACCEPTANCE_SAMPLES = 20;

export const ACCEPTANCE_REDLINES = Object.freeze({
  300: Object.freeze({ coldMax: 500, warmP95: 50, warmMax: 100, longTaskMax: 50 }),
  800: Object.freeze({ coldMax: 500, warmP95: 100, warmMax: 125, longTaskMax: 100 }),
  driftP95: 0.25,
  driftMax: 0.5,
  rafP95: 20,
  rafMax: 50,
});
