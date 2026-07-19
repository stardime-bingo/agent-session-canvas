/**
 * [INPUT]: 依赖真实 FlowCanvas/scene-store/UIHost 与 4518 synthetic 数据；自研墨迹直渲，无故障注入
 * [OUTPUT]: 无 fetch 全内存交互画布 + 原生墨迹全链自动验收：冷渲/连发即时/P-R-O-A-T-E 实画/文字双击与字号/
 *           框选与 Shift 多选/批量样式移动缩放旋转删除/复制粘贴/Alt 拖/图片粘贴与 drop/文字图片变换/
 *           橡皮撤销/Esc 收工具/后台冲刷；报告挂 window
 * [POS]: 仅由 ?mode=interaction 动态加载；证伪"文档变更到像素可见=一次 React commit"的宪法
 * [PROTOCOL]: 变更时更新此头部，然后检查 main.jsx/README/web/CLAUDE.md
 */
import React, { useCallback, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import '@xyflow/react/dist/style.css';
import '../../../web/src/theme.css';
import FlowCanvas from '../../../web/src/canvas/FlowCanvas.jsx';
import { createSceneStore } from '../../../web/src/scene-store.js';
import { translateDrawingElements } from '../../../web/src/canvas/drawing.js';
import { selectionBounds } from '../../../web/src/canvas/ink-selection.js';
import { UIHost } from '../../../web/src/ui.jsx';

const h = React.createElement;
const WORKSPACE = '/Users/fixture/AutomationOps';
const SESSION_KEY = 'codex:fixture-ops-session';
const BOARD_ID = 'fixture-automation-board';
const FIXED_TIME = '2026-07-15T04:00:00.000Z';

const element = (id, x, y, width, height, extra = {}) => ({
  id, type: 'rectangle', x, y, width, height, angle: 0,
  strokeColor: '#155eef', backgroundColor: '#dbeafe', fillStyle: 'solid',
  strokeWidth: 2, strokeStyle: 'solid', roughness: 0, opacity: 70,
  roundness: { type: 3 }, seed: 4518, version: 1, versionNonce: 4518,
  index: null, isDeleted: false, groupIds: [], frameId: null, boundElements: null,
  updated: 1, link: null, locked: false, ...extra,
});
const below = { customData: { below: true } };
const INITIAL_DOC = {
  layout: { [WORKSPACE]: { d: `board:${BOARD_ID}`, x: 90, y: 100 } },
  edges: [],
  notes: [],
  boards: [{ id: BOARD_ID, x: 120, y: 100, w: 900, h: 650, name: '自动化运维区', color: 'blue' }],
  drawing: [
    element('fixture-landmark', 1060, 160, 180, 110, below),
    element('fixture-witness', 1280, 160, 160, 90, below),
  ],
  drawingFiles: {},
};
const SESSION = {
  key: SESSION_KEY, tool: 'codex', status: 'active', title: '验收：自动化运维会话卡',
  cwd: WORKSPACE, updatedAt: FIXED_TIME, kind: 'session', subagents: 0, runs: 1,
  summary: '', hasHandoff: false, gitBranch: 'main',
};
const WORKSPACES = [{
  path: WORKSPACE, name: '自动化运维', parent: null, tools: { codex: 1 },
  lastActivity: FIXED_TIME, sessionKeys: [SESSION_KEY], visibleKeys: [SESSION_KEY],
}];

// setTimeout 轮询而非 rAF：隐藏窗格 rAF 会停摆（v23 教训），验收必须在后台标签页也能跑完
const tick = () => new Promise(resolve => setTimeout(resolve, 50));
async function waitFor(read, label, timeoutMs = 20000) {
  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    const value = read();
    if (value) return value;
    await tick();
  }
  throw new Error(`Timed out waiting for ${label}`);
}

const probeReport = { status: 'booting', report: null, run: null };
window.__CANVAS_ACCEPTANCE__ = probeReport;

function InteractionCanvas() {
  const flushedRef = useRef([]);
  const storeRef = useRef(null);
  if (!storeRef.current) {
    storeRef.current = createSceneStore(INITIAL_DOC, {
      persistScene: async scene => { flushedRef.current.push(scene); return { rev: flushedRef.current.length }; },
      persistFiles: async files => ({ added: Object.keys(files).length }),
    });
  }
  const store = storeRef.current;
  window.__FIXTURE_STORE__ = store;   // 夹具专用透视窗：只在 4518 隔离页存在
  const doc = useSyncExternalStore(
    useCallback(cb => store.subscribe(cb), [store]),
    useCallback(() => store.get(), [store]),
  );
  const [suite, setSuite] = useState({ status: 'idle', checks: null, details: null });
  const frameTestProbeRef = useRef(null);
  window.__FIXTURE_PROBE__ = frameTestProbeRef;   // 透视窗必须在声明之后（v23 TDZ 教训）
  const focusRef = useRef(() => {});
  const actionsRef = useRef({});
  const shellRef = useRef(null);
  const sessionsByKey = useMemo(() => ({ [SESSION_KEY]: SESSION }), []);

  // 与 App.handleCanvas 同语义：便签补丁式合并（打字流 coalesce 一步 undo），不存在第二套写法
  const onCanvasAction = useCallback((kind, payload) => {
    if (kind === 'setNote') {
      store.mutate(d => {
        const i = d.notes.findIndex(n => n.id === payload.id);
        if (i >= 0) {
          const patch = {};
          for (const k of ['x', 'y', 'text', 'color', 'w', 'h']) if (payload[k] !== undefined) patch[k] = payload[k];
          const notes = [...d.notes];
          notes[i] = { ...notes[i], ...patch };
          return { ...d, notes };
        }
        return { ...d, notes: [...d.notes, { id: payload.id || `note:${Date.now()}`, x: 0, y: 0, text: '', color: 'yellow', ...payload }] };
      }, payload.text !== undefined ? { coalesce: `note-text:${payload.id}` } : {});
    } else if (kind === 'delNote') {
      store.mutate(d => ({ ...d, notes: d.notes.filter(n => n.id !== payload) }));
    }
    return true;
  }, [store]);

  const runSuite = useCallback(async () => {
    const checks = {};
    const details = {};
    const probe = () => frameTestProbeRef.current;
    const dom = () => shellRef.current?.querySelectorAll('.ink-world [data-ink-element-id]').length ?? 0;   // 排除 MiniMapInk 缩略副本
    const landmarkX = () => store.get().drawing.find(el => el.id === 'fixture-landmark')?.x;
    const input = () => shellRef.current?.querySelector('.ink-input-layer');
    const pointer = (type, point, extra = {}) => {
      const screen = probe().flowToScreen(point);
      input().dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, pointerId: 4518, pointerType: 'mouse', isPrimary: true,
        button: 0, buttons: type === 'pointerup' ? 0 : 1,
        clientX: screen.x, clientY: screen.y, ...extra,
      }));
    };
    const key = (value, extra = {}) => window.dispatchEvent(new KeyboardEvent('keydown', {
      key: value, bubbles: true, cancelable: true, ...extra,
    }));
    const doubleClick = point => {
      const screen = probe().flowToScreen(point);
      input().dispatchEvent(new MouseEvent('dblclick', {
        bubbles: true, cancelable: true, button: 0, buttons: 0,
        clientX: screen.x, clientY: screen.y,
      }));
    };
    const setTextarea = (node, value) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      setter.call(node, value);
      node.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const imageFile = name => {
      const bytes = Uint8Array.from(atob(
        'iVBORw0KGgoAAAANSUhEUgAAAHgAAABQAQMAAADoVSPKAAAAIGNIUk0AAHomAACAhAAA+gAAAIDoAAB1MAAA6mAAADqYAAAXcJy6UTwAAAAGUExURRVe7//////9LDEAAAABYktHRAH/Ai3eAAAAB3RJTUUH6gcTBicj96gJgAAAACV0RVh0ZGF0ZTpjcmVhdGUAMjAyNi0wNy0xOVQwNjozOTozNSswMDowMHcryPYAAAAldEVYdGRhdGU6bW9kaWZ5ADIwMjYtMDctMTlUMDY6Mzk6MzUrMDA6MDAGdnBKAAAAKHRFWHRkYXRlOnRpbWVzdGFtcAAyMDI2LTA3LTE5VDA2OjM5OjM1KzAwOjAwUWNRlQAAABJJREFUOMtjYBgFo2AUjIKRCQAFAAABL8GJmgAAAABJRU5ErkJggg==',
      ), char => char.charCodeAt(0));
      return new File([bytes], name, { type: 'image/png' });
    };
    try {
      // 1) 冷渲：文档元素直渲进 DOM，数量一致
      await waitFor(() => dom() === 2, 'cold render');
      checks.coldRender = true;

      // 2) 连发即时：两笔平移背靠背，文档同步推进、DOM 同 commit 跟上——没有任何门
      const before = store.get().seq;
      probe().mutateDrawing(els => translateDrawingElements(els, ['fixture-landmark'], 10, 0));
      probe().mutateDrawing(els => translateDrawingElements(els, ['fixture-landmark'], 10, 0));
      checks.rapidMutations = store.get().seq === before + 2 && landmarkX() === 1080;
      await waitFor(() => shellRef.current?.querySelector('.ink-world [data-ink-element-id="fixture-landmark"] rect')?.getAttribute('x') === '1080', 'dom sync');
      checks.domSync = true;

      // 3) Figma 肌肉记忆不是只看按钮亮起：P/R/O/A/T 都必须真实产出对应元素，V 切回选择
      const shortcutStart = store.get().drawing.length;
      key('p');
      await waitFor(() => shellRef.current?.querySelector('.ink-input-layer'), 'input layer');
      const penTool = probe().snapshot().tool;
      pointer('pointerdown', { x: 360, y: 360 });
      pointer('pointermove', { x: 410, y: 390 });
      pointer('pointerup', { x: 430, y: 410 });
      key('r');
      pointer('pointerdown', { x: 480, y: 360 });
      pointer('pointermove', { x: 560, y: 420 });
      pointer('pointerup', { x: 560, y: 420 });
      key('o');
      pointer('pointerdown', { x: 600, y: 360 });
      pointer('pointermove', { x: 680, y: 420 });
      pointer('pointerup', { x: 680, y: 420 });
      key('a');
      pointer('pointerdown', { x: 720, y: 360 });
      pointer('pointermove', { x: 800, y: 420 });
      pointer('pointerup', { x: 800, y: 420 });
      key('t');
      pointer('pointerdown', { x: 840, y: 360 });
      pointer('pointerup', { x: 840, y: 360 });
      const textEditor = await waitFor(() => shellRef.current?.querySelector('.ink-text-editor'), 'new text editor');
      setTextarea(textEditor, '接力验收文字');
      const createdText = await waitFor(
        () => store.get().drawing.find(el => el.type === 'text' && el.text === '接力验收文字'),
        'new text content',
      );
      textEditor.blur();
      await waitFor(() => !shellRef.current?.querySelector('.ink-text-editor'), 'new text editor close');
      key('v');
      await waitFor(() => probe().snapshot().tool === 'select', 'select shortcut');
      const shortcutElements = store.get().drawing.slice(shortcutStart);
      checks.toolShortcuts = penTool === 'freedraw'
        && ['freedraw', 'rectangle', 'ellipse', 'arrow', 'text'].every(type => shortcutElements.some(el => el.type === type));

      // 4) 已有文字双击就地编辑，字号岛真实改成 28；随后单元素缩放/旋转都写回同一文档
      doubleClick({ x: createdText.x + 4, y: createdText.y + 4 });
      const reopenedText = await waitFor(() => shellRef.current?.querySelector('.ink-text-editor'), 'double click text editor');
      setTextarea(reopenedText, '双击编辑已生效');
      await waitFor(() => store.get().drawing.find(el => el.id === createdText.id)?.text === '双击编辑已生效', 'double click text update');
      reopenedText.blur();
      probe().setSelectedId(createdText.id);
      await waitFor(() => probe().snapshot().selectedId === createdText.id, 'select edited text');
      const size28 = await waitFor(() => shellRef.current?.querySelector('button[title="字号 28"]'), 'font size 28');
      size28.click();
      await waitFor(() => store.get().drawing.find(el => el.id === createdText.id)?.fontSize === 28, 'font size update');
      const textBeforeResize = { ...store.get().drawing.find(el => el.id === createdText.id) };
      const textBox = selectionBounds(store.get().drawing, [createdText.id]);
      pointer('pointerdown', { x: textBox.maxX, y: textBox.maxY });
      pointer('pointermove', { x: textBox.maxX + 56, y: textBox.maxY + 32 });
      pointer('pointerup', { x: textBox.maxX + 56, y: textBox.maxY + 32 });
      const textRotateBox = selectionBounds(store.get().drawing, [createdText.id]);
      const textCx = (textRotateBox.minX + textRotateBox.maxX) / 2;
      const textCy = (textRotateBox.minY + textRotateBox.maxY) / 2;
      pointer('pointerdown', { x: textCx, y: textRotateBox.minY - 28 });
      pointer('pointermove', { x: textRotateBox.maxX + 28, y: textCy });
      pointer('pointerup', { x: textRotateBox.maxX + 28, y: textCy });
      const transformedText = store.get().drawing.find(el => el.id === createdText.id);
      checks.textEditSizeTransform = transformedText.text === '双击编辑已生效'
        && transformedText.fontSize > textBeforeResize.fontSize
        && Math.abs(transformedText.angle || 0) > 0.5;

      // 5) 空白拖框选中两元素：合成 pointer 只存在 4518，真实 4517 永不坐标自动化
      pointer('pointerdown', { x: 1040, y: 140 });
      pointer('pointermove', { x: 1460, y: 310 });
      pointer('pointerup', { x: 1460, y: 310 });
      await waitFor(() => probe().snapshot().selectedIds.length === 2, 'marquee multi-select');
      checks.marqueeMultiSelect = !!shellRef.current?.querySelector('[data-ink-handle="se"]');

      // 5b) Shift 点击必须真实追加/移除选择，不用探针直接塞 selection 充数。
      const shiftBox = selectionBounds(store.get().drawing, [createdText.id]);
      const shiftPoint = { x: (shiftBox.minX + shiftBox.maxX) / 2, y: (shiftBox.minY + shiftBox.maxY) / 2 };
      pointer('pointerdown', shiftPoint, { shiftKey: true });
      pointer('pointerup', shiftPoint, { shiftKey: true });
      await waitFor(() => probe().snapshot().selectedIds.length === 3, 'shift add selection');
      const shiftAdded = probe().snapshot().selectedIds.includes(createdText.id);
      pointer('pointerdown', shiftPoint, { shiftKey: true });
      pointer('pointerup', shiftPoint, { shiftKey: true });
      await waitFor(() => probe().snapshot().selectedIds.length === 2, 'shift remove selection');
      checks.shiftAddSelection = shiftAdded && !probe().snapshot().selectedIds.includes(createdText.id);

      // 5c) 样式岛的真实控件一次改两项：描边、填充、线宽都写回同一场景文档。
      const styledIds = [...probe().snapshot().selectedIds];
      const styleIsland = await waitFor(() => shellRef.current?.querySelector('[data-ink-style-island="true"]'), 'batch style island');
      styleIsland.querySelectorAll('[title="描边颜色"]')[5].click();
      styleIsland.querySelectorAll('[title="填充颜色"]')[3].click();
      styleIsland.querySelector('button[title="线宽 5"]').click();
      await waitFor(() => styledIds.every(id => {
        const item = store.get().drawing.find(el => el.id === id);
        return item?.strokeColor === '#7c3aed' && item?.backgroundColor === '#fde0e0' && item?.strokeWidth === 5;
      }), 'batch style writeback');
      checks.batchStyle = true;

      // 6) 多选批量移动：一次 pointer 流、一次 coalesce undo 步
      pointer('pointerdown', { x: 1120, y: 200 });
      pointer('pointermove', { x: 1140, y: 220 });
      pointer('pointerup', { x: 1140, y: 220 });
      checks.groupMove = landmarkX() === 1100
        && store.get().drawing.find(el => el.id === 'fixture-witness')?.x === 1300;

      // 7) 右下手柄批量缩放：文档同步变化，选择保持同一组
      const beforeResize = selectionBounds(store.get().drawing, probe().snapshot().selectedIds);
      pointer('pointerdown', { x: beforeResize.maxX, y: beforeResize.maxY });
      pointer('pointermove', { x: beforeResize.maxX + 60, y: beforeResize.maxY + 40 });
      pointer('pointerup', { x: beforeResize.maxX + 60, y: beforeResize.maxY + 40 });
      const afterResize = selectionBounds(store.get().drawing, probe().snapshot().selectedIds);
      checks.resize = afterResize.maxX - beforeResize.maxX > 59 && afterResize.maxY - beforeResize.maxY > 39;

      // 8) 旋转手柄围绕共同中心旋转，两个元素角度同代推进
      const rotateBox = selectionBounds(store.get().drawing, probe().snapshot().selectedIds);
      const cx = (rotateBox.minX + rotateBox.maxX) / 2;
      const cy = (rotateBox.minY + rotateBox.maxY) / 2;
      pointer('pointerdown', { x: cx, y: rotateBox.minY - 28 });
      pointer('pointermove', { x: rotateBox.maxX + 28, y: cy });
      pointer('pointerup', { x: rotateBox.maxX + 28, y: cy });
      checks.rotate = store.get().drawing.filter(el => ['fixture-landmark', 'fixture-witness'].includes(el.id))
        .every(el => Math.abs(el.angle || 0) > 0.5);

      // 9) ClipboardEvent 走 production copy/paste 监听：元素与选择数同步翻倍
      const transfer = new DataTransfer();
      input().dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: transfer }));
      const beforePaste = store.get().drawing.length;
      input().dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: transfer }));
      await waitFor(() => probe().snapshot().selectedIds.length === 2, 'pasted selection');
      const pastedIds = probe().snapshot().selectedIds;
      checks.copyPaste = store.get().drawing.length === beforePaste + 2 && pastedIds.length === 2;

      // 10) Alt+拖只在首次真正移动时克隆，点击不制造幽灵副本
      const pasted = store.get().drawing.find(el => el.id === pastedIds[0]);
      const pastedBounds = selectionBounds(store.get().drawing, [pasted.id]);
      const px = (pastedBounds.minX + pastedBounds.maxX) / 2;
      const py = (pastedBounds.minY + pastedBounds.maxY) / 2;
      const beforeAlt = store.get().drawing.length;
      probe().setSelectedId(pasted.id);
      await waitFor(() => probe().snapshot().selectedIds.length === 1, 'single alt selection');
      pointer('pointerdown', { x: px, y: py }, { altKey: true });
      pointer('pointermove', { x: px + 24, y: py + 16 }, { altKey: true });
      pointer('pointerup', { x: px + 24, y: py + 16 }, { altKey: true });
      checks.altDrag = store.get().drawing.length === beforeAlt + 1 && probe().snapshot().selectedIds.length === 1;

      // 11) 图片 paste 与 drop 都走 production 监听；drop 后的图片再实际缩放、旋转
      const imageTransfer = new DataTransfer();
      imageTransfer.items.add(imageFile('fixture-paste.svg'));
      const filesBefore = Object.keys(store.get().drawingFiles).length;
      input().dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: imageTransfer }));
      const placeholder = store.get().drawing.at(-1);
      const placeholderImmediate = placeholder?.type === 'image' && placeholder.customData?.importing === true && !placeholder.fileId;
      await waitFor(() => store.get().drawing.find(el => el.id === placeholder.id)?.fileId, 'image content address');
      const imported = store.get().drawing.find(el => el.id === placeholder.id);
      checks.imagePaste = placeholderImmediate
        && Object.keys(store.get().drawingFiles).length === filesBefore + 1
        && imported.width === 120 && imported.height === 80;

      const dropTransfer = new DataTransfer();
      dropTransfer.items.add(imageFile('fixture-drop.svg'));
      const dropPoint = probe().flowToScreen({ x: 940, y: 500 });
      const canvasRoot = shellRef.current.querySelector('.canvas-root');
      const beforeDrop = store.get().drawing.length;
      canvasRoot.dispatchEvent(new DragEvent('dragover', {
        bubbles: true, cancelable: true, dataTransfer: dropTransfer,
        clientX: dropPoint.x, clientY: dropPoint.y,
      }));
      canvasRoot.dispatchEvent(new DragEvent('drop', {
        bubbles: true, cancelable: true, dataTransfer: dropTransfer,
        clientX: dropPoint.x, clientY: dropPoint.y,
      }));
      const dropped = store.get().drawing.at(-1);
      await waitFor(() => store.get().drawing.find(el => el.id === dropped.id)?.fileId, 'dropped image content address');
      checks.imageDrop = store.get().drawing.length === beforeDrop + 1 && dropped.type === 'image';
      probe().setSelectedId(dropped.id);
      await waitFor(() => probe().snapshot().selectedId === dropped.id, 'select dropped image');
      const imageBox = selectionBounds(store.get().drawing, [dropped.id]);
      pointer('pointerdown', { x: imageBox.maxX, y: imageBox.maxY });
      pointer('pointermove', { x: imageBox.maxX + 72, y: imageBox.maxY + 48 });
      pointer('pointerup', { x: imageBox.maxX + 72, y: imageBox.maxY + 48 });
      const imageRotateBox = selectionBounds(store.get().drawing, [dropped.id]);
      const imageCx = (imageRotateBox.minX + imageRotateBox.maxX) / 2;
      const imageCy = (imageRotateBox.minY + imageRotateBox.maxY) / 2;
      pointer('pointerdown', { x: imageCx, y: imageRotateBox.minY - 28 });
      pointer('pointermove', { x: imageRotateBox.maxX + 28, y: imageCy });
      pointer('pointerup', { x: imageRotateBox.maxX + 28, y: imageCy });
      const transformedImage = store.get().drawing.find(el => el.id === dropped.id);
      details.imageTransform = {
        before: imageBox,
        afterResize: imageRotateBox,
        width: transformedImage.width,
        height: transformedImage.height,
        angle: transformedImage.angle || 0,
      };
      checks.imageTransform = transformedImage.width > 190 && transformedImage.height > 125
        && Math.abs(transformedImage.angle || 0) > 0.5;

      // 12) 橡皮：E 武装，按住划过同步删除；整笔 coalesce 成一步 undo
      const eraseTarget = imported;
      const eraseX = eraseTarget.x + eraseTarget.width / 2;
      const eraseY = eraseTarget.y + eraseTarget.height / 2;
      key('e');
      await waitFor(() => probe().snapshot().tool === 'eraser', 'eraser shortcut');
      pointer('pointerdown', { x: eraseX, y: eraseY });
      pointer('pointerup', { x: eraseX, y: eraseY });
      await waitFor(() => !store.get().drawing.some(el => el.id === eraseTarget.id), 'eraser delete');
      store.undo();
      await waitFor(() => store.get().drawing.some(el => el.id === eraseTarget.id), 'eraser undo');
      checks.eraserUndo = true;
      key('v');
      probe().setSelectedIds([eraseTarget.id, dropped.id]);
      await waitFor(() => probe().snapshot().selectedIds.length === 2, 'batch delete target selection');

      // 13) 多选 Delete + 全画布 undo：生产快捷键一次删两项，store 历史原样复活
      await waitFor(() => dom() === store.get().drawing.length, 'alt clone dom commit');
      const beforeDelete = dom();
      details.delete = {
        beforeDom: beforeDelete,
        beforeDrawing: store.get().drawing.length,
        selectedIds: probe().snapshot().selectedIds,
        tool: probe().snapshot().tool,
      };
      key('Delete');
      try {
        await waitFor(() => dom() === beforeDelete - 2, 'batch delete hides');
      } finally {
        details.delete.afterDom = dom();
        details.delete.afterDrawing = store.get().drawing.length;
        details.delete.afterSelectedIds = probe().snapshot().selectedIds;
      }
      store.undo();
      await waitFor(() => dom() === beforeDelete, 'undo revives');
      checks.batchDeleteUndo = [eraseTarget.id, dropped.id]
        .every(id => store.get().drawing.some(el => el.id === id));

      // 13b) Esc 分层退出：先清选择，再从 select 收回到 none。
      probe().setSelectedId(eraseTarget.id);
      await waitFor(() => probe().snapshot().selectedIds.length === 1, 'escape target selection');
      key('Escape');
      await waitFor(() => probe().snapshot().selectedIds.length === 0 && probe().snapshot().tool === 'select', 'escape clears selection');
      key('Escape');
      await waitFor(() => probe().snapshot().tool === 'none', 'escape closes ink tool');
      checks.escapeClosesTool = true;

      // 14) 后台冲刷：防抖后 persist 收到最终文档，以上输入没有一步等待它
      await waitFor(() => flushedRef.current.length > 0, 'background flush', 5000);
      checks.backgroundFlush = flushedRef.current.at(-1).canvas.drawing.some(el => el.id === 'fixture-landmark');
      details.flushCount = flushedRef.current.length;

      // 15) 浏览器原生诊断由 main.jsx 统一收集；套件内也必须保持零错误/零警告
      checks.consoleClean = window.__CANVAS_CONSOLE_ERRORS__.length === 0
        && window.__CANVAS_CONSOLE_WARNINGS__.length === 0
        && window.__CANVAS_PAGE_ERRORS__.length === 0;

      const pass = Object.values(checks).every(Boolean);
      probeReport.status = pass ? 'complete' : 'fail';
      probeReport.report = { checks, details };
      document.documentElement.dataset.interactionStatus = pass ? 'pass' : 'fail';
      setSuite({ status: pass ? 'pass' : 'fail', checks, details });
    } catch (error) {
      probeReport.status = 'error';
      probeReport.report = { checks, details, error: error.message };
      document.documentElement.dataset.interactionStatus = 'error';
      setSuite({ status: 'error', checks, details: { error: error.message } });
    }
  }, [store]);

  probeReport.run = runSuite;

  return h('div', { ref: shellRef, style: { position: 'fixed', inset: 0 } },
    h(FlowCanvas, {
      workspaces: WORKSPACES,
      sessionsByKey,
      edges: [],
      layout: doc.layout,
      canvas: doc,
      store,
      onCanvasAction,
      onMoveNode: entries => store.mutate(d => {
        const layout = { ...d.layout };
        for (const entry of entries || []) layout[entry.path] = { ...layout[entry.path], ...entry };
        return { ...d, layout };
      }),
      onRenameSession: () => {},
      onRenameWs: () => {},
      selectedKey: null,
      onSelect: () => {},
      onChanged: () => {},
      onArrange: () => {},
      focusRef,
      actionsRef,
      expanded: useMemo(() => new Set(), []),
      searching: false,
      onToggleExpand: () => {},
      frameTestProbeRef,
    }),
    h(UIHost),
    h('aside', { className: 'fixture-hud', style: {
      position: 'fixed', right: 10, bottom: 10, zIndex: 99, maxWidth: 420,
      background: '#fff', border: '1px solid #d0d5dd', borderRadius: 10, padding: 10,
      font: '11px/1.5 ui-monospace, monospace', maxHeight: '46vh', overflow: 'auto',
    } },
      h('button', {
        type: 'button',
        'data-run-suite': 'true',
        onClick: () => { setSuite({ status: 'running', checks: null, details: null }); void runSuite(); },
        style: { marginBottom: 6 },
      }, '运行原生墨迹验收'),
      h('div', { 'data-suite-status': suite.status }, `status: ${suite.status}`),
      suite.checks && h('pre', null, JSON.stringify(suite.checks, null, 2)),
    ),
  );
}

export function mountInteractionFixture(target) {
  document.documentElement.dataset.interactionStatus = 'mounted';
  probeReport.status = 'mounted';
  createRoot(target).render(h(InteractionCanvas));
  if (new URLSearchParams(location.search).get('autorun') === '1') {
    setTimeout(() => probeReport.run?.(), 800);
  }
}
