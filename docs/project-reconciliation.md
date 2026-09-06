# Project reconciliation primitives

`src/shared/project-reconciliation.ts` merges portable project documents against a known common
base. Both shells can use it without importing platform services. The current runtime uses only
the small external-change classifier correction in this change: breadcrumbs, capability answers
and closed-session history no longer count as shared-file edits. The three-way and acknowledgment
helpers are not yet connected to WorkspaceStore, IPC or Canvas.

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

Integration still requires a reviewed storage/publication protocol, durable base and receipt
history, tombstone retention, field-level resolution UI, legacy-client fencing, and adapters for
Desktop and Server. Atomic filesystem replacement is not compare-and-swap with an external editor.
The same-user coordinator's cooperative guarantees must be stated separately from Git/editor and
direct-SSH writers that do not honor its coordination. Mobile uses a separate registrar and needs
protocol/device acceptance; the fixture uses the real host append helper but starts no phone or
terminal. No installed or running application is updated by these primitives.
