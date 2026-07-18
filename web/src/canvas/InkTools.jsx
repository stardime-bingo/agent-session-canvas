/**
 * [INPUT]: scene-store 的 mutate/undo、ink.js 元素工厂与拖画更新、drawing.js 命中/沉浮/删除、gestures.js 滚轮数学、RF instance
 * [OUTPUT]: 对外提供 useInkTools——工具状态 + 输入捕获层（笔/形状/箭头/线/文字拖画即写入文档）+
 *           就地文字编辑 + 选中移动/删除 + 样式岛；armed 期间滚轮直接改 RF 相机（单相机，无冻结无预览）
 * [POS]: canvas 的自研墨迹交互层。每一笔从第一毫秒起就活在场景文档里，coalesce 保证一笔=一步 undo
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  deleteDrawingElement, isLargeFilledDrawingElement, setDrawingElementPlane, translateDrawingElements,
} from './drawing.js';
import {
  createInkElement, finishInkElement, INK_COLORS, INK_FILLS, INK_FONT, INK_WIDTHS,
  measureInkText, updateInkElementDrag, upsertInkElement,
} from './ink.js';
import { wheelViewport } from './gestures.js';
import { Icon, toast } from '../ui.jsx';

const DRAW_TOOLS = [
  ['freedraw', 'pen', '画笔'], ['rectangle', 'board', '矩形'], ['ellipse', 'circle', '椭圆'],
  ['arrow', 'up', '箭头'], ['text', 'edit', '文字'],
];

export function useInkTools({ store, instRef, rootRef, hitAt, wheelModeRef, minZoom, maxZoom }) {
  const [tool, setToolState] = useState('none');       // none | select | freedraw | rectangle | ellipse | diamond | arrow | line | text
  const [selectedId, setSelectedId] = useState(null);
  const [style, setStyle] = useState({ strokeColor: '#e2611f', backgroundColor: 'transparent', strokeWidth: 2.5 });
  const [textEdit, setTextEdit] = useState(null);      // { id, flowX, flowY, fontSize }
  const toolRef = useRef(tool);
  const gestureRef = useRef(null);                     // { kind:'draw'|'move', id, startFx, startFy, moved }
  const spaceRef = useRef(false);
  const wheelStreakRef = useRef(null);

  const setTool = useCallback(next => {
    toolRef.current = next;
    setToolState(next);
    if (next === 'none') setSelectedId(null);
  }, []);

  const flowPoint = useCallback(e => instRef.current?.screenToFlowPosition({ x: e.clientX, y: e.clientY }), [instRef]);
  const mutateDrawing = useCallback((fn, options) => store.mutate(doc => {
    const drawing = fn(doc.drawing);
    return drawing === doc.drawing ? doc : { ...doc, drawing };
  }, options), [store]);

  // ---- 空格平移：按住空格时捕获层让路，RF 原生拖拽平移接管 ----
  useEffect(() => {
    const editable = t => t?.tagName === 'TEXTAREA' || t?.tagName === 'INPUT' || t?.isContentEditable;
    const onDown = e => { if (e.code === 'Space' && !editable(e.target)) spaceRef.current = true; };
    const onUp = e => { if (e.code === 'Space') spaceRef.current = false; };
    window.addEventListener('keydown', onDown, true);
    window.addEventListener('keyup', onUp, true);
    return () => {
      window.removeEventListener('keydown', onDown, true);
      window.removeEventListener('keyup', onUp, true);
    };
  }, []);

  // ---- 文字编辑：开一块与画布同倍率的 textarea，击键直写文档 ----
  const openTextEditor = useCallback(element => {
    setSelectedId(element.id);
    setTextEdit({ id: element.id, fontSize: element.fontSize || 20 });
  }, []);

  const closeTextEditor = useCallback(() => {
    const edit = textEdit;
    if (!edit) return;
    setTextEdit(null);
    store.endCoalescing();
    const el = store.get().drawing.find(item => item.id === edit.id);
    if (el && !String(el.text || '').trim()) {
      mutateDrawing(els => deleteDrawingElement(els, edit.id), { history: false });
      setSelectedId(null);
    }
  }, [textEdit, store, mutateDrawing]);

  // ---- 主手势：落笔即元素，拖画即 mutate（coalesce 一笔一步），收笔定稿 ----
  const onPointerDown = useCallback(e => {
    if (!e.isPrimary || e.button !== 0 || spaceRef.current) return;
    const active = toolRef.current;
    const p = flowPoint(e);
    if (!p) return;
    if (textEdit) closeTextEditor();

    if (active === 'select') {
      const hit = hitAt(p.x, p.y, 'all', true);
      setSelectedId(hit?.id || null);
      if (hit) {
        gestureRef.current = { kind: 'move', id: hit.id, lastFx: p.x, lastFy: p.y, moved: false };
        e.currentTarget.setPointerCapture?.(e.pointerId);
      }
      return;
    }
    if (active === 'text') {
      const element = createInkElement('text', p.x, p.y, { ...style, fontSize: 20 });
      mutateDrawing(els => upsertInkElement(els, element), { coalesce: `ink:${element.id}` });
      openTextEditor(element);
      return;
    }
    const element = createInkElement(active, p.x, p.y, style);
    gestureRef.current = { kind: 'draw', id: element.id, element, moved: false };
    mutateDrawing(els => upsertInkElement(els, element), { coalesce: `ink:${element.id}` });
    e.currentTarget.setPointerCapture?.(e.pointerId);
  }, [flowPoint, hitAt, style, textEdit, closeTextEditor, mutateDrawing, openTextEditor]);

  const onPointerMove = useCallback(e => {
    const gesture = gestureRef.current;
    if (!gesture) return;
    const p = flowPoint(e);
    if (!p) return;
    if (gesture.kind === 'move') {
      const dx = p.x - gesture.lastFx, dy = p.y - gesture.lastFy;
      if (!dx && !dy) return;
      gesture.lastFx = p.x; gesture.lastFy = p.y; gesture.moved = true;
      mutateDrawing(els => translateDrawingElements(els, [gesture.id], dx, dy), { coalesce: `ink-move:${gesture.id}` });
      return;
    }
    const updated = updateInkElementDrag(gesture.element, p.x, p.y);
    if (updated === gesture.element) return;
    gesture.element = updated;
    gesture.moved = true;
    mutateDrawing(els => upsertInkElement(els, updated), { coalesce: `ink:${gesture.id}` });
  }, [flowPoint, mutateDrawing]);

  const onPointerUp = useCallback(() => {
    const gesture = gestureRef.current;
    gestureRef.current = null;
    if (!gesture) return;
    store.endCoalescing();
    if (gesture.kind === 'move') return;
    const { element, discard } = finishInkElement(gesture.element);
    if (discard) {
      mutateDrawing(els => deleteDrawingElement(els, element.id), { history: false });
      return;
    }
    let sunk = false;
    mutateDrawing(els => {
      let next = upsertInkElement(els, element);
      if (isLargeFilledDrawingElement(element)) {   // 大块实心底板自动沉层，不挡卡片点击
        next = setDrawingElementPlane(next, element.id, true);
        sunk = true;
      }
      return next;
    }, { coalesce: `ink:${element.id}` });
    store.endCoalescing();
    if (sunk) {
      toast('大块底板已自动沉到卡片下面', 'ok', {
        label: '撤销',
        onClick: () => mutateDrawing(els => setDrawingElementPlane(els, element.id, false)),
      });
    }
  }, [store, mutateDrawing]);

  // ---- armed 期间滚轮：直接改 RF 相机（触控板平移/捏合与鼠标缩放同一套数学），单相机无冻结 ----
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

  // ---- 键盘：Esc 收工具/取消选中；Delete 删选中（文字编辑中不劫持） ----
  useEffect(() => {
    if (tool === 'none') return;
    const onKey = e => {
      const t = e.target;
      if (t.tagName === 'TEXTAREA' || t.tagName === 'INPUT' || t.isContentEditable) return;
      if (e.key === 'Escape') {
        if (textEdit) { closeTextEditor(); return; }
        if (selectedId) { setSelectedId(null); return; }
        setTool('none');
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) {
        e.preventDefault();
        mutateDrawing(els => deleteDrawingElement(els, selectedId));
        setSelectedId(null);
        toast('绘图已删除', 'ok', { label: '撤销', onClick: () => store.undo() });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tool, selectedId, textEdit, closeTextEditor, mutateDrawing, setTool, store]);

  // ---- 双击文字进入编辑（select 模式）----
  const onDoubleClick = useCallback(e => {
    if (toolRef.current !== 'select') return;
    const p = flowPoint(e);
    const hit = p && hitAt(p.x, p.y, 'all', true);
    if (hit?.type === 'text') openTextEditor(hit);
  }, [flowPoint, hitAt, openTextEditor]);

  // ---- 覆盖层与就地文字编辑器 ----
  const editingEl = textEdit ? store.get().drawing.find(el => el.id === textEdit.id) : null;
  const vp = textEdit ? instRef.current?.getViewport() : null;
  const overlay = tool !== 'none' ? (
    <>
      <div
        className={`ink-input-layer${tool === 'select' ? ' ink-tool-select' : ''}`}
        style={spaceRef.current ? { pointerEvents: 'none' } : undefined}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
        onDoubleClick={onDoubleClick}
      />
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

  // ---- 样式岛：armed 或选中时在场；改样式=改默认 + 改选中元素 ----
  const applyStyle = patch => {
    setStyle(s => ({ ...s, ...patch }));
    if (selectedId) {
      mutateDrawing(els => els.map(el => el.id === selectedId ? { ...el, ...patch } : el));
    }
  };
  const selectedEl = selectedId ? store.get().drawing.find(el => el.id === selectedId) : null;
  const shown = selectedEl || style;
  const styleIsland = (tool !== 'none' && tool !== 'select') || selectedEl ? (
    <div className="island ink-style-island" data-ink-style-island="true">
      {INK_COLORS.map(c => (
        <span key={c} className={`swatch${shown.strokeColor === c ? ' on' : ''}`}
          style={{ background: c }} title="描边颜色"
          onClick={() => applyStyle({ strokeColor: c })} />
      ))}
      <span style={{ width: 1, height: 18, background: 'var(--line)' }} />
      {INK_FILLS.map(f => (
        <span key={f} className={`swatch${(shown.backgroundColor || 'transparent') === f ? ' on' : ''}`}
          style={f === 'transparent'
            ? { background: '#fff', backgroundImage: 'linear-gradient(45deg, transparent 46%, #d92d20 46%, #d92d20 54%, transparent 54%)' }
            : { background: f }}
          title={f === 'transparent' ? '无填充' : '填充颜色'}
          onClick={() => applyStyle({ backgroundColor: f })} />
      ))}
      <span style={{ width: 1, height: 18, background: 'var(--line)' }} />
      {INK_WIDTHS.map(w => (
        <button key={w} type="button" className={`wbtn${(shown.strokeWidth || 2.5) === w ? ' on' : ''}`}
          title={`线宽 ${w}`} onClick={() => applyStyle({ strokeWidth: w })}>
          <span style={{ width: 14, height: w, borderRadius: 2, background: '#344054' }} />
        </button>
      ))}
      {selectedEl && (
        <>
          <span style={{ width: 1, height: 18, background: 'var(--line)' }} />
          <button type="button" className="wbtn" title={selectedEl.customData?.below ? '浮到卡片上面' : '沉到卡片下面'}
            onClick={() => mutateDrawing(els => setDrawingElementPlane(els, selectedEl.id, !selectedEl.customData?.below))}>
            <Icon name={selectedEl.customData?.below ? 'up' : 'down'} size={12} />
          </button>
          <button type="button" className="wbtn" title="删除（Delete）"
            onClick={() => {
              mutateDrawing(els => deleteDrawingElement(els, selectedEl.id));
              setSelectedId(null);
              toast('绘图已删除', 'ok', { label: '撤销', onClick: () => store.undo() });
            }}>
            <Icon name="trash" size={12} />
          </button>
        </>
      )}
    </div>
  ) : null;

  return {
    tool, setTool, selectedId, setSelectedId, overlay, styleIsland,
    toolButtons: DRAW_TOOLS,
    editingText: !!textEdit,
    openTextEditor,
  };
}
