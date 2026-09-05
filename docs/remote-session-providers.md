# Remote session surfaces — what each provider supports, and what we can enforce

Measured on one host (WSL, `desktop-20bvenj-wsl`) on 2026-09-04 against Claude Code **2.1.257** and
Codex CLI as installed. Every number below came from a command run on that host; the commands are in the
lane's trace notes. Versions move — re-measure before trusting a row, and treat the *shape* of the table as
the durable part.

## Why this file exists

A remote client shows one flat list of every session a host has ever run. On this machine a single
`ListAgents` call returned **227 peers in 19,071 bytes**: 216 offline Remote Control sessions, **60 of them
auto-named sessions belonging to two other machines**, and **7 live here** — a 3.1 % signal ratio, with the
reply declaring itself truncated. That list has no grouping, no filter, no search and no pin.

The instinct is to assume every one of those transcripts is also entering a model's context. It is not.
Verified three ways: the live canvas has `bridges: []`; `context.sh list` from a live session answers *"No
linked nodes"*; all eight `SessionStart` hooks measure **15,126 chars ≈ 3,780 tokens and are constant in
session count**, and none reads tmux, the canvas, or any agent-status file. `Peer sessions` appears in **1 of
the 30** most recent transcripts — the one that called the tool. So this is a **discovery and naming**
problem, and the fixes below are aimed there.

## The matrix

| | grouping | filtering | search | naming | rename | pin | archive | liveness filter |
|---|---|---|---|---|---|---|---|---|
| **`ListAgents`** (in-context peer list) | **no** | **no** | **no** | inherits the session name | via the session | **no** | **no** | **no** — 216/227 offline |
| **claude.ai/code list** (provider UI) | not ours to state | not ours to state | not ours to state | same names as above | — | — | — | — |
| **`claude agents --json`** (CLI) | cwd | **yes** — `--cwd`, `--all` | no | `nameSource: derived` = cwd + 2 hex | **yes** (`formerNames` proves history is kept) | background jobs only (`jobs/pins.json`, currently `[]`) | no | **yes** — returned 6 where `ListAgents` returned 227 |
| **Claude remote-control daemon** (host side) | cwd | yes | no | job id / `dispatch.source` | — | yes, empty | no | yes |
| **`codex resume`** | cwd, **and `git.repository_url` + `git.branch`** | **yes, on by default** (`--all` is what *disables* it) | no | first prompt truncated to ~36 chars | **yes** — `set_thread_title` | no | **yes** — `codex archive`/`unarchive` | index is a 67-thread recency window over 874 rollouts |
| **nodeterm Server browser view** | project, group frame, status | yes | yes | node title, ours | yes | sidebar collapse persisted | n/a | yes — nodes map 1:1 to live tmux sessions |

Two rows deserve emphasis because they invert the obvious expectation:

- **The Claude CLI is already correct.** `claude agents --json` returned **6** at the same instant
  `ListAgents` returned **227**. The provider ships a liveness-filtered, cwd-filterable listing; the surface
  reached from a phone is the one that does not use it. The 221-entry gap is the whole finding.
- **Codex is the best-behaved surface,** despite holding the largest store: 874 rollouts (4.31 GB) and 67
  indexed threads, **zero live processes**, yet its picker is cwd-scoped by default and its `session_meta`
  carries `git.repository_url` + `git.branch` — a project identity Claude's session records have no
  equivalent of. Its context cost is 2,729 bytes of tool *definitions*, present in 3 of 250 September
  rollouts, and **no thread list has ever entered a Codex model's context on this host**.

## What we can enforce

**Naming, completely.** This is the lever, and it is the one that matters, because a list you cannot
restructure is still a list you can make legible.

- Claude accepts `-n, --name <name>` ("shown in the prompt box, /resume picker, and terminal title") and
  `--remote-control [name]`. Left alone, `--remote-control-session-name-prefix` **defaults to the hostname**,
  which is exactly where `desktop-20bvenj-zippy-crystal` comes from — and nodeterm's Server build appends
  `--remote-control` **with no name**, so we are a direct contributor to the 60 unreadable entries.
- Without a name, Claude derives one from **cwd basename + 2 hex chars**. On a host holding hundreds of
  worktrees of one repository that produces `<repo>-e4` / `-8f` / `-c0`, distinguished by two hex digits;
  and on a second account, **4 of 6 live sessions read `claude-XX`** because they share a cwd. Deriving
  identity from cwd cannot work at this scale.
- Codex exposes `set_thread_title`, and its threads are addressable **by name** (`codex archive <name>`). It
  is unused today, and **12 of 67 threads share 2 names**.

**Feature-detect, never assume.** An unrecognised flag does not degrade — it makes the CLI exit and takes the
launch with it. Every flag we add is probed out of the installed binary's own `--help` and **fails closed**:
unprobed or unreadable ⇒ no flag ⇒ a command line byte-identical to the one that shipped before the feature.
This is the pattern `--session-id` and `--remote-control` already use here; follow it rather than inventing a
second one.

**Liveness, correctly.** Check `procStart`, not the pid. Of 20 pid directories that existed for session
records on this host, **5 were pid reuse** — colliding with `/init`, a playwright process, the Codex
app-server and a bare `-bash`. A listing that trusts the pid alone presents unrelated processes as agent
sessions.

**Our own surfaces, entirely** — the Server's project scoping, the sessions sidebar's grouping and search,
the `list` verb's row shape, and the naming above.

## What we cannot enforce

- **The account-wide Remote Control registry.** It is server-side, spans every machine on the account, keeps
  offline sessions, and offers no grouping or archive verb we have found. 216 of 227 entries were offline.
  Naming makes it readable; nothing available to us makes it shorter.
- **The truncation.** The peer list declares itself incomplete, so any count taken from it is a floor.
- **The provider UIs themselves** (claude.ai/code, the Codex app). We document the limit; we do not work
  around it.

The supported answer to an unstructured list we do not own is a **scoped entry point that we do**: a
task-first navigator over the shared task registry, which is what `docs/plans/2026-09-04-remote-session-navigation.md`
builds.

## Three surfaces

**Desktop** and **Server Edition** both get the naming and the navigator, because the probe and the reader
live in `src/core` behind `CorePlatform`. **Mobile** (`nodeterm-ios`, separate repo) is a follow-up, not a
gap in this change: the phone attaches to tmux sessions over the transport protocol and has no task-registry
concept, so surfacing one means extending that protocol. Raised here so it is not forgotten.
