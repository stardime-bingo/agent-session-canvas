#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SOURCE_APP="$ROOT/dist/会话指挥塔.app"
TARGET_DIR="$HOME/Applications"
TARGET_APP="$TARGET_DIR/会话指挥塔.app"
MODE="${1:-open}"

if ! xcrun --find swift >/dev/null 2>&1; then
  echo "未找到 Swift 工具链，无法构建原生控制器。命令行与 Finder 启停入口仍可使用。" >&2
  exit 1
fi

"$ROOT/script/build_and_run.sh" --build-only
WAS_RUNNING=false
if pgrep -x AgentCanvasController >/dev/null 2>&1; then
  WAS_RUNNING=true
  pkill -x AgentCanvasController >/dev/null 2>&1 || true
  for _ in {1..20}; do
    pgrep -x AgentCanvasController >/dev/null 2>&1 || break
    sleep 0.1
  done
fi
mkdir -p "$TARGET_DIR"
/usr/bin/ditto "$SOURCE_APP" "$TARGET_APP"
codesign --verify --deep --strict "$TARGET_APP"

if [[ "$MODE" != "--no-open" ]]; then
  /usr/bin/open "$TARGET_APP"
elif [[ "$WAS_RUNNING" == "true" ]]; then
  /usr/bin/open -n "$TARGET_APP" --args --no-open
fi

echo "控制器已安装：$TARGET_APP"
