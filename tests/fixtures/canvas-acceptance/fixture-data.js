/**
 * [INPUT]: 元素数量 300/800 与变更序号
 * [OUTPUT]: 确定性双平面 Excalidraw 元素、单平面变更与验收红线
 * [POS]: 4518 无持久化验收数据真相；不读真实 canvas/layout
 * [PROTOCOL]: 变更时更新此头部，然后检查 README/web/CLAUDE.md
 */

const COLORS = ['#dbeafe', '#dcfce7', '#fef3c7', '#fce7f3'];

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
      const text = index === 4 ? '早期唯一字龘' : `自动化区 ${index}`;
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
    text: '早期唯一字靐',
    originalText: '早期唯一字靐',
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
