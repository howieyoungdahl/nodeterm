# Remote session navigation — task-first view over a flat provider list

**Date:** 2026-09-04 · **Status:** plan · **Owner:** remote-sessions lane

## Goal

From a remote connection, find the right task, see its status and next step, and open the relevant session
without sorting through every supporting terminal.

## What the trace found (this is what makes the plan look the way it does)

Measured on one development host, 2026-09-04 21:42–22:05. The counts below are that machine's;
the shapes they demonstrate are not.

- **The flood is one layer: account-wide Remote Control peer discovery.** One `ListAgents` call returned
  **227 peers / 19,071 bytes** — 216 offline, **60 auto-named sessions on two other machines**, 7 live here
  (**3.1 %**), and the reply declared itself truncated. That surface has **no grouping, filter, search or
  pin**.
- **No transcript is injected anywhere.** `bridges: []` on the live canvas; `context.sh list` answers "No
  linked nodes"; all 8 `SessionStart` emitters measure **15,126 chars ≈ 3,780 tokens, constant in session
  count** and read no terminal source; `Peer sessions` appears in 1 of the 30 most recent transcripts — the
  one that called the tool. **A fix aimed at context injection would have fixed nothing.**
- **We are a contributor to the flood.** The live Server appends `--remote-control` with **no name**, and
  `--remote-control-session-name-prefix` defaults to the hostname. Locally, `nameSource: "derived"` is cwd +
  2 hex, so 4 of 6 live sessions on account 2 read `claude-XX`.
- **Listed vs live:** `ListAgents` 227→7 · Claude records 470→15 · Codex rollouts 874→0 · Codex threads 67→0
  · tmux sessions 20→20. Liveness must be `procStart`-checked: 5 of 20 pid dirs are PID reuse.
- **Nothing records task identity.** `node-ownership.json` is `{sourceNodeId, projectId}` only; tier and lane
  exist solely in free-text node titles that nothing parses.

## Decisions

1. **Consume the shared task registry; do not invent a store.** The registry file named by
   `$NODETERM_TASK_REGISTRY` (contract v0.1) is the single source, and nodeterm is a **read-only
   consumer** of it. It is published by a supervising tool, and nodeterm names no particular one —
   any producer emitting the contract shape works. `task_id` is the permanent join key; pane numbers
   and titles are never identities.
2. **Name the sessions we launch.** The provider list cannot be restructured, but every entry in it can be
   made legible. Feature-detected `-n/--name` (and, where present, `--remote-control <name>`), built from
   project · task · role. Fail closed: unprobed CLI ⇒ no flag ⇒ byte-identical command.
3. **Extend the sessions sidebar, do not build a second navigator.** `sessionList.ts` already ships project
   and status grouping, persisted collapse, signal roll-up and search. Add a third grouping, `'task'`, so the
   canvas and the remote view are literally the same function — which is what makes local and remote agree.
4. **A CLI is the entry point that works first.** The operator already reaches the host by SSH for the
   tunnel, so a `nav` command that prints projects → tasks → status → next step → the exact open
   command meets the acceptance criterion without waiting on any UI.
5. **Four separate things, and filtering is none of them.** Display (scoped broadcast + view filters),
   discovery (the `list` verb's project scope), context (pull-only, capped), control
   (`node-ownership.json`, fail-closed). Written in `docs/remote-session-scoping.md` and in a comment at the
   broadcast site.
6. **Hiding never destroys.** Collapse, filter and pin change presentation only; no session is terminated and
   no history is discarded. Retired nodes stay in `retired_nodes[]`.

## Non-goals

Deleting or archiving sessions, rollouts or worktrees (counts reported; cleanup is separately authorized).
Changing what any agent is *authorized* to control. Working around provider-owned UIs — offline Remote
Control entries persist account-wide and that is documented as a limit, not hacked around. Mobile surfaces
(`nodeterm-ios`, separate repo) — raised as a follow-up, not built here.

## Tasks

| # | Task | Proof command |
|---|---|---|
| 1 | Synthetic population: ≥300 sessions, ~10 projects, ~25 tasks, mixed providers/accounts, adversarial cases (pane + title collisions, account switch, node replacement, 30-worker task, orphans) | `npx vitest run src/shared/remote-nav/ --reporter=dot` |
| 2 | Pure navigation model: task-first tree, six saved views, search/sort/pin, workers collapsed, needs-attention **deduped by (kind, text, owner)** per contract v0.1 | `npx vitest run src/shared/remote-nav/ --reporter=dot` |
| 3 | Core registry reader in `src/core` behind `CorePlatform`; registry path from `$NODETERM_TASK_REGISTRY`; unset, missing or stale degrades visibly, never silently | `npx vitest run src/core/remote-nav/ --reporter=dot` |
| 4 | Server route: authenticated, **verbatim passthrough** of `generated_at` / `source.generation` / `host_boot_epoch`; validated on a disposable instance with its own data dir and port | `npx vitest run src/server/ --reporter=dot` |
| 5 | CLI entry point: task → status → next step → open command, bounded steps | scripted walk over the fixture, output pasted in the report |
| 6 | Session naming at launch (feature-detected, fail-closed, composed-line assertion) | `npx vitest run src/shared/agents/ src/core/claude-cli.test.ts --reporter=dot` |
| 7 | Scoping: default-open scoped broadcast · `list` row carries owner + optional task id (help text regenerated in the same change) · capped transcript render with a visible truncation notice · `docs/remote-session-scoping.md` | `npx vitest run src/server/ src/core/context-link-render.test.ts --reporter=dot` |
| 8 | Sidebar `'task'` grouping wired to the reader | `npx vitest run src/renderer/lib/ --reporter=dot` |

## Persistence rules

| State | Where | Why |
|---|---|---|
| Pins, promote-to-primary, task closure | the **registry's own writer**, through its CLI (contract v0.1 ruling) | statements about the work; must agree on every machine and survive restart |
| Sort direction, column order, collapse, current saved view | `view-prefs.json` beside the registry, machine-local | display-specific; a phone's layout is not a desktop's |
| Sidebar collapse for canvas projects/frames | existing `settings.sidebarCollapsedItems`, pruned on write | already shipped; reused rather than duplicated |
| Registry projection | read-only cache with a stated source generation | never written by this lane |

Reconnect and restart: identity is `task_id`, so grouping survives node replacement, account switches
(session ids may change; `session_lineage[]` carries them) and the four host restarts in the last day. Nothing
here writes `project.json`, so the `82b11742` conflict bar is untouched.

## Risks

- **The registry may be absent or stale.** Degrade visibly — show freshness beside every badge, and never
  present a pre-`host_boot_epoch` observation as current. A navigator that silently shows yesterday is worse
  than one that says it cannot tell.
- **Provider lists keep growing regardless of naming.** Naming makes 227 entries searchable; it does not make
  them 7. The scoped entry point is what actually answers the acceptance criterion.
- **Scoping the broadcast can starve a live client.** Default-open, opt-in narrowing, reconnect-safe.
- **The registry is now served to a browser**: no secrets, no PII, no prod row data in any field.
