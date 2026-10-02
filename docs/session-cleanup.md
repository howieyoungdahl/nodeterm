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
An empty local shell prompt with no job descendants also qualifies. A current,
verified explicit done hook permits the exited agent's empty shell to qualify.
Restored or idle-inferred done metadata cannot provide that proof.
An exited Codex review's known footer above its empty shell prompt supplies its
own semantic proof even after a Server restart; titles never supply that proof.

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

The legacy WorkspaceStore is not a filesystem CAS. The workflow re-reads disk
after awaited probes, checks the synchronous hook epoch and rechecks activity
after save before publishing the archive. An observed raced turn restores the
archive presentation. A recovery failure retains the receipt for inspection.
The original backend is never interrupted during those windows. Arbitrary
non-cooperative disk writes can still race publication; PR #30's revision-aware
writer needs separate integration before stronger multi-writer guarantees can be
claimed. Do not independently merge this branch over that overlapping work.

Both the dead-card timer and memory/session reaper preserve archived IDs. The
session reaper takes a session lease, rechecks protection at kill time and does no
killing if its archive-protection read fails. Prepared and applied receipts also
protect IDs when a legacy workspace read falls back to empty. Archiving reduces
UI clutter; it intentionally does not reclaim backend RAM by stopping processes.

If a process died holding `transaction.lock`, quiesce cleanup writers, retain and
inspect receipts and current project files, then use a separately reviewed exact
lock recovery. There is no age-based lock theft or automatic receipt/log deletion.

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
