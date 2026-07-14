# hooks/
> L2 | 父级: ../CLAUDE.md

Agent 工具侧的钩子：让"结束前自动生成接力提示词"不依赖人的自觉。

成员清单
handoff-hook.sh: Claude Code SessionEnd 钩子，stdin 收 hook JSON 转发 daemon 的 /api/handoff-auto；火种即忘，daemon 离线静默跳过；daemon 侧有 200KB 体量门槛过滤琐碎会话

安装位置: ~/.claude/settings.json 的 hooks.SessionEnd（属系统级配置变更，须用户亲自确认安装；安装前先备份原文件）
当前状态: 本机已于 2026-07-14 经用户明确授权安装到 ~/.claude/hooks/agent-canvas-handoff.sh；追加为第 4 条 SessionEnd，原三条保留，settings 已先做时间戳备份。公开安装仍必须显式 opt-in
Codex 侧钩子: v1 暂未接入，Codex 会话仍可在看板手动生成接力

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
