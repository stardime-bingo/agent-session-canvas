/**
 * [INPUT]: production buildGraph 节点、SceneStore 当前场景、容器承载纯函数
 * [OUTPUT]: 内容增长导致的避碰投影，以及可在下一次用户输入前 history:false 原子提交的场景结果
 * [POS]: 布局增长的纯投影桥；页面加载只算不写，FlowCanvas 在下一次用户动作前提交终点与对应墨迹
 * [PROTOCOL]: 变更时更新 web/CLAUDE.md/CLAUDE.md/AGENTS.md
 */
import { applyBatchCarry } from '../../../shared/canvas-carry.mjs';
import { committedDrawingElements } from './drawing.js';
import { planBatchCarry } from './container-carry.js';
import { persistedContainerNodes } from './layout.js';

export function reconcileContainerLayout(doc, nodes) {
  const source = persistedContainerNodes(nodes, doc.layout, doc.boards);
  const moves = planBatchCarry(source, nodes, committedDrawingElements(doc.drawing));
  if (!moves.length) return { doc, moves };
  const targets = new Map(nodes.map(node => [node.id, node]));
  const layout = { ...doc.layout };
  const boards = doc.boards.map(board => ({ ...board }));
  const boardById = new Map(boards.map(board => [String(board.id), board]));
  for (const move of moves) {
    const node = targets.get(move.containerId);
    if (!node) continue;
    const geometry = {
      x: Math.round(node.position.x), y: Math.round(node.position.y),
      w: Math.round(node.width ?? node.data._w), h: Math.round(node.height ?? node.data._h),
    };
    if (node.type === 'district') layout[node.id] = { ...(layout[node.id] || {}), ...geometry };
    if (node.type === 'board') Object.assign(boardById.get(String(node.data.board.id)) || {}, geometry);
  }
  return {
    moves,
    doc: { ...doc, layout, boards, drawing: applyBatchCarry(doc.drawing, moves) },
  };
}

export function stageContainerLayoutProjection(canvas, nodes, layout, boards, store, projectionRef, commitRef) {
  const projected = reconcileContainerLayout(canvas, nodes).doc;
  projectionRef.current = projected;
  commitRef.current = () => {
    store.mutate(doc => doc.layout === layout && doc.boards === boards
      ? reconcileContainerLayout(doc, nodes).doc : doc, { history: false });
    return store.get();
  };
  return projected;
}
