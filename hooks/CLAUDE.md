# hooks/
> L2 | 父级: ../CLAUDE.md

Agent 工具侧的钩子：让"结束前自动生成接力提示词"不依赖人的自觉。

成员清单
handoff-hook.sh: Claude Code SessionEnd 钩子，stdin 收 hook JSON 转发 daemon 的 /api/handoff-auto；火种即忘，daemon 离线静默跳过；daemon 侧有 200KB 体量门槛过滤琐碎会话

安装位置: ~/.claude/settings.json 的 hooks.SessionEnd（属系统级配置变更，须用户亲自确认安装；安装前先备份原文件）
当前状态: 脚本就绪，未安装——安装命令见项目 L1 或问指挥塔
Codex 侧钩子: v1 暂未接入，Codex 会话仍可在看板手动生成接力

[PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
