#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec env AGENT_CANVAS_HOME="$ROOT" "$ROOT/plugins/agent-session-canvas/scripts/agent-canvas" stop
