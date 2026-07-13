# Privacy Policy

Last updated: July 14, 2026

AGENT Session Canvas is a local-first, open-source macOS application. This policy explains what the application and its companion Claude Code / Codex plugin access and where that information goes.

## Data the application accesses

The application reads local Claude Code and Codex session files from the current macOS user's home directory to build the session map. It may read session metadata, workspace paths, prompts, assistant messages, tool activity, and errors. The normal scanner uses bounded sections of session files; user-requested AI summaries and handoffs may sample larger sections.

The application stores generated titles, summaries, handoffs, canvas objects, layout positions, configuration, caches, temporary launch scripts, and daemon logs in its local `data/` directory. Browser layout preferences are stored in local browser storage for `localhost:4517`.

## Network and AI processing

The web application and daemon listen only on `127.0.0.1`. The project does not operate a hosted backend, user account system, telemetry service, advertising service, or analytics service.

Scanning, searching, editing the canvas, and launching or resuming a session do not send session content to the project publisher.

When the user explicitly requests AI naming, summarization, handoff generation, or batch backfill, the application sends extracted session content to a locally installed command-line provider selected in the user's configuration. Supported routes are Codex CLI, Claude Code, and an optional DeepSeek CLI integration. Those providers may transmit the content to their own services and process it under the user's account, provider settings, and provider terms. The publisher of this project does not receive that content.

Installing from GitHub or through a plugin marketplace requires normal network access to download the repository and npm packages.

## Data sharing and retention

The project publisher does not collect or sell personal information. Local runtime data remains on the user's device until the user removes it. Temporary terminal launch files are removed automatically after use; local backups and logs follow the behavior documented in the repository.

Users control the retention of their Claude Code, Codex, browser, provider, and local application data. Removing or changing those assets is outside the automatic plugin workflow and should be done only with an explicit backup and confirmation.

## Permissions

Installation creates a macOS LaunchAgent so the local daemon can start at login. The optional Claude Code SessionEnd hook is not installed by default and requires a separate, explicit user request because it modifies `~/.claude/settings.json`.

The plugin can install, diagnose, start, restart, and open the local application. It is instructed not to delete session data, call destructive APIs, install the optional hook, change schemas, uninstall the daemon, or remove the application without explicit user authorization.

## Security and support

Please do not include private session content, credentials, or personal data in a public issue. Security and privacy reports can be opened through the repository's [GitHub issue tracker](https://github.com/bingo0621/agent-session-canvas/issues).

Material changes to this policy will be published in this repository.
