/**
 * [INPUT]: 依赖 @excalidraw/excalidraw 组件/样式/exportToCanvas、api 的 setDrawing、drawing 的快照/分流/包围盒/命中内核
 * [OUTPUT]: 对外提供 DrawLayer 组件（ref 暴露 pushViewport/getViewport/activateTool/getElements/selectElement/
 *           deleteElement/setElementPlane/flush）——双平面绘图：沉层(customData.below)静态垫在卡片之下，浮层批注在上；
 *           相机主权唯一：pushViewport 领先沿同步喂浮沉两层，rAF 只做风暴合并阀
 * [POS]: canvas 的 Excalidraw 绘图覆盖层——闲置时浮层展示指针穿透、沉层经 belowHost 门户垫底；
 *        激活后全量合流进活实例编辑，退出再分流。坐标契约: excalidraw.scroll = rfViewport.xy / zoom
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import React, { forwardRef, useImperativeHandle, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Excalidraw, exportToCanvas } from '@excalidraw/excalidraw';
import '@excalidraw/excalidraw/index.css';
import { api } from '../api.js';
import { drawingBounds, drawingFilesSignature, drawingSnapshot, hitDrawingElement, splitDrawingPlanes } from './drawing.js';

const EXPORT_CAP = 4096;   // 沉层静态画布最长边像素帽：巨型区域底板降采样导出，内存不许爆

export default forwardRef(function DrawLayer({ active, initialElements, initialFiles, belowHost, onScrollToFlow, onToolChange, onReady, onPersisted, onExitToCanvas }, ref) {
  const apiRef = useRef(null);
  const wrapRef = useRef(null);
  const belowWrapRef = useRef(null);                  // 沉层门户内衬：绝对定位 + transform 钉在 flow 坐标
  const belowRef = useRef([]);                        // 闲置时的沉层元素（激活时清空——全量都在活实例里）
  const belowMetaRef = useRef(null);                  // { bounds, scale } 供视口桥定位
  const timer = useRef(null);
  const raf = useRef(0);
  const pendingVp = useRef(null);                     // 每帧合并推送的目标视口
  const exportN = useRef(0);                          // 导出竞态票号：慢返的旧导出不许覆盖新的
  const lastPushed = useRef({ x: 0, y: 0, z: 1 });    // 回声守卫：程序写入不触发反向同步
  const lastVp = useRef(null);
  const downRef = useRef(null);                       // 空点退场：pointerdown 快照
  const hydratedRef = useRef(false);                  // initialData 水合旗：API 就绪时场景可能还是空的
  const activeRef = useRef(active);
  activeRef.current = active;
  const latestFiles = useRef(initialFiles || {});
  const savedFileSig = useRef(drawingFilesSignature(initialFiles));

  // ---- 全量场景 = 沉层 + 活实例：闲置时二分，激活时活实例即全量 ----
  const fullScene = () => [...belowRef.current, ...(apiRef.current?.getSceneElements() || [])];

  // ---- 沉层静态导出：只在场景变化时发生，平移缩放全程零重绘 ----
  const positionBelow = vp => {
    const el = belowWrapRef.current, meta = belowMetaRef.current;
    if (!el) return;
    if (!meta || !vp) { el.style.display = 'none'; return; }
    el.style.display = activeRef.current ? 'none' : 'block';   // 编辑态全量在活实例里，垫底画布休眠
    el.style.transform = `translate(${vp.x + meta.bounds.minX * vp.zoom}px, ${vp.y + meta.bounds.minY * vp.zoom}px) scale(${vp.zoom / meta.scale})`;
  };

  const exportBelow = () => {
    const ticket = ++exportN.current;
    const els = belowRef.current;
    const host = belowWrapRef.current;
    if (!els.length || !host) {
      belowMetaRef.current = null;
      if (host) host.replaceChildren();
      positionBelow(lastVp.current);
      return;
    }
    const bounds = drawingBounds(els);
    // retina 锐度：导出按 dpr 栅格化（帽内），同一支笔沉下去不许发虚
    const scale = Math.min(window.devicePixelRatio || 1, EXPORT_CAP / Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, 1));
    exportToCanvas({
      elements: els,
      files: latestFiles.current,
      exportPadding: 0,
      appState: { viewBackgroundColor: 'transparent' },
      getDimensions: (w, h) => ({ width: Math.ceil(w * scale), height: Math.ceil(h * scale), scale }),
    }).then(canvas => {
      if (ticket !== exportN.current || !belowWrapRef.current) return;
      belowMetaRef.current = { bounds, scale };
      belowWrapRef.current.replaceChildren(canvas);
      positionBelow(lastVp.current);
    }).catch(() => { /* 导出失败只影响垫底展示，编辑态数据无恙 */ });
  };

  // ---- 合流/分流：active 翻转即平面生命周期 ----
  const syncPlanes = () => {
    const inst = apiRef.current;
    if (!inst) return;
    if (activeRef.current) {
      if (belowRef.current.length) {
        inst.updateScene({ elements: [...belowRef.current, ...inst.getSceneElements()] });
        belowRef.current = [];
      }
    } else {
      const { below, above } = splitDrawingPlanes(inst.getSceneElements());
      if (below.length) {
        belowRef.current = [...belowRef.current, ...below];
        inst.updateScene({ elements: above });
      }
      // 一个模式一个主权：退出编辑清掉 Excalidraw 选中——旧选中残留会让下次进门的 Delete 误杀
      inst.updateScene({ appState: { selectedElementIds: {} } });
    }
    exportBelow();
  };
  useEffect(() => { syncPlanes(); }, [active]);

  // 图片资产仅在 ID 集变化时随请求发送；普通笔画只传轻量元素，避免反复上传大图。
  // 永远持久化全量（沉层+浮层）；成功后经 onPersisted 回写 App 状态。
  const persist = () => {
    const snapshot = drawingSnapshot(fullScene(), apiRef.current?.getFiles?.() || latestFiles.current);
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

  // ============================================================
  //  相机主权唯一：视口值一次采样、同一相位、同步喂给浮沉两层——
  //  谁私藏第二份位置真相，谁就是下一个残影（CSS 桥双表征已废）。
  //  领先沿同步直喂（onMove 本身在帧相位内，rAF 推迟反欠一帧）；
  //  rAF 只做风暴合并阀：同帧多余事件合并到帧门开启时补喂。
  // ============================================================
  const applyVp = v => {
    lastPushed.current = { x: v.x / v.zoom, y: v.y / v.zoom, z: v.zoom };
    apiRef.current?.updateScene({
      appState: { scrollX: v.x / v.zoom, scrollY: v.y / v.zoom, zoom: { value: v.zoom } },
    });
    positionBelow(v);
  };
  const pushViewport = vp => {
    lastVp.current = vp;
    if (raf.current) { pendingVp.current = vp; return; }   // 本帧已喂过：存起来等帧门
    applyVp(vp);
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      const p = pendingVp.current;
      pendingVp.current = null;
      if (p) applyVp(p);
    });
  };

  useImperativeHandle(ref, () => ({
    pushViewport,
    // 退出绘图编辑时读回：用户可能在 Excalidraw 里平移过
    getViewport() {
      const s = apiRef.current?.getAppState();
      if (!s) return null;
      return { x: s.scrollX * s.zoom.value, y: s.scrollY * s.zoom.value, zoom: s.zoom.value };
    },
    activateTool(type) {
      apiRef.current?.setActiveTool({ type });
    },
    // 普通看板模式的命中/删除通路：全量场景（沉层在前，浮层在后——后画者优先天然让浮层赢）
    getElements() {
      return apiRef.current ? fullScene() : null;
    },
    selectElement(id) {
      apiRef.current?.updateScene({ appState: { selectedElementIds: { [id]: true } } });
    },
    deleteElement(id) {
      const inst = apiRef.current;
      if (!inst) return Promise.reject(new Error('绘图层未就绪'));
      // 连带删除绑定在此形状上的标签文字，不留幽灵文本；沉浮两层各删各的
      const keep = e => e.id !== id && e.containerId !== id;
      if (belowRef.current.some(e => !keep(e))) {
        belowRef.current = belowRef.current.filter(keep);
        exportBelow();
      } else {
        inst.updateScene({ elements: inst.getSceneElements().filter(keep) });
      }
      clearTimeout(timer.current);
      timer.current = null;
      return persist();   // 删除是主权动作，不等防抖，立即落盘；回执由调用方跟结果走
    },
    // 沉浮切换：区域底板沉到卡片下面当背景，批注浮到上面——层级从此可调
    setElementPlane(id, below) {
      const inst = apiRef.current;
      if (!inst) return Promise.reject(new Error('绘图层未就绪'));
      const flip = e => (e.id === id || e.containerId === id)
        ? { ...e, customData: { ...e.customData, below } } : e;
      const full = fullScene().map(flip);
      const { below: b, above: a } = splitDrawingPlanes(full);
      belowRef.current = activeRef.current ? [] : b;
      inst.updateScene({ elements: activeRef.current ? full : a });
      exportBelow();
      clearTimeout(timer.current);
      timer.current = null;
      return persist();
    },
    flush() {
      clearTimeout(timer.current);
      timer.current = null;
      persist().catch(() => {});
    },
  }), []);

  // ---- 空点退场：选择工具下点击空白（未命中任何笔迹、无既有选中、非框选拖动）→ 放行回看板 ----
  const onDown = e => {
    if (!activeRef.current) return;
    const s = apiRef.current?.getAppState();
    downRef.current = {
      x: e.clientX, y: e.clientY,
      tool: s?.activeTool?.type,
      hadSel: Object.values(s?.selectedElementIds || {}).some(Boolean),
    };
  };
  const onUp = e => {
    const d = downRef.current;
    downRef.current = null;
    if (!activeRef.current || !d || d.tool !== 'selection' || d.hadSel) return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5) return;   // 框选拖动不是点击
    const s = apiRef.current?.getAppState();
    if (!s) return;
    const z = s.zoom.value;
    const fx = e.clientX / z - s.scrollX, fy = e.clientY / z - s.scrollY;
    if (hitDrawingElement(fullScene(), fx, fy, 8 / z)) return;      // 点在笔迹上：归 Excalidraw
    onExitToCanvas?.({ x: e.clientX, y: e.clientY });
  };

  return (
    <>
      {belowHost && createPortal(
        <div ref={el => { belowWrapRef.current = el; if (el) exportBelow(); }}
          style={{ position: 'absolute', left: 0, top: 0, transformOrigin: '0 0', pointerEvents: 'none' }} />,
        belowHost,
      )}
      <div ref={wrapRef} className={`draw-layer ${active ? 'draw-active' : ''}`}
        onPointerDownCapture={onDown} onPointerUpCapture={onUp}
        style={{
          position: 'absolute', inset: 0, zIndex: 6,
          transformOrigin: '0 0',
          pointerEvents: active ? 'auto' : 'none',   // 绘图编辑未激活：只展示，指针全穿透
        }}>
        <Excalidraw
          excalidrawAPI={a => { apiRef.current = a; syncPlanes(); onReady?.(); }}
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
            // 水合完成的第一声 onChange 再分流一次——excalidrawAPI 回调时 initialData 往往尚未落场
            if (!hydratedRef.current && (apiRef.current?.getSceneElements()?.length || 0) > 0) {
              hydratedRef.current = true;
              if (!activeRef.current) syncPlanes();
            }
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
    </>
  );
});
