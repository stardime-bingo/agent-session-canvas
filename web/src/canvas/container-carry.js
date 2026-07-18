/**
 * [INPUT]: 依赖 shared/canvas-carry.mjs 的 computeAnchorIds 锚定纯函数
 * [OUTPUT]: 对外提供 planBatchCarry 整理承载规划、markerExportElements/installExportMarkers SVG 锚标、
 *           createInkDragBridge 拖动期墨迹跟随桥、createBatchCarryBridge 整理逆向 FLIP 桥
 * [POS]: canvas 的容器承载纯规划与唯一 DOM 桥。落盘由 scene-store 负责——这里只管"墨迹在帧追上前跟着容器走"
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import { computeAnchorIds } from '../../../shared/canvas-carry.mjs';

const MARKER_PREFIX = 'ink-marker:';

const containerRect = node => ({
  id: node.id,
  x: node.position.x,
  y: node.position.y,
  w: node.width ?? node.data?._w,
  h: node.height ?? node.data?._h,
});

// 整理承载规划：before/after 容器位置差 + 各自锚定的墨迹（面积小者优先认领在 computeAnchorIds 内）
export function planBatchCarry(beforeNodes = [], afterNodes = [], drawingElements = []) {
  const before = beforeNodes
    .filter(node => node.type === 'district' || node.type === 'board')
    .map(containerRect);
  const after = new Map(afterNodes
    .filter(node => node.type === 'district' || node.type === 'board')
    .map(node => [node.id, containerRect(node)]));
  const owners = computeAnchorIds(drawingElements, before);
  return before.flatMap(container => {
    const target = after.get(container.id);
    if (!target || (target.x === container.x && target.y === container.y)) return [];
    return [{
      containerId: container.id,
      from: { x: container.x, y: container.y },
      to: { x: target.x, y: target.y },
      anchorIds: owners.get(container.id) || [],
    }];
  });
}

// 导出前给元素挂 link 记号，导出后换成 data-ink-element-id——SVG 里的墨迹从此可被 DOM 桥定位
export function markerExportElements(elements = []) {
  return elements.map(element => element?.id
    ? { ...element, link: `${MARKER_PREFIX}${encodeURIComponent(element.id)}` }
    : element);
}

export function installExportMarkers(svg) {
  for (const anchor of svg?.querySelectorAll?.('a[href], a[xlink\\:href]') || []) {
    const href = anchor.getAttribute('href') || anchor.getAttribute('xlink:href') || '';
    if (!href.startsWith(MARKER_PREFIX)) continue;
    anchor.setAttribute('data-ink-element-id', decodeURIComponent(href.slice(MARKER_PREFIX.length)));
    anchor.removeAttribute('href');
    anchor.removeAttribute('xlink:href');
  }
  return svg;
}

// 拖动桥：dragStart 标记一次，pointermove 只改根 CSS 变量（纯合成器），帧追上后 clear
export function createInkDragBridge(root) {
  let marked = [];
  const select = id => root?.querySelectorAll?.(`[data-ink-element-id="${CSS.escape(id)}"]`) || [];
  return Object.freeze({
    mark(anchorIds) {
      marked.forEach(node => node.classList.remove('ink-carry-anchor'));
      marked = anchorIds.flatMap(id => [...select(id)]);
      marked.forEach(node => node.classList.add('ink-carry-anchor'));
      root?.classList.toggle('ink-carry-active', !!marked.length);
    },
    move(dx, dy) {
      root?.style.setProperty('--carry-x', `${dx}px`);
      root?.style.setProperty('--carry-y', `${dy}px`);
    },
    clear() {
      marked.forEach(node => node.classList.remove('ink-carry-anchor'));
      marked = [];
      root?.classList.remove('ink-carry-active');
      root?.style.removeProperty('--carry-x');
      root?.style.removeProperty('--carry-y');
    },
    count: () => marked.length,
  });
}

// 整理桥：每个 move 的锚点各自带 delta（per-node CSS 变量），一次 present、帧追上后 clear
export function createBatchCarryBridge(root) {
  let marked = [];
  const escape = value => globalThis.CSS?.escape?.(value) || String(value).replace(/["\\]/g, '\\$&');
  const select = id => root?.querySelectorAll?.(`[data-ink-element-id="${escape(id)}"]`) || [];
  const clear = () => {
    for (const node of marked) {
      node.classList.remove('ink-carry-anchor');
      node.style.removeProperty('--carry-x');
      node.style.removeProperty('--carry-y');
    }
    marked = [];
    root?.classList.remove('ink-carry-active');
  };
  return Object.freeze({
    present(moves = []) {
      clear();
      for (const move of moves) {
        const dx = move.to.x - move.from.x;
        const dy = move.to.y - move.from.y;
        if (!dx && !dy) continue;
        for (const id of move.anchorIds) {
          for (const node of select(id)) {
            node.classList.add('ink-carry-anchor');
            // store 先落终点；逆向 delta 把新 DOM 暂时钉回旧像素，下一帧 release 才呼吸到终点。
            node.style.setProperty('--carry-x', `${-dx}px`);
            node.style.setProperty('--carry-y', `${-dy}px`);
            marked.push(node);
          }
        }
      }
      root?.classList.toggle('ink-carry-active', !!marked.length);
      return marked.length;
    },
    release() {
      for (const node of marked) {
        node.style.removeProperty('--carry-x');
        node.style.removeProperty('--carry-y');
      }
    },
    clear,
    count: () => marked.length,
  });
}
