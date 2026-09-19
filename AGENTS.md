# Nodeterm agent instructions

This is the shared entrypoint for coding agents, loaded natively by supported
Claude Code sessions (2.1.277+), Codex and OpenCode. Maintain shared instructions
here and in the linked reference, never in a second provider-specific copy.
Verify project instructions loaded before work, especially with third-party
providers, telemetry/hooks disabled, or local/ancestor Claude instruction files.

Before implementation, read `CONTRIBUTING.md`, then the applicable sections of
[the engineering reference](AGENT-REFERENCE.md). Always read its
**Platform support**, **Process model**, **Atomic writes** and **Conventions**
sections. The full reference is preserved from the former CLAUDE.md; its rules
remain binding. Read section bodies, not only this routing table.

| Working on | Reference sections |
|---|---|
| Setup, builds, packaging | Commands; Packaging & auto-update |
| Services and process boundaries | Process model; Key abstraction: TerminalTransport |
| Workspace, projects, persistence | State & persistence model; Projects (tabs); Atomic writes |
| Terminal lifecycle | Terminal session continuity (tmux); Terminal node lifecycle (gotchas) |
| Canvas nodes and agent integrations | Node kinds; Agent support |
| Context and memory | Session memory |
| Shortcuts and renderer UI | Keybindings; Canvas interaction & panels |
| Remote and speech | Remote access; Speech / dictation |

## Core invariants

- Keep Electron-specific code in `src/main/`; shared services belong in
  `src/core/` behind `CorePlatform`. Renderer code uses the preload or server
  bridge, never Node/Electron imports.
- Design features for desktop, Server Edition and the mobile companion.
  Canvas and kanban are two views of the same nodes; consider both.
- New code is platform-neutral. Use `renameAtomic` / `writeFileAtomic` for
  publication; POSIX-only behavior needs a documented graceful degradation.
- Preserve terminal/session continuity and ownership checks. Do not restart a
  live shared server or destroy another session as part of verification.
- Keep contributor-facing rules aligned with `CONTRIBUTING.md`. Keep code,
  comments and UI strings in English.
- When Claude subagents are requested, this repository specifies Opus 5
  (`claude-opus-5`). This is a model rule, not permission to delegate.

## Verification

Use `npm run typecheck` and focused `npm test` suites appropriate to the change.
Follow `CONTRIBUTING.md` for setup, native dependency patches and platform tests.
Validate Server Edition changes on a disposable instance. The host updater
owns activation of the served branch; never restart the live server yourself.
