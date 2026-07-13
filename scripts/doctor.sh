#!/bin/zsh
set -u

LABEL="com.bingo.agent-canvas"
DOMAIN="gui/$(id -u)"
FAILED=0

check_cmd() {
  if command -v "$1" >/dev/null 2>&1; then
    echo "✓ $1: $(command -v "$1")"
  else
    echo "· $1: 未安装（可选能力）"
  fi
}

if command -v node >/dev/null 2>&1; then
  NODE_OK="$(node -p 'const [a,b]=process.versions.node.split(".").map(Number); Number((a===20&&b>=19)||(a===22&&b>=12)||a>22)')"
  if [[ "$NODE_OK" == "1" ]]; then
    echo "✓ node: $(node -v)"
  else
    echo "✗ node: $(node -v)（需要 20.19+ 或 22.12+）"
    FAILED=1
  fi
else
  echo "✗ node: 未安装（需要 20.19+ 或 22.12+）"
  FAILED=1
fi
check_cmd claude
check_cmd codex
check_cmd ghostty

if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  PID="$(launchctl print "$DOMAIN/$LABEL" | awk '/pid =/ { print $3; exit }')"
  echo "✓ launchd: running${PID:+ (pid $PID)}"
else
  echo "✗ launchd: 未安装或未运行"
  FAILED=1
fi

if GRAPH="$(curl -fsS --max-time 3 http://localhost:4517/api/graph 2>/dev/null)"; then
  printf '%s' "$GRAPH" | node --input-type=module -e '
    let s=""; for await (const c of process.stdin) s+=c;
    const g=JSON.parse(s); console.log(`✓ API: ${g.stats?.total ?? g.sessions?.length ?? 0} 会话 / ${g.stats?.workspaces ?? 0} 工作区`);
  '
else
  echo "✗ API: http://localhost:4517 无响应"
  FAILED=1
fi

exit "$FAILED"
