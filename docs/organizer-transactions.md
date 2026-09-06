# Organizer transaction integration

Lease acquisition now serializes read/check/write across cooperating store instances and uses an
exclusive sibling `.lock` file across processes. A grant includes a fresh token and is returned
only after the record can be read back. Failed reads, corrupt records, failed publication and
unresolved writer locks refuse automation. A missing file is distinct from an unreadable file.
Every new acquisition, including renewal by the same holder, invalidates earlier preview tokens.
Token-aware release cannot cancel a newer grant. The legacy holder-only release remains a
cancellation operation and conveys no apply permission.

The lock is never stolen based on age. After a crash, an operator must establish that the writer
has stopped before removing its exact lock. These are cooperative integrity controls for upgraded
shells, not isolation against older clients or arbitrary writers with the same filesystem access.

`captureLayoutTransaction(plan, revision, leaseToken)` copies the approved candidate and binds it
to `{projectId, revision, inputRevision, holder, ownershipEpoch}`. `revision` is the project
coordinator's opaque content identity. `inputRevision` must advance on every relevant working-copy
edit, including an edit followed by undo. Epoch and ownership checks must come from authoritative
assignment/control evidence, never project titles, creator labels or caller assertions.

`applyLayoutTransaction(transaction, {lease, current, apply})` executes the synchronous presentation
callback only while the exact lease remains current. Inside that boundary it asks for current
state, compares all five fields, requires current source and complete activity evidence, and
checks pins, manual placement, active nodes, loop exclusions, roles and explicit ownership. It
also checks ancestors and descendants that a group refit/collapse can affect, both ends of a
reparent, missing nodes and cycles. Any refusal rejects the entire candidate before a mutation.
Exceptions from the effect or unlock propagate; they must not be treated as safe replay receipts.

The project coordinator must hold its own project transaction before entering this helper and
keep revision, epoch and input evidence stable through its conditional publication. `apply` is
synchronous and presentation-only. It must not start an asynchronous save or touch a transport.
Its `applied` result means that callback ran, not that a project was durably committed. The
coordinator supplies operation IDs, matching acknowledgments, lost-ack settlement, conditional
publication and revision-aware inverse edits.

## Registered consumer/coordinator boundary (2026-09-05)

Both shells register `canvas-layout:plan`, `:apply` and `:inverse` with the existing workspace
reconciliation coordinator. Planning retains a copied candidate and host-produced presentation
proposal by operation ID; apply accepts the ID, exact token and revision/input binding, not
caller-edited ops/nodes. The transport sender owns that preview, not its caller-supplied holder
label. Browser operator identity is never evidence of creator-agent ownership.

Publication uses the existing ProjectCommitStore writer lock, retained versions, immutable
operation receipts, displaced-file retention and exclusive publication. Conditional organizer
commits require exact current revision rather than merging a stale plan. The original validator
runs under the lease/publication boundary and is rechecked before displacement/publication.
A failed post-publication guard remains **publication-unknown**, never a safe-replay refusal.
Receipt-only settlement cannot start a write and remains available after opt-in/input/TTL changes.
Preview caches are bounded and ephemeral; a restart or eviction refuses unknown operations,
never reconstructs authority from a submitted preview. No new ownership ledger was introduced.

Canvas explicit and automatic paths call these registered routes; neither directly applies the
preview nor records an organizer whole-array undo. The history entry invokes a revision-aware
conditional inverse. Changed organizer fields conflict; unrelated edits/unknown fields survive.
Publication blocks ordinary save until the receipt settles; concurrent local edits are merged
against the original pre-operation view, including lost-ack settlement. Automatic errors and
refusals replace one dismissible visible notice instead of disappearing in an empty catch.

## Still unavailable in actual shells

**Neither shell supplies OrganizerRuntime. Actual organizer execution remains unavailable.**
The registered route returns `activity-and-assignment-adapter-unavailable`, even for an opted-in
authenticated browser. The shell must provide a trusted adapter that keeps complete cross-client
input/activity/loop/creator-assignment evidence stable through publication, with an authoritative
assignment incarnation, and a canonical host presentation transform. Existing presence focus
broadcasts and creator records do not establish that combined contract. One client's empty active
list, an authenticated operator, a project title or a persisted creator label cannot replace it.

The registered-boundary tests supply an explicit disposable runtime fixture and the existing
renderer presentation transform; their successful commit/inverse is not a production adapter.
Until the missing source is wired, real Canvas behavior is visible refusal, not successful layout.
Exact-token release is wired; durable plan recovery across restart, a real host geometry adapter,
and actual trusted-runtime/device layout acceptance remain separate work. No new-file, migration,
SSH or D07 refusal fence was weakened to support these transactions.

Appearance editing uses `withProjectBorder`, preserving unknown rule keys, versions, spawn/tray
rules and other appearance tiers. The real editor reads current project state at the click and
does not move machine-local effects/reduced-motion settings into the shared rule block. Safe
disk publication and conflict/reopen behavior still depend on the project coordinator.

Desktop and Server share these modules but need their common coordinator/Canvas integration.
Mobile has no organizer invocation in this patch; shared-file round trips, per-client display
preferences and physical-device acceptance remain separate verification. No installation,
service restart, live canvas organization, cleanup or session operation is part of this change.
