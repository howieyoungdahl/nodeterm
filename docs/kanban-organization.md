# Assistant Kanban organization

New operator-created terminal cards can opt into deterministic placement. The request supplies a
descriptive owner, exact NodeTerm project ID, workstream and functional role. A project policy maps
functional roles to **existing column IDs**, with optional exact workstream/role overrides. Neither
titles nor model names affect placement. Renaming a column retains its route; a missing policy,
board, role or column leaves the card in virtual Ungrouped. No columns are created or renamed.

There is no timer, startup migration or automatic reshuffling. Existing cards do not become
eligible by acquiring labels. The private creator ledger must attest opt-in at new-node creation,
and the private journal must match that exact node/project/origin. The shared `ops-operator` label,
an owner string and hand-edited project metadata confer no permission. Primary cards, unknown
ownership, pins, manual canvas placement and changed assignment provenance are protected.

Moving a card manually, changing only its order, or choosing Ungrouped writes a durable manual
tombstone. Choosing Ungrouped again counts even if the card already has no assignment. Removing a
column marks its affected cards manual too. Organization cannot reclaim those choices. New
automatic cards append without reordering other cards; metadata updates change only the target
assignment and organization fields. A metadata edit resolving to the same column preserves the
exact assignment and position. IDs, geometry, parent frames, CLI options and sessions survive.

The workstream/role chip appears on the terminal header, board card and card modal. Its tooltip
shows the descriptive owner and automatic/manual status. The chip does not prove ownership.

## Policy and creation

First inspect `GET /opsapi/boards` for exact project/column IDs and the current project `revision`.
The response includes saved assignments and policy, never creates a board, and does not inspect
terminal panes. `GET /opsapi/nodes` additionally exposes `organization`, `columnId`,
`assistantCreated` and project `revision` alongside existing inventory fields.

The following is a **template**, not a global mapping. Replace every ID with the approved IDs from
that project's inventory. Role/workstream comparisons are exact and case-sensitive.

```json
{
  "version": 1,
  "projectId": "project-example",
  "roles": {
    "ops": "existing-column-ops",
    "security": "existing-column-security",
    "deliverable": "existing-column-deliverable"
  },
  "overrides": [
    { "workstream": "seo", "functionalRole": "ops", "columnId": "existing-column-deliverable" }
  ]
}
```

`POST /opsapi/nodes` retains `projectId`, `cmd`, `cwd`, `title`, `width` and `height`. It accepts:

| Field | Contract |
|---|---|
| `organization` | Exact `{owner, projectId, workstream, functionalRole}`; opts the new worker card in. |
| `idempotencyKey` | 8–128 letters/digits/`.`/`_`/`-`; required for organization creation. Generate once per logical create. |
| `organizationPolicy` | Optional exact policy above; requires organization and `expectedRevision`. |
| `expectedRevision` | Current 64-character project digest; required when configuring policy, optional otherwise. |

Organization creation requires an explicit `projectId` matching metadata; no active-project
guessing. Policy version is 1; at most 64 roles and 128 exact overrides. Owner is 1–160 printable
characters; workstream/role are 1–80 letters/digits/`.`/`_`/`-`. Unknown nested/top-level keys and
prototype keys reject. SSH/unavailable projects reject rather than target another host.
The management JSON body/client input is capped at 10 KiB, including policy and command fields.

Within the shared workspace transaction the Server reserves the node ID and request fingerprint,
persists creator opt-in, saves the node/assignment and receipt, then durably claims launch. PTY and
initial command work cannot start before the ownership ledger's atomic write finishes. Flush waits
for an already running background write and rejects failed publication; a retry must reach disk.
External work runs after that queue releases. Successful create returns `201` with `id`,
`projectId`, `tmuxSession`, `idempotencyKey` and organization; a replay also returns `replayed:true`.
The key fingerprint covers all supplied creation fields, including command and revision. Changed
fields with the same key return `409 idempotency_key_reused`. JSON field ordering is immaterial.

Retries retain the reserved ID after complete/partial save failures. A claimed launch is never
replayed after timeout, crash, spawn or delivery failure. The 30-second deadline may leave a late
PTY running; it cannot deliver the initial command after that deadline. Partial responses retain
the original ID/key. Inspect `GET /opsapi/creation-receipts/<key>` for `stage` and `outcome`; it is
read-only. An uncertain result requires inspection, not a new key or automatic retry. Legacy
keyless creation receives a generated key; clients should supply one so a lost response is safe.

## Managed updates, preview and undo

`PATCH /opsapi/nodes/<id>` accepts `{organization, expectedRevision, organizationPolicy?}` for a
reliably attested, still-automatic worker. Organization cannot be combined with rename/resize.
The current project revision must match; `force=1` cannot bypass organization ownership or manual
intent. Missing/dangling/changed placement evidence returns a conflict. Installing a policy here
affects this update and future opted-in creation; it does not move other cards.
The private journal tracks current expected positions separately from historical receipts. A
committed automatic move adjusts expected sibling indices without changing their receipts or
manual status. An existing assignment referencing a deleted or duplicate column refuses further
automation; the missing-column Ungrouped fallback applies to new placement decisions.
Unexplained order drift, duplicate assignments, missing evidence and unresolved
project writes conservatively refuse automation. An unrelated direct file/manual edit that shifts
a card's index can require explicit operator resolution; the server never rearranges cards to
recover evidence.

`POST /opsapi/organization/preview` accepts exactly:

```json
{
  "projectId": "project-example",
  "entries": [
    {
      "nodeId": "explicit-node-id",
      "metadata": {
        "owner": "Directory assistant",
        "projectId": "project-example",
        "workstream": "directory",
        "functionalRole": "ops"
      }
    }
  ]
}
```

The preview returns `dryRun:true`, project revision and deterministic plans/reasons. Entries are an
explicit, unique allowlist of 1–100 nodes; only reliably attested creation/placement evidence is
eligible. It writes nothing and launches nothing. There is **no bulk apply/backfill endpoint**.
Applying a reviewed backfill requires separate concrete operator approval covering its node IDs,
metadata and destinations, then individual CAS updates against freshly checked revisions. An
`apply` field on preview is rejected. Do not translate all operator cards into an allowlist.

`GET /opsapi/nodes/<id>/organization-audit` returns at most 20 receipts for that node. Each contains
exact before/after assignment and order anchors, the organization marker, operation/time, and
committed/published/undone flags. It contains no arbitrary workspace snapshot, credential,
command, transcript or coordination text. Use non-secret descriptive labels.

`POST /opsapi/nodes/<id>/organization-undo` takes `{receiptId, expectedRevision}`. Only the latest
eligible committed receipt can be undone. It rechecks creator evidence, current marker, column,
card position, worker role, pins and manual intent. It restores that card's assignment/order using
saved neighbors while preserving unrelated edits and relative card order. A removed destination
or drift rejects. Undo creates a new receipt and records a manual choice, so organization cannot
reapply it. It never starts, stops or sends to a terminal.

An interrupted metadata/undo write reports `503 organization_write_uncertain_inspect_audit_before_retry`
with the node ID. Reload inventory/audit before retrying with a fresh revision. A matching pending
receipt can be finalized from exact persisted content without another move; a completely failed
write can be retried from the unchanged prior receipt. Changed content refuses recovery.

Board history publication follows durable state. Stable receipt IDs deduplicate log retry.
`POST /opsapi/organization/retry-events` retries at most 100 pending events and returns the remaining
count; it cannot place cards or launch sessions. Unpublished/uncertain receipts are never evicted
to satisfy the per-node limit. The journal retains up to 25,000 creation keys and 32 MiB, refuses
when full, and treats corrupt/unreadable or previously initialized-but-missing history as a
failure. Keys are not silently expired or reset on restart. Back up the journal, its initialization
marker and creator ledger together; deleting history is not a recovery procedure.
Current placement evidence is bounded to 25,000 nodes and contains only project/node/receipt IDs,
column IDs and indices, with no workspace snapshot. Browser publications apply only changed
placements against the loaded baseline, keeping local manual choices and untouched relative order.

## Repository management client

`scripts/nodeterm-organization.mjs` uses the existing management `ops-token`, not conversation
credentials. It neither provisions credentials nor changes settings. The credential file must be
private and owned by the caller on POSIX; it is opened without following symlinks. Bearer bytes stay
in memory and out of argv/output. Only loopback HTTP is allowed. Use an explicitly approved target.

```sh
node scripts/nodeterm-organization.mjs boards \
  --url http://127.0.0.1:8443 --credential-file /protected/path/ops-token
node scripts/nodeterm-organization.mjs create \
  --url http://127.0.0.1:8443 --credential-file /protected/path/ops-token \
  --body-file /protected/path/reviewed-create.json
node scripts/nodeterm-organization.mjs receipt \
  --url http://127.0.0.1:8443 --credential-file /protected/path/ops-token --key create-example-0001
```

Commands are `boards`, `create`, `update --node ID`, `preview`, `audit --node ID`, `undo --node ID`,
`receipt --key KEY`, and `retry-events`. JSON commands accept `--body-file` or stdin. Creates require
a key. Response JSON, including partial IDs, goes to stdout; HTTP rejection exits 2, client failure
exits 3. Requests time out after 35 seconds and are never automatically retried.

External helpers can call this repository client as a subprocess and put reviewed JSON on stdin,
or add the exact fields/routes above to their existing authenticated management transport. Keep a
single key and identical body for one creation across retries; inspect receipts after transport
failure. Do not put commands or credentials in generated shell arguments. No external helper file
needs modification to use this client.

## Browser and platform behavior

Workspace loads/saves carry storage revision evidence. The authoritative store compares it before
writing any active or background project. A stale browser/tab cannot erase a Server organization
write or another tab's edit. The UI keeps unsaved edits visible, stops autosave, and offers Reload
or Keep local edits. Keep preserves local edits, incoming organization/new cards and independent
manual moves using the loaded board baseline; overlapping manual choices prefer the explicit local
choice. Reload adopts saved content while retaining newly registered open nodes. Ordered Server
organization broadcasts merge and acknowledge their digest chain; missed broadcasts force a
conflict. Loads retry if the file set changes during reading, and save acknowledgments verify the
published bytes. A failed read/save or missing acknowledgment is never treated as success or
absence. Older clients without revision evidence must reload the updated UI before saving; a
new renderer connected to an older host also refuses that host's missing revision acknowledgment.
Other writers without an acknowledged revision chain conservatively trigger conflict resolution
on the next whole-workspace save; they cannot silently advance browser evidence.

Desktop shares codecs, badges, manual board intent and the real IPC save fence. Automatic creation
and management HTTP are Server Edition features. Local/inline projects are supported. SSH keeps
its existing remote-file reconciliation; the new fence covers the local index/cache and does not
claim cross-host CAS. Relay clients forward real workspace calls to their owning host. Windows
paths remain opaque content; private state uses the existing atomic publication/retry utilities.

The private Swift mobile companion (`nodeterm-ios`) is outside this repository. Saved assignments
remain readable; mobile writers must preserve organization fields/manual tombstones, record manual
choice versions and carry loaded/acknowledged revisions or use host-controlled mutations. Legacy
raw-file writers do not gain server provenance, and assignment drift is never reclaimed, but this
PR cannot add CAS to that private client's direct filesystem writes. Mobile follow-up: @eneskirca.
