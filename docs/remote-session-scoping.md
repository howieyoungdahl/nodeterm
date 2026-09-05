# Remote session scoping — display, discovery, context, control

Four different questions get confused with each other whenever a remote client shows many agent
sessions at once:

1. what a remote client **displays**,
2. what an agent can **discover**,
3. what it **loads into context**,
4. what it is **authorized to control**.

They have four different mechanisms in this repo, and only the last one is a security boundary.
This page says which is which, so the next person changing one of them knows what they are, and are
not, changing.

> **Filtering is not an access-control boundary.**
> Narrowing what a client is *shown* does not narrow what it may *ask for*. A connection that can
> reach the server can still request any project. If you tighten a filter and describe the result as
> a permission, you have made the real boundary harder to find, not stronger.

## The four, with the file that enforces each

| | mechanism | file | is it a boundary? |
|---|---|---|---|
| **displays** | per-project scoped delivery of the three per-node pushes, plus the renderer's own view | `src/server/platform-server.ts` (`broadcastScoped` / `setClientScope`), `src/server/client-scope.ts`, `src/server/agent-status.ts` | **No.** Presentation. Default-open. |
| **discovers** | the canvas-control `list` verb's row | `src/shared/canvas-list-row.ts`, the `list` case in `src/renderer/canvas/Canvas.tsx` | **No.** It lists the canvas the caller is already on. |
| **loads into context** | pull-only, and capped: `context.sh summary / transcript` | `src/core/context-link-render.ts`, `src/core/context-link.ts` | **No.** But nothing is pushed, and the pull is bounded. |
| **is authorized to control** | creator ownership, fail-closed | `src/core/agents/pane-ownership.ts`, `HeadlessNodeOwnership` in `src/server/headless-node-factory.ts`; transport auth in `src/server/auth.ts` | **Yes. This is the one.** |

## 1. Display — scoped broadcast (`platform-server.ts`)

`agent:status`, `agent:subagent-activity` and `context:update` are per-node events. They used to go
to **every** connected browser client with no project filter, so a client viewing project A received
node status for project B — including `agent:subagent-activity`, which carries a live transcript
**chunk**.

They now go through `broadcastScoped(channel, projectId, payload)`. A connection declares the
project it is looking at (`presence:project`, which the renderer already casts from Canvas's
active-project effect on connect and on every switch), and a scoped connection is skipped for events
belonging to another project.

Three properties, all deliberate, all tested:

- **Default-open.** A connection that has declared nothing is in no map entry and receives
  everything, exactly as before scoping existed. A client silently starved of `agent:status` shows
  dead agent badges with no error anywhere and nothing to diagnose — so every failure on this path
  degrades to *more* traffic: a client that never declares, a declaration lost to someone else's
  rate limiter, a reconnect under a fresh id, or a scope naming a project that has since been
  deleted.
- **Unknown means deliver.** The resolver behind it (`paneOwnerProject`) is fail-closed: it answers
  `undefined` for any pane this process did not freshly spawn, which after a restart is most of
  them. `broadcastScoped` treats `undefined` as "send to everyone", because the alternative is a
  blank canvas after every restart.
- **Reconnect-safe.** `detach` forgets the scope, and the renderer resets its own dedup latch when
  the connection is torn down, so a reconnect re-announces from scratch and starts undeclared.

## 2. Discovery — the `list` row (`shared/canvas-list-row.ts`)

`list` is the verb an orchestrating agent calls first, and its cost is linear in node count. The row
is `id [kind] title`, plus two **optional** fields:

- `opened-by=<id>` — which node opened this one, from the creator ledger;
- `task=<id>` — the task a registry projection names this node as belonging to.

Both are **omitted when unknown, never placeholdered and never guessed**. A node with neither
renders byte-identically to the pre-change row, and a reader can never mistake "we cannot prove it"
for "this node has no parent". `opened-by` exists so a fan-out of a dozen sessions can be rebuilt
into a tree from one call instead of asking each node in turn.

The agent-facing help text in `core/canvas-control-core.ts` is **derived** from this module
(`listRowHelpLines()`), so the documented row and the emitted row cannot drift —
`canvas-control-core.test.ts` fails on the stale claim.

## 3. Context — pull-only, and bounded

Nothing injects another session's transcript anywhere. Context links are **pull**: a linked agent
runs `context.sh`, the document it may read is selected by the **requester's** node id, and no hook
or boot path reads any terminal, transcript or session list. The only automatic cross-session writes
are a one-line discovery note on a hand-drawn context edge and a sticky-note push capped at 2,000
characters, both of which require a human to draw the edge.

What changed is the bound. `summary -n N` was already capped by `N`; `transcript` returned the
**entire** conversation however long it was. It now defaults to the last
`TRANSCRIPT_DEFAULT_LINES` (400) rendered lines, with `-n N` to raise it, and the truncation is
**visible in the output** — it says how many lines were dropped and the exact `-n` to pass for the
whole thing. Silent truncation would be worse than none: a reader handed a transcript that starts
mid-conversation, with nothing saying so, draws confident conclusions from a window it does not know
it is inside.

## 4. Control — creator ownership, and it is the only boundary here

A caller may act only on nodes it **provably spawned during the current run**. Ownership is recorded
on a genuine fresh spawn and on nothing else — never on an attach, never from `project.json`,
titles, tmux session names or rope edges, none of which are creator proof (`project.json` is
git-shared and hand-editable; a rope cannot even say whether its source *opened* the node or is a
`--after` dependency it once waited on). The ledger is in-memory and empty after a restart, so an
unproven node is **refused**, not adopted. `src/core/agents/pane-ownership.ts` states the full
argument, including why repopulating on attach is exactly how the confused deputy it closes would be
re-opened.

The transport is gated separately, by the single-user auth in `src/server/auth.ts`.

**Nothing in §1–§3 is part of this.** The scope map is not consulted by `workspace.load()`, by
`pty:subscribe`, or by any control verb.

## What the measurements said

Recorded so the next reader does not re-run them. Measured on one host, 2026-09-04, against a live
canvas of ~20 agent sessions:

- **No transcript enters any model's context, anywhere.** Verified three independent ways: no
  `SessionStart` hook emitter reads any terminal, tmux, agent-status or capture source (all eight
  measured, ~15 kB constant in session count); the canvas had `bridges: []` and `context.sh list`
  answered *"No linked nodes"*; and the peer list appeared in 1 of the 30 most recent transcripts —
  the session that called the tool. **A fix aimed at "stop injecting transcripts" would have fixed
  nothing**, which is why this lane went to the four paths above instead.
- **The flood is discovery, and it is mostly on a provider-owned surface.** One account-wide peer
  listing returned 227+ entries in 19 kB, of which 7 were live on the host — 3.1 % signal, and the
  reply declared itself truncated. That surface has no grouping, filter, search or pinning. What is
  ours there is the launch command's session **name**, handled separately.
- **The three paths in this repo that scale with session count** are the ones fixed above: the
  unfiltered broadcast, the `list` row (~130 B/row on the Server-Edition inventory lineage → ~3.3 k
  tokens at 100 nodes), and the uncapped `transcript` render.
- **Scale, for judging the risk of the broadcast change**: one connected client and ~14–20 node
  entries. This was a correctness-and-shape fix, not a performance emergency, which is why the
  change is small and default-open rather than clever.

## Three surfaces

- **Desktop** — unaffected by the scoped broadcast: `wireAgentStatus` and `broadcastScoped` are
  Server-Edition code, and the desktop shell's own raw hook listener (`src/main/index.ts`) is
  unchanged. It fans out to one renderer plus any relay peers; scoping relay peers is a separate
  question with a separate ownership model and has deliberately not been answered here. The `list`
  row and the capped `transcript` are shared and apply on desktop.
- **Server Edition** — where the scoped broadcast lives, wired at boot in `src/server/index.ts`.
  The capped `transcript` applies (the shell registers `initContextLink`); the `list` verb is not a
  Server-Edition v1 verb, so the row change reaches it the day `list` is added there.
- **Mobile** — N/A. The companion attaches to tmux sessions over the transport protocol and has no
  canvas, no per-client project scope and no `list` verb. Surfacing any of this means extending that
  protocol, which is work in the iOS repo, not here.
