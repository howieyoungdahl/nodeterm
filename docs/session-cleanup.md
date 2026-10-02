# Safe session cleanup

The Server operator can preview terminals quiet for at least one hour and archive
an exact reviewed ID list. An archive hides the card on the canvas, Sessions
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
an existing approval packet. The HTTP body's existing 10KiB bound also applies.

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
data directory precede project saves. A prepared or undo-prepared receipt is
retained after an uncertain/partial save and can be undone after restart. Invalid
receipts or unknown targets refuse. Undo never recreates deleted IDs and never
overrides a different archive marker. Later title/position edits survive.

Publication requires PR #30's retained raw revision contract. Legacy writers
refuse with `revision_aware_cleanup_required`; there is no whole-workspace save
fallback. Preview does not enroll revisions. Authorized saves enroll one exact
caller base, validate marker-only changes and conditionally commit only selected
projects. Index bytes, sibling files and unknown metadata remain untouched.
Publication conflicts, refusals and unknown acknowledgments preserve prepared
receipts; no failed write is automatically replayed on a newer base. The actual
PR #30 writer checks the activity guard under its publication lock. The workflow
also rechecks activity after save and restores presentation on an observed race.
A recovery failure retains the receipt. No terminal is interrupted.

The integration deliverable is composed on PR #30's exact `b19c9cca` contract.
PR #30 (or a compatible retained-writer integration) must land before cleanup
can activate. Current main lacks that contract and the operator routes. This
adapter resolves cleanup's persistence compatibility; PR #30's broader rollout
gates remain its owner's responsibility. Do not merge this source over an
incompatible writer or independently discard the raw history/recovery records.

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
presentation, and removing the marker manually also restores visibility. The
mobile companion needs the same hide/restore presentation contract and a separate
authorized operator interface in its private repository.

CLI file arguments must be absolute in the executing host's dialect. On Linux,
`C:\\...` and `/tmp/workspace/C:\\...` are refused instead of being resolved relative
to a Linux workspace. On Windows, use an absolute Windows path. A Windows viewer
does not change the Linux server's path dialect. The platform approval service's
`AbsolutePathBuf` failure occurs outside NodeTerm; this change prevents a similar
mistake in this CLI and does not claim to repair that service.

Keep the PR draft until reviewed and activation explicitly approved. A source
revert must preserve archive markers and receipts; restore visibility with the
documented inverse before downgrading a renderer that does not understand them.
