/**
 * [INPUT]: 依赖 api 的数据通道、scene-store 的场景真相源、canvas/FlowCanvas 画布、panels 三件套、ui 的 UIHost/toast
 * [OUTPUT]: 对外提供 App 根组件：全局状态、过滤管道、SSE 订阅（地形举旗 + 场景回声采纳）、
 *           岛屿布局、对象动作分发（全部同步 mutate）、整理与全画布 undo、画布终端框开合
 * [POS]: web 的总装线——数据如河流单向流动：地形 graph + 场景 doc → 过滤 → 画布/面板；
 *        一切写动作同步进 store，磁盘由 store 后台冲刷，交互路径零等待
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { api, subscribeEvents, WRITER_ID } from './api.js';
import { createSceneStore } from './scene-store.js';
import FlowCanvas from './canvas/FlowCanvas.jsx';
import { tidyLayoutEntries } from './canvas/layout.js';
import TopBar from './panels/TopBar.jsx';
import Sidebar from './panels/Sidebar.jsx';
import DetailPanel from './panels/DetailPanel.jsx';
import ContextFrame from './panels/ContextFrame.jsx';
import { UIHost, toast, Icon } from './ui.jsx';

const RANGE_MS = { '7d': 7 * 864e5, '30d': 30 * 864e5, all: Infinity };
const DEFAULT_FILTERS = () => ({
  q: '', range: '30d',                                // 铁律：历史不管，默认只看近 30 天
  tools: new Set(['claude', 'codex']),
  statuses: new Set(['active', 'dead', 'stale']),     // 空壳与归档默认不看
});
const layoutFromEntries = entries => Object.fromEntries(entries.map(({ path, ...entry }) => [path, entry]));

// 布局条目字段合并：x/y/d/w/h 只更新送来的（w/h 支撑容器手动调尺寸）
const pickLayout = (src, prev) => {
  const out = { ...prev };
  for (const k of ['x', 'y', 'd', 'w', 'h']) if (src[k] !== undefined) out[k] = src[k];
  return out;
};

// 落空连线：对象与手动边同一次 mutate，同生同灭
function nodeFromEdge(doc, body, now = Date.now()) {
  const x = Math.round(Number(body.x) || 0);
  const y = Math.round(Number(body.y) || 0);
  const node = body.kind === 'note'
    ? { id: `note:${now}`, x, y: y - 40, text: '', color: 'yellow' }
    : { id: `${now}`, x, y: y - 30, w: 520, h: 360, name: '新画板', color: 'blue' };
  const target = body.kind === 'note' ? node.id : `board:${node.id}`;
  return {
    ...doc,
    notes: body.kind === 'note' ? [...doc.notes, node] : doc.notes,
    boards: body.kind === 'board' ? [...doc.boards, node] : doc.boards,
    edges: [...doc.edges, { id: `manual:${now}`, from: body.from, to: target }],
  };
}

export default function App() {
  const [graph, setGraph] = useState(null);            // 地形：sessions/workspaces/系统边/stats
  const [live, setLive] = useState(false);
  const [pending, setPending] = useState(false);       // 有新活动但不打断用户：举旗，不抢方向盘
  const [selectedKey, setSelectedKey] = useState(null);
  const [ctxFrame, setCtxFrame] = useState(null);      // 画布终端框 {key, x, y}
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [expandedWs, setExpandedWs] = useState(() => new Set());   // 会话级展开记忆，刷新即收
  const focusRef = useRef(() => {});
  const actionsRef = useRef({});

  // ---- 场景真相源：首次 graph 到达即诞生（随 setGraph 同帧可见），此后一切画布写动作同步进它 ----
  const storeRef = useRef(null);
  const adoptScene = useCallback(g => {
    const sceneDoc = {
      layout: g.layout || {},
      edges: g.canvas?.edges || [],
      notes: g.canvas?.notes || [],
      boards: g.canvas?.boards || [],
      drawing: g.canvas?.drawing || [],
      drawingFiles: g.canvas?.drawingFiles || {},
    };
    if (!storeRef.current) {
      storeRef.current = createSceneStore(sceneDoc, {
        persistScene: scene => api.putScene(scene),
        persistFiles: files => api.putDrawingFiles(files),
      });
    } else {
      storeRef.current.adoptRemote(sceneDoc);   // 本地有脏改动时静默保留本地（LWW）
    }
  }, []);
  const store = storeRef.current;

  const reload = useCallback(() => api.graph().then(g => {
    adoptScene(g);
    setGraph(g);
    setLive(true);
    setPending(false);
  }), [adoptScene]);

  // ---- 双侧边栏：宽度可拖、可收回，记进 localStorage ----
  const [leftW, setLeftW] = useState(+localStorage.leftW || 250);
  const [rightW, setRightW] = useState(+localStorage.rightW || 400);
  const [leftOpen, setLeftOpen] = useState(localStorage.leftOpen !== '0');
  const [rightOpen, setRightOpen] = useState(true);
  useEffect(() => { localStorage.leftW = leftW; localStorage.rightW = rightW; localStorage.leftOpen = leftOpen ? '1' : '0'; }, [leftW, rightW, leftOpen]);

  // Pointer Capture：鼠标飞出窗口松手也不丢 up 事件，面板不会回窗后跟手乱飞
  const startResize = (side, e) => {
    e.preventDefault();
    const strip = e.currentTarget;
    strip.setPointerCapture?.(e.pointerId);
    const startX = e.clientX, startW = side === 'left' ? leftW : rightW;
    const move = ev => {
      const dx = ev.clientX - startX;
      if (side === 'left') setLeftW(Math.min(440, Math.max(150, startW + dx)));
      else setRightW(Math.min(680, Math.max(300, startW - dx)));
    };
    const up = () => {
      strip.releasePointerCapture?.(e.pointerId);
      strip.removeEventListener('pointermove', move);
      strip.removeEventListener('pointerup', up);
    };
    strip.addEventListener('pointermove', move);
    strip.addEventListener('pointerup', up);
  };

  // ---- 整理：production buildGraph 同步规划（FlowCanvas 暴露），一次 mutate 落定，撤销走全局 undo ----
  const arrange = useCallback(async () => {
    const prepared = await actionsRef.current.prepareGeometry?.();   // 绘图激活时先收笔
    if (prepared === false) return;
    const doc = storeRef.current.get();
    const targetLayout = layoutFromEntries(tidyLayoutEntries(structuredClone(doc.layout)));
    const applied = actionsRef.current.applyArrange?.(targetLayout);
    if (!applied) return toast('整理失败：画布尚未就绪', 'error');
    focusRef.current(null);
    toast('已整理位置，人工归属保持不变', 'ok', { label: '撤销', onClick: () => storeRef.current.undo() });
  }, []);

  // ---- 对象动作分发：全部同步 mutate，磁盘由 store 后台冲刷 ----
  const handleCanvas = useCallback((action, payload) => {
    if (action === 'openContext') return setCtxFrame(payload);   // 纯视图动作：画布就地弹终端框
    const store = storeRef.current;
    if (!store) return false;
    if (action === 'addEdge') {
      store.mutate(doc => {
        const dup = doc.edges.find(e =>
          (e.from === payload.from && e.to === payload.to) || (e.from === payload.to && e.to === payload.from));
        if (dup) return doc;
        return { ...doc, edges: [...doc.edges, { id: `manual:${Date.now()}`, from: payload.from, to: payload.to }] };
      });
    } else if (action === 'delEdge') {
      store.mutate(doc => ({ ...doc, edges: doc.edges.filter(e => e.id !== payload) }));
    } else if (action === 'setNote') {
      // 补丁式合并：拖动/打字/换色各发各的字段，不互相覆盖；打字流合并为一步 undo
      store.mutate(doc => {
        const i = doc.notes.findIndex(n => n.id === payload.id);
        if (i >= 0) {
          const patch = {};
          for (const k of ['x', 'y', 'text', 'color', 'w', 'h']) if (payload[k] !== undefined) patch[k] = payload[k];
          const notes = [...doc.notes];
          notes[i] = { ...notes[i], ...patch };
          return { ...doc, notes };
        }
        return { ...doc, notes: [...doc.notes, { id: payload.id || `note:${Date.now()}`, x: 0, y: 0, text: '', color: 'yellow', ...payload }] };
      }, payload.text !== undefined ? { coalesce: `note-text:${payload.id}` } : {});
    } else if (action === 'delNote') {
      store.mutate(doc => ({ ...doc, notes: doc.notes.filter(n => n.id !== payload) }));
    } else if (action === 'setBoard') {
      store.mutate(doc => {
        const i = doc.boards.findIndex(b => b.id === payload.id);
        if (i >= 0) {
          const patch = {};
          for (const k of ['x', 'y', 'w', 'h', 'name', 'color']) if (payload[k] !== undefined) patch[k] = payload[k];
          const boards = [...doc.boards];
          boards[i] = { ...boards[i], ...patch };
          return { ...doc, boards };
        }
        return { ...doc, boards: [...doc.boards, { id: payload.id || `${Date.now()}`, x: 0, y: 0, w: 520, h: 360, name: '新画板', color: 'blue', ...payload }] };
      });
    } else if (action === 'delBoard') {
      store.mutate(doc => ({ ...doc, boards: doc.boards.filter(b => b.id !== payload) }));
      toast('画板已删除，成员回到原街区');
    } else if (action === 'nodeFromEdge') {
      store.mutate(doc => nodeFromEdge(doc, payload));
    }
    return true;
  }, []);

  useEffect(() => {
    reload();
    return subscribeEvents(evt => {
      if (evt.type === 'graph-updated') setPending(true);          // 地形变化举旗，用户主动刷新才重排
      else if (evt.type === 'scene-updated' && evt.writerId !== WRITER_ID) {
        // 别的标签页写了场景：本地干净才采纳，静默同步不打扰
        api.graph().then(adoptScene).catch(() => {});
      }
    }, up => setLive(up));
  }, [reload, adoptScene]);

  // pagehide 兜底：离开页面前把未冲刷的场景推一把（keepalive 尽力而为，失败由下次会话的重试兜住）
  useEffect(() => {
    const onHide = () => { storeRef.current?.flushNow(); };
    window.addEventListener('pagehide', onHide);
    return () => window.removeEventListener('pagehide', onHide);
  }, []);

  // ---- 快捷键：N 便签 / B 画板 / F 全景 / "/" 搜索 / Esc 关面板 / Cmd+Z 全画布撤销；输入框内不劫持 ----
  useEffect(() => {
    const onKey = e => {
      const t = e.target;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) {
        if (e.key === 'Escape') t.blur();
        return;
      }
      // 绘图编辑激活时快捷键交给 Excalidraw（含它自己的撤销栈）
      if (document.querySelector('.draw-active')) return;
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        const store = storeRef.current;
        if (!store) return;
        const done = e.shiftKey ? store.redo() : store.undo();
        if (!done) toast(e.shiftKey ? '没有可重做的操作' : '没有可撤销的操作');
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'n') actionsRef.current.addNote?.();
      else if (k === 'b') actionsRef.current.addBoard?.();
      else if (k === 'f') actionsRef.current.fit?.();
      else if (k === 'd') actionsRef.current.toggleDraw?.();
      else if (e.key === '/') { e.preventDefault(); document.getElementById('cmd-search')?.focus(); }
      else if (e.key === 'Escape') {
        // 分层退出：菜单/确认层在 capture 阶段已自行拦截，走到这里的只剩面板与选中
        setSelectedKey(null);
        actionsRef.current.clearSelection?.();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ---- 场景文档订阅：store 是外部真相，React 只做镜子 ----
  const doc = useSyncExternalStore(
    useCallback(cb => store ? store.subscribe(cb) : () => {}, [store]),
    useCallback(() => store ? store.get() : null, [store]),
  );
  const syncInfo = doc && store ? store.status() : { status: 'saved' };

  // ============================================================
  //  过滤管道：会话级过滤（工具/状态/时间/搜索）→ 工作区聚合裁剪
  // ============================================================
  const deferredQ = useDeferredValue(filters.q);

  const view = useMemo(() => {
    if (!graph) return null;
    const q = deferredQ.trim().toLowerCase();
    const cutoff = Date.now() - RANGE_MS[filters.range];

    const sessionsByKey = {};
    for (const s of graph.sessions) sessionsByKey[s.key] = s;

    const pass = s =>
      filters.tools.has(s.tool) &&
      filters.statuses.has(s.status) &&
      new Date(s.updatedAt).getTime() > cutoff &&        // 时间过滤裁到会话粒度："7天"里不许混进旧卡
      (!q || s.title.toLowerCase().includes(q) || (s.cwd || '').toLowerCase().includes(q));

    const workspaces = Object.values(graph.workspaces)
      .map(ws => {
        const keys = ws.sessionKeys
          .filter(k => pass(sessionsByKey[k]))
          .sort((a, b) => sessionsByKey[b].updatedAt.localeCompare(sessionsByKey[a].updatedAt));
        return { ...ws, visibleKeys: keys };
      })
      .filter(ws => ws.visibleKeys.length > 0)
      .sort((a, b) => b.lastActivity.localeCompare(a.lastActivity));

    // 边不在此过滤：画布知道哪些节点真实在场，悬空端点由它丢弃
    return { workspaces, sessionsByKey, edges: graph.edges };
  }, [graph, deferredQ, filters.range, filters.tools, filters.statuses]);

  if (!view || !doc) {
    return (
      <div className="mono" style={{ height: '100%', display: 'grid', placeItems: 'center', color: 'var(--ink-faint)' }}>
        正在扫描本地会话地形…
      </div>
    );
  }

  // ============================================================
  //  岛屿律：画布即世界铺满全屏，导航/动作/详情皆为漂浮岛
  // ============================================================
  return (
    <div style={{
      position: 'relative', height: '100%', overflow: 'hidden',
      '--draw-panel-shift': leftOpen ? `${leftW + 12}px` : '0px',
    }}>
      {/* ===== 世界：无限画布满屏铺底 ===== */}
      <div style={{ position: 'absolute', inset: 0 }}>
        <FlowCanvas
          workspaces={view.workspaces}
          sessionsByKey={view.sessionsByKey}
          edges={view.edges}
          layout={doc.layout}
          canvas={doc}
          store={store}
          onCanvasAction={handleCanvas}
          onRenameSession={(key, title) =>
            api.rename(key, title).then(r => { toast(r.synced ? '已重命名并同步回工具本体' : '已重命名（本体热文件，稍后自动同步）'); reload(); })
              .catch(e => toast(`改名失败：${e.message}`, 'error'))}
          onRenameWs={(path, name) =>
            api.wsRename(path, name).then(reload).catch(e => toast(`改名失败：${e.message}`, 'error'))}
          selectedKey={selectedKey}
          actionsRef={actionsRef}
          expanded={expandedWs}
          searching={!!deferredQ.trim()}
          onToggleExpand={path => setExpandedWs(s => {
            const n = new Set(s); n.has(path) ? n.delete(path) : n.add(path); return n;
          })}
          onMoveNode={entries => store.mutate(doc => {
            const layout = { ...doc.layout };
            for (const e of entries) layout[e.path] = pickLayout(e, layout[e.path]);
            return { ...doc, layout };
          })}
          onSelect={k => { setSelectedKey(k); if (k) setRightOpen(true); }}
          onChanged={reload}
          onArrange={arrange}
          focusRef={focusRef}
        />
      </div>

      {/* ===== 空态指路牌：世界被筛空时告诉用户发生了什么 ===== */}
      {view.workspaces.length === 0 && (
        <div className="empty-state island">
          {graph.stats.total === 0 ? (
            <>
              <div className="es-title">未发现任何本地会话</div>
              <div className="es-hint">确认 ~/.claude/projects 或 ~/.codex/sessions 有记录后，点右上 <Icon name="refresh" size={11} /> 重扫</div>
            </>
          ) : (
            <>
              <div className="es-title">没有匹配的会话</div>
              <div className="es-hint">当前搜索词或筛选组合下没有结果（共 {graph.stats.total} 个会话在库）</div>
              <button className="btn primary" onClick={() => setFilters(DEFAULT_FILTERS())}>清除筛选，回到全部</button>
            </>
          )}
        </div>
      )}

      {/* ===== 左：导航岛（品牌/搜索/过滤/清单） ===== */}
      {leftOpen ? (
        <div className="island" style={{
          position: 'absolute', left: 12, top: 12, bottom: 12, width: leftW,
          zIndex: 8, overflow: 'hidden',
        }}>
          <Sidebar
            stats={graph.stats} live={live}
            filters={filters} setFilters={setFilters}
            workspaces={view.workspaces}
            onFocus={p => focusRef.current(p)}
            onCollapse={() => setLeftOpen(false)}
            onRenameWs={(p, name) => api.wsRename(p, name).then(reload).catch(e => toast(`改名失败：${e.message}`, 'error'))}
          />
          <div className="resize-strip" onPointerDown={e => startResize('left', e)} title="拖动调宽"
            style={{ position: 'absolute', right: 0, top: 0, bottom: 0 }} />
        </div>
      ) : (
        <button className="btn island" onClick={() => setLeftOpen(true)} title="展开导航岛"
          style={{ position: 'absolute', left: 12, top: 12, zIndex: 8 }}><Icon name="chevR" /> 指挥塔</button>
      )}

      {/* ===== 右上：动作岛。画笔是并列工具，不再令全局动作退场 ===== */}
      <div style={{
        position: 'absolute', top: 12, zIndex: 8,
        right: (selectedKey && rightOpen) ? rightW + 24 : 12,
        transition: 'right 0.2s var(--ease-panel)',
      }}>
        <TopBar
          pending={pending} onRefresh={reload}
          syncStatus={syncInfo.status}
          onRescan={() => api.rescan().then(() => { reload(); toast('已全量重扫', 'ok'); })}
          onArrange={() => arrange()}
        />
      </div>

      {/* ===== 右：详情岛 ===== */}
      {selectedKey && (rightOpen ? (
        <div className="island" style={{
          position: 'absolute', right: 12, top: 12, bottom: 12, width: rightW,
          zIndex: 8, overflow: 'hidden',
        }}>
          <DetailPanel
            width="100%" sessionKey={selectedKey}
            onClose={() => { setSelectedKey(null); actionsRef.current.clearSelection?.(); }}
            onCollapse={() => setRightOpen(false)}
            onChanged={reload}
          />
          <div className="resize-strip" onPointerDown={e => startResize('right', e)} title="拖动调宽"
            style={{ position: 'absolute', left: 0, top: 0, bottom: 0 }} />
        </div>
      ) : (
        <button className="btn island" onClick={() => setRightOpen(true)} title="展开详情岛"
          style={{ position: 'absolute', right: 12, top: 64, zIndex: 8 }}><Icon name="chevL" /> 详情</button>
      ))}

      {/* ===== 画布终端框：拉线落空/右键就地查看会话完整上下文 ===== */}
      {ctxFrame && (
        <ContextFrame
          frame={ctxFrame}
          onClose={() => setCtxFrame(null)}
          onOpenDetail={key => { setSelectedKey(key); setRightOpen(true); setCtxFrame(null); }}
        />
      )}

      {/* ===== 自绘弹层宿主：toast 与确认层 ===== */}
      <UIHost />
    </div>
  );
}
