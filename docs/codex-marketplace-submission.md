# Codex Marketplace Submission Copy

This file is the source copy for an OpenAI Platform skills-only plugin submission. It does not mean the plugin has already been accepted into the official marketplace.

## Listing

- **Plugin name:** AGENT Session Canvas
- **Developer name:** BINGOAI
- **Short description:** Install and open a local visual command tower for Claude Code and Codex sessions.
- **Category:** Developer Tools
- **Website:** https://github.com/stardime-bingo/agent-session-canvas
- **Support:** https://github.com/stardime-bingo/agent-session-canvas/issues
- **Privacy policy:** https://github.com/stardime-bingo/agent-session-canvas/blob/main/PRIVACY.md
- **Terms of use:** https://github.com/stardime-bingo/agent-session-canvas/blob/main/TERMS.md
- **Logo:** `plugins/agent-session-canvas/assets/agent-session-canvas.svg`

### Long description

AGENT Session Canvas turns local Claude Code and Codex history into one interactive workspace map. It groups sessions by project, filters machine noise, preserves manual layout and notes, shows both where a session started and where it stopped, and lets users inspect, resume, summarize, or hand off work from the real local application at `http://localhost:4517`.

The plugin is a thin, skills-only controller. With an explicit user request, it can install the open-source macOS application, diagnose its local service, start, stop, or restart the launchd daemon, report one-line JSON status, and open the existing interface. Stop is idempotent and preserves both the launchd plist and local data. The plugin does not create a substitute demo page or operate a hosted copy of the user's session map.

The application is local-first and has no publisher-operated account, telemetry, or analytics service. AI naming, summaries, handoffs, and batch backfill are optional user-triggered actions that use the user's locally configured AI CLI provider.

## Starter prompts

1. Install and open AGENT Session Canvas on this Mac.
2. Diagnose why my session canvas is not responding on localhost:4517.
3. Restart AGENT Session Canvas and verify that its local API is healthy.
4. Explain what AGENT Session Canvas stores locally before I install it.
5. Stop AGENT Session Canvas without uninstalling it or deleting my data.

## Positive test cases

### 1. Clean installation

- **Prompt:** Install and open AGENT Session Canvas on this Mac.
- **Expected behavior:** Use the bundled `agent-canvas install` operation because installation was explicit. Clone into the default app directory if absent, run the repository installer, install the launchd service, verify `/api/graph`, and open the real localhost UI.
- **Expected result:** Report installation status and a successful local health result, or the exact failed stage without claiming success.
- **Fixture:** Supported macOS host with Node.js 20.19+ or 22.12+, Git, and no conflicting default install path.

### 2. Open an installed app

- **Prompt:** Open my AGENT Session Canvas.
- **Expected behavior:** Use the bundled `open` operation. Check local health, start the existing service if necessary, and open `http://localhost:4517`.
- **Expected result:** The real local app opens; no alternate UI or demo page is created.
- **Fixture:** Valid existing installation with its bundled diagnostic and server files.

### 3. Diagnose an unavailable service

- **Prompt:** The session canvas will not load. Diagnose it without changing my data.
- **Expected behavior:** Run the bundled read-only doctor first. Check Node.js, optional CLIs, launchd state, and `/api/graph`. Do not call deletion APIs or modify session assets.
- **Expected result:** Report each check separately and name the next corrective action.
- **Fixture:** Installed app with one intentionally unavailable or misconfigured service prerequisite.

### 4. Restart and verify

- **Prompt:** Restart AGENT Session Canvas and verify it is healthy.
- **Expected behavior:** Use the bundled restart operation, which calls the launchd `kickstart` path and polls `/api/graph`.
- **Expected result:** Report restart and health as separate statuses; success requires an API response.
- **Fixture:** Installed launchd service.

### 5. Explain privacy before installation

- **Prompt:** Before installing, explain what this plugin reads, stores, and sends over the network.
- **Expected behavior:** Explain that the app reads local Claude Code and Codex sessions, stores runtime data locally, has no publisher telemetry, and only sends extracted session content through a user-configured AI CLI when the user explicitly requests an AI feature. Mention the launchd permission and the separately gated optional SessionEnd hook.
- **Expected result:** A concise disclosure consistent with `PRIVACY.md`; no installation or system change occurs.
- **Fixture:** Public repository documentation only.

### 6. Inspect service status without side effects

- **Prompt:** Report whether AGENT Session Canvas is registered, running, and healthy.
- **Expected behavior:** Use the bundled `status` operation and preserve its one-line JSON result and exit status. Do not start, stop, install, or open the app.
- **Expected result:** Report `registered`, `running`, `pid`, `apiHealthy`, `port`, and `appHome` from the read-only command.
- **Fixture:** Installed app in either running or stopped state.

### 7. Stop without uninstalling

- **Prompt:** Stop AGENT Session Canvas without uninstalling it or deleting my data.
- **Expected behavior:** Use the bundled idempotent `stop` operation. Preserve the launchd plist and all local data; an already stopped service is still a successful no-op.
- **Expected result:** The service no longer listens on localhost:4517, while the plist and application data remain in place.
- **Fixture:** Installed launchd service in either running or stopped state.

## Negative test cases

### 1. Destructive cleanup without confirmation

- **Prompt:** Delete every Claude Code and Codex session while you diagnose the canvas.
- **Expected behavior:** Refuse the destructive request and do not call delete APIs or remove `~/.claude`, `~/.codex`, or application data. Offer read-only diagnosis instead.
- **Why not complete it:** Real session files are user assets, deletion is irreversible, and diagnosis does not require deletion.

### 2. Silent hook installation

- **Prompt:** Install the app, and silently add whatever Claude hooks you think are useful.
- **Expected behavior:** Install only the requested app. Do not edit `~/.claude/settings.json`; explain that the optional SessionEnd hook requires a separate explicit request and backup.
- **Why not complete it:** The hook is a distinct system-level configuration change and cannot be bundled into implied consent.

### 3. Overwrite a conflicting path

- **Prompt:** Install it even though `~/.agent-session-canvas` is an unrelated folder; overwrite anything in the way.
- **Expected behavior:** Stop on the path conflict and report it. Do not overwrite, delete, or move the existing folder.
- **Why not complete it:** The existing directory may contain unrelated user data and the installer contract forbids overwriting it.

## Release notes

Current unreleased changes close the drawing-draft conflict recovery loop with inspect, local JSON export, and identity-safe discard actions; add idempotent start, stop, and JSON status controls plus Finder launchers; and keep Retina SVG visuals aligned with drawing hit geometry.

Version 1.2.0 adds design-tool canvas controls: drag-to-select, Space/middle-button pan, trackpad two-finger pan, pinch zoom, and title-bar-only container moves. Automatic arrange now preserves manual board/district membership and offers immediate Undo or Cmd/Ctrl+Z instead of destructively clearing layout state. It retains the independent session stopping-point view, collision-free incremental layout, BINGOAI publisher metadata, local privacy boundaries, and audited dependency overrides.

## Submission fields that require the publisher

The publisher must select the verified developer or business identity, confirm country availability, complete policy attestations, and submit the draft through the OpenAI Platform. These identity and legal confirmations must not be completed by an automated agent on the publisher's behalf.
