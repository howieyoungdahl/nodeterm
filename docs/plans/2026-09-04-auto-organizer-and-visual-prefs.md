# Auto canvas organizer and persistent visual preferences

Plan of record, 2026-09-04. Base: `fork/integration/server-fixes-2026-08-31` @ `82b11742`
(37 commits ahead of `origin/main`, none upstreamed — recorded below). Four PRs, A–D.

Goal: as agents spawn more terminals, the canvas stays readable without the operator arranging it.
Delegated workers open small, grouped, titled and status-labelled; the workspace the operator is
actually using is never moved, resized or focused by anything automatic; and the organization plus
the operator's chosen colors/borders survive a restart and a project reopen.

Two halves, deliberately separate: **organization** (A–C) and **appearance** (D). They share one
rule: a fact that changes every few seconds is rendered, never persisted.

---

## 0. What already exists — build on it, do not rebuild

| Thing | Where | State |
|---|---|---|
| Compact control-spawn geometry (440×320), `--size compact\|normal`, `resize` verb, `controlSize` marker, creator ownership | `src/shared/control-node-size.ts`, `src/server/headless-node-factory.ts`, `9839ef6c` | **Shipped and live.** PR-A extends it; it does not re-implement it. |
| Reliable per-node status, hook-fed, with a timestamp | `~/.nodeterm-server/agent-status.json` (`nodes.<id>.{state,updatedAt,sessionId,name}`); renderer `state/agentStatus.ts`; snapshot seed `94f3bc0a` | **Shipped.** PR-B's only source of truth. |
| Server writes that must not raise the Reload/Keep-mine bar | `workspace:server-change` + `renderer/lib/serverChange.ts` three-way merge, `82b11742` | **Shipped.** Every automatic write in this plan rides it. |
| Naming + clustering from real conversation content | the shared `canvas-organize` skill (maintained in the operator's out-of-tree skill layer; rename + group only, no resize, excludes loop members) | PR-C extends this body at its canonical out-of-tree source. |
| One slug-labeled frame per loop | the shared `director-loop` skill (same out-of-tree skill layer) | Layout authority treats loop frames as owned by the loop; it never re-parents their members. |
| Session-name-as-title | `fork/feat/server-auto-title` (2 commits on `3133de8e`, **not** in the integration branch) | PR-A's titling must not duplicate it; see task A4. |

**Fork-only, not upstreamed** (`git log origin/main..fork/integration/server-fixes-2026-08-31` = 37):
the whole Server ops-API / creator-ownership / compact-nodes / conflict-channel series. So every PR
here bases on the fork integration branch, not `origin/main`, and targets the fork.

---

## 1. Decisions, with reasons

**D1 — Layout authority is the core, one per project; agents request, they do not place.**
Two directors both calling `arrange` is the operator's "conflicting layout decisions from multiple
directors". The rule engine lives in `src/core` (so Desktop and Server Edition both have it) and is
the only thing that moves a node under a rule. An agent's explicit `move`/`arrange` still works and
is recorded as **manual placement**, which pins that node against the engine from then on. Documented
in `CLAUDE.md` beside the creator-ownership section.

**D2 — The tray is a group frame.** The operator asks for "an expandable group, tray, or equivalent
secondary area". Frames already nest, collapse, carry a label and a color, persist, and are
creator-owned. A new tray region would be a second layout system with its own persistence and its own
bugs. Decision: workers spawned by a node are grouped under a frame keyed by that node's task, and
the frame ships **collapsed**. Expandable group = the requirement, already built.

**D3 — Status is read, never inferred from appearance.** The five words in the request map as:
`working`, `waiting`, `blocked` and `completed` come from hook events already in
`agent-status.json`; **`failed` is derived only from session facts** — the pane's tmux session gone,
or the agent process exited non-zero, while the last hook state was `working`. No output parsing, no
"the terminal looks stuck". A node with no status event renders **`unknown`**, which is its own word
on screen and never silently reads as idle. Freshness (age of `updatedAt`) is rendered next to every
state, and a state older than the staleness window is marked stale rather than presented as current.

**D4 — Status never touches disk.** Everything status-driven (badge, freshness, any border tint) is
computed at render time from the live store. Only user intent and structural layout ops persist. This
is the single decision that makes "no repeated conflict warnings" true by construction: the
high-frequency fact has no write path to `project.json` at all.

**D5 — Preference precedence, one sentence, everywhere:** explicit per-node/per-group override >
project rule > global default > built-in. Enforced by one pure resolver so the UI and the renderer
cannot disagree.

**D6 — Shared vs machine-local follows the existing split** (`CLAUDE.md`, "the shared file carries
content, not identity"): anything that is a statement about *this canvas* is shared and rides
`.nodeterm/project.json`; anything that is a statement about *this display or this person* is
machine-local and rides `settings.json` / the v3 index entry. Concretely — shared: pins, manual
placement, layout rules, per-node color/border overrides, group frames. Machine-local: window-edge
appearance, reduced-motion, effects-off, viewport, whether a frame is collapsed on *this* screen.

**D7 — Zero model tokens on an unchanged canvas.** The engine is deterministic TypeScript over
(nodes, statuses, rules), fired by events. The LLM appears only in the `canvas-organize` skill, for
naming and clustering from conversation content, and it caches its classification per node keyed by
`(nodeId, sessionId, transcript watermark)` — an unchanged node is never re-classified.

**D8 — Presentation is never authority.** No layout or appearance path may message an agent, submit
input, kill a PTY, change loop ownership or close a session. Collapsing, resizing and grouping are
all pure canvas-state writes; `resize` already leaves the PTY alone and that property is a test, not
a habit.

---

## 2. (a) What a skill can do today, with the verbs that already exist

`list`, `rename`, `group`, `ungroup`, `move`, `arrange`, `align`, `color`, `resize`, `board`, `sticky`
are live on the shim. So today, with no new nodeterm capability, a skill can already:

- inventory the canvas (`list`) and read status out of `agent-status.json`;
- rename generically-titled nodes from conversation evidence and cluster them into labeled frames
  (`canvas-organize`, shipped);
- shrink an already-open worker (`resize --size compact`) and put it inside a frame (`move`);
- tidy an existing canvas once, on request, and report what it did.

That is a *one-shot, operator-triggered* organizer. It is what exists, and it is not what the operator
asked for.

## 3. (b) What genuinely needs new capability in nodeterm

A skill cannot provide any of these, because a skill only runs when an agent decides to run it:

1. **Automatic placement at spawn time.** The decision has to be made inside the node factory, when
   the node is created, before the operator ever sees it. (PR-A)
2. **A persistent status surface.** A badge with freshness that is visible on a *collapsed* node and
   on the frame around it is renderer state, not something an agent can draw. (PR-B)
3. **Event-driven rules.** "Organize future nodes automatically" means a subscriber to node-create
   and status-change inside the app, with saved rules — not an agent re-inspecting the canvas.
   A skill polling the canvas is exactly the token burn the operator rules out. (PR-C)
4. **Persistent UI settings.** Border color/thickness/glow, reduced-motion, effects-off and their
   global/project precedence are settings-store and renderer work. (PR-D)
5. **Pinning and manual-placement memory.** "Keep these nodes where I put them" has to survive the
   engine, which means a persisted flag the engine reads — new node state. (PR-A/C)

## 4. (c) The event-driven layout rule engine

Pure core module, `src/core/canvas-layout/` — `plan(input) → LayoutPlan`, no I/O:

```
input  = { nodes, groups, statuses, rules, actives, now }
plan   = { ops: LayoutOp[], skipped: {nodeId, reason}[] }
op     = place | resize | reparent | collapse | label
```

- **Triggers, not polling:** `node-created` (the big one — placement happens once, at birth),
  `status-changed` (only ever changes a badge or a frame roll-up; emits layout ops solely when a rule
  says so, e.g. "float a blocked worker out of the tray"), `rules-changed` (explicit operator action),
  and an explicit `organize` request. Nothing runs on a timer.
- **Refusals are first-class and reported, never silent.** `plan()` skips, with a reason: a pinned
  node; a node with a manual placement; a loop-owned frame's members; the node the operator is
  actively using (focused, or last-interacted within the activity window); a node another authority
  created this run. `skipped[]` is what the preview shows and what the report prints.
- **Preview and reversible apply:** the plan renders as a table before it is applied; apply pushes the
  inverse ops as **one** entry on the existing undo stack, so ⌘Z restores the previous arrangement.
- **Writes ride `workspace:server-change`** (D4/`82b11742`) and are coalesced into one write per plan,
  so a burst of eight spawns is one merge, not eight.
- **Single authority:** the engine refuses to run for a project while another instance holds that
  project's layout lease; the lease-holder is named in the report so a second director sees why it
  stood down rather than fighting.

## 5. (d) The preferences model

```
settings.json (machine-local)          .nodeterm/project.json (shared, git-travelling)
  appearance.windowEdge{color,             layoutRules{version, spawn{...}, tray{...},
    thickness,glow,focusHighlight}           appearance{byDirector|byProvider|byTaskGroup}}
  appearance.reducedMotion                 nodes[].pinned, nodes[].manualPlacement
  appearance.effectsOff                    nodes[].appearance (explicit override — wins)
  canvasLayout (global default rules)      groups[].appearance
  index entry: viewport, collapsed-on-this-screen
```

- **Resolution** is one pure function (`resolveNodeAppearance`) applying D5's precedence; both the
  Settings UI and the renderer call it, so the preview and the canvas cannot drift.
- **Forward/backward compatible:** `layoutRules.version` is checked, unknown rule kinds and unknown
  appearance keys are ignored rather than rejected, and an absent block means "built-in defaults" —
  an older build reading a newer project file sees a canvas it can still render.
- **Conflict-fix integration:** preference writes are ordinary project saves; *derived* appearance is
  never written (D4); layout-op writes are coalesced and ride `workspace:server-change`, which is
  three-way merged — so an external edit during an automatic organize is merged, not overwritten, and
  the Reload/Keep-mine bar keeps its original meaning (a genuine other-device edit).
- **Reduced-motion and effects-off** are machine-local *and* override any shared glow rule, and the
  renderer additionally honours the OS `prefers-reduced-motion`. Accessibility is never something a
  shared repo file can switch back on.
- **Never color alone:** every status distinction carries a glyph and a word; color is redundant
  encoding only. This is a test in PR-B, not a review comment.

---

## 6. Ordered tasks

Each task names the command whose output is the proof. Every PR additionally carries a
disposable-instance validation (isolated Server, temp data dir, unused port, real hook installs
disabled) with captured JSON or a screenshot kept with the review record, out of tree. Never validate
against a live Server.

**PR-A — compact spawn defaults + grouping** (branch `feat/organizer-compact-grouping`)
- A1 `data.role: 'primary' | 'worker'` on canvas nodes; control-spawned = worker, manual UI opens =
  primary and untouched. Persisted. *Proof:* `npx vitest run src/shared src/server/headless-node-factory.test.ts`
- A2 A worker spawn is placed inside a **task frame** derived from the spawning node (its own frame,
  else a frame named for it), created if absent, **collapsed** on creation. *Proof:*
  `npx vitest run src/server/headless-node-factory.test.ts src/renderer/state/workspace.test.ts`
- A3 Expand ⇄ return-to-compact as **one** action: header button + context-menu row (registered in
  the `hiddenHeaderButtons` / `hiddenNodeMenuItems` inventories) storing `compactRect` so the return
  restores size *and* position. Must not respawn or kill the PTY. *Proof:* renderer unit test that
  the toggle round-trips geometry and issues no transport call.
- A4 Meaningful title + one-line task summary on every generated node (`<lane>·<role>` shape), taking
  the session name when known. Coordinate with `fork/feat/server-auto-title`: read that branch, and
  either rebase on it or state in the PR body why the two titling paths do not collide.
- A5 `pinned` + `manualPlacement` node flags, written when the operator drags/resizes a node by hand.
  *Proof:* test that a hand-moved node is flagged and the engine's `plan()` skips it.

**PR-B — status surface** (branch `feat/organizer-status-badges`, off PR-A)
- B1 Extend the state model to the operator's five plus `unknown`; `failed` derived only from session facts
  (D3), in core, beside the mirror. *Proof:* `npx vitest run src/core` for the derivation table.
- B2 Badge = glyph + word + freshness age, on the node header **and** rolled up on a collapsed frame
  (worst member state wins; a blocked or failed member is always visible on the closed frame — this
  is the operator's "approvals and failures discoverable even when their terminals are collapsed").
- B3 "Why attention is needed" without opening the terminal: the badge carries the reason string the
  hook event already provides (permission prompt / question / exit status), truncated.
- B4 Stale marking past the staleness window; never color alone (a test asserts every state has a
  distinct glyph and word).
- B5 Three surfaces: Desktop, Server Edition (real bridge member, not a stub), Mobile — state the
  call explicitly in the PR body.

**PR-C — layout rules + skill** (branch `feat/organizer-layout-rules`, off PR-B)
- C1 `src/core/canvas-layout/` engine per §4, pure and unit-tested including every refusal.
  *Proof:* `npx vitest run src/core/canvas-layout`
- C2 Event subscriptions (node-created, status-changed, rules-changed) in both shells; opt-in via
  `canvasLayout.enabled`, default **off**. *Proof:* a shell-parity test in the spirit of
  `hook-verified-parity.test.ts`.
- C3 Preview + one-undo-entry reversible apply for an existing canvas.
- C4 Layout lease / single authority per project, and its refusal path.
- C5 Extend the shared `canvas-organize` skill (edited at its canonical out-of-tree source, then synced
  and checked) to answer the five operator phrasings, delegating placement to the engine and keeping the
  LLM to naming/clustering with the D7 cache.

**PR-D — visual preferences** (branch `feat/organizer-visual-prefs`, off the integration base, parallel with A)
- D1 Settings model + `resolveNodeAppearance` pure resolver with the D5 precedence.
  *Proof:* `npx vitest run src/shared` on the precedence table.
- D2 Window/app edge appearance, separate from node/group borders.
- D3 Node/group border color, thickness, optional glow and focus highlight; derivation by project /
  director / task group / provider, explicit override winning.
- D4 Reduced-motion + effects-off, machine-local, overriding shared rules, honouring the OS setting.
- D5 Settings → Appearance UI; persistence across restart and project reopen. *Proof:* the
  disposable-instance stop/start showing the settings and the canvas come back identical.

**Acceptance run (all four merged into a validation branch):** on a disposable instance, spawn ≥ 8
workers under two directors; capture the canvas and `project.json`; stop and restart that instance;
capture again. Criterion: readable canvas, visible status, the active workspace untouched, and both
organization and appearance identical across the restart.

---

## 7. Non-goals

Merging to upstream nodeterm (the maintainer's call; these target the fork). Restarting
`nodeterm-server.service`. Any validation against the live Server. Replacing the director-loop
layout rules — loops keep owning their own frames. A tray as a new UI region (D2). Any presentation
path that messages, submits, stops, closes, or transfers loop authority (D8). Mobile implementation
(flagged per-PR, carried to the iOS repo).

## 8. Risks

- **Frame churn.** A task frame created per spawning node could multiply. Mitigation: the frame is
  keyed by the spawning node's existing frame first, and a frame with one member is not created.
- **The engine moving something the operator is touching.** Mitigation: the active-node refusal is a
  refusal *at apply time*, re-asked, not a plan-time verdict — the same rule agent hibernation uses.
- **Two authorities.** Mitigation: the lease (C4); a stood-down engine says so rather than going quiet.
- **`failed` being wrong.** Mitigation: it is derived only from session facts; when the facts are
  unavailable the state is `unknown`, which is a word on screen, not a guess.
- **Write amplification against the conflict fix.** Mitigation: D4 (status never persists) plus
  one coalesced write per plan.
- **Base drift.** All four PRs sit on a 37-commit fork-only stack. If the maintainer upstreams it mid-flight
  the PRs need a rebase; recorded here so that is a known cost, not a surprise.
