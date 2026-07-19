/**
 * [INPUT]: 工作区列表、layout 手工位置记忆、工作区实时高度
 * [OUTPUT]: 提供画布布局常量、production buildGraph、活跃度行网格/街区平衡车道、容器缩放子项快照、固定锚点避让与可撤销整理归属
 * [POS]: FlowCanvas 的纯布局内核；不读写磁盘，不触碰真实会话，可由 node:test 直接证伪
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

export const COL_W = 336;
export const GAP_IN = 40;
export const PAD = { t: 62, l: 26, r: 26, b: 26 };
export const BREATH = { w: 200, h: 120 };
export const GUTTER = 170;
export const MAX_FLOW_LANES = 4;
export const TARGET_FLOW_ASPECT = 1.6;
export const HEADER_H = 66;
export const CARD_H = 62;
export const CARD_GAP = 8;
export const MAX_SHOW = 8;

/** 自动整理只重置几何记忆，人工划入街区/画板的 layout.d 必须留下。 */
export function tidyLayoutEntries(layout) {
  return Object.entries(layout || {}).flatMap(([path, pos]) =>
    typeof pos?.d === 'string' && pos.d ? [{ path, d: pos.d }] : [],
  );
}

/** 显式整理落盘几何：工作区归属沿用 targetLayout，街区与画板写入本轮确定性终点。 */
export function arrangedSceneGeometry(nodes, targetLayout) {
  const layout = { ...targetLayout };
  const boards = new Map();
  for (const node of nodes) {
    if (node.type !== 'district' && node.type !== 'board') continue;
    const geometry = {
      x: Math.round(node.position.x), y: Math.round(node.position.y),
      w: Math.round(node.width ?? node.data._w), h: Math.round(node.height ?? node.data._h),
    };
    if (node.type === 'district') layout[node.id] = geometry;
    else boards.set(String(node.data.board.id), geometry);
  }
  return { layout, boards };
}

/**
 * React Flow 从左/上缩放父容器时会实时补偿直属子节点，使其绝对位置不变。
 * 松手后必须把这份新相对坐标写进 layout；否则图数据重建会把子节点拉回旧相对坐标，
 * 肉眼就成了“放大画框，里面全部跟着跳”。
 */
export function resizedContainerChildren(nodes, parentId) {
  const district = parentId.startsWith('district:') ? parentId.slice(9) : parentId;
  return (nodes || [])
    .filter(node => node.type === 'workspace' && node.parentId === parentId)
    .map(node => ({
      path: node.id,
      x: Math.round(node.position.x),
      y: Math.round(node.position.y),
      d: district,
    }));
}

const horizontalConflict = (x, other) =>
  x < other.x + COL_W + GAP_IN && x + COL_W + GAP_IN > other.x;

function firstFreeY(x, startY, h, placed) {
  let y = startY;
  while (true) {
    const blockers = placed.filter(other =>
      horizontalConflict(x, other) &&
      y < other.y + other.h + GAP_IN && y + h + GAP_IN > other.y,
    );
    if (!blockers.length) return y;
    y = Math.max(...blockers.map(other => other.y + other.h + GAP_IN));
  }
}

/**
 * 用户拖过的位置是优先锚点，但不是允许相互覆盖的许可：
 * - 已保存成员按画布空间顺序放置，内容变高时只把后方成员顺延；
 * - 新补入成员在所有锚点留下的空位中选最靠上的一格；
 * - 不写回 layout，浏览/筛选不会暗改用户资产。
 */
export function packWorkspaces(members, layout, key, heightOf) {
  const cols = Math.min(Math.max(Math.ceil(Math.sqrt(members.length * 0.75)), 1), 4);
  const saved = [];
  const incoming = [];

  members.forEach((ws, order) => {
    const h = heightOf(ws);
    const pos = layout?.[ws.path];
    if (pos?.d === key && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
      saved.push({ ws, h, x: Math.max(PAD.l, pos.x), y: Math.max(PAD.t, pos.y), order });
    }
    else incoming.push({ ws, h, order });
  });

  // 没有手工几何就是自动地形（含显式“整理”后的 membership-only layout）：
  // 活跃者从左上开始，同行共享基线。宁可留一点行内呼吸，也不要瀑布流把阅读顺序打碎。
  if (!saved.length) {
    incoming.sort((a, b) =>
      String(b.ws.lastActivity || '').localeCompare(String(a.ws.lastActivity || '')) ||
      String(a.ws.path).localeCompare(String(b.ws.path)) || a.order - b.order);
    const aligned = [];
    let y = PAD.t;
    for (let start = 0; start < incoming.length; start += cols) {
      const row = incoming.slice(start, start + cols);
      row.forEach((item, column) => aligned.push({
        ...item,
        x: PAD.l + column * (COL_W + GAP_IN),
        y,
      }));
      y += Math.max(...row.map(item => item.h), 0) + GAP_IN;
    }
    return aligned;
  }

  saved.sort((a, b) => a.y - b.y || a.x - b.x || a.order - b.order);
  const placed = [];
  for (const item of saved) {
    placed.push({ ...item, y: firstFreeY(item.x, item.y, item.h, placed) });
  }

  for (const item of incoming) {
    const candidates = Array.from({ length: cols }, (_, c) => {
      const x = PAD.l + c * (COL_W + GAP_IN);
      return { x, y: firstFreeY(x, PAD.t, item.h, placed) };
    });
    candidates.sort((a, b) => a.y - b.y || a.x - b.x);
    placed.push({ ...item, ...candidates[0] });
  }

  return placed;
}

/**
 * 自动街区按最多四条等宽纵向车道放置：先让最新的街区占据首屏，再把后续街区放进当前最短车道。
 * 巨型街区只拉长自己的车道，不再像 shelf row 一样把整行小街区下方撑成大片空洞。
 */
export function arrangeFlowBlocks(blocks) {
  if (!blocks.length) return blocks;
  const laneWidth = Math.max(...blocks.map(block => block.w), 0);
  const totalHeight = blocks.reduce((sum, block) => sum + block.h, 0)
    + Math.max(0, blocks.length - 1) * GUTTER;
  let laneCount = 1;
  let bestScore = Infinity;
  for (let candidate = 1; candidate <= Math.min(MAX_FLOW_LANES, blocks.length); candidate++) {
    const width = candidate * laneWidth + (candidate - 1) * GUTTER;
    const estimatedHeight = totalHeight / candidate;
    const score = Math.abs(Math.log((width / estimatedHeight) / TARGET_FLOW_ASPECT));
    if (score < bestScore) { laneCount = candidate; bestScore = score; }
  }
  const heights = Array(laneCount).fill(0);

  blocks.forEach((block, index) => {
    let lane = index < laneCount ? index : 0;
    if (index >= laneCount) {
      for (let candidate = 1; candidate < laneCount; candidate++) {
        if (heights[candidate] < heights[lane]) lane = candidate;
      }
    }
    block.x = lane * (laneWidth + GUTTER);
    block.y = heights[lane];
    heights[lane] += block.h + GUTTER;
  });
  return blocks;
}

/** 街区/画板变大后可能侵入邻居；保留空间顺序，只把后方容器向下顺延。 */
export function resolveContainerOverlaps(blocks) {
  const fixed = blocks
    .filter(block => block.fixed)
    .map((block, order) => ({ block, order }))
    .sort((a, b) => a.block.y - b.block.y || a.block.x - b.block.x || a.order - b.order);
  const ordered = blocks
    .filter(block => !block.fixed)
    .map((block, order) => ({ block, order }))
    .sort((a, b) => a.block.y - b.block.y || a.block.x - b.block.x || a.order - b.order);
  const placed = fixed.map(item => item.block);

  for (const item of ordered) {
    const block = item.block;
    let y = block.y;
    while (true) {
      const blockers = placed.filter(other =>
        block.x < other.x + other.w && block.x + block.w > other.x &&
        y < other.y + other.h && y + block.h > other.y,
      );
      if (!blockers.length) break;
      y = Math.max(...blockers.map(other => other.y + other.h + GUTTER));
    }
    block.y = y;
    placed.push(block);
  }
  return blocks;
}

function districtOf(path) {
  const parts = path.split('/').filter(Boolean);
  if (parts[0] === 'Users') {
    const segs = parts.slice(2, 4);
    return segs.length ? segs.join(' / ') : '~';
  }
  return '/' + parts[0];
}

function districtDir(memberPath) {
  const parts = memberPath.split('/').filter(Boolean);
  if (parts[0] === 'Users') return '/' + parts.slice(0, Math.min(4, parts.length)).join('/');
  return '/' + parts[0];
}

/**
 * FlowCanvas 的唯一生产图构建器。自动整理规划必须同步调用同一函数，
 * 不能等待 React/DOM 后再反推容器量差。
 */
export function buildGraph(workspaces, sessionsByKey, layout, boards, relEdges, expanded, searching, options = {}) {
  const boardById = new Map((boards || []).map(b => [`board:${b.id}`, b]));
  const showAllOf = ws => searching || expanded.has(ws.path);
  const heightOf = ws => {
    const len = ws.visibleKeys.length;
    const shown = showAllOf(ws) ? len : Math.min(len, MAX_SHOW);
    return HEADER_H + shown * (CARD_H + CARD_GAP) + ((!searching && len > MAX_SHOW) ? 26 : 8);
  };

  const groups = new Map();
  const wsGroup = new Map();
  for (const ws of workspaces) {
    let key = layout?.[ws.path]?.d;
    if (!key || (key.startsWith('board:') && !boardById.has(key))) key = districtOf(ws.path);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(ws);
    wsGroup.set(ws.path, key);
  }
  for (const bid of boardById.keys()) if (!groups.has(bid)) groups.set(bid, []);

  const blocks = [];
  for (const [key, members] of groups) {
    const isBoard = key.startsWith('board:');
    const placed = packWorkspaces(members, layout, key, heightOf);
    const maxX = Math.max(...placed.map(p => p.x + COL_W), PAD.l + COL_W);
    const maxY = Math.max(...placed.map(p => p.y + p.h), PAD.t + 40);
    const board = boardById.get(key);
    const savedD = isBoard ? board : layout?.[`district:${key}`];
    const fixed = (isBoard && !options.reflowBoards)
      || (!isBoard && Number.isFinite(savedD?.x) && Number.isFinite(savedD?.y));
    const savedW = isBoard && options.reflowBoards ? 0 : savedD?.w;
    const savedH = isBoard && options.reflowBoards ? 0 : savedD?.h;
    const minW = maxX + PAD.r, minH = maxY + PAD.b;
    blocks.push({
      key, isBoard, board, placed, minW, minH, fixed,
      w: Math.max(minW + (isBoard || savedW ? 0 : BREATH.w), savedW || 0, isBoard ? 520 : 0),
      h: Math.max(minH + (isBoard || savedH ? 0 : BREATH.h), savedH || 0, isBoard ? 360 : 0),
      count: members.length,
      activity: members[0]?.lastActivity || '0',
    });
  }

  const groupOf = end => {
    const p = end.includes(':') ? (sessionsByKey[end]?.cwd || '') : end;
    return wsGroup.get(p) || null;
  };
  const parent = new Map(blocks.map(b => [b.key, b.key]));
  const find = x => parent.get(x) === x ? x : find(parent.get(x));
  for (const e of relEdges || []) {
    const a = groupOf(e.from), b = groupOf(e.to);
    if (a && b && a !== b && parent.has(a) && parent.has(b)) parent.set(find(a), find(b));
  }

  const clusterAct = new Map();
  const flowBlocks = blocks.filter(b => !b.fixed);
  for (const b of flowBlocks) {
    const r = find(b.key);
    if (!clusterAct.has(r) || b.activity > clusterAct.get(r)) clusterAct.set(r, b.activity);
  }
  flowBlocks.sort((a, b) => {
    const ra = find(a.key), rb = find(b.key);
    if (ra !== rb) return clusterAct.get(rb).localeCompare(clusterAct.get(ra));
    return b.activity.localeCompare(a.activity);
  });
  arrangeFlowBlocks(flowBlocks);
  for (const b of blocks) {
    if (b.isBoard && b.fixed) { b.x = b.board.x; b.y = b.board.y; }
    else if (b.fixed) {
      b.x = layout[`district:${b.key}`].x;
      b.y = layout[`district:${b.key}`].y;
    }
  }
  resolveContainerOverlaps(blocks);

  const nodes = [];
  const positions = {};
  for (const b of blocks) {
    const containerId = b.isBoard ? b.key : `district:${b.key}`;
    nodes.push(b.isBoard
      ? {
          id: containerId, type: 'board', position: { x: b.x, y: b.y },
          width: b.w, height: b.h,
          data: { board: b.board, count: b.count, _w: b.w, _h: b.h },
          draggable: true, dragHandle: '.container-drag-handle', selectable: true, deletable: true,
        }
      : {
          id: containerId, type: 'district', position: { x: b.x, y: b.y },
          width: b.w, height: b.h,
          data: {
            name: b.key, count: b.count, _w: b.w, _h: b.h, _minW: b.minW, _minH: b.minH,
            _dir: b.placed[0] ? districtDir(b.placed[0].ws.path) : null,
          },
          draggable: true, dragHandle: '.container-drag-handle', selectable: true, deletable: false,
        });

    for (const { ws, x, y } of b.placed) {
      const h = heightOf(ws);
      const showAll = showAllOf(ws);
      const shown = showAll ? ws.visibleKeys.length : Math.min(ws.visibleKeys.length, MAX_SHOW);
      positions[ws.path] = { x: b.x + x, y: b.y + y, w: COL_W, h };
      nodes.push({
        id: ws.path, type: 'workspace', parentId: containerId,
        position: { x, y },
        data: {
          workspace: ws, width: COL_W, height: h,
          hidden: ws.visibleKeys.length - shown,
          expanded: expanded.has(ws.path), searching,
        },
        draggable: true, selectable: true, deletable: false,
      });
      ws.visibleKeys.slice(0, shown).forEach((key, i) => {
        nodes.push({
          id: key, type: 'session', parentId: ws.path, extent: 'parent',
          position: { x: 10, y: HEADER_H + i * (CARD_H + CARD_GAP) },
          data: { session: sessionsByKey[key], width: COL_W - 20, height: CARD_H },
          draggable: false, deletable: false,
        });
      });
    }
  }
  return { nodes, positions };
}
