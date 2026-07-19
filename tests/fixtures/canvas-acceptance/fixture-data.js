/**
 * [INPUT]: 元素数量 300/800、352 节点 FlowCanvas 规模与确定性序号
 * [OUTPUT]: 确定性双平面自研墨迹元素，以及 1 街区 + 1 工作区 + 350 会话的性能验收数据
 * [POS]: 4518 无持久化验收数据真相；不读真实 canvas/layout
 * [PROTOCOL]: 变更时更新此头部，然后检查 README/web/CLAUDE.md
 */


const COLORS = ['#dbeafe', '#dcfce7', '#fef3c7', '#fce7f3'];

export const FLOW_PERFORMANCE_NODE_COUNT = 352;
export const FLOW_PERFORMANCE_WORKSPACE = '/Users/fixture/Perf352';

export function createFlowPerformanceFixture() {
  const sessionCount = FLOW_PERFORMANCE_NODE_COUNT - 2;
  const keys = Array.from({ length: sessionCount }, (_, index) => `codex:perf-352-${index}`);
  const sessionsByKey = Object.fromEntries(keys.map((key, index) => [key, {
    key,
    tool: index % 2 ? 'claude' : 'codex',
    status: index % 11 === 0 ? 'active' : 'done',
    title: `匿名性能会话 ${String(index + 1).padStart(3, '0')}`,
    cwd: FLOW_PERFORMANCE_WORKSPACE,
    updatedAt: '2026-07-19T00:00:00.000Z',
    kind: 'session',
    subagents: 0,
    runs: 1,
    summary: '',
    hasHandoff: false,
    gitBranch: index % 9 === 0 ? 'feat/anonymous-fixture' : 'main',
  }]));
  const workspaces = [{
    path: FLOW_PERFORMANCE_WORKSPACE,
    name: '352 节点性能场景',
    parent: null,
    tools: { codex: Math.ceil(sessionCount / 2), claude: Math.floor(sessionCount / 2) },
    lastActivity: '2026-07-19T00:00:00.000Z',
    sessionKeys: keys,
    visibleKeys: keys,
  }];
  return { keys, sessionsByKey, workspaces };
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
