---
name: agent-session-canvas
description: Install, diagnose, start, stop, inspect, and open the local AGENT Session Canvas that visualizes Claude Code and Codex sessions. Use when the user asks to install or open the session command tower, check localhost:4517, control its launchd service, or understand how the plugin relates to the real local app.
---

# AGENT Session Canvas

Control the existing local product at `http://localhost:4517`. This skill is a thin installer/controller; never create or substitute another demo page.

## Choose the operation

- User explicitly asks to install → run `<plugin-root>/scripts/agent-canvas install`.
- User asks to open → run `<plugin-root>/scripts/agent-canvas open`.
- User asks to start → run `<plugin-root>/scripts/agent-canvas start`; if the preserved plist exists but launchd is unregistered, this bootstraps it without reinstalling.
- User asks to restart → run `<plugin-root>/scripts/agent-canvas restart`.
- User asks to stop → run `<plugin-root>/scripts/agent-canvas stop`; this preserves the plist and all local data, and is safe to repeat.
- User asks for machine-readable service state → run `<plugin-root>/scripts/agent-canvas status`; report its one-line JSON and exit status without substituting a write operation.
- User asks why it is unavailable or wants a health check → run `<plugin-root>/scripts/agent-canvas doctor` first.

Resolve `<plugin-root>` as the directory two levels above the directory containing this `SKILL.md`. Do not reimplement the shell operations by hand when the bundled script is available.

## Installation contract

The install command clones the app to `${AGENT_CANVAS_HOME:-$HOME/.agent-session-canvas}`, installs dependencies, builds the existing React app, and installs its macOS launchd service. Run it only when the user has clearly asked to install; that request authorizes the launchd change.

If the destination already exists but is not this Git repository, stop and report the path conflict. Never overwrite or delete it.

After successful install or start, open the real app URL. Do not claim success unless the health endpoint responds.

## Safety boundaries

- Treat `~/.claude`, `~/.codex`, and the app's `data/` directory as real user assets. Never delete, upload, or use them as destructive test fixtures.
- Do not call the app's delete APIs while diagnosing.
- Do not install the optional Claude Code SessionEnd hook or edit `~/.claude/settings.json` unless the user separately and explicitly requests that system configuration change.
- Do not change schemas, uninstall the daemon, or remove the app directory without explicit confirmation.
- The app is local-first and listens on localhost. The plugin wrapper must not transmit session content. Explain that optional, user-triggered AI features pass extracted session snippets to the user's locally configured AI CLI provider.

## Reporting

Report the operation performed, the localhost health result, and the exact next action if it failed. Keep installation, app health, optional AI backends, and optional SessionEnd hook as separate statuses.
