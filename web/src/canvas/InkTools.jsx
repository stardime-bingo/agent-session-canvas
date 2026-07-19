/**
 * [INPUT]: scene-store、输入前布局提交钩子、ink.js 元素工厂、ink-selection.js 选择内核、drawing.js 命中、gestures.js 相机数学、RF instance
 * [OUTPUT]: useInkTools——笔/形状/文字直写文档；单选/框选/多选、批量移动/缩放/旋转/删除/改样式、复制粘贴与 Alt 拖；
 *           V/P/R/O/A/T/E 快捷键、橡皮、真实指针落点不丢焦的就地文字编辑和单相机滚轮；指针写入前先落定只读布局投影
 * [POS]: canvas 的自研墨迹交互层。每一帧手势只做同步内存 mutate；持久化永远在 scene-store 后台
 * [PROTOCOL]: 变更时更新此头部，然后检查 web/CLAUDE.md
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { isLargeFilledDrawingElement } from './drawing.js';
import {
  deleteDrawingElements, drawingElementsInBox, duplicateDrawingElements, hitSelectionHandle,
  resizeBoundsFromHandle, resizeSelectedElements, rotateSelectedElements, selectionBounds,
  selectionClosureIds, setDrawingElementsPlane, translateSelectedElements,
} from './ink-selection.js';
import {
  createInkElement, finishInkElement, INK_COLORS, INK_FILLS, INK_FONT, INK_WIDTHS,
  measureInkText, updateInkElementDrag, upsertInkElement,
} from './ink.js';
import { createImagePlaceholder, loadImageFile } from './image-import.js';
import { stageRecoveryFile } from '../scene-recovery.js';
import { wheelViewport } from './gestures.js';
import { Icon, toast } from '../ui.jsx';

const DRAW_TOOLS = [
  ['freedraw', 'pen', '画笔'], ['rectangle', 'board', '矩形'], ['ellipse', 'circle', '椭圆'],
  ['arrow', 'up', '箭头'], ['text', 'edit', '文字'], ['eraser', 'trash', '橡皮'],
];
const TOOL_KEYS = Object.freeze({ v: 'select', p: 'freedraw', r: 'rectangle', o: 'ellipse', a: 'arrow', t: 'text', e: 'eraser' });
const CLIPBOARD_MIME = 'application/x-agent-canvas-ink+json';
const CLIPBOARD_TAG = 'agent-canvas-ink';
const TEXT_SIZES = [14, 20, 28, 40];

const editableTarget = target => target?.tagName === 'TEXTAREA' || target?.tagName === 'INPUT' || target?.isContentEditable;
const uniq = ids => [...new Set(ids)];
const capturePointer = (target, pointerId) => {
  try { target.setPointerCapture?.(pointerId); } catch { /* 4518 合成 pointer 不属于原生 active pointer */ }
};

function clipboardPayload(doc, ids) {
  const closed = new Set(selectionClosureIds(doc.drawing, ids));
  const elements = doc.drawing.filter(el => closed.has(el.id));
  const fileIds = new Set(elements.filter(el => el.type === 'image').map(el => el.fileId).filter(Boolean));
  const files = Object.fromEntries(Object.entries(doc.drawingFiles || {}).filter(([id]) => fileIds.has(id)));
  return JSON.stringify({ type: CLIPBOARD_TAG, version: 1, elements, files });
}

function readClipboardPayload(data) {
  try {
    const parsed = JSON.parse(data);
    return parsed?.type === CLIPBOARD_TAG && parsed.version === 1 && Array.isArray(parsed.elements) ? parsed : null;
  } catch { return null; }
}

export function useInkTools({ store, instRef, rootRef, hitAt, beforeInput, wheelModeRef, minZoom, maxZoom }) {
  const [tool, setToolState] = useState('none');
  const [selectedIds, setSelectedIdsState] = useState([]);
  const [style, setStyle] = useState({ strokeColor: '#e2611f', backgroundColor: 'transparent', strokeWidth: 2.5 });
  const [textEdit, setTextEdit] = useState(null);
  const [marquee, setMarquee] = useState(null);
  const [spaceHeld, setSpaceHeld] = useState(false);
  const toolRef = useRef(tool);
  const selectedIdsRef = useRef(selectedIds);
  const gestureRef = useRef(null);
  const spaceRef = useRef(false);
  const wheelStreakRef = useRef(null);
  const pasteCountRef = useRef(1);

  const setSelectedIds = useCallback(ids => {
    const next = uniq(ids || []);
    selectedIdsRef.current = next;
    setSelectedIdsState(next);
  }, []);
  const setSelectedId = useCallback(id => setSelectedIds(id ? [id] : []), [setSelectedIds]);

  const setTool = useCallback(next => {
    toolRef.current = next;
    setToolState(next);
    if (next === 'none') setSelectedIds([]);
  }, [setSelectedIds]);

  const flowPoint = useCallback(e => instRef.current?.screenToFlowPosition({ x: e.clientX, y: e.clientY }), [instRef]);
  const mutateDrawing = useCallback((fn, options) => store.mutate(doc => {
    const drawing = fn(doc.drawing);
    return drawing === doc.drawing ? doc : { ...doc, drawing };
  }, options), [store]);

  const eraseAt = useCallback((gesture, point) => {
    const hit = hitAt(point.x, point.y, 'all', true);
    if (!hit || gesture.erased.has(hit.id)) return;
    gesture.erased.add(hit.id);
    mutateDrawing(elements => deleteDrawingElements(elements, [hit.id]), { coalesce: gesture.coalesce });
    if (selectedIdsRef.current.includes(hit.id)) {
      setSelectedIds(selectedIdsRef.current.filter(id => id !== hit.id));
    }
  }, [hitAt, mutateDrawing, setSelectedIds]);

  useEffect(() => {
    const onDown = e => {
      if (e.code !== 'Space' || editableTarget(e.target)) return;
      spaceRef.current = true;
      setSpaceHeld(true);
    };
    const onUp = e => {
      if (e.code !== 'Space') return;
      spaceRef.current = false;
      setSpaceHeld(false);
    };
    window.addEventListener('keydown', onDown, true);
    window.addEventListener('keyup', onUp, true);
    return () => {
      window.removeEventListener('keydown', onDown, true);
      window.removeEventListener('keyup', onUp, true);
    };
  }, []);

  const openTextEditor = useCallback(element => {
    setSelectedId(element.id);
    setTextEdit({ id: element.id, fontSize: element.fontSize || 20 });
  }, [setSelectedId]);

  const closeTextEditor = useCallback(() => {
    const edit = textEdit;
    if (!edit) return;
    setTextEdit(null);
    store.endCoalescing();
    const el = store.get().drawing.find(item => item.id === edit.id);
    if (el && !String(el.text || '').trim()) {
      mutateDrawing(els => deleteDrawingElements(els, [edit.id]), { history: false });
      setSelectedId(null);
    }
  }, [textEdit, store, mutateDrawing, setSelectedId]);

  // 图片交互只同步放占位；读取/哈希/解码完成后 history:false 回填，同一 undo 仍撤整次导入。
  const importImages = useCallback((fileList, dropPoint = null) => {
    const files = [...(fileList || [])].filter(file => file?.type?.startsWith('image/'));
    if (!files.length) return false;
    let point = dropPoint;
    if (!point) {
      const rect = rootRef.current?.getBoundingClientRect();
      if (rect) point = instRef.current?.screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
    }
    point ||= { x: 0, y: 0 };
    const placeholders = files.map((file, index) => createImagePlaceholder(
      point.x + index * 28, point.y + index * 28, file.name || `图片 ${index + 1}`,
    ));
    store.mutate(doc => ({ ...doc, drawing: [...doc.drawing.filter(el => !el.isDeleted), ...placeholders] }));
    setTool('select');
    setSelectedIds(placeholders.map(el => el.id));
    toast(files.length > 1 ? `正在加入 ${files.length} 张图片` : '正在加入图片');

    files.forEach((file, index) => {
      const placeholder = placeholders[index];
      void loadImageFile(file).then(async asset => {
        // 先把大资产放进同源恢复仓，再把 fileId 写进场景；关页时即使 keepalive 超限也能重开追平。
        await stageRecoveryFile(asset.file);
        store.mutate(doc => {
          if (!doc.drawing.some(el => el.id === placeholder.id)) return doc;   // 用户已 undo：迟到读取没有复活权
          return {
            ...doc,
            drawingFiles: { [asset.id]: asset.file, ...doc.drawingFiles },
            drawing: doc.drawing.map(el => el.id === placeholder.id ? {
              ...el, fileId: asset.id, width: asset.width, height: asset.height,
              customData: Object.fromEntries(Object.entries(el.customData || {})
                .filter(([key]) => key !== 'importing' && key !== 'importError')),
              updated: Date.now(),
            } : el),
          };
        }, { history: false });
      }).catch(error => {
        store.mutate(doc => {
          if (!doc.drawing.some(el => el.id === placeholder.id)) return doc;
          return {
            ...doc,
            drawing: doc.drawing.map(el => el.id === placeholder.id
              ? { ...el, customData: { ...el.customData, importing: false, importError: String(error.message || error) } }
              : el),
          };
        }, { history: false });
        toast(`${file.name || '图片'}导入失败`, 'error');
      });
    });
    return true;
  }, [instRef, rootRef, setSelectedIds, setTool, store]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return undefined;
    const carriesImages = event => [...(event.dataTransfer?.items || [])].some(item => item.kind === 'file' && item.type.startsWith('image/'));
    const onDragOver = event => {
      if (!carriesImages(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      root.classList.add('ink-file-over');
    };
    const onDragLeave = event => {
      if (!root.contains(event.relatedTarget)) root.classList.remove('ink-file-over');
    };
    const onDrop = event => {
      root.classList.remove('ink-file-over');
      const point = instRef.current?.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      if (importImages(event.dataTransfer?.files, point)) event.preventDefault();
    };
    root.addEventListener('dragover', onDragOver);
    root.addEventListener('dragleave', onDragLeave);
    root.addEventListener('drop', onDrop);
    return () => {
      root.classList.remove('ink-file-over');
      root.removeEventListener('dragover', onDragOver);
      root.removeEventListener('dragleave', onDragLeave);
      root.removeEventListener('drop', onDrop);
    };
  }, [importImages, instRef, rootRef]);

  const beginSelectGesture = useCallback((e, p) => {
    const currentIds = selectedIdsRef.current;
    const elements = store.get().drawing;
    const bounds = selectionBounds(elements, currentIds);
    const zoom = instRef.current?.getZoom() || 1;
    const handle = bounds && hitSelectionHandle(bounds, p.x, p.y, 10 / zoom, 28);
    if (handle) {
      const coalesce = `ink-${handle}:${Date.now()}`;
      store.endCoalescing();
      if (handle === 'rotate') {
        const cx = (bounds.minX + bounds.maxX) / 2, cy = (bounds.minY + bounds.maxY) / 2;
        gestureRef.current = {
          kind: 'rotate', ids: currentIds, original: elements, bounds, cx, cy,
          startAngle: Math.atan2(p.y - cy, p.x - cx), coalesce,
        };
      } else {
        gestureRef.current = { kind: 'resize', ids: currentIds, original: elements, bounds, handle, coalesce };
      }
      capturePointer(e.currentTarget, e.pointerId);
      return;
    }

    const hit = hitAt(p.x, p.y, 'all', true);
    if (hit) {
      if (e.shiftKey) {
        setSelectedIds(currentIds.includes(hit.id)
          ? currentIds.filter(id => id !== hit.id)
          : [...currentIds, hit.id]);
        return;
      }
      const ids = currentIds.includes(hit.id) ? currentIds : [hit.id];
      setSelectedIds(ids);
      store.endCoalescing();
      gestureRef.current = {
        kind: 'move', ids, lastFx: p.x, lastFy: p.y, moved: false,
        alt: e.altKey, cloned: false, coalesce: `ink-move:${Date.now()}`,
      };
      capturePointer(e.currentTarget, e.pointerId);
      return;
    }

    const baseIds = e.shiftKey ? currentIds : [];
    if (!e.shiftKey) setSelectedIds([]);
    gestureRef.current = {
      kind: 'marquee', startFx: p.x, startFy: p.y, lastFx: p.x, lastFy: p.y,
      startX: e.clientX, startY: e.clientY, baseIds,
    };
    setMarquee({ x1: e.clientX, y1: e.clientY, x2: e.clientX, y2: e.clientY });
    capturePointer(e.currentTarget, e.pointerId);
  }, [hitAt, instRef, setSelectedIds, store]);

  const onPointerDown = useCallback(e => {
    if (!e.isPrimary || e.button !== 0 || spaceRef.current) return;
    beforeInput?.();
    const active = toolRef.current;
    const p = flowPoint(e);
    if (!p) return;
    if (textEdit) closeTextEditor();
    if (active === 'select') return beginSelectGesture(e, p);
    if (active === 'eraser') {
      store.endCoalescing();
      const gesture = { kind: 'erase', erased: new Set(), coalesce: `ink-erase:${Date.now()}` };
      gestureRef.current = gesture;
      eraseAt(gesture, p);
      capturePointer(e.currentTarget, e.pointerId);
      return;
    }
    if (active === 'text') {
      // textarea 在 pointerdown 中挂载并 autoFocus；阻止浏览器随后把焦点还给落点 div，
      // 否则真实鼠标会立刻 blur 空编辑器并删掉刚建的文字（合成 PointerEvent 不会暴露它）。
      e.preventDefault();
      const element = createInkElement('text', p.x, p.y, { ...style, fontSize: 20 });
      mutateDrawing(els => upsertInkElement(els, element), { coalesce: `ink:${element.id}` });
      openTextEditor(element);
      return;
    }
    const element = createInkElement(active, p.x, p.y, style);
    gestureRef.current = { kind: 'draw', id: element.id, element, moved: false };
    mutateDrawing(els => upsertInkElement(els, element), { coalesce: `ink:${element.id}` });
    capturePointer(e.currentTarget, e.pointerId);
  }, [beforeInput, flowPoint, textEdit, closeTextEditor, beginSelectGesture, eraseAt, style, mutateDrawing, openTextEditor, store]);

  const onPointerMove = useCallback(e => {
    const gesture = gestureRef.current;
    if (!gesture) return;
    const p = flowPoint(e);
    if (!p) return;
    if (gesture.kind === 'marquee') {
      gesture.lastFx = p.x; gesture.lastFy = p.y;
      setMarquee({ x1: gesture.startX, y1: gesture.startY, x2: e.clientX, y2: e.clientY });
      return;
    }
    if (gesture.kind === 'move') {
      const dx = p.x - gesture.lastFx, dy = p.y - gesture.lastFy;
      if (!dx && !dy) return;
      if (gesture.alt && !gesture.cloned) {
        const copied = duplicateDrawingElements(store.get().drawing, gesture.ids, { dx: 0, dy: 0 });
        gesture.ids = copied.ids;
        gesture.cloned = true;
        setSelectedIds(copied.ids);
        mutateDrawing(() => copied.elements, { coalesce: gesture.coalesce });
      }
      gesture.lastFx = p.x; gesture.lastFy = p.y; gesture.moved = true;
      mutateDrawing(els => translateSelectedElements(els, gesture.ids, dx, dy), { coalesce: gesture.coalesce });
      return;
    }
    if (gesture.kind === 'resize') {
      const target = resizeBoundsFromHandle(gesture.bounds, gesture.handle, p.x, p.y, 8 / (instRef.current?.getZoom() || 1));
      mutateDrawing(() => resizeSelectedElements(gesture.original, gesture.ids, gesture.bounds, target), { coalesce: gesture.coalesce });
      return;
    }
    if (gesture.kind === 'rotate') {
      const angle = Math.atan2(p.y - gesture.cy, p.x - gesture.cx);
      mutateDrawing(() => rotateSelectedElements(
        gesture.original, gesture.ids, gesture.bounds, angle - gesture.startAngle,
      ), { coalesce: gesture.coalesce });
      return;
    }
    if (gesture.kind === 'erase') {
      eraseAt(gesture, p);
      return;
    }
    const updated = updateInkElementDrag(gesture.element, p.x, p.y);
    if (updated === gesture.element) return;
    gesture.element = updated;
    gesture.moved = true;
    mutateDrawing(els => upsertInkElement(els, updated), { coalesce: `ink:${gesture.id}` });
  }, [eraseAt, flowPoint, instRef, mutateDrawing, setSelectedIds, store]);

  const onPointerUp = useCallback(() => {
    const gesture = gestureRef.current;
    gestureRef.current = null;
    if (!gesture) return;
    if (gesture.kind === 'marquee') {
      setMarquee(null);
      const hitIds = drawingElementsInBox(store.get().drawing, {
        minX: gesture.startFx, minY: gesture.startFy, maxX: gesture.lastFx, maxY: gesture.lastFy,
      });
      setSelectedIds([...gesture.baseIds, ...hitIds]);
      return;
    }
    store.endCoalescing();
    if (gesture.kind !== 'draw') return;
    const { element, discard } = finishInkElement(gesture.element);
    if (discard) {
      mutateDrawing(els => deleteDrawingElements(els, [element.id]), { history: false });
      return;
    }
    let sunk = false;
    mutateDrawing(els => {
      let next = upsertInkElement(els, element);
      if (isLargeFilledDrawingElement(element)) {
        next = setDrawingElementsPlane(next, [element.id], true);
        sunk = true;
      }
      return next;
    }, { coalesce: `ink:${element.id}` });
    store.endCoalescing();
    if (sunk) {
      toast('大块底板已自动沉到卡片下面', 'ok', {
        label: '撤销', onClick: () => mutateDrawing(els => setDrawingElementsPlane(els, [element.id], false)),
      });
    }
  }, [mutateDrawing, setSelectedIds, store]);

  const onWheel = useCallback(e => {
    const inst = instRef.current;
    const root = rootRef.current;
    if (!inst || !root) return;
    e.preventDefault();
    e.stopPropagation();
    const now = Date.now();
    const result = wheelViewport(inst.getViewport(), e.nativeEvent, root.getBoundingClientRect(), {
      mode: wheelModeRef.current, streak: wheelStreakRef.current, now, min: minZoom, max: maxZoom,
    });
    wheelStreakRef.current = { device: result.device === 'pinch' ? 'trackpad' : result.device, t: now };
    inst.setViewport(result.viewport);
  }, [instRef, rootRef, wheelModeRef, minZoom, maxZoom]);

  useEffect(() => {
    const onKey = e => {
      if (editableTarget(e.target)) return;
      if (!e.metaKey && !e.ctrlKey && !e.altKey) {
        const shortcut = TOOL_KEYS[e.key.toLowerCase()];
        if (shortcut) {
          e.preventDefault();
          e.stopPropagation();
          setTool(shortcut);
          return;
        }
      }
      if (e.key === 'Escape' && toolRef.current !== 'none') {
        e.preventDefault();
        e.stopPropagation();
        if (textEdit) return closeTextEditor();
        if (selectedIdsRef.current.length) return setSelectedIds([]);
        setTool('none');
        return;
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && toolRef.current === 'select' && selectedIdsRef.current.length) {
        e.preventDefault();
        e.stopPropagation();
        const removed = selectedIdsRef.current;
        mutateDrawing(els => deleteDrawingElements(els, removed));
        setSelectedIds([]);
        toast(removed.length > 1 ? `已删除 ${removed.length} 个绘图` : '绘图已删除', 'ok', {
          label: '撤销', onClick: () => store.undo(),
        });
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [closeTextEditor, mutateDrawing, setSelectedIds, setTool, store, textEdit]);

  useEffect(() => {
    const onCopy = e => {
      if (editableTarget(e.target) || toolRef.current !== 'select' || !selectedIdsRef.current.length) return;
      const payload = clipboardPayload(store.get(), selectedIdsRef.current);
      e.clipboardData?.setData(CLIPBOARD_MIME, payload);
      e.clipboardData?.setData('text/plain', payload);
      e.preventDefault();
      pasteCountRef.current = 1;
      toast(selectedIdsRef.current.length > 1 ? `已复制 ${selectedIdsRef.current.length} 个绘图` : '已复制绘图');
    };
    const onPaste = e => {
      if (editableTarget(e.target)) return;
      if (importImages(e.clipboardData?.files)) {
        e.preventDefault();
        return;
      }
      const raw = e.clipboardData?.getData(CLIPBOARD_MIME) || e.clipboardData?.getData('text/plain');
      const payload = readClipboardPayload(raw);
      if (!payload) return;
      e.preventDefault();
      const offset = 24 * pasteCountRef.current++;
      const sourceIds = payload.elements.map(el => el.id).filter(Boolean);
      const copied = duplicateDrawingElements(payload.elements, sourceIds, { dx: offset, dy: offset });
      for (const file of Object.values(payload.files || {})) void stageRecoveryFile(file);
      store.mutate(doc => ({
        ...doc,
        drawing: [...doc.drawing.filter(el => !el.isDeleted), ...copied.clones],
        drawingFiles: { ...(payload.files || {}), ...doc.drawingFiles },
      }));
      setTool('select');
      setSelectedIds(copied.ids);
      toast(copied.ids.length > 1 ? `已粘贴 ${copied.ids.length} 个绘图` : '已粘贴绘图', 'ok');
    };
    window.addEventListener('copy', onCopy);
    window.addEventListener('paste', onPaste);
    return () => {
      window.removeEventListener('copy', onCopy);
      window.removeEventListener('paste', onPaste);
    };
  }, [importImages, setSelectedIds, setTool, store]);

  const onDoubleClick = useCallback(e => {
    if (toolRef.current !== 'select') return;
    const p = flowPoint(e);
    const hit = p && hitAt(p.x, p.y, 'all', true);
    if (hit?.type === 'text') openTextEditor(hit);
  }, [flowPoint, hitAt, openTextEditor]);

  const editingEl = textEdit ? store.get().drawing.find(el => el.id === textEdit.id) : null;
  const vp = textEdit ? instRef.current?.getViewport() : null;
  const rootRect = marquee ? rootRef.current?.getBoundingClientRect() : null;
  const overlay = tool !== 'none' ? (
    <>
      <div
        className={`ink-input-layer ink-tool-${tool}`}
        style={spaceHeld ? { pointerEvents: 'none' } : undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
        onDoubleClick={onDoubleClick}
      />
      {marquee && rootRect && (
        <div className="ink-marquee" style={{
          left: Math.min(marquee.x1, marquee.x2) - rootRect.left,
          top: Math.min(marquee.y1, marquee.y2) - rootRect.top,
          width: Math.abs(marquee.x2 - marquee.x1),
          height: Math.abs(marquee.y2 - marquee.y1),
        }} />
      )}
      {editingEl && vp && (
        <textarea
          className="ink-text-editor nodrag nowheel"
          autoFocus
          value={editingEl.text || ''}
          onChange={e => {
            const text = e.target.value;
            const metrics = measureInkText(text, textEdit.fontSize);
            mutateDrawing(els => els.map(el => el.id === textEdit.id
              ? { ...el, text, originalText: text, ...metrics } : el), { coalesce: `ink-text:${textEdit.id}` });
          }}
          onBlur={closeTextEditor}
          style={{
            left: vp.x + editingEl.x * vp.zoom,
            top: vp.y + editingEl.y * vp.zoom,
            width: Math.max(60, (editingEl.width + 20) * vp.zoom),
            height: Math.max(30, (editingEl.height + 10) * vp.zoom),
            fontSize: textEdit.fontSize * vp.zoom,
            lineHeight: 1.3,
            color: editingEl.strokeColor,
            fontFamily: INK_FONT,
          }}
        />
      )}
    </>
  ) : null;

  const selectedElements = selectedIds
    .map(id => store.get().drawing.find(el => el.id === id && !el.isDeleted))
    .filter(Boolean);
  const applyStyle = patch => {
    setStyle(s => ({ ...s, ...patch }));
    if (selectedElements.length) {
      const ids = new Set(selectionClosureIds(store.get().drawing, selectedIds));
      mutateDrawing(els => els.map(el => {
        if (!ids.has(el.id)) return el;
        if (el.type === 'text' && patch.fontSize) {
          return { ...el, ...patch, ...measureInkText(el.text || '', patch.fontSize) };
        }
        return { ...el, ...patch };
      }));
    }
  };
  const primary = selectedElements.at(-1);
  const shown = primary || style;
  const allBelow = selectedElements.length > 0 && selectedElements.every(el => el.customData?.below);
  const styleIsland = (tool !== 'none' && tool !== 'select') || selectedElements.length ? (
    <div className="island ink-style-island" data-ink-style-island="true">
      {INK_COLORS.map(c => (
        <span key={c} className={`swatch${shown.strokeColor === c ? ' on' : ''}`}
          style={{ background: c }} title="描边颜色"
          onClick={() => applyStyle({ strokeColor: c })} />
      ))}
      <span className="ink-style-sep" />
      {INK_FILLS.map(f => (
        <span key={f} className={`swatch${(shown.backgroundColor || 'transparent') === f ? ' on' : ''}`}
          style={f === 'transparent'
            ? { background: '#fff', backgroundImage: 'linear-gradient(45deg, transparent 46%, #d92d20 46%, #d92d20 54%, transparent 54%)' }
            : { background: f }}
          title={f === 'transparent' ? '无填充' : '填充颜色'}
          onClick={() => applyStyle({ backgroundColor: f })} />
      ))}
      <span className="ink-style-sep" />
      {INK_WIDTHS.map(w => (
        <button key={w} type="button" className={`wbtn${(shown.strokeWidth || 2.5) === w ? ' on' : ''}`}
          title={`线宽 ${w}`} onClick={() => applyStyle({ strokeWidth: w })}>
          <span style={{ width: 14, height: w, borderRadius: 2, background: '#344054' }} />
        </button>
      ))}
      {selectedElements.some(el => el.type === 'text') && (
        <>
          <span className="ink-style-sep" />
          {TEXT_SIZES.map(size => (
            <button key={size} type="button" className={`wbtn${Math.round(primary?.fontSize || 20) === size ? ' on' : ''}`}
              title={`字号 ${size}`} onClick={() => applyStyle({ fontSize: size })}>{size}</button>
          ))}
        </>
      )}
      {!!selectedElements.length && (
        <>
          <span className="ink-style-sep" />
          <span className="ink-selection-count">{selectedElements.length > 1 ? `${selectedElements.length} 项` : ''}</span>
          <button type="button" className="wbtn" title={allBelow ? '浮到卡片上面' : '沉到卡片下面'}
            onClick={() => mutateDrawing(els => setDrawingElementsPlane(els, selectedIds, !allBelow))}>
            <Icon name={allBelow ? 'up' : 'down'} size={12} />
          </button>
          <button type="button" className="wbtn" title="复制（Cmd/Ctrl+C）"
            onClick={() => document.execCommand?.('copy')}><Icon name="copy" size={12} /></button>
          <button type="button" className="wbtn" title="删除（Delete）"
            onClick={() => {
              mutateDrawing(els => deleteDrawingElements(els, selectedIds));
              setSelectedIds([]);
              toast(selectedIds.length > 1 ? `已删除 ${selectedIds.length} 个绘图` : '绘图已删除', 'ok', {
                label: '撤销', onClick: () => store.undo(),
              });
            }}>
            <Icon name="trash" size={12} />
          </button>
        </>
      )}
    </div>
  ) : null;

  return {
    tool, setTool, selectedId: selectedIds.at(-1) || null, selectedIds, setSelectedId, setSelectedIds,
    overlay, styleIsland, toolButtons: DRAW_TOOLS, editingText: !!textEdit, openTextEditor,
  };
}
