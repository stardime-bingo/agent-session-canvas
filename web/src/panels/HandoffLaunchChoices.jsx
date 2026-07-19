/**
 * [INPUT]: 接力提示词、工作区、源会话 key、忙碌态与启动回调
 * [OUTPUT]: Claude Code / Codex 两个并列接班入口；回调收到同一份提示词与明确 tool 的 launch payload
 * [POS]: 详情面板的接力工具选择器——不默认继承源工具，不制造隐式首选项
 * [PROTOCOL]: 变更时更新此头部，然后检查 DetailPanel/4518 handoff-choice/web CLAUDE
 */
import React from 'react';
import { Icon } from '../ui.jsx';

const OPTIONS = Object.freeze([
  { tool: 'claude', label: 'Claude Code' },
  { tool: 'codex', label: 'Codex' },
]);

export default function HandoffLaunchChoices({ handoff, cwd, sourceKey, busy, onLaunch }) {
  return OPTIONS.map(({ tool, label }) => (
    <button key={tool} className="btn" disabled={Boolean(busy)}
      data-testid={`handoff-launch-${tool}`}
      aria-label={`用 ${label} 带接力开新会话`}
      title={`在 ${label} 中带着当前接力提示词开启新会话`}
      onClick={() => onLaunch(tool, {
        tool, cwd, mode: 'prompt', prompt: handoff, sourceKey,
      })}>
      <Icon name="play" /> {label} 接力会话
    </button>
  ));
}
