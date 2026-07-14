/**
 * [INPUT]: 依赖 @excalidraw/excalidraw 组件与样式、api 的 setDrawing、drawing 的图片资产裁剪
 * [OUTPUT]: 对外提供 DrawLayer 组件（ref 暴露 syncViewport/getViewport/activateTool/getElements/selectElement/deleteElement/flush）
 * [POS]: canvas 的 Excalidraw 绘图覆盖层——编辑未激活时指针穿透只作展示；激活后保留原生选择与属性面板，
 *        坐标契约: excalidraw.scroll = rfViewport.xy / zoom，画的东西钉在画布坐标系上
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import React, { forwardRef, useImperativeHandle, useRef, useEffect } from 'react';
import { Excalidraw } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import { api } from '../api.js';
import { drawingFilesSignature, drawingSnapshot } from './drawing.js';

export default forwardRef(function DrawLayer({ active, initialElements, initialFiles, onScrollToFlow, onToolChange, onReady, onPersisted }, ref) {
  const apiRef = useRef(null);
  const wrapRef = useRef(null);
  const timer = useRef(null);
  const raf = useRef(0);
  const lastPushed = useRef({ x: 0, y: 0, z: 1 });   // 回声守卫：程序写入不触发反向同步
  const base = useRef(null);                          // 已落定的看板视口——CSS 桥的锚点
  const latestFiles = useRef(initialFiles || {});
  const savedFileSig = useRef(drawingFilesSignature(initialFiles));

  // 图片资产仅在 ID 集变化时随请求发送；普通笔画只传轻量元素，避免反复上传大图。
  // 返回 Promise 且不吞错：删除等主权动作的回执必须跟真实落盘结果走；
  // 成功后经 onPersisted 回写 App 状态——首笔退出画笔时挂载条件不再拿陈旧空数组说事。
  const persist = () => {
    const elements = apiRef.current?.getSceneElements() || [];
    const snapshot = drawingSnapshot(elements, apiRef.current?.getFiles?.() || latestFiles.current);
    const fileSig = drawingFilesSignature(snapshot.files);
    const files = fileSig === savedFileSig.current ? undefined : snapshot.files;
    return api.setDrawing(snapshot.elements, files).then(() => {
      if (files !== undefined) savedFileSig.current = fileSig;
      onPersisted?.(snapshot.elements);
    });
  };

  // ---- 防抖落盘：停笔 800ms 才写后端，卸载前冲刷（后台路径静默，主权路径各自跟回执） ----
  const save = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { timer.current = null; persist().catch(() => {}); }, 800);
  };

  // 卸载前冲刷：懒卸载时最后一笔不许丢
  useEffect(() => () => {
    clearTimeout(timer.current);
    cancelAnimationFrame(raf.current);
    if (apiRef.current) persist().catch(() => {});
  }, []);

  // 关标签页/刷新落在防抖窗口内：尽力同步冲刷，删除/笔迹不许静默丢失
  useEffect(() => {
    const onHide = () => {
      if (!timer.current) return;
      clearTimeout(timer.current);
      timer.current = null;
      persist().catch(() => {});
    };
    window.addEventListener('pagehide', onHide);
    return () => window.removeEventListener('pagehide', onHide);
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
    // 退出绘图编辑时读回：用户可能在 Excalidraw 里平移过
    getViewport() {
      const s = apiRef.current?.getAppState();
      if (!s) return null;
      return { x: s.scrollX * s.zoom.value, y: s.scrollY * s.zoom.value, zoom: s.zoom.value };
    },
    activateTool(type) {
      apiRef.current?.setActiveTool({ type });
    },
    // 普通看板模式的删除通路由这三个口进来：读活元素、程序化选中、直删单个元素
    getElements() {
      return apiRef.current?.getSceneElements() || null;
    },
    selectElement(id) {
      apiRef.current?.updateScene({ appState: { selectedElementIds: { [id]: true } } });
    },
    deleteElement(id) {
      const inst = apiRef.current;
      if (!inst) return Promise.reject(new Error('绘图层未就绪'));
      // 连带删除绑定在此形状上的标签文字，不留幽灵文本
      inst.updateScene({ elements: inst.getSceneElements().filter(e => e.id !== id && e.containerId !== id) });
      clearTimeout(timer.current);
      timer.current = null;
      return persist();   // 删除是主权动作，不等防抖，立即落盘；回执由调用方跟结果走
    },
    flush() {
      clearTimeout(timer.current);
      timer.current = null;
      persist().catch(() => {});
    },
  }), []);

  return (
    <div ref={wrapRef} className={`draw-layer ${active ? 'draw-active' : ''}`} style={{
      position: 'absolute', inset: 0, zIndex: 6,
      transformOrigin: '0 0',
      pointerEvents: active ? 'auto' : 'none',   // 绘图编辑未激活：只展示，指针全穿透
    }}>
      <Excalidraw
        excalidrawAPI={a => { apiRef.current = a; onReady?.(); }}
        langCode="zh-CN"
        initialData={{
          elements: initialElements || [],
          files: initialFiles || {},
          appState: { viewBackgroundColor: 'transparent' },
          scrollToContent: false,
        }}
        onChange={(_, appState, files) => {
          latestFiles.current = files || {};
          onToolChange?.(appState?.activeTool?.type);
          if (active) save();
        }}
        onScrollChange={(sx, sy, zoom) => {
          // 绘图编辑时平移缩放 → 实时带着底下的看板一起走，笔迹与卡片永不分家
          if (!active) return;
          const z = zoom?.value ?? zoom;
          const lp = lastPushed.current;
          if (Math.abs(sx - lp.x) < 0.5 && Math.abs(sy - lp.y) < 0.5 && Math.abs(z - lp.z) < 0.001) return;
          onScrollToFlow?.({ x: sx * z, y: sy * z, zoom: z });
        }}
        viewModeEnabled={!active}
        UIOptions={{
          canvasActions: {
            changeViewBackgroundColor: false, export: false, loadScene: false,
            saveToActiveFile: false, saveAsImage: false, toggleTheme: false,
            clearCanvas: false,   // Reset canvas 能一键毁掉全部笔迹，不进屋
          },
          tools: { image: true },
        }}
      />
    </div>
  );
});
