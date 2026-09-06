# Remote task context integration

The registry reader accepts mechanical task bindings (`node`/`sid`) and declared
owners. Registered assignments retain their actor, epoch and supervisor separately
from the node creator. Conflicting bindings remain visible and have no open hint.
`producer-eight.json` is actual schema-2 producer output from eight synthetic tasks;
it records the producer source digest and omits unrelated task fields. It contains
no captured session text. The large mixed-provider fixture remains separate.

`buildNavigator` receives an explicit clock and optional `currentHostBootId` from
the filesystem-owning host. Observation age derives from the absolute observation;
the published age is retained as `reportedObservationAgeS`. Boot IDs decide restart
identity when available; legacy epochs are only a fallback. An unknown boot comparison
is reported as unknown. Querying or republishing cannot renew an observation.

`openActionFor` produces read-only tmux hints for known nodes. `typingAllowed` is
always false. A bare provider resume cannot preserve the account and is no longer
emitted. A process or pane classification never closes a task. `GONE`, `UNKNOWN`,
`?`, missing observations and malformed rows remain distinguishable from live work.

The core reader and CLI cap file reads at 1 MiB plus one sentinel byte and refuse
larger inputs explicitly. They do not page the entire registry. Large inventories
use the canonical producer's bounded context API through the following seam.

## Browser and agent adapter

`src/shared/remote-nav/context-page.ts` exports:

- `adaptContextPage(payload, request)`: request specifies `operation`, `scope`,
  `nowMs`, optional `limit` (default 25), `maxBytes` (default 12288) and
  `previousSources`. It preserves source generations, query time, records,
  absolute observation times, uncertainty, deferred fields and opaque continuation.
  Source replacement requires reset. An empty filtered page with a continuation
  is not the end. Input and adapted output have byte ceilings. No page is fetched
  automatically and no evidence path is opened.
- `validateOpenTarget(target, current, nowMs)`: compare clicked metadata against a
  newly authenticated observation. Exact task, node, session, provider, account,
  project, host, boot, source generation and assignment epoch must agree. Missing,
  stale, suspended or conflicting targets refuse. Success is `focus_only`, with
  `controlGranted: false`; existing focus authorization still runs afterward.
  The current observation explicitly supplies `observationState`, `conflicts` and
  `stale` as well as its absolute `observedAt`, class and assignment state.

Compact context records have no complete node registry. Feed them to a paged task
view, not `buildNavigator` with invented observations. Task/handoff queries expose
`fields` and `deferred_fields`; retrieve evidence only through the canonical bounded
evidence API and its allowed roots. The adapter is a schema/view check, not an
authentication boundary.

## Required integration patches

1. Add one authenticated request route and matching shared IPC, preload and browser
   bridge member. The host selects the configured source and current boot identity;
   a client must not choose an arbitrary file. Pass operation, scope, cursor and
   bounded limits to the canonical query. Preserve failure codes and continuation.
2. Extend the existing sessions sidebar with task grouping. Show project, task,
   director, next step and collapsed workers with their blockers. Supply `task_id`
   to discovery rows. Agent defaults come from assigned project/task; broader reads
   require independent permission checks. Display filters do not grant discovery,
   transcript or control access.
3. Store view, sort and collapse per browser client in local storage with
   `normalizeViewPrefs`; the legacy sibling `view-prefs.json` helper is for a single
   local client only. Shared pins, promotions and closure use the registry writer.
4. Requery and validate the exact target on each explicit open, then use the
   existing authorized attach-only focus path. Do not execute a printed hint,
   submit a draft, resume a provider or create a missing pane. Recheck at focus
   after any async work so a transfer cannot race the initial validation.
5. Verify two browser clients with different preferences, generation replacement,
   reconnect, a disposable host restart, malformed/stale pages, pagination, and
   wrong-host/account/project/session refusals. With 320 nodes, require task,
   status/next step and correct session focus within three deliberate actions.
   Filter/collapse operations must produce zero session-control calls.

Desktop and Server share these pure modules but still need the integration above.
Native provider lists cannot be reorganized by this code. The private mobile
companion needs an equivalent authenticated task-page and exact-focus protocol;
no mobile behavior is established by these tests. Browser/phone adoption and a
service build or live rollout are separate acceptance steps. Revert this source
change to undo it; it makes no registry migration or session lifecycle changes.
