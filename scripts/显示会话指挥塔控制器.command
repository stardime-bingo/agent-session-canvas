#!/bin/zsh
set -euo pipefail

APP="$HOME/Applications/会话指挥塔.app"
if [[ ! -d "$APP" ]]; then
  echo "尚未安装会话指挥塔控制器。请先运行仓库中的 scripts/install-controller.sh。" >&2
  read -r '?按回车键关闭…'
  exit 1
fi
pkill -x AgentCanvasController >/dev/null 2>&1 || true
for _ in {1..20}; do
  pgrep -x AgentCanvasController >/dev/null 2>&1 || break
  sleep 0.1
done
/usr/bin/open -n "$APP" --args --show-controls
