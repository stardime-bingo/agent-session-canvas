#!/bin/zsh
set -euo pipefail

MODE="${1:-run}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PACKAGE_DIR="$ROOT/mac-controller"
DIST_DIR="$ROOT/dist"
APP_NAME="会话指挥塔"
PROCESS_NAME="AgentCanvasController"
BUNDLE_ID="com.bingo.agent-canvas.controller"
APP_BUNDLE="$DIST_DIR/$APP_NAME.app"
CONTENTS="$APP_BUNDLE/Contents"
MACOS_DIR="$CONTENTS/MacOS"
RESOURCES_DIR="$CONTENTS/Resources"
INFO_PLIST="$CONTENTS/Info.plist"
ICONSET_DIR="$DIST_DIR/AppIcon.iconset"

stage_bundle() {
  swift build --package-path "$PACKAGE_DIR"
  local bin_path
  bin_path="$(swift build --package-path "$PACKAGE_DIR" --show-bin-path)"

  case "$APP_BUNDLE" in
    "$ROOT"/dist/*.app) ;;
    *) echo "拒绝清理意外的 app 路径：$APP_BUNDLE" >&2; exit 1 ;;
  esac
  rm -rf "$APP_BUNDLE" "$ICONSET_DIR"
  mkdir -p "$MACOS_DIR" "$RESOURCES_DIR"
  cp "$bin_path/$PROCESS_NAME" "$MACOS_DIR/$PROCESS_NAME"
  chmod +x "$MACOS_DIR/$PROCESS_NAME"
  cp "$ROOT/plugins/agent-session-canvas/scripts/agent-canvas" "$RESOURCES_DIR/agent-canvas"
  chmod +x "$RESOURCES_DIR/agent-canvas"

  xcrun swift "$PACKAGE_DIR/script/generate_icon.swift" "$ICONSET_DIR"
  iconutil -c icns "$ICONSET_DIR" -o "$RESOURCES_DIR/AppIcon.icns"
  rm -rf "$ICONSET_DIR"

  local version
  version="$(node -p 'require(process.argv[1]).version' "$ROOT/package.json")"
  plutil -create xml1 "$INFO_PLIST"
  /usr/libexec/PlistBuddy -c "Add :CFBundleExecutable string $PROCESS_NAME" "$INFO_PLIST"
  /usr/libexec/PlistBuddy -c "Add :CFBundleIdentifier string $BUNDLE_ID" "$INFO_PLIST"
  /usr/libexec/PlistBuddy -c "Add :CFBundleName string $APP_NAME" "$INFO_PLIST"
  /usr/libexec/PlistBuddy -c "Add :CFBundleDisplayName string $APP_NAME" "$INFO_PLIST"
  /usr/libexec/PlistBuddy -c 'Add :CFBundlePackageType string APPL' "$INFO_PLIST"
  /usr/libexec/PlistBuddy -c "Add :CFBundleShortVersionString string $version" "$INFO_PLIST"
  /usr/libexec/PlistBuddy -c "Add :CFBundleVersion string $version" "$INFO_PLIST"
  /usr/libexec/PlistBuddy -c 'Add :CFBundleIconFile string AppIcon' "$INFO_PLIST"
  /usr/libexec/PlistBuddy -c 'Add :LSMinimumSystemVersion string 13.0' "$INFO_PLIST"
  /usr/libexec/PlistBuddy -c 'Add :LSApplicationCategoryType string public.app-category.utilities' "$INFO_PLIST"
  /usr/libexec/PlistBuddy -c 'Add :LSMultipleInstancesProhibited bool true' "$INFO_PLIST"
  /usr/libexec/PlistBuddy -c 'Add :NSHighResolutionCapable bool true' "$INFO_PLIST"
  /usr/libexec/PlistBuddy -c 'Add :NSPrincipalClass string NSApplication' "$INFO_PLIST"
  plutil -lint "$INFO_PLIST" >/dev/null
  codesign --force --deep --sign - "$APP_BUNDLE" >/dev/null
}

open_app() {
  /usr/bin/open -n "$APP_BUNDLE" "$@"
}

case "$MODE" in
  run)
    pkill -x "$PROCESS_NAME" >/dev/null 2>&1 || true
    stage_bundle
    open_app
    ;;
  --build-only|build-only)
    stage_bundle
    ;;
  --debug|debug)
    pkill -x "$PROCESS_NAME" >/dev/null 2>&1 || true
    stage_bundle
    lldb -- "$MACOS_DIR/$PROCESS_NAME"
    ;;
  --logs|logs)
    pkill -x "$PROCESS_NAME" >/dev/null 2>&1 || true
    stage_bundle
    open_app
    /usr/bin/log stream --info --style compact --predicate "process == \"$PROCESS_NAME\""
    ;;
  --telemetry|telemetry)
    pkill -x "$PROCESS_NAME" >/dev/null 2>&1 || true
    stage_bundle
    open_app
    /usr/bin/log stream --info --style compact --predicate "subsystem == \"$BUNDLE_ID\""
    ;;
  --verify|verify)
    pkill -x "$PROCESS_NAME" >/dev/null 2>&1 || true
    swift test --package-path "$PACKAGE_DIR"
    stage_bundle
    open_app --args --no-open
    sleep 1
    pgrep -x "$PROCESS_NAME" >/dev/null
    codesign --verify --deep --strict "$APP_BUNDLE"
    ;;
  *)
    echo "用法: $0 [run|--build-only|--debug|--logs|--telemetry|--verify]" >&2
    exit 2
    ;;
esac
