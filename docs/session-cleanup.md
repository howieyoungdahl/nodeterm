# Safe session cleanup

The authenticated Server operator can preview automatic candidates quiet for at
least one hour, or prepare a separate exact operator-reviewed cohort. An archive hides the card on the canvas, Sessions
sidebar and kanban board. Its original node, session identity, ownership, content,
scrollback and transcript files remain. Undo clears only the archive marker and
preserves later edits. There is no kill, input, resume, delete, wildcard, force or
automatic archive action in this workflow.

## Operator workflow

Use the new script from the installed source after a separately approved rollout.
The credential is the existing host's private `ops-token`; this feature needs no
new credential or permission grant. Commands run on the server's filesystem and
use direct loopback HTTP, with no proxy or redirect credential forwarding.

```sh
node scripts/nodeterm-cleanup.mjs preview \
  --url http://127.0.0.1:8443 --credential-file /absolute/data-dir/ops-token \
  --output /absolute/cleanup-preview.json
```

Review every row's exact `projectId`, `nodeId`, title, idle duration, eligibility,
generation and reason. The preview does not change a project or create a receipt.
Select only IDs whose evidence and task disposition you accept. Write this exact
request to an absolute local file (UTF-8, an optional BOM is accepted):

```json
{"planId":"UUID-FROM-PREVIEW","nodeIds":["EXACT-REVIEWED-NODE-ID"]}
```

```sh
node scripts/nodeterm-cleanup.mjs archive \
  --credential-file /absolute/data-dir/ops-token --request-file /absolute/request.json
node scripts/nodeterm-cleanup.mjs receipt \
  --credential-file /absolute/data-dir/ops-token --receipt-id RECEIPT-UUID
node scripts/nodeterm-cleanup.mjs undo \
  --credential-file /absolute/data-dir/ops-token --receipt-id RECEIPT-UUID
```

Previews expire after five minutes and on Server restart. Any observed workspace,
session generation, output, process, hook state or pending-task change refuses
the archive. Re-preview and review again; never replace a failed archive with
the old destructive sweep. At most 100 explicitly selected IDs fit one request.
Outputs are JSON; `--output` creates a new file exclusively and will not replace
an existing approval packet. Cleanup requests have a separate 64,000-byte hard bound; other management
requests keep their existing 10KiB bound.

If a response times out, its execution outcome is unknown. Do not automatically
repeat a mutation. Use `preview` to inspect each `archiveId`, or `receipts` to
list retained receipt IDs; inspect the receipt before undoing it.

## Evidence and conservative exclusions

Linux local tmux is the first runtime adapter. The probe reads exact pane and
process generations, real window output activity, current hook activity, the
terminal screen and the descendant process table. `session_activity` is an attach
clock, so it is used for change fencing, never as evidence that work made progress.
Missing, future or invalid stamps do not qualify. Titles and card creation dates
do not establish completion or inactivity.

The known completed Codex screen requires the CLI's `Worked for …` completion
footer and its exact empty `Ask Codex to do anything` placeholder. The live shell,
Codex client and persistent code-mode helper can survive completion; unknown
descendants remain work. Unknown CLI versions/prompt variants remain excluded.
The pane must also have a live Codex foreground process. A shell's prompt
punctuation cannot prove an empty input buffer or distinguish a quiet `read`
builtin. Plain shells and exited reviews with old footers remain unknown and
ineligible until a trusted shell input-boundary adapter exists. They are still
listed for review. Restored, idle-inferred or explicit done metadata alone cannot
provide that input proof; titles never supply it.

Same-PID async children require continuous task-history coverage as well. Eligible
Codex sessions need the private process marker injected by the current Server boot
and an authenticated explicit `SessionStart` with `source: startup`, a matching
session ID, and the managed hook revision 6 sender stamp. The hook captures its
Codex ancestor PID and Linux process-birth tick before backgrounding the POST.
The Server witnesses that exact foreground generation twice before enrolling it,
and every preview compares the enrolled generation. A late startup POST cannot
attest a replacement CLI in the same shell. Lifecycle epochs fence asynchronous
enrollment; a repeated, resumed or previously unknown startup never re-enrolls
the same session. Missing or unfamiliar fields stay unknown. A restart,
reconnect, resume or compaction never converts missing child history into zero.
Lifecycle events never clear unfinished child IDs or recurring work. Inherited
pre-rollout/pre-restart sessions remain listed with `child-history-unproven` and
cannot be automatically archived. No old session is resumed to manufacture proof.
The installed provider's actual `source` values still require a fresh disposable
startup/resume compatibility check before activation; synthetic fixtures do not
certify its lifecycle schema. Missing support safely yields no eligible rows.

Automatic eligibility additionally requires an immutable host-private assistant
creation/task receipt and private creator grant bound to this exact project and
node. Its verified source and stable explicit task/creation IDs must match.
Admission also requires successful Linux directory-durable acknowledgment in this
cleanup runtime. Windows visibility receipts, copied receipts, legacy receipts,
unconfirmed publications and receipts discovered only after restart cannot supply
that acknowledgment. Durable discovery still supports idempotent management;
it does not retrospectively enroll nodes for automatic cleanup.
Current-boot completion on a human-created card is still ineligible. Shared node
metadata, title, model and the shared operator principal never supply this proof.
Private receipt discovery is bounded to 1,000 files and 256 KiB per file; unreadable,
ambiguous or over-budget evidence refuses. No legacy node is adopted retrospectively.

Working, waiting, blocked, pending launch, unanswered input, child tasks and
recurring activity veto eligibility. A done parent does not finish its children.
Missing child-end or recurring evidence stays conservative. SSH, non-Linux,
ambiguous IDs/panes, unreadable probes, dead backends, unfamiliar prompts and
draft input appear in the preview with a reason and are preserved. Pending
approvals never become completed merely because the pane has been quiet.

No data acquisition, old-session continuation or shell input is needed to preview
or archive. The implementation does not retry a previously denied sweep.

## Transactions and recovery

Host writes share `WorkspaceMutationQueue`. Probes run outside that FIFO; session
leases coordinate archive with the memory reaper without holding workspace writes
over subprocess work. Cleanup operations also take an exclusive filesystem lock,
never stolen automatically. Receipts in the private
data directory precede project saves. Inverse receipt files and their Linux parent
directories are synced before project publication; a sync failure refuses it.
A prepared or undo-prepared receipt is
retained after an uncertain/partial save and can be undone after restart. Invalid
receipts or unknown targets refuse. Undo never recreates deleted IDs and never
overrides a different archive marker. Later title/position edits survive.

Publication requires PR #30's retained raw revision contract. Legacy writers
refuse with `cleanup_revision_contract_required`; there is no whole-workspace save
fallback. Preview does not enroll revisions. Authorized saves enroll one exact
caller base, validate marker-only changes and conditionally commit only selected
projects. Index bytes, sibling files and unknown metadata remain untouched.
Publication conflicts, refusals and unknown acknowledgments preserve prepared
receipts; no failed write is automatically replayed on a newer base. The actual
PR #30 writer checks the activity guard under its publication lock. The workflow
also rechecks activity after save and restores presentation on an observed race.
A recovery failure retains the receipt. No terminal is interrupted.

The current integration includes a narrow retained writer implementing the
`loadReconciled()` / `organizerCoordinator().commitOrganizer()` contract used by
PR58. It admits only archive-marker deltas over retained raw revisions. This
composition does not import PR30's older whole workspace or replace the current
organization, ownership, labels or serializer APIs. Ordinary saves retain opaque
foreign project, node and index fields while still sanitizing this version's
known fields. Reads for revision publication use a separate store: a publication
snapshot must never authorize a blind write by populating the writer's cache.

Every ordinary serialized server mutation publishes complete changed-project
content and contiguous before/after global revision evidence. The renderer merges
all changed fields and background projects before acknowledgment. It preserves
disjoint local edits, and rejects overlaps, foreign projects and broken revision
chains. Saved per-node broadcasts cannot reapply an older whole node over that
merge; browser casts cannot forge the saved-revision attestation.
Concurrent insertions preserve both lists' ordering constraints, including
unsaved manual placement; an incompatible ordering refuses adoption and acknowledgment.

Both Desktop and Server memory/session reapers use the same protection adapter.
It reads raw project files rather than a fallback empty workspace and refuses
reaping on missing, corrupt, changing or publication-locked metadata. The
Server dead-card timer also preserves archived IDs. A private host-wide file
lease keyed by socket and exact session name prevents archive/reaper races
across runtime processes. Protection is checked again while leased before any
kill. Server prepared and applied receipts also protect uncertain saves. Archiving reduces
UI clutter; it intentionally does not reclaim backend RAM by stopping processes.

If a process died holding `transaction.lock`, quiesce cleanup writers, retain and
inspect receipts and current project files, then use a separately reviewed exact
lock recovery. Session leases under the host temp directory follow the same
rule: never steal them because of age. Do not remove another owner's token.
There is no automatic receipt, transcript or history deletion.

## Surfaces and path boundary

The workflow's management routes and CLI are Server-only. No Desktop/phone
session-control API is advertised. The shared renderer respects the saved archive
marker in canvas, sidebar and board; Desktop can display the same shared project
presentation. Ordinary workspace saves preserve markers, archived nodes, their
ancestors, links and omitted board placement even when an older client does not
understand the marker. Only the audited undo writer clears it. Host loads detach
client objects from the retained index so a client's in-place edits cannot erase
the baseline before save admission.

The documented companion source is `~/projects/nodeterm-ios`; it is absent from
this checkout/host. `CONTRIBUTING.md`, `AGENT-REFERENCE.md` and
`docs/remote-sessions.md` describe that private SwiftUI client and its shipped old
phone protocol. Its actual filtering has not been verified. The shared React
renderer covers desktop, Server browser and a phone browser using that renderer;
native Swift presentation needs a reviewed companion change by @eneskirca. No new
native-phone cleanup control is advertised. Older full-workspace clients are
protected by the real host save regression, not a claim of Swift UI parity.
The shipped legacy phone host RPC also keeps existing markers and session identity
on upsert, and refuses removal of an archived node. Ordinary unarchived explicit
removal remains available. These host safeguards do not establish native Swift filtering.

CLI file arguments must be absolute in the executing host's dialect. On Linux,
`C:\\...` and `/tmp/workspace/C:\\...` are refused instead of being resolved relative
to a Linux workspace. On Windows, use an absolute Windows path. A Windows viewer
does not change the Linux server's path dialect. The platform approval service's
`AbsolutePathBuf` failure occurs outside NodeTerm; this change prevents a similar
mistake in this CLI and does not claim to repair that service.

Keep the PR draft until reviewed and activation explicitly approved. A source
revert must preserve archive markers and receipts; restore visibility with the
documented inverse before downgrading a renderer that does not understand them.

## Separate operator-reviewed presentation archive

`POST /opsapi/cleanup/reviewed-preview` accepts one exact project and 1 to 100
entries. Every entry carries `nodeId`, an explicit obsolete disposition, the
SHA-256 digest of its human task receipt, and the exact private owner digest from
a fresh preview. Allowed dispositions are `obsolete-completed`,
`obsolete-superseded`, `obsolete-paused` and `obsolete-shell`. The operator bearer
is the existing management principal. Agent/node tokens, browser cookies and
conversation credentials cannot invoke this route. No standing grant is added.

This route deliberately keeps the automatic task state unknown when hook history
is unknown. A human receipt supplies task disposition only. The independent local
Linux witness reads exact pane/root/descendant births, CPU counters, full bounded
tmux output, hook activity and private ownership. A readable full pane inventory
can witness a stopped backend, but absence alone never supplies task semantics.
Unknown ownership, SSH, ambiguous panes, pending launches, unreadable probes and
observed working tasks refuse. No process is sent input, resumed or stopped.

The reviewed plan binds the entire exact cohort. Archive rejects a subset rather
than splitting the review. The reviewed activity counter is scoped to the exact selected IDs, so retained
sessions can progress without being controlled. Automatic cleanup keeps PR58's
conservative global activity fence. Workspace revision, generation, ownership and activity
are rechecked before publication, after publication and after receipt sync. An
observed race restores only this operation's markers before success. Failure or
partial publication retains an inverse receipt. Existing destructive sweep limits,
including the five-card guard, remain unchanged; archive never invokes sweep.

A fresh packet of one to 100 exact IDs can be prepared offline after an authenticated
preview. The review JSON requires `requested: true`, `confirmedObsolete` equal to
the target count, and `targets` with exact `nodeId`, current `title`, and an explicit
`disposition` from the four values above. The audit JSON supplies unique `rows`
with `nodeId`, `projectId`, and `category`; every selected row must be `redundant`.
The helper excludes every other audit row and refuses changed titles, scope,
ambiguous or archived cards. It never contacts a server. Review the generated
packet, then obtain the separate reviewed preview and submit all its exact IDs.
The earlier 43/36 cohorts are historical; their cards must not be recreated or
their packets treated as current authorization.

```sh
node scripts/nodeterm-cleanup-review.mjs /absolute/removal-review.json \
  /absolute/usefulness-audit.json /absolute/cleanup-preview.json /absolute/review-request.json
node scripts/nodeterm-cleanup.mjs reviewed-preview \
  --url http://127.0.0.1:PORT --credential-file /absolute/data-dir/ops-token \
  --request-file /absolute/review-request.json --output /absolute/reviewed-preview.json
```

Write `{"planId":"ID-FROM-REVIEWED-PREVIEW","nodeIds":["ALL-EXACT-REVIEWED-IDS"]}`
to a new absolute request file. Submit with `archive` and the same explicit URL
and credential file. Discover receipts with `receipts`, inspect one with
`receipt --receipt-id UUID`, and restore with `undo --receipt-id UUID`. An expired,
changed or restarted preview requires a fresh read and review. Never substitute a
force sweep for a refusal.

The fencing is observational and cooperative, not an OS lock on terminal work or
an atomic filesystem CAS against arbitrary non-cooperating external writers.
Quiet external processes may do unobserved work. The reviewed semantics therefore
remain an explicit operator judgment; neither process existence nor a screen
snapshot is an authoritative task-completion hook. Recovery on an observed
external publication race requires the durable receipt. Directory sync is required
before a retained publication can be acknowledged. The current Node API has no
Windows directory-sync adapter: archive enrollment refuses explicitly before
creating history. An ordinary Windows file that has NEVER enrolled instead uses
a separately fenced visibility-only save contract. It compares the actual
displaced bytes and publishes exclusively; it does not promise retained or
power-loss durability. The same exclusive admission fence excludes retained
enrollment. Any recovery directory, pending private cleanup/enrollment evidence,
portable reconciliation metadata or archive marker forbids that path. Interrupted
ordinary Windows saves leave their exact intent/candidate/displaced bytes and
fence for explicit recovery; no age/PID stealing or overwrite fallback is allowed.
Folder saves, phone registration and explicit removal check the workspace's private
evidence directory before displacing project bytes, rather than waiting for an index refusal.
Native Windows archive and undo refuse before preparing a receipt or enrolling
files. Ordinary creation and organization remain supported: private assistant
receipts publish with exclusive links and flushed files, then record and validate
an exact acknowledgment before save or spawn. Their explicit publication guarantee
is `file-flush-visibility`, not directory or power-loss durability. Linux receipts
use `file-and-directory-sync`. The authenticated read-only creation contract exposes
this distinction as `receiptPublication`. Interrupted receipt publications retain
their intent, candidate and fence; discovery refuses adoption or automatic replay.
File sync and rename retries do not satisfy the retained archive contract.
Refused retained submitted intent is retained
exclusively under `.recovery/<file>/unconfirmed/`; it is evidence for recovery, with
explicitly unconfirmed directory durability, and never a successful receipt.
Automatic/reviewed process evidence
currently refuses outside local Linux tmux. Shared presentation still works on
Desktop and Server; native mobile filtering remains unverified.

Mobile protocol acceptance uses the actual authenticated Server WS-RPC boundary
in `test/server/mobile-cleanup-protocol.test.ts`. It checks complete archive and
undo publications, stale-save rejection, acknowledged revisions, and two legacy
client saves: one strips unknown marker fields, the other also omits hidden rows.
Both preserve the host marker, session/model identity, pins, manual board order
and assignment versions. Undo retains the legacy client's ordinary edits. The
fixture also compares the actual private tmux pane, PID and captured history.
The existing host canvas mutation suite covers older phone upserts and refuses
removal of an archived row. These are host and protocol checks, not native UI tests.

The private `nodeterm-ios` companion is maintained separately. Its board and
canvas must filter nodes carrying `cleanupArchiveId` without removing backend
sessions or history, preserve omitted fields and rows when saving, consume loaded
and acknowledged workspace revisions, and expose an explicit audited undo path.
It must preserve manual placement and order while adopting complete publications.
Native archive visibility, history navigation and undo controls still require
the companion maintainer's source and device acceptance. Legacy clients receive
the retained raw rows, so host preservation alone does not prove that their UI
hides an archive. Carry this limitation and follow-up in the publication PR.
