# Assistant Kanban organization implementation

Placement is explicit at operator node creation. Descriptive owner, exact project,
workstream and functional role are content. Only a server creation attestation
grants eligibility. Roles map to existing column IDs per project; absent policy
or a missing column means virtual Ungrouped. No timer, title classifier, column
creation, terminal lifecycle changes or migration of existing cards.

1. Add strict shared metadata, policy and placement schemas, deterministic core
   planning, manual tombstones and renderer/file round trips.
2. Persist creation reservations, request fingerprints and bounded node receipts
   in a private server journal. Serialize journal and workspace writes in the
   existing transaction. Claim a launch durably before external work; an uncertain
   launch is never replayed. Persist assistant origin in the creator ledger.
3. Carry loaded and acknowledged revision evidence through workspace APIs and
   renderer saves. Check evidence inside the authoritative save chain. Reject a
   stale whole-workspace write before writing any project. Keep conflicts and
   unsaved edits visible, including across project switches.
4. Extend strict operator create/update, exact board inventory, allowlisted
   read-only preview, bounded audit and guarded per-node undo. Backfill has no
   apply endpoint. Publish board history after durable state with stable event IDs.
5. Add a repository-owned management client and public API/behavior documentation.
6. Test actual HTTP, store and renderer codecs with temporary data; cover restart,
   partial writes, concurrent clients, manual choices, ownership and undo. Mutate
   important guards. Run typecheck, focused/full tests (two workers), builds and
   platform/boundary checks.

Desktop shares schema, codecs, manual intent and revision fencing. Management
HTTP is Server-only. SSH retains its existing reconciliation protocol; browser
revision evidence protects the local workspace/cache. The separate native mobile
client must send manual intent and handle revision conflicts before writing these
new documents. Tests use private sockets/data, never a live service or board.
