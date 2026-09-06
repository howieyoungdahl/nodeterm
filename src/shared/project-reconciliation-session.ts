/** Pure per-project transition functions for a future Canvas/store adapter. They deliberately
 * perform no IO: only a storage coordinator can attest that a commit/operation receipt is durable.
 * Keeping these transitions independent lets both shells exercise the same acknowledgment rules. */
import {
  reconcileProjectBytes,
  type ProjectByteMerge,
  type ProjectDocument
} from './project-reconciliation'

export interface ProjectSnapshot { revision: string; raw: string }
export interface ProjectSaveIntent {
  projectId: string
  operationId: string
  expectedRevision: string
  commonBase: string
  proposed: string
}
export interface ProjectCommitReceipt {
  projectId: string
  operationId: string
  expectedRevision: string
  outcome: 'committed' | 'already-applied'
  snapshot: ProjectSnapshot
}
export interface ProjectReconciliationSession {
  projectId: string
  base: ProjectSnapshot
  local: string
  deletedNodeIds: string[]
  pending?: ProjectSaveIntent
  conflict?: Exclude<ProjectByteMerge, { kind: 'merged' }>
}

/** Pure commit planning against a coordinator-supplied historical base. A client's assertion of
 * ancestry is insufficient: if history cannot establish its base, retain all bytes and refuse.
 * The coordinator must still serialize/verify publication and store the operation receipt. */
export function reconcileProjectSave(request: ProjectSaveIntent, knownBase: ProjectSnapshot | undefined,
  current: ProjectSnapshot, deletedNodeIds?: ReadonlySet<string>): ProjectByteMerge |
  { kind: 'unknown-base'; request: ProjectSaveIntent; current: ProjectSnapshot } {
  if (!knownBase || knownBase.revision !== request.expectedRevision || knownBase.raw !== request.commonBase) {
    return { kind: 'unknown-base', request: { ...request }, current: { ...current } }
  }
  return reconcileProjectBytes({ base: knownBase.raw, local: request.proposed, incoming: current.raw }, deletedNodeIds)
}

export function openProjectReconciliation(projectId: string, base: ProjectSnapshot): ProjectReconciliationSession {
  return { projectId, base: { ...base }, local: base.raw, deletedNodeIds: [] }
}

export function prepareProjectSave(state: ProjectReconciliationSession, operationId: string):
  | { kind: 'blocked'; state: ProjectReconciliationSession }
  | { kind: 'pending' | 'prepared'; state: ProjectReconciliationSession; request: ProjectSaveIntent } {
  if (state.pending) return { kind: 'pending', state, request: structuredClone(state.pending) }
  if (state.conflict || !operationId || !state.base.revision) return { kind: 'blocked', state }
  const validation = reconcileProjectBytes({ base: state.base.raw, local: state.local, incoming: state.base.raw },
    new Set(state.deletedNodeIds))
  if (validation.kind !== 'merged') return { kind: 'blocked', state: { ...state, conflict: validation } }
  const request: ProjectSaveIntent = { projectId: state.projectId, operationId,
    expectedRevision: state.base.revision, commonBase: state.base.raw, proposed: state.local }
  return { kind: 'prepared', state: { ...state, pending: { ...request } }, request }
}

function nodes(raw: string): Set<string> {
  const value = JSON.parse(raw) as ProjectDocument
  return new Set(Array.isArray(value.nodes) ? value.nodes.flatMap((node) =>
    node && typeof node === 'object' && !Array.isArray(node) && typeof node.id === 'string' ? [node.id] : []) : [])
}

function deletions(state: ProjectReconciliationSession, next: string): string[] {
  const retained = nodes(next)
  return [...new Set([...state.deletedNodeIds, ...[...nodes(state.base.raw)].filter((id) => !retained.has(id))])]
}

/** expectedRevision is captured BEFORE asking the coordinator for a current snapshot. A delayed
 * observation after the base advanced cannot silently be treated as a new external edit. */
export function receiveProjectSnapshot(state: ProjectReconciliationSession, incoming: ProjectSnapshot,
  expectedRevision: string):
  | { kind: 'stale' | 'pending'; state: ProjectReconciliationSession; incoming: ProjectSnapshot }
  | { kind: 'merged' | 'conflict' | 'unavailable'; state: ProjectReconciliationSession; result: ProjectByteMerge } {
  if (expectedRevision !== state.base.revision) return { kind: 'stale', state, incoming }
  if (state.pending) return { kind: 'pending', state, incoming }
  const result = reconcileProjectBytes({ base: state.base.raw, local: state.local, incoming: incoming.raw },
    new Set(state.deletedNodeIds))
  if (result.kind !== 'merged') return { kind: result.kind, state: { ...state, conflict: result }, result }
  return { kind: 'merged', result, state: { ...state, base: { ...incoming },
    local: JSON.stringify(result.document), deletedNodeIds: deletions(state, incoming.raw), conflict: undefined } }
}

/** Lost acknowledgments leave pending intact. Only a matching operation receipt can clear it;
 * a different tab's receipt (even with the same operation ID) cannot clear this project's edits.
 * Already-applied is admissible only when the host recovered its exact durable operation receipt. */
export function acknowledgeProjectSave(state: ProjectReconciliationSession, receipt: ProjectCommitReceipt):
  | { kind: 'unrecognized'; state: ProjectReconciliationSession; receipt: ProjectCommitReceipt }
  | { kind: 'acknowledged' | 'conflict' | 'unavailable'; state: ProjectReconciliationSession; result: ProjectByteMerge } {
  const pending = state.pending
  if (!pending || receipt.projectId !== state.projectId || receipt.operationId !== pending.operationId ||
    receipt.expectedRevision !== pending.expectedRevision || state.base.revision !== pending.expectedRevision) {
    return { kind: 'unrecognized', state, receipt }
  }
  // Rebase edits made WHILE saving against what was actually sent, not against the older base.
  const result = reconcileProjectBytes({ base: pending.proposed, local: state.local, incoming: receipt.snapshot.raw },
    new Set(state.deletedNodeIds))
  if (result.kind !== 'merged') {
    // A reported durable commit with an unusable result is still not a safe baseline. Keep its
    // pending request so recovery can ask for the same receipt without duplicating the operation.
    return { kind: result.kind, state: { ...state, conflict: result }, result }
  }
  return { kind: 'acknowledged', result, state: { ...state, base: { ...receipt.snapshot },
    local: JSON.stringify(result.document), pending: undefined, conflict: undefined,
    deletedNodeIds: deletions(state, receipt.snapshot.raw) } }
}
