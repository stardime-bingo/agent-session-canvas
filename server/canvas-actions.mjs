/**
 * [INPUT]: canvas 手绘仓快照、落空连线的来源/落点/对象类型
 * [OUTPUT]: 提供“创建便签或画板并接上线”的单次事务构造
 * [POS]: server 的画布动作纯内核；让对象与连线同写同成败，可由合成数据直接证伪
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

export function createNodeFromEdge(canvas, body, now = Date.now()) {
  if (typeof body?.from !== 'string' || !body.from) throw new Error('连线来源无效');
  if (body.kind !== 'note' && body.kind !== 'board') throw new Error('只支持新建便签或画板');

  const x = Math.round(Number(body.x) || 0);
  const y = Math.round(Number(body.y) || 0);
  const next = {
    ...canvas,
    edges: [...(canvas.edges || [])],
    notes: [...(canvas.notes || [])],
    boards: [...(canvas.boards || [])],
  };

  const node = body.kind === 'note'
    ? { id: `note:${now}`, x, y: y - 40, text: '', color: 'yellow' }
    : { id: `${now}`, x, y: y - 30, w: 520, h: 360, name: '新画板', color: 'blue' };
  const target = body.kind === 'note' ? node.id : `board:${node.id}`;
  const edge = { id: `manual:${now}`, from: body.from, to: target };

  next[body.kind === 'note' ? 'notes' : 'boards'].push(node);
  next.edges.push(edge);
  return { canvas: next, kind: body.kind, node, edge };
}
