# Contributing to nodeterm

The Sessions sidebar's Tasks tab reads a bounded canonical D15 publication from
host startup configuration. It never grants session control; exact focus remains
unavailable without a trusted shell identity/authority adapter. See
`docs/remote-task-context.md` for configuration and acceptance limits.

Thanks for looking. This file is the short door: enough to get running, plus the house rules that
actually get a pull request sent back. The long version — every subsystem and the reasoning behind
its invariants — lives in `CLAUDE.md` at the repo root, which is also loaded automatically if you
work with an AI coding agent.

nodeterm is licensed **BUSL-1.1** (converts to MIT after four years — see `LICENSE`). Contributions
are accepted under that license.

## Getting set up

```bash
npm install        # also patches + rebuilds node-pty against Electron's ABI (postinstall)
npm run dev        # dev mode with renderer HMR
npm run typecheck  # tsc for both the node and web projects — the fastest correctness gate
npm test           # vitest, unit + integration
```

`npm run server:dev` boots the Server Edition (browser UI) if you are working on that surface.

**If `src/main/node-pty-patch.test.ts` is red, your `node_modules` is unpatched — not your code.**
Run `npm run rebuild`. node-pty 1.1.0 leaks a pty device per spawn on macOS
([node-pty#950](https://github.com/microsoft/node-pty/issues/950)) and, on Windows, leaves a
conhost alive per killed session (its exit thread deletes the ConPTY baton without closing the
HPCON); we patch both sources before `electron-rebuild` compiles them, and that test guards the
patches surviving upgrades.

## Where code goes

The repo is split by Electron process boundary and the split is enforced, not advisory:

| Directory | What lives there |
|---|---|
| `src/core/` | Electron-free service core. Talks to its shell only through `CorePlatform`. |
| `src/main/` | The Electron shell around `src/core` — windows, IPC, dialogs. |
| `src/server/` | The Server Edition shell (browser UI over WS-RPC). |
| `src/preload/` | The only bridge: `contextBridge` exposing `window.nodeTerminal`. |
| `src/renderer/` | React UI. Reaches main *only* through `window.nodeTerminal`. |
| `src/shared/` | Types and IPC channel names imported by all sides. |

`src/core/no-electron.test.ts` and `src/server/no-electron.test.ts` fail if `src/core` or
`src/server` import `electron` or `../main/*`.

**Put new service logic in `src/core` behind `CorePlatform`, not inline in `src/main`.** That is the
seam the Server Edition boots from; logic left in `src/main` silently does not exist there, and the
boundary tests cannot tell you a feature is *missing*.

## Three surfaces

A feature is not done until you have decided how it behaves on each — even if the decision is "not
applicable here":

1. **Desktop** (Electron)
2. **Server Edition** (Linux, browser)
3. **Mobile companion** — *nodeterm mobile*, a **private** repo (`nodeterm-ios`, SwiftUI). You
   cannot open a PR against it, so this is normally a follow-up note rather than same-PR
   work: say in your PR what the mobile side would need, and **mention @eneskirca** so it
   gets picked up there. "Not applicable" is a fine answer — just make it a stated one.

Anything reachable from `window.nodeTerminal` needs a **real** implementation in
`src/renderer/bridge/`, or a deliberate, documented degrade. The `satisfies NodeTerminalApi` gate
forces you to *declare* every member, but a no-op stub compiles fine while doing nothing.

The **canvas and the kanban board are two views of the same nodes.** When you add something to a
canvas node — a header action, a badge, a menu item — ask whether the board's card and card modal
need it too, and wire it in the same change. The global (Omni) board shows all open projects as
stacked swimlanes; it is off by default (`settings.omniKanbanEnabled`), has a dedicated remappable
shortcut (`view.globalKanbanToggle`), and can be made the default for Cmd+Shift+B via
`settings.omniKanbanAsDefault` — see CLAUDE.md for the full invariants.

A board card's **source** is a registry entry, not a branch you add at a call site
(`renderer/lib/kanbanSources.ts`). Declare the source once — filter label, `placement`
(`assignment` = the board's own persisted assignments, `provider` = the provider owns the column),
in-column `lane` order, whether it is `configured` for a board, whether it is `readOnly` (the
board never writes it: no drag, no move control) — and give it its one leaf (a card component and
the list path feeding it). Columns take lanes and name no source; the drag path branches on
`placement`. If you find yourself writing `=== 'github'` outside the registry, the registry is
missing a field.

Before adding a GitHub read, check what the existing poll already fetches. Pull request cards
needed no new request at all: `/repos/{repo}/issues` returns pull requests, and the client used to
discard them. `/repos/{repo}/pulls` looks like the obvious endpoint and is the expensive one — it
**ignores `since`**, so it can reuse none of the incremental machinery, and its items are ~3.5× the
bytes. CLAUDE.md's kanban section has the measurements and the eviction rule that keeps the issue
lane unaffected.

## House rules

- **Never call the user's machine a Mac in user-visible copy.** Use `thisMachine()` /
  `thisMachineCap()` / `machineNoun()` from `src/renderer/lib/machineName.ts` — "this Mac" on
  macOS, "this PC" on Windows, "this computer" elsewhere and in any Server Edition browser tab
  (where the machine being described is the SERVER, whose OS the viewer cannot know). Issue #563:
  ~30 strings said "this Mac", including *"This Mac is not authorized on this license"* and *"a
  teammate on a seat can run commands on this Mac"* — the one sentence a user has to trust before
  handing out shell access. `machineName.guard.test.ts` scans non-comment lines and will fail your
  PR; copy that really is macOS-specific (the ptmx-limit banner, the notch step) is exempt by name
  with its reason. Comments are not scanned.

- **Anything path-shaped: Windows is a delivery target.** Most of this was written on
  macOS/Linux, so the recurring defect is code that is genuinely correct on POSIX —
  `split('/')`, `startsWith('/')` as an is-absolute test, a bare `fs.rename`. Use
  `path.basename`/`join`/`sep`, publish files with `renameAtomic`, and write at least one test with
  a real `C:\`-shaped input. Guards enforce some of this and will fail your PR. In the Server
  Edition and relay tabs, the browser's OS is NOT the filesystem's OS: obtain the dialect from the
  core that owns the files, and keep an unobserved host unknown rather than guessing. Conversely,
  on POSIX a backslash is legal filename text — do not treat both separators as interchangeable
  unless the owning filesystem is known to be Windows.

- **Normalize BOTH sides of a path comparison, through one function.** A marker normalized where
  it is built and matched raw where it is used is a no-op on the machine you wrote it on and a
  silent defect on Windows. That is issue #558: the managed-hook marker was folded to `/` while
  the stored command still carried `\`, so nodeterm stopped recognizing its own hook entries and
  appended a fresh copy of all nine on every launch — nine hook processes per event, nine
  concurrent 45 s permission waits racing one prompt. Write the normalizer once, use it on both
  sides, and pin it with a `C:\`-shaped test.

- **Never publish a file with a bare `fs.rename`.** Use `renameAtomic` or `writeFileAtomic` from
  `src/core/fs-atomic.ts`. On Windows a rename fails with `EPERM` whenever anything has the
  destination open — Defender scanning the file you just wrote, the search indexer, OneDrive — so
  the plain version loses saves intermittently and only on other people's machines. A test scans
  for this and will fail your PR; `docs/atomic-writes.md` explains why the retry is safe. Every
  temp/part staging name must also be unique per call across processes and cleaned by its owner —
  including paths embedded in generated SSH commands or handed to scp, which the `fs` scan cannot
  see. Keep a remote temp's own leaf bounded: extending an already-valid maximum-length target leaf
  with a UUID suffix turns an atomic write into a guaranteed `ENAMETOOLONG` failure.

- **Never write to a child's stdin without an `'error'` listener on that stream.** A pipe write's
  failure is not a throw at the call site: when the child exits before draining stdin (a CLI handed
  a flag it doesn't know, an unreachable ssh host), Node re-emits the EPIPE as an async `'error'`
  EVENT on the stream — a try/catch around the write is inert, and the unhandled event crashes the
  whole main process with an "Uncaught Exception: write EPIPE" dialog (issue #382's class). Attach
  `child.stdin.on('error', ...)` before the first write — log via `console.warn` so the debug ring
  sees it, or settle the pending call; the child's exit code stays the authority on the outcome
  (see `tmux-control-client.ts` and `pty-manager.ts` `runWithStdin` for the house pattern). A test
  (`src/core/stream-epipe.guard.test.ts`) scans for this and will fail your PR.

- **Never unmount, move or re-key a browser/web node's element.** An Electron `<webview>`'s guest
  process dies on DOM detach — and a detach includes any `insertBefore`/`appendChild` MOVE of an
  attached element, which React performs whenever a kept child's relative order among kept keyed
  children changes. That is why webview-hosting nodes render in one stable pool region at the tail
  of the `<ReactFlow>` nodes prop (`renderer/lib/webviewKeepAlive.ts` — read its header before
  touching the merge, the node array swap in Canvas's load effect, or anything that reorders
  nodes), and why a background project's pages stay mounted as hidden ghosts instead of
  unmounting. `display:none` is safe (measured: state, scroll and viewport size survive); a reorder
  or unmount reloads the user's page and loses their in-page state.

These are the ones that come up in review most often. Each exists because its absence caused a real
bug.

**A failed read is never evidence of absence.** "Could not measure" and "there is nothing" are
different facts and must stay distinguishable at every layer. Collapsing them is how a panel ends up
reporting "no sessions" on a host running thirty.

Workspace readers check the existing publication lock before/after reading; a displaced managed
file is retryable unavailable, never a successful empty workspace. Reconciled loads bind the typed
index view to the exact observed raw index. Do not clear abandoned locks or bypass caller enrollment
to make a load/save succeed. See `docs/project-reconciliation.md` for bounded read/retry behavior.

**A workspace save must reject if any local project write fails.** The renderer uses that result
to keep changes unsaved, show a warning, and retry on a bounded schedule. Swallowing a per-project
error can leave new terminal cards only in browser memory until a refresh removes them. Keep
initial saves on the same failure path, and never let retries override an unresolved conflict.
Browser-server updates must build in isolated release worktrees and preserve tmux. The optional
updater waits for all browser clients to disconnect, verifies exact pane ids/PIDs and saved cards,
and rolls back failed activation. Never replace those checks with an HTTP-only health check.
See `docs/server-auto-updates.md` for the deployment contract and its remaining connection race.

**Degrade to nothing, never to something wrong.** A probe that fails means the bare, safe command —
never a substituted nearest match. A hand-editable value that is unrecognised must yield the safe
default, never something more destructive than the default.

**A Server Edition agent owns only nodes it opened through this Server.** The creator ledger must
never be rebuilt from `.nodeterm/project.json`, titles, hook history, or a surviving tmux name: all
are writable or stale. The server does, however, write it DOWN itself — a 0600
`<dataDir>/node-ownership.json` (`src/server/node-ownership-store.ts`), the same trust class as the
`node-tokens/` beside it — so a restart no longer revokes an orchestrator's grants over the children
it spawned. A missing, unreadable or wrong-shaped ledger loads EMPTY: unknown ownership still fails
closed, and every id is re-validated with `isSafeNodeId` on the way in. Durable ownership grants no
extra SPAWN authority: whether a persisted node may fresh-spawn remains the boot classification's
decision, below, and the delivery queue is memory-only, so a restart still sends no queued command.
Before listening, Server boot classifies
every saved local terminal id. A definitively absent backend becomes an inert dead card; a live or
unreadable backend may be reached only through an attach-only primitive. Neither branch may
attach-or-create, and only node ids created during the current Server run may fresh-spawn. Metadata
mutations and message delivery validate every target before writing anything; missing proof is a
 named refusal. There is no agent ownership exception for global dead-card cleanup. The separately
authenticated operator API and its periodic reaper share one engine; it skips SSH projects and
removes a local terminal card only after two definitive absent-session probes. Failed or unreadable
probes preserve it. The same engine runs that rule BACKWARDS at boot and on `POST
/opsapi/adopt-orphans`: a live `nt-<id>` session no project still lists gets a card again, in the
project whose folder is its pane's nearest ancestor. That is not an inert-boot exception — it adds a
card for a backend it just proved exists, creates and attaches and types nothing, and puts the
adopted id through the very same boot classification, so it stays attach-only. It exists because
`workspace:save` is a whole-workspace last-writer-wins write with NO conflict machinery for local
projects: a client holding a stale node list deletes every card created since its snapshot, for
everyone, with all the panes still running. `WorkspaceStore` now keeps an omitted node whose backend
is live and that was not deleted here, and names the client that dropped it. Validate Server upgrades against a disposable data directory and port.
Restarting a shared live service is an explicit operator action, never a test or an automatic
repair step.

**The Server operator API is a different principal, not an agent escape hatch.** `/opsapi/*` is
TCP-loopback-only and authenticates only the `0600` `ops-token` bearer; browser cookies, the
operator password, proxy headers, and node tokens never substitute for it. Keep agent
canvas-control creator ownership strict. A dead-card sweep requires two definitive absent-pane
probes, preserves `unknown` on every read failure, and shares one mutation engine with the periodic
reaper. Server-owned operator and agent workspace transactions also share one FIFO; separate
load/save queues can overwrite each other with stale snapshots. `/opsapi/health` must snapshot
spawn-handler state without awaiting the preparation or parallel external launches it diagnoses;
timed-out non-cancellable launches remain visible until they actually settle. Credentials still
never ride argv — operator clients feed curl headers via stdin or another non-argv channel.

**A Server Edition message is not submitted just because tmux accepted Enter.** A fresh agent
composer can render a pasted envelope before it is ready to consume the submit key. Capture the
composed pane after Enter; if it did not advance, send one bounded retry and capture again. The
target's verified next-turn hook remains the delivery receipt. Never report the paste as delivered
 from a successful tmux command alone, and never loop Enter against somebody else's composer.

**A plain terminal is not a Claude node.** It may carry the generic node/endpoint wiring needed for
a hand-launched agent to report hooks, but it gets no `NODETERM_AGENT_ID` and no
`NODETERM_CANVAS_CONTROL` until the serialized node explicitly names an agent.

**Re-validate hand-editable values at the point of use**, not by their TypeScript type. Settings
come from git-shared JSON and can end up interpolated into a shell command line.

**Test generated shell for real.** If you generate a shell command, run it under an actual
`/bin/sh` against a fixture tree. A composed fixture will not tell you that `echo ##MEM` prints an
empty line because `#` starts a comment.

**A shared agent daemon is live-session infrastructure.** Codex's app-server control socket is
shared by every `--remote` TUI in an account scope, so stopping or replacing one daemon disconnects
every attached canvas node. A managed launcher must keep the already-bound thread under a bounded
supervisor: resume only when protocol health failed or the known socket generation changed, never
loop an unrelated client error, and never replay the original prompt after reconnect. Probe a
responsive daemon before invoking lifecycle repair; stale PID bookkeeping is not permission to kill
working sessions. See `docs/shared-codex-node-identity.md`.

**Credentials never ride argv — local or SSH.** Not a tmux `-e` pair, not `curl -H`, not a remote
command string. `/proc/<pid>/cmdline` is mode 444 on a stock Linux, and a remote command line is argv
on the host too: we shipped the hook bearer that way and any other account on the machine could read
it and open a terminal running an arbitrary command. Pass secrets by 0600 file or by **stdin**
(`curl --config -`), and never add an argv fallback. See `docs/node-identity.md`.

**Both raw listeners change together** — `src/main/index.ts` and `src/server/agent-status.ts`. A new
field on a hook event that reaches only the desktop leaves the Server Edition quietly without the
feature, and the boundary tests can only tell you an import is wrong, never that a field is missing.
The same applies to any hook-server signature change; this repo has shipped one to a single shell
three times.

**A rule enforced at one mint site is enforced nowhere.** Nodes are created on two surfaces — the
canvas (`createAgentNode`) and the phone's `projects.registerNode` (`appendProjectNode`) — and a
constraint spelled out inline at one of them silently does not exist at the other. "Which agents
bind a managed account" lived as a ternary in the renderer while the phone leg wrote whatever the
wire sent.
Put the rule in one predicate under `src/shared` and have every mint site ask it, and derive the
things that follow from it (a node's color, say) from that same call rather than re-deriving the
condition per caller.

**Do not take scrolling away from tmux.** It owns the mouse, the scrollback and the alternate
screen. A previous design moved that into the emulator and failed structurally; `CLAUDE.md` explains
why in detail.

**Keep renderer terminal memory separate from tmux history.** tmux may retain 50,000 operator-
scrollable lines outside the browser process; each mounted xterm is capped at 2,000 lines and an
offscreen xterm is released after one minute by default. Raising the renderer cap multiplies across
every terminal card on the active canvas; do not couple it back to tmux's retention setting.

**A spawn-env write does not reach a tmux session on its own.** The shared tmux server takes each
new session's env from its own GLOBAL env (inherited from whichever client *started* the server) —
the creating client's process env only matters for names listed in `update-environment` (or passed
as non-secret `-e` pairs). Setting `env.FOO` in `pty-manager` therefore works for the plain-shell
fallback and for the one client that happens to start the server, and silently does nothing (or
worse, leaks the server-starter's value into everyone else) after that. That is how issue #419
shipped: managed-account `CLAUDE_CONFIG_DIR` leaked into system-account sessions. New per-session
env either joins `ACCOUNT_SCOPE_UPDATE_ENV` / the gateway list, or rides `-e` — and gets a
real-tmux test (`account-env.realtmux.test.ts` is the pattern).

**Do not hold a workspace transaction lock across PTY or subprocess work.** Save and publish the
durable node while serialized, release the lock, then start external work behind a bounded deadline.
PTY creation is not cancellable: a timeout must preserve the card, report that the operation may
finish late, and tell the caller not to repeat. Any capability promise used on this path needs its
own bounded fail-safe; an edition-specific `false` answer must not be replaced with a getter whose
initializer that edition never runs. When close can race the unlocked external phase, retain a
per-node cancellation until the late operation settles and destroy its exact backend again; the
first destroy may have run before anything existed.

**A new keyboard chord has to survive the shells, not just the renderer.** The application menu is
ours (`buildAppMenu` in `main/index.ts`), but its command-style accelerators — ⌘Q, ⌘M, ⌘W, ⌘0, ⌘⇧B,
⌘, — are still handled above the page, so your `keydown` branch simply never runs: steal the chord
back in `main/keydown-intercept.ts`'s `before-input-event` allowlist and forward it, like the three
already there. Two legs stand the menu down instead of stealing — the terminal-first policy and an
armed shortcut recorder (`menuStandsDown` → `menuItemIdsToSuspend`, since a disabled item suppresses
its accelerator) — and Reload (⌘R / ⌘⇧R) is the named exception that always stays with the app,
because it is the crash-recovery lever. Browsers own a different set. And any chord that reaches the canvas needs the two refusals every canvas shortcut
here has: not while the kanban board covers it, not while the user is typing.

**A new chord needs no edit to the shortcuts panel — and must not get one.** `ShortcutsPanel`
derives its whole inventory from `COMMAND_DEFINITIONS` (section per `CommandGroup`, label from
`def.title`, chord from the EFFECTIVE binding), so adding a registry command is all it takes to
make it show up; a command with no effective binding is omitted rather than listed chord-less.
`ShortcutsPanel.test.tsx` is the watchdog and reds if a command fails to surface. The panel it
replaced hand-listed 24 ids against a 45-command registry and had drifted four live chords behind
— if you find yourself typing a command id into that file, that is the bug reappearing.

**Comments explain WHY, and name the failure they prevent.** The codebase is deliberately dense with
reasoning. A comment that restates the code is noise; one that says "do not simplify this back,
here is what broke" is the point.

**A generated sh client reads its node token through the one resolver.** Every POSIX-sh client we
emit (the managed hook script, `nodeterm.sh`, `context.sh`) presents this node's per-node identity by
calling `nt_read_node_token` from `core/agents/node-token-sh.ts` — never by re-typing
`head -n 1 "$NODETERM_NODE_TOKEN_DIR/$NODETERM_NODE_ID"`. That copy was issue #384: a session is
pinned for life to the endpoint FILE path it got at tmux creation, so a client that trusts only what
that file advertises presents nothing forever when the file is old or unreadable — and because the
hook script alone could heal itself, the same node proved itself through one client and was refused
through another for the life of the session.

**Local generated sh clients resolve shared-Codex identity before their env gate.** A reused
account-scoped app-server can give a tool shell absent, incomplete, or complete foreign
`NODETERM_*`. Always look up its exact thread/account binding: recover incomplete context, accept
matching complete context, preserve complete direct launches only when records are absent, and
refuse conflicts or existing invalid/unreadable/ambiguous evidence by name before transport.
Complete means a valid node and endpoint plus any nonempty client `NODETERM_CANVAS_CONTROL`;
agent-role metadata and `NODETERM_SERVER_CANVAS_CONTROL` are not substitutes. Recovery clears
inherited transport/credential fields before loading the bound endpoint. Managed hooks must pass
`'hook'` to `codexThreadIdentityResolverSh` so refusal drains stdin and exits 0 with empty stdout;
commands exit 1. The shell checks protected-record shape/scope, not HMAC signatures. See
`docs/shared-codex-node-identity.md` for account semantics and exact comparisons. Keep the SSH shim
constants machine-neutral: a local record root must never be baked into a remote host's copy.
**Local generated sh clients recover shared-Codex identity before their env gate.** A Codex tool
shell is forked by the account-scoped app-server, so it has `CODEX_THREAD_ID` but not the pane's
`NODETERM_*`. Managed hooks, local `nodeterm.sh`, and local `context.sh` must prepend
`codexThreadIdentityResolverSh(codexThreadIdentityRoot())` before checking `NODETERM_NODE_ID` or
`NODETERM_CANVAS_CONTROL`. Keep the SSH shim constants machine-neutral: baking the desktop/server
record path into a remote host is both wrong and a local-layout leak. A guard test enforces that
(`remote-shim-neutrality.guard.test.ts`), because the leak is silent — the remote shim keeps
working, and nothing goes red.

**That prelude may not decide anything a pane already decided.** It exports the agent id and the
canvas-control grant the ownership RECORD carries, never constants. They used to be hardcoded
(`codex`, granted) and both are `buildPtyEnv`'s answers: a custom agent inheriting the codex harness
is `custom:<uuid>`, and the grant comes from `canControlCanvas`. If you add a field the prelude
exports, put it inside the record's HMAC and have the desktop re-derive anything that grants a
capability — never accept the client's word for that. Withhold rather than assume: a tool shell
missing a verb its pane has is a bug report, a tool shell holding one its pane was denied is a
security question.

**A shell that forwards data into these records cannot be type-checked into correctness.** A
handler that destructures the request without the new field, and a call that omits an optional
trailing argument, are both well-typed — so the feature ships inert with a green suite. Pin the
wiring at source level (`codex-identity-record-wiring.test.ts`, `hook-verified-parity.test.ts`).

**A stream error is not a throw you can catch.** When a write to `process.stdout`/`stderr` fails —
`EPIPE` down a closed pipe, `EIO` after macOS revokes a closed terminal's tty — node reports it by
emitting `'error'` on the stream a tick later, and the default for an unhandled `'error'` event is
to kill the process. The stack it carries was captured at the write, so the crash *reads* as if it
happened synchronously at your `console.log`, and wrapping that call in `try/catch` changes nothing
(measured on node 22). If you write to a stream that can go away, attach an `'error'` listener and
latch the writer off — `installLogSink` (`src/core/log-sink.ts`) is the worked example. Issue #382.

**A retry budget must measure the thing it is waiting for, and running out must be VISIBLE.** The
armed-launch loop (canvas-control `--after`, and the cold open a `--project` node gets) delivered its
held command on a flat 5 × 400 ms budget started when the *canvas* held the node — so on a cold
project switch it was spent loading the canvas, mounting the node and spawning tmux, and the launch
was abandoned before the session it was for existed. Two rules came out of issue #569: wait on a
real signal (`isSessionReady`, published by the node when its shell settles) rather than on a
stopwatch aimed at the wrong start, and never let "we gave up" live only in a `console.warn` — the
node shows it (`state/launchDelivery.ts` → the QUEUED badge's ⚠ + tooltip) and the canvas-control
reply carries it (`queued` / `queuedIds`), because a user who cannot see the failure and an
orchestrator that is told "opened" both act on a session that is not there. If you add a bounded
retry anywhere, ask what the clock actually starts on and where its exhaustion becomes visible.

**Never move the user's view on a background agent's say-so.** Canvas-control requests route by
SOURCE, and React Flow holds only the ACTIVE project's nodes — so the dispatch used to travel to the
caller's project before answering. For an OPEN that was a screen hijack: the user is looking at
project B, an agent in project A runs `open-claude`, the tab switches and A's saved viewport is
applied, so the camera appears to jump and zoom. The rule now has two tiers, both membership lists in
`renderer/lib/controlRouting.ts`: `STORE_ANSWERED_VERBS` ("no canvas is needed at either end" —
`list`, `send`, `reply`, `sticky`, `open-project`) and `canColdOpen` ("a canvas IS needed, but the
serialized one will do" — `open-terminal`, `open-claude`, `open-agent`, which write into the owning
project's stored nodes with their launch armed and report `queued: true`). Everything that acts on
nodes which already exist still travels, because it reads live state the serialized copy does not
carry. When you add a verb, decide which tier it is in — and if you change what a verb DOES, update
`buildCanvasSkillBody` / `buildCanvasControlInstructions` in the same PR, with a test that goes red
on the stale claim (`src/main/canvas-control-core.test.ts`).

**Pointing a project at a folder is a WRITE — probe before you bind.** A project's canvas is
written to `<cwd>/.nodeterm/project.json`, so the moment a project gains a `cwd` the next autosave
owns that file. "Open folder…" always probed and adopted; "Set folder…" (tab ⌄) used to bind
unconditionally, which overwrote a canvas a teammate had committed to that repo — their nodes gone,
no backup, nothing on screen. Both entrances now share the rule (`renderer/lib/setProjectFolder.ts`):
an occupied *or unreadable* project file refuses the bind and says why. The store's "never
blind-write" guard will not save you — it only refuses an EMPTY canvas over a populated file.

**Every workspace entry is a REF — content in a file, machine-local state on the entry.** There are
three kinds and they now share one shape: a folder ref (`<cwd>/.nodeterm/project.json`, git-shared),
an SSH ref (the same file on the host, with an offline `cache`), and a cwd-less canvas
(`userData/inline-projects/<id>.json`, with the entry's `project` field kept as a cache for one
release so an older build still reads it). Two habits follow. **Content goes in the file; anything
this machine would legitimately disagree with another machine about — project id, viewport, default
account, breadcrumbs, closed-session history, per-node `shell` — goes on the index entry**
(`IndexEntryV3`), or a `git worktree add` / a second instance hands one machine's state to another.
And **`workspace.json` is one file with last-writer-wins semantics, so it may not be the only home
of any content**: that is precisely what let a second app instance erase a cwd-less canvas. Between
two instances the arbiter is the file's `rev` — a lower rev never overwrites a higher one — and
there is no merge; if you add a fourth kind, give it a file and say which rev wins.

**A project with no folder is a real project — degrade explicitly, never silently.** "New project"
creates a cwd-less canvas, so every folder-shaped feature meets one. Keep the affordance and
disable it with its reason (`NEW_FILE_NO_CWD_HINT`,
`WORKTREE_NO_CWD_HINT`, the Explorer/Source Control notes); a row that simply vanishes teaches
nothing, and a message that names the wrong cause ("not a git repository" for a project that has no
folder to be one) sends the user hunting a problem that does not exist.

**Agent features attach to base harness capabilities, not frontend allowlists.** A custom agent can
inherit a builtin harness, so add the capability and its one shared leaf (`src/shared/agents`) and
let every UI ask the helper. Repeating Claude/Codex/etc. cases in menus breaks that inheritance and
eventually drifts.

**Never put a raw NUL byte in a source file — write `\x00`.** Git classifies a file containing one
as *binary*, so it renders as "Binary files differ" in every diff surface (the PR page, `git diff`,
`git log -p`) and `git grep` skips it. It still compiles and its tests still pass, so nothing fails
— the file just becomes invisible to review, which is the worst way for this to go wrong. A
separator or sentinel is a fine reason to want the byte; the escape is the same byte and keeps the
file text. `src/shared/source-hygiene.test.ts` enforces this across every tracked `.ts`/`.tsx`.

**Paths cross machines, so treat `\` as a separator wherever you split one.** A value persisted in
`.nodeterm/project.json` is written by one machine and validated on another, so a guard that reads
`\` as an ordinary filename character is simply wrong about the machine that will resolve it. This
has already produced a real hole: a traversal check that split on `/` alone saw `./a\..\..\x.png`
as a single harmless segment on *every* platform. Split on `[\\/]`, and prefer accepting both
dialects while storing only one (see **Node icons** in CLAUDE.md for the worked example).

**Canvas edges are all `type: 'floating'`, and one relation gets one edge.** Never set
`sourceHandle`/`targetHandle` on an edge object — the rendered path is computed from the two nodes'
rectangles (`renderer/lib/floatingEdge.ts`), and a fixed side is what sent an edge to a node placed
left of its source looping across the whole canvas. And do not add a second edge family for a
relation a rope already carries: `--after` is a **rope** whose dashed "⏳ waits for" look is DERIVED
from the target's `pendingLaunch` (`renderer/lib/edgeModel.ts`), and the context bridge it also
writes stays hidden underneath it. One `open-claude --after` used to land three edges on one node.
`src/renderer/canvas/edge-model.source.test.ts` pins both halves.

**React Flow's `fitView` is queued, not immediate — never use it to frame something automatically.**
Calling it sets `fitViewQueued` and the fit runs from a later `setNodes` (only once every node is
measured) or the next `updateNodeInternals`, against whatever the node lookup holds by then; a fit
set that comes out empty parks the canvas origin in the middle of the screen. Compute the viewport
yourself and apply it with `setViewport` (`renderer/lib/nodeFocus.ts`, `canvas/fit-view.ts`), which
lands now and against the canvas you meant. `fitAll` is the one deliberate exception: an explicit
user gesture on a settled canvas.

**Filtering is not an access-control boundary — and only one of the four is.** What a remote client
*displays*, what an agent can *discover*, what it *loads into context*, and what it is *authorized
to control* are four different mechanisms in this repo, and only the last is security. The scoped
broadcast (`src/server/platform-server.ts`) narrows what the server volunteers to a browser tab; it
grants and withholds nothing, because that connection can still `workspace.load()` the whole index
and `pty:subscribe` to any session. Control is gated by **creator ownership**, fail-closed
(`src/core/agents/pane-ownership.ts`), and the transport by the single-user auth. Two consequences
for your PR: a display filter must be **default-open** — an undeclared client keeps receiving
everything, because a client silently starved of `agent:status` shows dead badges with no error
anywhere — and if you tighten a filter, do not describe the result as a permission. A reviewer who
believes a filter is the boundary stops looking for the real one. `docs/remote-session-scoping.md`
has the four-way table and the measurements.
**Never guess a local CLI launch flag from its version.** Probe the installed CLI's help once,
carry the answer through the shared capability bag, and refuse before node creation when a requested
option is absent. Keep the command assembler, both generated canvas-control instruction bodies, and
the operator-facing edition docs in the same PR. Capability tests must inspect help and command
assembly without starting an externally visible provider session.

**A node's status is read, never inferred from what its terminal looks like.** The six states
(`shared/node-status.ts`) have exactly two sources: the hook-fed agent-status mirror for
`working / waiting / blocked / completed`, and a PROVEN session fact — the last hook state was one
of those three live ones and `PtyManager.sessionPresence` says the pane is gone, double-checked —
for `failed`. A finished (`done`) session whose terminal was then closed stays `completed`; that is
the only state a dead pane does not change.
Everything else is `unknown`, and `unknown` is a word on the badge, never an empty header: a state
you cannot establish must say so rather than read as idle. Three consequences worth knowing before
you touch it: nothing status-derived is written to disk (that is what keeps status churn from
re-raising the Reload/Keep-mine bar), every state carries a distinct glyph *and* word so colour is
redundant encoding only, and a shell that forgets to register the pane-evidence channel boots fine
and simply never reports a failure — which is why `core/node-status-parity.test.ts` greps for both
registrations.

**Automatic layout only moves what it can prove is safe to move, and it says what it did not
touch.** The engine (`src/core/canvas-layout/`) is opt-in, default off, and machine-local — the
shared project file carries WHAT the rules are and never WHETHER they run, so cloning a repo can
never start rearranging someone's canvas. `plan()` is pure and returns `{ops, skipped}`; a node is
refused, with a reason, when it is pinned, hand-placed, in use right now, inside a loop-owned
frame, created by another authority, or simply not a delegated worker (an absent `role` reads as
`primary`, so every pre-existing canvas is untouchable by construction). **Report every refusal —
a silent skip and a bug look identical from outside.** Two rules a refactor keeps wanting to undo:
all refusal rules are re-asked at APPLY time rather than trusted from the plan (the operator may
pin, move, or start using a card while its preview is open), and the engine has no op that creates a frame, so
it can never become a second frame-creator racing the spawn path. Nothing runs on a timer, and
nothing on this path may reach a PTY.

Organizer lease acquisition serializes and refuses unverifiable persistence. Grants carry tokens;
plan-time permission is not apply-time permission. `core/canvas-layout/transaction.ts` supplies a
synchronous apply gate for the project coordinator, including revisions, ownership epochs and
complete activity evidence. Its Canvas/store/IPC integration remains required; see
`docs/organizer-transactions.md`. A leftover lease-store lock is never stolen automatically.
Clearing a border edits only that appearance subtree, preserving unrelated and unknown layout rules.

Layout events received during an asynchronous plan must be coalesced and drained, not discarded.
Capture their project identity, reject application after a project switch, and release the actual
held lease on unmount. Messaging likewise serializes admission and delivery per target; a queued
rate limit retries once its advertised delay passes, with every authorization gate rechecked and
the original expiry unchanged. Server session presence must include detached tmux sessions, and
that probe runs only after the free permission/status checks. Test fixtures disable agent-hook
and instruction installation; temporary test paths must never reach live provider homes.

## Testing

Project reconciliation must retain a committed raw common base independently of pending renderer
edits. Unknown fields need a raw-base overlay before typed serialization; a conflict preview is not
a writable resolution. The revision-bound adapters and their explicit rollout limits are documented in
`docs/project-reconciliation.md`. A successful atomic rename is not a compare-and-swap against an
external editor, and only a durable operation receipt establishes a recovered save acknowledgment.
Messaging queue changes must preserve deadlines at the actual send boundary and keep transport delivery separate from recipient work acceptance. The opt-in assignment adapter, receipt bounds, and remaining legacy integration are documented in `docs/message-delivery-integrity.md`.
Remote task context is read-only metadata. Preserve absolute observation times,
source generations and failures, and never use a filtered view as a control grant.
Browser integration must revalidate exact host, project, account and session at
focus. See `docs/remote-task-context.md` for the bounded adapter and client preferences.

`npm test` must pass, and `npm run typecheck` is the fastest gate.

Beyond that, one habit is worth more than any other here:

**Mutation-test your guards.** Delete or invert the check you just added and confirm a test *fails*.
A green suite is not evidence on its own — during one recent feature this caught nine tests that
passed with the code they were meant to pin removed, including one mutation that survived the entire
4,500-test suite because the class it touched had no test file at all.

Watch for fixtures that cannot discriminate: if every row in your fixture happens to make the
mutant's output identical to the real one, the test proves nothing while looking thorough.

**Never pin behaviour by reading source text.** `expect(SRC).toContain('...')` is the fixture that
can never discriminate: it is satisfied by code that is present *and wrong*. We shipped one —
`src/main/menu-accelerator-intercepts.test.ts` matched three strings inside the `before-input-event`
handler, and stayed green on a tree where a shared guard had moved out from under them and the bare
`0` key was swallowed app-wide. It was, precisely, red on the fix and green on the break. If a
module is untestable because it imports `electron` at the top, that is the thing to fix: lift the
decision into a pure function next to it (`keydown-intercept.ts`, `main-window.ts`,
`zoomShortcut.ts`) and press the keys.

Where a behaviour can only be verified on hardware we do not have in CI (a Mac, a real SSH host, a
GPU), say so explicitly rather than implying coverage. Several docs carry numbered device
checklists for exactly this.

**A test that reads a checked-in file must not care how git checked it out.** `.gitattributes`
declares `* text=auto eol=lf`, so every working tree is LF — but attributes only take effect on a
re-checkout, so if you cloned before it landed, run `git add --renormalize .` (or re-clone) and your
tree catches up. Windows is where this bites: Git for Windows defaults to `core.autocrlf=true`, so
without the attributes file a fresh clone had CRLF working files and `CSS.indexOf('}\n}')` matched
nothing — two suites failed on a checkout with zero local changes, and one of them reported 25 theme
tokens missing that were all present. Normalize at the read
(`readFileSync(f, 'utf8').replace(/\r\n/g, '\n')`); `src/shared/line-endings.guard.test.ts` fails on
a read that slices a `\n`-bearing literal without it.

**A test never touches a live tmux server.** You will most likely run `npm test` from inside a
nodeterm terminal, where `-L node-terminal` and `-L nodeterm-rmt` are the servers holding every
node you have open — one stray `kill-server` there ends your whole canvas, not your test. Every run
therefore gets a private `TMUX_TMPDIR` (`test/setup/tmux-sandbox.ts`), which re-points every socket
name at once. Write real-tmux suites the normal way — pick your own socket name, and use
`makeTmuxTmpdir` if you also want your own directory — and do not build an `env` object for a real
tmux without carrying `TMUX_TMPDIR` into it, which is the one way left to escape the sandbox.
`src/core/tmux-socket-isolation.guard.test.ts` holds the short allowlist of suites that name a
production socket on purpose; adding a third is a review conversation, not a checkbox.

## Pull requests

- Branch from `main`. CI runs `quality`, `CodeQL` and `Dependency review`; all three are required.
- Explain **why**, not just what. If a decision has a trade-off, name it and say what you rejected.
- If you measured something, put the numbers in — they save the next person the same afternoon.
- Say what you did **not** verify. That is more useful than a confident summary.

## Documentation

Two files, two audiences:

- **`CONTRIBUTING.md`** (this file) — what another human needs before touching the code.
- **`CLAUDE.md`** — the deep invariants, per subsystem, with the reasoning and the measurements.

**If you change or discover something other contributors must know, update this file too.** An
invariant that only lives in a commit message is one refactor away from being violated by someone
who never saw it.

The 2026-09-05 combined fork recovery source is a local prototype, not rollout acceptance.
Exactly one explicit new inline project can be created in an already enrolled local v3 index,
with exclusive virgin-file publication and separate file/index receipts. Keep partial intents
and retained index history; never infer creation from a missing base. Browser-termination
recovery and first-run/folder creation remain unsupported.
See `docs/project-reconciliation.md` for the active first-run/migration/SSH refusal boundaries
and the still-unavailable qualified message and trusted organizer-runtime integrations.
Do not restore legacy save fallback to make a fixture pass. Public organizer lease release
must carry the exact acquisition token; holder identity alone is insufficient.

Browser startup must treat unsupported license and saved-SSH reads as unavailable, not as
verified free entitlement or an empty saved-server list. The stores retain read-error state,
Canvas exposes it, and their management panels withhold unavailable actions. Bridge calls
still reject; startup hydration merely completes with an explicit unavailable result in state.
The first-run mobile announcement is valid UI: browser smoke tests dismiss its Close button.

Organizer Canvas apply/undo now uses retained operation IDs and the existing revision coordinator;
never restore direct preview application or whole-array organizer undo. Both actual shells still
lack the trusted complete activity/assignment/host-presentation adapter and visibly refuse as
`activity-and-assignment-adapter-unavailable`. Fixture success is not runtime acceptance. See
`docs/organizer-transactions.md`; post-publication uncertainty permits receipt reads, not replay.

Identified message host routes now consume explicitly pinned canonical assignment validation,
but both real shells refuse without a qualified principal/issuer/durable-intent adapter. Do not
substitute operator/browser read rights or node-token identity. ACK must match every recipient
actor field immediately around the canonical read; observed turns are not receipts. Keep message
credentials out of renderer forwarding and subprocess environments. Legacy identity claims are
rejected, not upgraded. Details and remaining client/restart gaps: `docs/message-delivery-integrity.md`.
