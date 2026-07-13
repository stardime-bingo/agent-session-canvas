/**
 * [INPUT]: 依赖 @excalidraw/excalidraw 组件与样式、api 的 setDrawing
 * [OUTPUT]: 对外提供 DrawLayer 组件（ref 暴露 syncViewport/getViewport/flush）
 * [POS]: canvas 的 Excalidraw 绘图覆盖层——非绘图模式下指针穿透只作展示，
 *        坐标契约: excalidraw.scroll = rfViewport.xy / zoom，画的东西钉在画布坐标系上
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import React, { forwardRef, useImperativeHandle, useRef, useEffect } from 'react';
import { Excalidraw } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import { api } from '../api.js';

export default forwardRef(function DrawLayer({ active, initialElements, onScrollToFlow, onReady }, ref) {
  const apiRef = useRef(null);
  const wrapRef = useRef(null);
  const timer = useRef(null);
  const raf = useRef(0);
  const lastPushed = useRef({ x: 0, y: 0, z: 1 });   // 回声守卫：程序写入不触发反向同步
  const base = useRef(null);                          // 已落定的看板视口——CSS 桥的锚点

  // ---- 防抖落盘：停笔 800ms 才写后端，卸载前冲刷 ----
  const save = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      const els = apiRef.current?.getSceneElements() || [];
      api.setDrawing(els).catch(() => {});
    }, 800);
  };

  // 卸载前冲刷：关标签页/懒卸载时最后一笔不许丢
  useEffect(() => () => {
    clearTimeout(timer.current);
    cancelAnimationFrame(raf.current);
    const els = apiRef.current?.getSceneElements();
    if (els?.length) api.setDrawing(els).catch(() => {});
  }, []);

  useImperativeHandle(ref, () => ({
    // 落定：真正把视口写进 Excalidraw（重绘一次），并复位 CSS 桥
    syncViewport(vp) {
      cancelAnimationFrame(raf.current);
      raf.current = requestAnimationFrame(() => {
        base.current = vp;
        if (wrapRef.current) wrapRef.current.style.transform = 'none';
        lastPushed.current = { x: vp.x / vp.zoom, y: vp.y / vp.zoom, z: vp.zoom };
        apiRef.current?.updateScene({
          appState: { scrollX: vp.x / vp.zoom, scrollY: vp.y / vp.zoom, zoom: { value: vp.zoom } },
        });
      });
    },

    // 预览：平移/缩放进行中只动 CSS transform——纯合成器，零 Excalidraw 重绘
    previewViewport(vp) {
      const b = base.current;
      if (!b || !wrapRef.current) return;
      const s = vp.zoom / b.zoom;
      wrapRef.current.style.transform = `translate(${vp.x - b.x * s}px, ${vp.y - b.y * s}px) scale(${s})`;
    },
    // 退出绘图模式时读回：用户可能在 excalidraw 里平移过
    getViewport() {
      const s = apiRef.current?.getAppState();
      if (!s) return null;
      return { x: s.scrollX * s.zoom.value, y: s.scrollY * s.zoom.value, zoom: s.zoom.value };
    },
    flush() {
      clearTimeout(timer.current);
      const els = apiRef.current?.getSceneElements() || [];
      api.setDrawing(els).catch(() => {});
    },
  }), []);

  return (
    <div ref={wrapRef} className={`draw-layer ${active ? 'draw-active' : ''}`} style={{
      position: 'absolute', inset: 0, zIndex: 6,
      transformOrigin: '0 0',
      pointerEvents: active ? 'auto' : 'none',   // 非绘图模式：只展示，指针全穿透
    }}>
      <Excalidraw
        excalidrawAPI={a => { apiRef.current = a; onReady?.(); }}
        langCode="zh-CN"
        initialData={{
          elements: initialElements || [],
          appState: { viewBackgroundColor: 'transparent' },
          scrollToContent: false,
        }}
        onChange={(_, __, files) => { if (active) save(); }}
        onScrollChange={(sx, sy, zoom) => {
          // 绘图模式里平移缩放 → 实时带着底下的看板一起走，笔迹与卡片永不分家
          if (!active) return;
          const z = zoom?.value ?? zoom;
          const lp = lastPushed.current;
          if (Math.abs(sx - lp.x) < 0.5 && Math.abs(sy - lp.y) < 0.5 && Math.abs(z - lp.z) < 0.001) return;
          onScrollToFlow?.({ x: sx * z, y: sy * z, zoom: z });
        }}
        viewModeEnabled={!active}
        zenModeEnabled
        UIOptions={{
          canvasActions: {
            changeViewBackgroundColor: false, export: false, loadScene: false,
            saveToActiveFile: false, saveAsImage: false, toggleTheme: false,
            clearCanvas: false,   // Reset canvas 能一键毁掉全部笔迹，不进屋
          },
          tools: { image: false },   // 图片尚未持久化(files 不落盘)，先关闸防丢
        }}
      />
    </div>
  );
});
