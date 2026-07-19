/**
 * [INPUT]: 依赖 react、api 的 backfill 接口、ui 的 Icon
 * [OUTPUT]: 对外提供 TopBar 组件——右上动作岛：静默同步状态点/有新活动举旗/可撤销智能整理/批量命名/重扫
 * [POS]: panels 的动作岛（历史名 TopBar）；智能整理按活跃度重排街区与画板、保留人工归属，回执可直接撤销
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */
import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Icon } from '../ui.jsx';

const SYNC_META = {
  saved: ['已保存', '画布已保存'],
  dirty: ['未同步', '改动已在本机生效，正在等待后台同步'],
  saving: ['同步中', '正在后台同步，画布可继续操作'],
  error: ['未同步', '后台同步失败，正在自动重试；画布可继续操作'],
};

export default function TopBar({ onRescan, pending, onRefresh, onArrange, syncStatus = 'saved' }) {
  const [bf, setBf] = useState(null);
  useEffect(() => {
    if (!bf?.running) return;
    const t = setInterval(() => api.backfillStatus().then(setBf).catch(() => {}), 4000);
    return () => clearInterval(t);
  }, [bf?.running]);

  return (
    <div className="island" style={{ display: 'flex', gap: 4, padding: 5, alignItems: 'center' }}>
      <span className={`sync-state ${syncStatus}`} title={SYNC_META[syncStatus]?.[1] || SYNC_META.saved[1]}
        aria-label={SYNC_META[syncStatus]?.[1] || SYNC_META.saved[1]} role="status">
        <span className="sync-dot" />
        {syncStatus !== 'saved' && <span>{SYNC_META[syncStatus]?.[0] || '未同步'}</span>}
      </span>
      {pending && (
        <button className="btn primary" onClick={onRefresh} title="地形有新变化（新会话/状态翻转/改名），点击刷新画布"
          style={{ animation: 'pulse 2.4s infinite' }}>
          ● 有新活动
        </button>
      )}
      <button className="btn ghost" title="按活跃度整理街区与画板；容器内墨迹随行，便签保持手工位置，保留归属，可立即撤销" onClick={onArrange}>
        <Icon name="tidy" /> 智能整理
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
