/**
 * [INPUT]: 工作区列表、layout 手工位置记忆、工作区实时高度
 * [OUTPUT]: 提供画布布局常量、成员打包、街区碰撞修复与可撤销整理所需的归属提取
 * [POS]: FlowCanvas 的纯布局内核；不读写磁盘，不触碰真实会话，可由 node:test 直接证伪
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

export const COL_W = 336;
export const GAP_IN = 40;
export const PAD = { t: 62, l: 26, r: 26, b: 26 };
export const BREATH = { w: 200, h: 120 };
export const GUTTER = 170;
export const ROW_MAX_W = 5200;
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
    if (pos && pos.d === key) saved.push({ ws, h, x: Math.max(PAD.l, pos.x), y: Math.max(PAD.t, pos.y), order });
    else incoming.push({ ws, h, order });
  });

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

/** 街区/画板变大后可能侵入邻居；保留空间顺序，只把后方容器向下顺延。 */
export function resolveContainerOverlaps(blocks) {
  const ordered = blocks
    .map((block, order) => ({ block, order }))
    .sort((a, b) => a.block.y - b.block.y || a.block.x - b.block.x || a.order - b.order);
  const placed = [];

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
