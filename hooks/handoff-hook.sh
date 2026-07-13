#!/bin/zsh
# ============================================================
#  [INPUT]: stdin 接收 Claude Code SessionEnd hook JSON ({session_id, cwd, ...})
#  [OUTPUT]: POST 到指挥塔 daemon 的 /api/handoff-auto，触发接力提示词自动生成
#  [POS]: hooks 的 SessionEnd 钩子——会话谢幕时自动留下接力火种
#  [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
# ============================================================
#  火种即忘（fire-and-forget）：daemon 不在线或会话太小都静默跳过，
#  绝不阻塞、绝不报错——钩子失败不配打扰会话的正常谢幕。
# ============================================================
curl -s -m 2 -X POST http://localhost:4517/api/handoff-auto \
  -H 'Content-Type: application/json' \
  -d @- >/dev/null 2>&1 || true
exit 0
