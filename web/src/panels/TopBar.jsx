/**
 * [INPUT]: 依赖 react、api 的 backfill 接口、ui 的 Icon
 * [OUTPUT]: 对外提供 TopBar 组件——右上动作岛：有新活动举旗/可撤销整理/批量命名/重扫
 * [POS]: panels 的动作岛（历史名 TopBar）；整理只重置几何且保留人工归属，回执可直接撤销
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Icon } from '../ui.jsx';

export default function TopBar({ onRescan, pending, onRefresh, onArrange }) {
  const [bf, setBf] = useState(null);
  useEffect(() => {
    if (!bf?.running) return;
    const t = setInterval(() => api.backfillStatus().then(setBf).catch(() => {}), 4000);
    return () => clearInterval(t);
  }, [bf?.running]);

  return (
    <div className="island" style={{ display: 'flex', gap: 4, padding: 5, alignItems: 'center' }}>
      {pending && (
        <button className="btn primary" onClick={onRefresh} title="地形有新变化（新会话/状态翻转/改名），点击刷新画布"
          style={{ animation: 'pulse 2.4s infinite' }}>
          ● 有新活动
        </button>
      )}
      <button className="btn ghost" title="整理位置并全景归位；保留人工街区/画板归属，可立即撤销" onClick={onArrange}>
        <Icon name="tidy" /> 整理
      </button>
      <button className="btn ghost" disabled={bf?.running}
        title="把近 30 天机器味标题批量翻译成人话（Codex 优先，额度尽自动切 Claude）"
        onClick={() => api.backfill().then(setBf)}>
        {bf?.running ? <>✎ {(bf.done ?? 0) + (bf.failed ?? 0)}/{bf.total ?? '?'}</> : <><Icon name="tag" /> 批量命名</>}
      </button>
      <button className="btn ghost" onClick={onRescan} title="全量重扫会话地形"><Icon name="refresh" /></button>
    </div>
  );
}
