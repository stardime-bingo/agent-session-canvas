/**
 * [INPUT]: 临时 scene daemon 的真实 /api/graph、/api/scene、/api/events；production SceneStore/api/TopBar
 * [OUTPUT]: 双标签 LWW、离线重试、pagehide keepalive 的匿名浏览器验收页与只读探针
 * [POS]: 仅在临时端口运行；不挂载真实 graph、不读取仓内 data、不提供产品第二实现
 * [PROTOCOL]: 变更时更新此头部，然后检查 README/verify.py/web/CLAUDE.md
 */
import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { createRoot } from 'react-dom/client';
import '../../../web/src/theme.css';
import { api, subscribeEvents, WRITER_ID } from '../../../web/src/api.js';
import { createSceneStore } from '../../../web/src/scene-store.js';
import TopBar from '../../../web/src/panels/TopBar.jsx';

const h = React.createElement;
const NOTE_ID = 'sync-acceptance-note';
const toDoc = graph => ({
  layout: graph.layout || {},
  edges: graph.canvas?.edges || [],
  notes: graph.canvas?.notes || [],
  boards: graph.canvas?.boards || [],
  drawing: graph.canvas?.drawing || [],
  drawingFiles: graph.canvas?.drawingFiles || {},
});

function AcceptanceBody({ store }) {
  const doc = useSyncExternalStore(
    useCallback(listener => store.subscribe(listener), [store]),
    useCallback(() => store.get(), [store]),
  );
  const sync = useSyncExternalStore(
    useCallback(listener => store.subscribe(listener), [store]),
    useCallback(() => store.status(), [store]),
  );
  const [live, setLive] = useState(false);
  const adoptionsRef = useRef([]);
  const [adoptionCount, setAdoptionCount] = useState(0);
  const note = doc.notes.find(item => item.id === NOTE_ID) || { id: NOTE_ID, text: '' };

  const edit = useCallback(text => store.mutate(current => {
    const existing = current.notes.findIndex(item => item.id === NOTE_ID);
    const next = [...current.notes];
    const value = { id: NOTE_ID, x: 100, y: 100, color: 'yellow', w: 280, h: 140, text };
    if (existing >= 0) next[existing] = { ...next[existing], ...value };
    else next.push(value);
    return { ...current, notes: next };
  }, { coalesce: `sync-note:${NOTE_ID}` }), [store]);

  useEffect(() => subscribeEvents(event => {
    if (event.type !== 'scene-updated' || event.writerId === WRITER_ID) return;
    api.graph().then(graph => {
      const accepted = store.adoptRemote(toDoc(graph), graph.rev);
      adoptionsRef.current.push({
        writerId: event.writerId,
        rev: graph.rev,
        accepted,
        localText: store.get().notes.find(item => item.id === NOTE_ID)?.text || '',
        sync: store.status().status,
      });
      setAdoptionCount(adoptionsRef.current.length);
    }).catch(() => {});
  }, setLive), [store]);

  useEffect(() => {
    const onHide = () => { store.flushNow(); };
    window.addEventListener('pagehide', onHide);
    return () => window.removeEventListener('pagehide', onHide);
  }, [store]);

  window.__SYNC_ACCEPTANCE__ = {
    ready: true,
    writerId: WRITER_ID,
    edit,
    flushNow: () => store.flushNow(),
    snapshot: () => ({
      writerId: WRITER_ID,
      text: store.get().notes.find(item => item.id === NOTE_ID)?.text || '',
      seq: store.get().seq,
      sync: store.status().status,
      syncError: store.status().error?.message || null,
      live,
      adoptions: [...adoptionsRef.current],
    }),
  };
  document.documentElement.dataset.syncReady = 'true';

  return h('main', { style: {
    minHeight: '100vh', display: 'grid', placeItems: 'center', background: 'var(--bg)', color: 'var(--ink)',
  } },
    h('section', { className: 'island', style: { width: 560, padding: 22, display: 'grid', gap: 16 } },
      h('header', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
        h('div', null,
          h('div', { className: 'eyebrow' }, 'ISOLATED SCENE SYNC'),
          h('h1', { style: { margin: '4px 0 0', fontSize: 22 } }, '双标签与 pagehide 验收'),
        ),
        h(TopBar, {
          syncStatus: sync.status,
          pending: false,
          onRefresh: () => {}, onArrange: () => {}, onRescan: () => {},
        }),
      ),
      h('label', { htmlFor: 'sync-note', style: { display: 'grid', gap: 8, fontWeight: 650 } },
        '匿名最终编辑',
        h('textarea', {
          id: 'sync-note',
          'data-testid': 'sync-note',
          value: note.text,
          onChange: event => edit(event.target.value),
          style: { minHeight: 150, resize: 'none', border: '1px solid var(--line)', borderRadius: 12, padding: 14, font: '15px/1.6 ui-sans-serif' },
        }),
      ),
      h('footer', { className: 'mono', style: { display: 'flex', justifyContent: 'space-between', color: 'var(--ink-dim)', fontSize: 11 } },
        h('span', { 'data-live': String(live) }, live ? 'daemon live' : 'daemon offline'),
        h('span', { 'data-adoption-count': adoptionCount }, `remote events ${adoptionCount}`),
        h('span', { 'data-writer-id': WRITER_ID }, WRITER_ID.slice(0, 13)),
      ),
    ),
  );
}

function App() {
  const [store, setStore] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let alive = true;
    api.graph().then(graph => {
      if (!alive) return;
      setStore(createSceneStore(toDoc(graph), {
        persistScene: (scene, options) => api.putScene(scene, options),
        persistFiles: (files, options) => api.putDrawingFiles(files, options),
      }));
    }).catch(reason => setError(reason.message));
    return () => { alive = false; };
  }, []);
  if (error) return h('pre', null, `sync fixture failed: ${error}`);
  if (!store) return h('div', null, 'loading isolated scene…');
  return h(AcceptanceBody, { store });
}

createRoot(document.getElementById('root')).render(h(App));
