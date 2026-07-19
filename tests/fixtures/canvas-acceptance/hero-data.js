/**
 * [INPUT]: 专用匿名会话、画板、便签与自研墨迹数据；production FlowCanvas/SceneStore/TopBar
 * [OUTPUT]: 4518 hero 截图页；展示单相机画布与真实同步点，不请求 API、不显示验收 HUD
 * [POS]: README 宣传图的唯一匿名来源；绝不读取 4517、真实 data 或用户路径
 * [PROTOCOL]: 变更时更新此头部，然后检查 main.jsx/capture-hero.py/README.md
 */
import React, { useCallback, useMemo, useRef, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import '@xyflow/react/dist/style.css';
import '../../../web/src/theme.css';
import FlowCanvas from '../../../web/src/canvas/FlowCanvas.jsx';
import { createSceneStore } from '../../../web/src/scene-store.js';
import TopBar from '../../../web/src/panels/TopBar.jsx';
import { UIHost } from '../../../web/src/ui.jsx';

const h = React.createElement;
const BOARD_ID = 'hero-launch-map';
const BOARD_GROUP = `board:${BOARD_ID}`;
const LAB_GROUP = 'Creative Lab';
const FIXED_TIME = '2026-07-19T03:30:00.000Z';

const session = (key, cwd, tool, title, extra = {}) => ({
  key, cwd, tool, title, status: 'done', updatedAt: FIXED_TIME,
  kind: 'session', subagents: 0, runs: 1, summary: '', hasHandoff: false,
  gitBranch: 'main', ...extra,
});

const SESSIONS = [
  session('codex:hero-brief', '/demo/launch-studio', 'codex', '把发布目标拆成可验收节点', {
    status: 'active', gitBranch: 'feat/launch-map', summary: 'ready',
  }),
  session('claude:hero-copy', '/demo/launch-studio', 'claude', '统一首页叙事与产品语气', {
    hasHandoff: true,
  }),
  session('codex:hero-proof', '/demo/launch-studio', 'codex', '补齐上线前浏览器证据'),
  session('claude:hero-research', '/demo/story-lab', 'claude', '提炼访谈里的高频阻力', {
    summary: 'ready',
  }),
  session('codex:hero-board', '/demo/story-lab', 'codex', '把洞察整理成内容地图'),
  session('claude:hero-script', '/demo/story-lab', 'claude', '完成演示脚本和接力说明', {
    hasHandoff: true,
  }),
  session('codex:hero-automation', '/demo/automation-lab', 'codex', '巡检每日内容生产链', {
    kind: 'automation', runs: 12, status: 'active',
  }),
  session('claude:hero-review', '/demo/automation-lab', 'claude', '复核异常并生成处置清单'),
];
const SESSIONS_BY_KEY = Object.fromEntries(SESSIONS.map(item => [item.key, item]));

const WORKSPACES = [
  {
    path: '/demo/launch-studio', name: '发布指挥室', parent: null,
    tools: { codex: 2, claude: 1 }, lastActivity: FIXED_TIME,
    sessionKeys: SESSIONS.slice(0, 3).map(item => item.key),
    visibleKeys: SESSIONS.slice(0, 3).map(item => item.key),
  },
  {
    path: '/demo/story-lab', name: '内容实验室', parent: null,
    tools: { claude: 2, codex: 1 }, lastActivity: FIXED_TIME,
    sessionKeys: SESSIONS.slice(3, 6).map(item => item.key),
    visibleKeys: SESSIONS.slice(3, 6).map(item => item.key),
  },
  {
    path: '/demo/automation-lab', name: '自动化巡检', parent: null,
    tools: { codex: 1, claude: 1 }, lastActivity: FIXED_TIME,
    sessionKeys: SESSIONS.slice(6).map(item => item.key),
    visibleKeys: SESSIONS.slice(6).map(item => item.key),
  },
];

const inkElement = (id, type, x, y, width, height, extra = {}) => ({
  id, type, x, y, width, height, angle: 0,
  strokeColor: '#155eef', backgroundColor: 'transparent', fillStyle: 'solid',
  strokeWidth: 3, strokeStyle: 'solid', roughness: 0, opacity: 92,
  roundness: { type: 3 }, seed: 4518, version: 1, versionNonce: 4518,
  index: null, isDeleted: false, groupIds: [], frameId: null, boundElements: null,
  updated: 1, link: null, locked: false, ...extra,
});

const INITIAL_DOC = {
  layout: {
    '/demo/launch-studio': { d: BOARD_GROUP, x: 26, y: 72 },
    '/demo/story-lab': { d: BOARD_GROUP, x: 402, y: 72 },
    '/demo/automation-lab': { d: LAB_GROUP, x: 26, y: 70 },
    [`district:${LAB_GROUP}`]: { x: 1040, y: 170, w: 430, h: 430 },
  },
  edges: [{ id: 'hero-manual-link', from: 'codex:hero-board', to: 'codex:hero-automation' }],
  notes: [
    { id: 'hero-note-principle', x: 1050, y: 635, w: 250, h: 150, color: 'yellow', text: '本周原则\n\n证据先于结论\n输入永远不等保存' },
    { id: 'hero-note-next', x: 1335, y: 625, w: 215, h: 145, color: 'green', text: '下一棒\n\n匿名演示 ✓\n性能取证 ✓' },
  ],
  boards: [{ id: BOARD_ID, x: 40, y: 120, w: 900, h: 600, name: 'LAUNCH MAP · 发布路线', color: 'blue' }],
  drawing: [
    inkElement('hero-highlight', 'rectangle', 1010, 130, 500, 520, {
      strokeColor: '#0e9384', backgroundColor: '#d3f8df', opacity: 24,
      strokeWidth: 2, customData: { below: true },
    }),
    inkElement('hero-title', 'text', 90, 74, 370, 42, {
      text: '从会话地形，到下一步行动', originalText: '从会话地形，到下一步行动',
      fontSize: 30, fontFamily: 5, strokeColor: '#101828', roundness: null,
    }),
    inkElement('hero-arrow', 'arrow', 900, 430, 190, 70, {
      points: [[0, 0], [190, -70]], strokeColor: '#155eef', backgroundColor: 'transparent',
      roundness: null,
    }),
    inkElement('hero-orbit', 'ellipse', 1280, 270, 210, 120, {
      strokeColor: '#e2611f', backgroundColor: 'transparent', opacity: 72,
    }),
    inkElement('hero-mark', 'freedraw', 1100, 808, 260, 30, {
      points: [[0, 8], [42, 2], [84, 11], [132, 4], [182, 12], [230, 3]],
      strokeColor: '#0e9384', backgroundColor: 'transparent', strokeWidth: 4,
      roundness: null,
    }),
  ],
  drawingFiles: {},
};

function HeroCanvas() {
  const storeRef = useRef(null);
  if (!storeRef.current) {
    storeRef.current = createSceneStore(INITIAL_DOC, {
      persistScene: async () => ({ rev: 1 }),
      persistFiles: async () => ({ added: 0 }),
    });
  }
  const store = storeRef.current;
  const doc = useSyncExternalStore(
    useCallback(cb => store.subscribe(cb), [store]),
    useCallback(() => store.get(), [store]),
  );
  const focusRef = useRef(() => {});
  const actionsRef = useRef({});
  const expanded = useMemo(() => new Set(), []);

  const onCanvasAction = useCallback((kind, payload) => {
    if (kind === 'setNote') {
      store.mutate(current => ({
        ...current,
        notes: current.notes.map(note => note.id === payload.id ? { ...note, ...payload } : note),
      }));
    }
    return true;
  }, [store]);

  return h('div', { 'data-hero-canvas': 'true', style: { position: 'fixed', inset: 0 } },
    h(FlowCanvas, {
      workspaces: WORKSPACES,
      sessionsByKey: SESSIONS_BY_KEY,
      edges: [{ type: 'handoff', from: 'claude:hero-copy', to: 'codex:hero-proof' }],
      layout: doc.layout,
      canvas: doc,
      store,
      onMoveNode: () => {},
      onCanvasAction,
      onRenameSession: () => {},
      onRenameWs: () => {},
      selectedKey: null,
      onSelect: () => {},
      onChanged: () => {},
      onArrange: () => {},
      focusRef,
      actionsRef,
      expanded,
      searching: false,
      onToggleExpand: () => {},
    }),
    h(UIHost),
    h('div', { className: 'island', style: {
      position: 'fixed', left: 18, top: 16, zIndex: 20, padding: '11px 15px 10px',
      display: 'flex', alignItems: 'center', gap: 12, pointerEvents: 'none',
    } },
      h('span', { style: {
        width: 28, height: 28, borderRadius: 9, display: 'grid', placeItems: 'center',
        color: '#fff', background: '#155eef', fontWeight: 800, boxShadow: '0 6px 16px rgba(21,94,239,.22)',
      } }, 'A'),
      h('span', null,
        h('strong', { style: { display: 'block', fontSize: 14, lineHeight: 1.15 } }, 'AGENT 会话指挥塔'),
        h('small', { style: { display: 'block', marginTop: 3, color: '#667085', fontSize: 10.5 } }, '本地会话地图 · 匿名演示'),
      ),
    ),
    h('div', { style: { position: 'fixed', right: 18, top: 16, zIndex: 20 } },
      h(TopBar, {
        syncStatus: 'saved', pending: false,
        onArrange: () => {}, onRescan: () => {}, onRefresh: () => {},
      }),
    ),
  );
}

export function mountHeroFixture(target) {
  localStorage.setItem('vp', JSON.stringify({ x: 38, y: 80, zoom: 0.72 }));
  createRoot(target).render(h(HeroCanvas));
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const root = document.querySelector('[data-hero-canvas]');
    const summary = {
      sessions: root?.querySelectorAll('.session-card').length || 0,
      boards: root?.querySelectorAll('.react-flow__node-board').length || 0,
      notes: root?.querySelectorAll('.react-flow__node-note').length || 0,
      ink: root?.querySelectorAll('.ink-world [data-ink-element-id]').length || 0,
      sync: root?.querySelectorAll('.sync-dot').length || 0,
    };
    const pass = summary.sessions === SESSIONS.length
      && summary.boards === 1 && summary.notes === 2 && summary.ink === INITIAL_DOC.drawing.length
      && summary.sync === 1;
    window.__HERO_ACCEPTANCE__ = { ...summary, pass };
    document.documentElement.dataset.heroStatus = pass ? 'ready' : 'fail';
  }));
}
