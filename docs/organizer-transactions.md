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

Remaining integration:

- Both shells must capture the trusted revision/epoch with the planning input, retain the
  canonical candidate by operation ID, and validate it at commit. Never accept a caller-edited
  plan as authority. Recheck the machine-local opt-in at this boundary.
- Canvas preview and automatic triggers must use this path instead of direct
  `applyLayoutPlan`/whole-array undo. A project switch or changed input invalidates the candidate.
  Return bounded visible refusal/error receipts for automatic triggers as well as explicit ones.
- Aggregate activity across connected clients; missing/stale observations remain incomplete.
  Wire authoritative loop/task membership and explicit creator-control checks. Status unknown
  must never mean free to move.
- Pass the exact token through release IPC. Keep operation/epoch evidence across retries and
  provide a conditional inverse that preserves intervening user work.

Appearance editing uses `withProjectBorder`, preserving unknown rule keys, versions, spawn/tray
rules and other appearance tiers. The real editor reads current project state at the click and
does not move machine-local effects/reduced-motion settings into the shared rule block. Safe
disk publication and conflict/reopen behavior still depend on the project coordinator.

Desktop and Server share these modules but need their common coordinator/Canvas integration.
Mobile has no organizer invocation in this patch; shared-file round trips, per-client display
preferences and physical-device acceptance remain separate verification. No installation,
service restart, live canvas organization, cleanup or session operation is part of this change.
