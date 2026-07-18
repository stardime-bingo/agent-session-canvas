/**
 * Pure container-carry geometry: anchored-ink ownership (smallest container
 * wins, bound text follows host) and carry translations. No DOM, no React, no filesystem.
 */

const finite = value => typeof value === 'number' && Number.isFinite(value);
const point = value => value && finite(value.x) && finite(value.y);
export function computeAnchorIds(elements = [], containers = []) {
  const validContainers = containers
    .filter(c => c?.id && finite(c.x) && finite(c.y) && finite(c.w) && finite(c.h) && c.w >= 0 && c.h >= 0)
    .map((c, order) => ({ ...c, order, area: c.w * c.h }))
    .sort((a, b) => a.area - b.area || a.order - b.order);
  const owner = new Map();
  const byId = new Map(elements.filter(Boolean).map(element => [element.id, element]));
  for (const element of elements) {
    if (!element?.id || element.isDeleted || element.containerId) continue;
    const x = Number(element.x) + Number(element.width || 0) / 2;
    const y = Number(element.y) + Number(element.height || 0) / 2;
    const container = validContainers.find(c => x >= c.x && x <= c.x + c.w && y >= c.y && y <= c.y + c.h);
    if (container) owner.set(element.id, container.id);
  }
  // Only legacy-format bound text inherits its container host; bound arrows keep
  // their own geometric ownership and cannot be claimed by traversal order.
  for (const element of elements) {
    if (element?.type !== 'text' || !element.containerId || !byId.has(element.containerId)) continue;
    const containerId = owner.get(element.containerId);
    if (containerId) owner.set(element.id, containerId);
  }
  const result = new Map(validContainers.map(c => [c.id, []]));
  for (const element of elements) {
    const containerId = owner.get(element?.id);
    if (containerId) result.get(containerId)?.push(element.id);
  }
  return result;
}

export function applyCarry(elements = [], anchorIds = [], dx = 0, dy = 0) {
  if (!finite(dx) || !finite(dy)) throw new TypeError('carry delta must be finite');
  const ids = new Set(anchorIds);
  if (!ids.size || (!dx && !dy)) return elements;
  return elements.map(element => ids.has(element?.id)
    ? { ...element, x: Number(element.x) + dx, y: Number(element.y) + dy }
    : element);
}

export function applyBatchCarry(elements = [], moves = []) {
  const deltas = new Map();
  for (const move of moves) {
    const dx = move.to.x - move.from.x;
    const dy = move.to.y - move.from.y;
    if (!finite(dx) || !finite(dy)) throw new TypeError('batch carry delta must be finite');
    if (!dx && !dy) continue;
    for (const id of move.anchorIds) {
      if (deltas.has(id)) throw new TypeError('batch anchorIds must be globally unique');
      deltas.set(id, { dx, dy });
    }
  }
  if (!deltas.size) return elements;
  return elements.map(element => {
    const delta = deltas.get(element?.id);
    return delta
      ? { ...element, x: Number(element.x) + delta.dx, y: Number(element.y) + delta.dy }
      : element;
  });
}
