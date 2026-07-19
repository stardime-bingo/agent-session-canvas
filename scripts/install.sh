#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.bingo.agent-canvas"
DOMAIN="gui/$(id -u)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
TEMPLATE="$ROOT/infra/$LABEL.plist.template"
NODE_BIN="$(command -v node || true)"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "AGENT 会话指挥塔目前只支持 macOS。" >&2
  exit 1
fi
if [[ -z "$NODE_BIN" ]]; then
  echo "未找到 Node.js；请先安装 Node.js 20.19 或更高版本。" >&2
  exit 1
fi
NODE_OK="$($NODE_BIN -p 'const [a,b]=process.versions.node.split(".").map(Number); Number((a===20&&b>=19)||(a===22&&b>=12)||a>22)')"
if [[ "$NODE_OK" != "1" ]]; then
  echo "Node.js 版本过低：需要 20.19+ 或 22.12+，当前 $($NODE_BIN -v)。" >&2
  exit 1
fi

mkdir -p "$ROOT/data" "$HOME/Library/LaunchAgents"
cd "$ROOT"
npm ci
npm run build

cp "$TEMPLATE" "$PLIST"
/usr/bin/plutil -replace ProgramArguments.0 -string "$NODE_BIN" "$PLIST"
/usr/bin/plutil -replace ProgramArguments.1 -string "$ROOT/server/index.mjs" "$PLIST"
/usr/bin/plutil -replace WorkingDirectory -string "$ROOT" "$PLIST"
/usr/bin/plutil -replace StandardOutPath -string "$ROOT/data/daemon.log" "$PLIST"
/usr/bin/plutil -replace StandardErrorPath -string "$ROOT/data/daemon.log" "$PLIST"
/usr/bin/plutil -replace EnvironmentVariables.PATH -string "$PATH" "$PLIST"
/usr/bin/plutil -replace EnvironmentVariables.HOME -string "$HOME" "$PLIST"
/usr/bin/plutil -lint "$PLIST" >/dev/null

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
launchctl bootstrap "$DOMAIN" "$PLIST"
launchctl kickstart -k "$DOMAIN/$LABEL"

API_READY=false
for _ in {1..20}; do
  if curl -fsS http://localhost:4517/api/graph >/dev/null 2>&1; then
    API_READY=true
    break
  fi
  sleep 0.25
done

if [[ "$API_READY" != "true" ]]; then
  echo "服务已安装但尚未响应；请运行 $ROOT/scripts/doctor.sh。" >&2
  exit 1
fi

if xcrun --find swift >/dev/null 2>&1; then
  "$ROOT/scripts/install-controller.sh" --no-open
else
  echo "提示：未找到 Swift 工具链，已跳过可选的原生控制器；Finder 与命令行入口仍可使用。" >&2
fi

echo "安装完成：http://localhost:4517"
