/**
 * [INPUT]: 依赖 api 的数据通道、canvas/FlowCanvas 画布、panels 三件套、ui 的 UIHost/toast
 * [OUTPUT]: 对外提供 App 根组件：全局状态、过滤管道、SSE 订阅、岛屿布局（含绘图属性面板动态让位）、
 *           可等待且互斥的整理/单步撤销事务、落空连线原子动作分发、committed 绘图 elements/files 原子回写、画布终端框开合
 * [POS]: web 的总装线——数据如河流单向流动：graph → 过滤 → 画布/面板
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import React, { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { api, subscribeEvents } from './api.js';
import FlowCanvas from './canvas/FlowCanvas.jsx';
import { createDrawingArrangeUndoTicket } from './canvas/drawing.js';
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

export default function App() {
  const [graph, setGraph] = useState(null);
  const [live, setLive] = useState(false);
  const [pending, setPending] = useState(false);   // 有新活动但不打断用户：举旗，不抢方向盘
  const [selectedKey, setSelectedKey] = useState(null);
  const [ctxFrame, setCtxFrame] = useState(null);   // 画布终端框 {key, x, y}
  const [filters, setFilters] = useState(DEFAULT_FILTERS);
  const [expandedWs, setExpandedWs] = useState(() => new Set());   // 会话级展开记忆，刷新即收
  const focusRef = useRef(() => {});
  const actionsRef = useRef({});
  const layoutUndoRef = useRef(null);
  const geometryPendingRef = useRef(false);

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

  const reload = useCallback(() => api.graph().then(g => { setGraph(g); setLive(true); setPending(false); }), []);

  const undoArrange = useCallback(async () => {
    const undo = layoutUndoRef.current;
    if (!undo) {
      toast('已有新的手工调整，不能再撤销上次整理');
      return;
    }
    const prepared = await actionsRef.current.prepareGeometry?.();
    if (prepared === false) return;
    geometryPendingRef.current = true;
    layoutUndoRef.current = null;
    try {
      await api.layoutBatch(Object.entries(undo.snapshot).map(([path, pos]) => ({ path, ...pos })), true);
      // 容器承载律：撤销整理时，跟着容器走过的墨迹按逆差回家
      if (undo.undoMoves?.length) await actionsRef.current.followDrawings?.(undo.undoMoves);
      await reload();
      focusRef.current(null);
      toast('已撤销整理', 'ok');
    } catch (e) {
      layoutUndoRef.current = undo;
      toast(`撤销失败：${e.message}`, 'error');
    } finally {
      geometryPendingRef.current = false;
    }
  }, [reload]);

  // ---- 自动整理只清几何、不清人工归属；原子替换后可由按钮或 Cmd/Ctrl+Z 撤销 ----
  const arrange = useCallback(async () => {
    const prepared = await actionsRef.current.prepareGeometry?.();
    if (prepared === false) return;
    geometryPendingRef.current = true;
    const snapshot = graph?.layout || {};
    const rectsBefore = actionsRef.current.containerRects?.() || {};
    try {
      await api.layoutBatch(tidyLayoutEntries(snapshot), true);
      // 成熟画布的 Cmd+Z 是一次撤一笔：新整理必须覆盖旧票据。
      layoutUndoRef.current = createDrawingArrangeUndoTicket(snapshot);
      await reload();
      focusRef.current(null);
      // 容器承载律：新布局由瀑布算法在渲染时定型——等落定后量差，锚定墨迹随容器走
      await new Promise(resolve => setTimeout(resolve, 120));
      const after = actionsRef.current.containerRects?.() || {};
      const moves = [];
      for (const [id, r] of Object.entries(rectsBefore)) {
        const n = after[id];
        if (n && (Math.abs(n.x - r.x) > 0.5 || Math.abs(n.y - r.y) > 0.5)) {
          moves.push({ rect: r, dx: n.x - r.x, dy: n.y - r.y });
        }
      }
      if (moves.length) {
        await actionsRef.current.followDrawings?.(moves);
        layoutUndoRef.current = createDrawingArrangeUndoTicket(snapshot, moves);
      }
      toast('已整理位置，人工归属保持不变', 'ok', { label: '撤销', onClick: undoArrange });
    } catch (e) {
      toast(`整理失败：${e.message}`, 'error');
    } finally {
      geometryPendingRef.current = false;
    }
  }, [graph?.layout, reload, undoArrange]);

  // ---- 手绘层动作分发：先落后端，再改本地状态；失败一律回读真相 ----
  const handleCanvas = useCallback((action, payload) => {
    const patch = fn => setGraph(g => ({ ...g, canvas: fn(g.canvas || { edges: [], notes: [], boards: [] }) }));
    const recover = e => { toast(`操作失败：${e.message}`, 'error'); api.graph().then(setGraph).catch(() => {}); };
    if (action === 'openContext') {
      setCtxFrame(payload);   // 纯视图动作：画布就地弹终端框，不碰盘
    } else if (action === 'drawingCommit') {
      // 普通看板态的沉浮/删除/承载动作：后端落盘成功才原子换本地 committed 快照。
      return api.setDrawing(payload.elements, payload.files).then(() => {
        patch(c => ({ ...c, drawing: payload.elements, drawingFiles: payload.files }));
        return payload;
      });
    } else if (action === 'drawingPersisted') {
      // 临时编辑器 flush 成功后回写；兼容旧的纯 elements 回调。
      const drawing = Array.isArray(payload) ? payload : payload.elements;
      const files = Array.isArray(payload) ? undefined : payload.files;
      patch(c => ({ ...c, drawing, ...(files === undefined ? {} : { drawingFiles: files }) }));
    } else if (action === 'addEdge') {
      api.addEdge(payload.from, payload.to)
        .then(edge => patch(c => ({ ...c, edges: [...c.edges.filter(e => e.id !== edge.id), edge] })))
        .catch(recover);
    } else if (action === 'delEdge') {
      api.delEdge(payload).catch(recover);
      patch(c => ({ ...c, edges: c.edges.filter(e => e.id !== payload) }));
    } else if (action === 'setNote') {
      api.setNote(payload)
        .then(note => patch(c => ({ ...c, notes: [...c.notes.filter(n => n.id !== note.id), note] })))
        .catch(recover);
    } else if (action === 'delNote') {
      api.delNote(payload).catch(recover);
      patch(c => ({ ...c, notes: c.notes.filter(n => n.id !== payload) }));
    } else if (action === 'setBoard') {
      // 画板：创建（无 id）与改动（有 id）同一条河——服务端补丁式合并后返回完整实体
      api.setBoard(payload)
        .then(board => patch(c => ({ ...c, boards: [...(c.boards || []).filter(b => b.id !== board.id), board] })))
        .catch(recover);
    } else if (action === 'delBoard') {
      api.delBoard(payload)
        .then(() => toast('画板已删除，成员回到原街区'))
        .catch(recover);
      patch(c => ({ ...c, boards: (c.boards || []).filter(b => b.id !== payload) }));
    } else if (action === 'nodeFromEdge') {
      api.createFromEdge(payload)
        .then(({ kind, node, edge }) => patch(c => ({
          ...c,
          notes: kind === 'note' ? [...c.notes, node] : c.notes,
          boards: kind === 'board' ? [...(c.boards || []), node] : (c.boards || []),
          edges: [...c.edges, edge],
        })))
        .catch(recover);
    }
  }, []);

  useEffect(() => {
    reload();
    return subscribeEvents(() => setPending(true), up => setLive(up));
  }, [reload]);

  // ---- 快捷键：N 便签 / B 画板 / F 全景 / "/" 搜索 / Esc 关面板；输入框内不劫持 ----
  useEffect(() => {
    const onKey = e => {
      const t = e.target;
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable) {
        if (e.key === 'Escape') t.blur();
        return;
      }
      // 绘图编辑激活时快捷键交给 Excalidraw（含选择、形状、文字与图片）
      if (document.querySelector('.draw-active')) return;
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'z' && layoutUndoRef.current) {
        e.preventDefault();
        undoArrange();
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
  }, [undoArrange]);

  // ============================================================
  //  过滤管道：会话级过滤（工具/状态/时间/搜索）→ 工作区聚合裁剪
  // ============================================================
  // 搜索防抖：每击键全图重排太贵，让渲染在输入间隙进行
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

  if (!view) {
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
          layout={graph.layout}
          canvas={graph.canvas}
          onCanvasAction={handleCanvas}
          onRenameSession={(key, title) =>
            api.rename(key, title).then(r => { toast(r.synced ? '已重命名并同步回工具本体' : '已重命名（本体热文件，稍后自动同步）'); reload(); })
              .catch(e => toast(`改名失败：${e.message}`, 'error'))}
          onRenameWs={(path, name) =>
            api.wsRename(path, name).then(reload).catch(e => toast(`改名失败：${e.message}`, 'error'))}
          selectedKey={selectedKey}
          actionsRef={actionsRef}
          geometryPendingRef={geometryPendingRef}
          expanded={expandedWs}
          searching={!!deferredQ.trim()}
          onToggleExpand={path => setExpandedWs(s => {
            const n = new Set(s); n.has(path) ? n.delete(path) : n.add(path); return n;
          })}
          onMoveNode={entries => {
            layoutUndoRef.current = null;   // 整理后又手动摆过，旧快照不再有资格覆盖新意图
            api.layoutBatch(entries).catch(() => api.graph().then(setGraph).catch(() => {}));
            // 本地与后端同律：按字段合并——快照不带 w/h 时不许抹掉已存的手调尺寸
            setGraph(g => {
              const layout = { ...g.layout };
              for (const e of entries) {
                const prev = { ...layout[e.path] };
                for (const k of ['x', 'y', 'd', 'w', 'h']) if (e[k] !== undefined) prev[k] = e[k];
                layout[e.path] = prev;
              }
              return { ...g, layout };
            });
          }}
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
          onRescan={() => api.rescan().then(() => { reload(); toast('已全量重扫', 'ok'); })}
          onArrange={e => arrange({ x: e.clientX - 250, y: e.clientY + 14 })}
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
