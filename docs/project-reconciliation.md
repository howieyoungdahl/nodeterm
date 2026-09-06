# Project reconciliation: local integration draft

`src/shared/project-reconciliation.ts` merges portable project documents against a known common
base. Both shells use it without importing platform services. The branch now connects a durable
coordinator and caller-bound adapters through WorkspaceStore, IPC, preload, browser bridge and
Canvas. It is not ready for broad rollout: the refusal boundaries below stop workflows for which
no equivalent safe adapter exists. No installed application or running service is changed.

The merge preserves unknown JSON properties, including nested entity properties. Nodes, bridges
and ropes use stable IDs. Other arrays are atomic because their ordering or identity semantics are
unknown. Relative entity order is merged; incompatible ordering produces a separate conflict while
retaining entity edits. Concurrent incompatible creations of one ID, duplicate IDs, delete versus
edit and replay of a tombstoned node are explicit conflicts. Tombstones must come from retained
deletion evidence; the algorithm cannot infer a historical deletion from its absence today.

This is a structural merge, not a complete project-schema validator. An adapter must validate
cross-field rules such as parent cycles, edge endpoints and account/host identity before publishing
the candidate. A disjoint field change alone cannot establish those domain guarantees.

`document` is a preview while `kind` is `conflict`. A caller must never publish that preview as an
implicit Keep Local. Each conflict records its path and base/local/incoming alternatives, with
absence distinct from null. `reconcileProjectBytes` also returns the original strings, including
whitespace and invalid partial input, so a recovery writer can retain them exactly. Returning the
strings does not itself make them durable.

An older typed serializer must use `applyProjectViewEdits(rawBase, viewBase, viewLocal)` first.
Omission from both typed views means unknown, while omission only from the edited view means a
deletion. Passing a freshly serialized typed view directly as a complete raw project would erase
unknown fields. Machine-local overlays must be separated before constructing these portable views;
project capability fields remain untrusted content and never become control grants by merging.

`project-reconciliation-session.ts` is a collection of pure transition functions, not another
workspace store. `prepareProjectSave` captures a project ID, operation ID, expected revision, exact
common base and proposed bytes. It leaves the acknowledged base unchanged. A retry while pending
returns the same operation. `reconcileProjectSave` refuses a base that coordinator history cannot
establish and merges a stale proposal against current content when the common base is known.
`acknowledgeProjectSave` accepts only a matching project/operation/base receipt and rebases edits
made while saving. `already-applied` requires a durable host receipt; content equality alone does
not prove an operation ran. Project state belongs to its project across tab switches.

The host must freshly read a snapshot after capturing the renderer's expected base revision. An
observation from an older base is rejected as stale; an observation while saving stays pending.
Neither outcome authorizes writing. The caller must retain it and obtain a fresh snapshot after
the operation settles. These pure helpers cannot establish the freshness of an arbitrary external
file or authenticate a receipt. Invalid acknowledgments retain the pending operation and prior base.

## Caller and renderer integration

`workspace:load-reconciled(clientId?)` assigns a host-owned client handle and returns exact project
and index content-hash revisions, a workspace view and unsupported project IDs. Enrollment retains
the exact raw bytes and typed views returned to that caller, durably across a host restart.
Knowing a globally current revision does not enroll a stale client. These same-user protocol
handles do not replace transport authentication, project authorization or ownership checks.

`workspace:save-reconciled({clientId, operationId, expected, indexRevision, workspace})` accepts
only caller-enrolled bases. Results distinguish committed, already-applied, conflict, stale-base,
busy, publication-refused, publication-unknown and unavailable, with recovery locations. Independent
projects can commit while another is conflicted; the index is withheld until all project outcomes
succeed. A project receipt is not a whole-workspace transaction receipt. Legacy IPC saves retain
the proposal and refuse. Legacy internal saves of managed indexes and enrolled files also refuse;
unmanaged legacy internal producers still exist and are not covered by this guarantee.

`WorkspaceReconciliationClient` keeps per-project bases/conflicts and an exact pending request,
coalesces overlapping saves, retries the same request after a lost acknowledgment and fences late
pre-ack observations. Incoming unknown node additions can be adopted during a save without moving
the base; a fresh read follows its acknowledgment. Tab selection cannot resolve parked conflicts.
Canvas commits actual Flow state before capture and applies merged results back to the project
store. Field buttons choose only that field, and tombstoned identities can only remain deleted.
Index conflicts are visibly unsaved but do not yet have equivalent field-resolution UI.

`projectEntityView` explicitly lists what the current Flow serializer can express, checked against
the real serializer in acceptance tests. Unknown entity/root fields remain in raw history rather
than becoming implied deletions. Fork serializer extensions must extend this contract and tests.
Camera/history/consent and execution overlays stay local; merged capability bytes grant no control.
Host remote-node append/removal use the same coordinator. Duplicate/no-target remains false;
persistence refusal throws a named error and recovery path. Phone-side acceptance remains required.

## Preserve-then-exclusive publication

### Bounded first creation: one inline project

An already caller-enrolled local v3 index supports exactly one new inline project
per reconciled request via explicit `createInline: [projectId]`. The host derives
`inline-projects/<validated-id>.json`; absence of an ordinary project base never
implies creation. First-run index bootstrap, multi-create batches, folder adoption,
relocation, pre-file migration, SSH and relay projects remain unsupported.

The existing caller-enrollment directory durably binds the complete creation
request to its operation ID. The existing file coordinator exclusively establishes
virgin recovery history, journals an observed absence/request/candidate, and links
a separate publication file only into an absent destination. Existing files,
nonregular/redirected parents, retained history/locks and competing creations refuse;
no old file is displaced or overwritten. Shared identity/graph checks still apply.
The host vetoes IDs found in current or retained index entries/deletion evidence.
This proof reads at most 4096 retained index versions / 32 MiB; unavailable, corrupt,
legacy-shaped or larger history refuses, never truncates or garbage-collects it.

File and index receipts remain separate. The file can be durable while index
publication is busy, conflicted or unknown; no whole-workspace success is reported
and the orphan file is retained, not deleted as rollback. Index creation guards
revalidate scope at the existing durable publication boundary while retaining the
ordinary index merge for unrelated edits; organizer exact-revision CAS is unchanged.
Success requires the index receipt to contain the exact new inline entry.

The renderer keeps the exact pending request across partial results, lost ACKs,
refreshes/tab switches and host-store reopen, rebasing edits made during delivery.
Only an exact durable receipt confirms already-applied; journal-without-receipt is
unknown and never replayed. The returned load workspace is detached from enrollment
evidence so in-place UI additions cannot enroll themselves. Existing browser and
preload bridges carry the typed request through their existing channels; no new
transport principal, registry, control grant or legacy fallback is introduced.

Browser/process termination recovery is NOT implemented: the browser's pending
object is in memory. Host intent/history survives as recovery evidence, but there
is no restart UI that reconstructs that pending object. An unindexed retained file
cannot be silently created again. Other metadata/index producers and first-run
bootstrap remain distinct rollout gaps. These source fixtures establish neither
live adoption nor Desktop/phone/SSH/Windows/power-loss conformance.

`ProjectCommitStore` retains adjacent `.recovery/<filename>/` evidence on the same filesystem:
immutable versions, operation request/candidate/receipt, displaced inodes and durable tombstones.
No history or tombstones are garbage-collected. Keep this machine-local directory out of Git/sync.
The embedded `_reconciliation.deleted` metadata is portable and imported durably when observed.

1. Exclusively create a cross-process writer directory. Never steal it using age or guessed PID
   liveness. Preserve the submitted request even when the base is unknown.
2. Merge the retained base with current raw content. Refuse conflicts, identity changes, replayed
   deleted IDs, parent cycles/dangling parents and edges with missing endpoints.
3. Durably journal the candidate. Rename the actual destination into a unique retained operation
   path. This captures even an unread external write interposed after observation. Compare its
   bytes with the observed input; if different, restore only into an absent destination and refuse.
4. Create a separate publication file and hard-link it into the destination only if absent. An
   external writer filling that slot wins without being replaced. Never link the immutable candidate
   to a path an in-place editor can mutate. Refusal retains the proposal and displaced file.
5. Sync and inspect the destination, persist tombstones/version/receipt, then acknowledge. Only an
   exact durable operation receipt permits already-applied. Reused IDs with different input refuse.
   An interrupted request without a receipt is unknown, never automatically replayed.

This is not atomic read/replace CAS: there is an observable absent-file interval. A killed writer
can leave the destination absent and its lock retained; subsequent writers refuse. Recovery must
inspect request/candidate/displaced/receipt, retain any external winner and restore exclusively into
an absent destination. No abandoned-lock recovery command/UI is implemented. Do not remove a lock
or overwrite a destination merely to make autosave work again.

Ordinary index/project/data-file reads and `ProjectCommitStore.observe()` now check the existing
writer lock before and after their read. An overlapping writer gets at most four 25 ms retries,
then `E_PUBLICATION_BUSY`; a missing managed file without an active lock gets
`E_PUBLICATION_UNAVAILABLE`, not first-run absence. Readers never acquire, remove or steal a lock,
guess liveness, restore a destination, replay an operation or enroll a fabricated latest base.
Only the writer's internal observation runs inside its already-held lock. A fully read old
snapshot remains a legitimate common base if a complete publication passes between checks; this
does not make a whole workspace an atomic multi-file snapshot or coordinate raw external writers.

Reconciled loading observes the index once before assembly and passes those exact bytes to the
driver. That call returns its own index entries, independent of another load's mutable cache;
the same snapshot/typed view is enrolled together. Publication failures propagate through IPC.
Canvas retains last-good state on a failed refresh, and an initial read error is visible with a
manual `Retry workspace read` button. No hydration or autosave is enabled before a successful
initial read. An abandoned lock stays unavailable after the bounded retries until explicit
external recovery; the retry button is not lock-recovery authority.

Deterministic real-file tests pause actual publication at `displaced` for both project and index,
load through independent stores and the browser adapter, assert named refusal, then release the
writer and verify exact published revisions, retained displaced bytes and durable receipts.
Another barrier publishes a new index while assembling a previously observed one and checks the
enrolled raw/typed index pair. Mounted read UI tests cover explicit retry and no default hydration.

An editor retaining an old file descriptor can write into the displaced inode after publication.
Those late bytes survive there, but are not automatically imported or announced. External writers
can replace the destination after acknowledgment while our candidate stays recoverable. This
protects bytes from destruction by our publication; it does not make raw editors transactional.
Directory sync and exclusive links must be available; nonregular/symlink destinations refuse.
Windows, network filesystems and physical power-loss behavior have not been validated.

## Exact product choice and remaining gates

The integrator must decide whether an absent-file interval with fail-closed crash recovery is an
acceptable direct-file contract. If not, the minimal safe option is read-only versioned mutation
with retained proposals until a sole-authority publication service or suitable platform primitive
exists. Do not substitute overwrite-by-rename or silently weaken the no-loss boundary.

Remaining: safe new-file creation/legacy migration, SSH publication, relocation, remaining internal
metadata/mirror producers, index-conflict UI, pending renderer intent after termination before it
reaches the host, explicit abandoned-lock recovery, relay load scoping, cross-host identity and
ownership validation, organizer lease/apply and navigation/browser-reader composition, fork-field
round trips, rendered Canvas acceptance and real Desktop/phone/SSH/Windows/power-loss testing.
This draft must not be adopted as a complete replacement on the strength of scoped green tests.

## Evidence

`project-commit-store.test.ts` uses real disposable files and kills disposable child writers at
journaled/displaced/published phases. It tests both publication interpositions, late descriptor
writes, exact history, portable tombstones, lost acknowledgment, unknown bases and graph validity.
`test/acceptance/workspace-reconciliation.test.ts` exercises registered store handlers, the actual
browser API adapter with JSON serialization, renderer project state, real Flow serialization,
host append/removal and reopened stores. It covers separate caller bases, unknown fields/local
exec, lost ack plus host restart, pending-save append, tab switch/background save/resolution/reopen,
stale deletion and late observations. It does not mount Canvas or start a real application/device.

Bounded checks: `timeout 60s npm exec -- vitest run workspace project-node-append
project-reconciliation project-commit externalChange fs-atomic ws-bridge --maxWorkers=2`, and
`timeout 60s npm run typecheck`. An explicit `NODETERM_RECONCILIATION_EVIDENCE_DIR` retains only
synthetic fixture evidence outside source control.

## Combined fork recovery prototype (2026-09-05)

The local recovery composition retains the remote-navigation and Server branches alongside
D04/D09/D11 and PR23–25. Its actual Flow projection must preserve `controlSize`, `role`,
`taskSummary`, `taskFrame`, `pinned`, `manualPlacement`, `compactRect` and `appearance`;
the registered-store/browser-adapter round-trip test covers these together with unknown raw
fields. Canvas save retries call the reconciler and surface refusal; they never fall back to
legacy whole-file save. Public organizer lease release requires the exact acquisition token,
including delayed renderer cleanup, so a stale same-holder release cannot revoke a successor.

This composition is not release acceptance. Existing local enrolled files are the bounded
save surface; new-file creation, legacy migration, SSH and other metadata/index producers
still have explicit refusal or missing-adapter boundaries. Message receipt validation has
no canonical assignment/acknowledgment service wired into the actual delivery queue.
Organizer apply/inverse now route through conditional host publication and operation receipts,
but both real shells lack the required trusted runtime adapter and visibly refuse layout.
Injected-runtime tests are not a successful production organizer path. Task navigation/browser-reader models are not an authenticated end-to-end
Canvas route. None of source containment, unit tests or a disposable local browser fixture
establishes real Desktop/mobile/SSH/Windows conformance, lock recovery, hostile same-user
isolation or live rollout authority. Keep the retained-history/exclusive-publication fence.

A bounded browser-startup follow-up mounted the combined renderer against an isolated local
Server and existing synthetic version-1 project: dismiss the mobile announcement through its
Close button, edit a sticky, observe revision 2 with an unknown root field preserved, then
reload and read the saved text. That path passes without browser runtime errors after license
and saved-SSH startup reads gained explicit unavailable state. It does not cover new project
creation, migration, SSH persistence, full device/browser conformance or other adapters above.
