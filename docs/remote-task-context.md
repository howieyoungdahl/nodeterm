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

## Browser integration and remaining focus boundary

The existing Sessions sidebar now has a Tasks tab. It reads the actual D15
`summary` / `task` operations through `task-context:read`, the shared preload type,
and the browser WS bridge. It retains successful partial `continue` / `read_limit`
pages as well as failures. Project/task filters and explicit Next page requests
retain the producer's cursor. Replacement generations and scope changes discard
previous display rows; reads never renew the absolute observation time. A maximum
of 100 loaded rows is retained. Exact task-ID lookup can find a task outside that
window without walking every page. Each browser stores task view/sort/worker
collapse preferences locally; these do not write the canonical ledger.
Task actions and explicitly requested next-step/worker details precede the full
recorded summary, so a long evidence record cannot push those actions offscreen.
The complete summary and its qualifications remain unchanged below the actions;
this presentation order adds no reads, claims or session authority.
The sidebar waits for an active project before mounting its reader. Otherwise a
reload first queries an empty scope, then queries the hydrated project, which can
exhaust the two-read budget when two clients reload together.
Canonical continuation JSON is opaque text on the browser wire. D15 fingerprints
contain nanosecond integers larger than JavaScript's safe integer range; parsing
and reserializing those as Numbers changes the cursor and causes a false reset.
The host preserves their original JSON integer tokens and passes the unchanged
cursor text back to D15 for its complete validation.

The source is disabled unless the host configures ALL of
`NODETERM_TASK_CONTEXT_SCRIPT`, `NODETERM_TASK_CONTEXT_LEDGER`, and
`NODETERM_TASK_CONTEXT_PYTHON` as absolute host paths. These are host startup
configuration, never request parameters. The script must be the canonical D15
`context.py` alongside its own dependencies, and its publication must already
exist. This reader never publishes or repairs it. Each subprocess has a five-second
deadline, 64 KiB output cap, 64 KiB producer read budget and 48 KiB producer output
budget; the adapter caps the final page at 64 KiB. Two reads may run concurrently.

Only attached, authenticated single-user browser operators (or the desktop's
local user) can read this source. Project filters are views, not ACLs. The shared
host-only channel list refuses relay guests; no agent context endpoint is added.
Agent-scoped reads remain unavailable until the host has an authenticated
assignment principal. A browser cookie is not such a principal.

**Focus is deliberately unavailable in the registered runtime.** Current D15
publication rows explicitly exclude live inventory and creator grants; they do
not carry a complete authenticated host/boot/account/session tuple. The sidebar
shows that limitation, with no resume, spawn, typing, automatic open, or fallback
to a raw Canvas node ID. `createTaskContextService` has a shell-only `focusCurrent`
integration seam whose implementation must validate the full exact identity and
existing authorization atomically with focus of an already attached node. It
cannot return a permit for a later browser callback. Neither shell currently has
that implementation, so `task-context:focus` returns
`focus_authority_unavailable`. Positive focus tests exercise a synthetic boundary
only; they are not evidence of working browser-to-Canvas focus.

The actual-producer acceptance test opts in with `NODETERM_TEST_CONTEXT_SCRIPT`
pointing to the canonical source. It verifies the D15 source digest, creates and
publishes 320 synthetic tasks in a disposable directory, then reads them through
the authenticated WS route and browser adapter. Without that explicit source it
is reported as skipped, not as canonical integration coverage. Mounted sidebar
tests cover client preferences, pagination/reset, disconnected hosts, absolute
aging and zero Canvas/session-control calls. No installed server, provider,
private companion or phone is exercised.

## Remaining integration acceptance

1. Supply authenticated current identity and assignment authority to the host focus
   seam. Keep unknown fields unknown; do not fabricate them from task summaries.
2. Requery and validate the exact target on each explicit open, then use the
   existing authorized attach-only focus path. Do not execute a printed hint,
   submit a draft, resume a provider or create a missing pane. Recheck at focus
   after any async work so a transfer cannot race the initial validation.
3. Verify two full browser clients with different preferences, generation replacement,
   reconnect, a disposable host restart, malformed/stale pages, pagination, and
   wrong-host/account/project/session refusals. With 320 nodes, require task,
   status/next step and correct session focus within three deliberate actions.
   Filter/collapse operations must produce zero session-control calls.

Desktop and Server share the read route but still need the focus integration above.
Native provider lists cannot be reorganized by this code. The private mobile
companion needs an equivalent authenticated task-page and exact-focus protocol;
no mobile behavior is established by these tests. Browser/phone adoption and a
service build or live rollout are separate acceptance steps. Revert this source
change to undo it; it makes no registry migration or session lifecycle changes.
