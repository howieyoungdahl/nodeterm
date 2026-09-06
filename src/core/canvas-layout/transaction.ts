// Presentation effects use the project coordinator's revision and ownership epoch. This module
// owns no project storage, identity registry or IPC. Its synchronous callback is the seam the
// coordinator calls while serializing its conditional project commit.
import type { LayoutNode, LayoutPlan, LayoutSkip } from '../../shared/canvas-layout'
import { refuse, refusalContext } from '../../shared/canvas-layout-refusals'
import type { LayoutLeaseStore } from './lease'

export interface LayoutRevision {
  projectId: string
  /** Opaque committed-content identity from the project coordinator, not project.json's rev. */
  revision: string
  /** Changes for every relevant edit to the working canvas/rules, including changes then undo. */
  inputRevision: string
  holder: string
  /** Current assignment incarnation. Creator metadata is not evidence of this epoch. */
  ownershipEpoch: string
}

export interface LayoutTransaction {
  fence: LayoutRevision & { leaseToken: string }
  plan: LayoutPlan
}

export interface LayoutApplyState extends LayoutRevision {
  enabled: boolean
  source: 'current' | 'stale' | 'unknown'
  /** Includes other connected clients. A local empty active list is not complete evidence. */
  activityComplete: boolean
  nodes: readonly LayoutNode[]
  actives: readonly string[]
  loopFrames: readonly string[]
  /** Undefined means unknown authority, never permission over all nodes. */
  owns?: (nodeId: string) => boolean
}

export type LayoutApplyOutcome =
  | { kind: 'applied'; plan: LayoutPlan }
  | { kind: 'unchanged'; plan: LayoutPlan }
  | { kind: 'refused'; reason: string; skipped?: LayoutSkip[]; holder?: string }

/** Capture by value: editing the request or preview afterwards cannot silently change the plan. */
export function captureLayoutTransaction(
  plan: LayoutPlan,
  revision: LayoutRevision,
  leaseToken: string
): LayoutTransaction {
  const { projectId, inputRevision, holder, ownershipEpoch } = revision
  return {
    plan: structuredClone(plan),
    fence: { projectId, revision: revision.revision, inputRevision, holder, ownershipEpoch, leaseToken }
  }
}

export function validateLayoutTransaction(transaction: LayoutTransaction, current: LayoutApplyState): LayoutApplyOutcome | null {
  const reject = (reason: string): LayoutApplyOutcome => ({ kind: 'refused', reason })
  if (current.enabled !== true) return reject('disabled')
  if (current.source !== 'current') return reject(`source-${current.source}`)
  for (const key of ['projectId', 'revision', 'inputRevision', 'holder', 'ownershipEpoch'] as const) {
    if (typeof current[key] !== 'string' || !current[key] || !transaction.fence[key]) {
      return reject('source-unknown')
    }
    if (current[key] !== transaction.fence[key]) return reject(`stale-${key}`)
  }
  if (current.activityComplete !== true) return reject('activity-unknown')
  if (!Array.isArray(current.nodes) || !Array.isArray(current.actives) || !Array.isArray(current.loopFrames)) {
    return reject('source-unknown')
  }
  if (!current.owns) return reject('ownership-unknown')
  if (transaction.plan.stoodDown) return reject(transaction.plan.stoodDown.reason)

  const context = refusalContext({ ...current, owns: (id) => current.owns?.(id) === true })
  if (context.byId.size !== current.nodes.length) return reject('invalid-hierarchy')
  // Refits can move ancestors and siblings, and collapsing a frame hides its descendants.
  // Validate the whole affected tree, including both ends of a reparent, before any operation.
  const affected = new Set<string>()
  const includeTree = (id: string): boolean => {
    const ancestors = new Set<string>()
    let cursor: string | undefined = id
    while (cursor) {
      if (ancestors.has(cursor)) return false
      ancestors.add(cursor)
      const node = context.byId.get(cursor)
      if (!node) return false
      affected.add(cursor)
      cursor = node.parentId
    }
    return true
  }
  const parents = new Map(current.nodes.map((node) => [node.id, node.parentId]))
  for (const op of transaction.plan.ops) {
    if (!includeTree(op.nodeId)) return reject('invalid-hierarchy')
    if (op.op === 'reparent' && op.parentId !== null) {
      if (context.byId.get(op.parentId)?.kind !== 'group' || !includeTree(op.parentId)) {
        return reject('invalid-hierarchy')
      }
      let cursor: string | undefined = op.parentId
      const seen = new Set<string>()
      while (cursor) {
        if (cursor === op.nodeId || seen.has(cursor)) return reject('invalid-hierarchy')
        seen.add(cursor)
        cursor = parents.get(cursor)
      }
    }
    if (op.op === 'reparent') parents.set(op.nodeId, op.parentId ?? undefined)
  }
  // Bounded by the number of nodes; no recursive walk over untrusted project data.
  for (let pass = 0; pass < current.nodes.length; pass++) {
    let grew = false
    for (const node of current.nodes) {
      if (node.parentId && affected.has(node.parentId) && !affected.has(node.id)) {
        affected.add(node.id)
        grew = true
      }
    }
    if (!grew) break
  }
  const skipped: LayoutSkip[] = []
  for (const id of affected) {
    const reason = refuse(context.byId.get(id)!, context)
    if (reason) skipped.push({ nodeId: id, reason })
  }
  return skipped.length ? { kind: 'refused', reason: 'ineligible', skipped } : null
}

export async function applyLayoutTransaction(
  transaction: LayoutTransaction,
  deps: {
    lease: LayoutLeaseStore
    /** Read NOW inside the coordinator's project transaction, never a captured preview object. */
    current: () => LayoutApplyState
    /** Synchronous presentation mutation only. No awaits, transport, saving or session effects. */
    apply: (plan: LayoutPlan) => undefined
  }
): Promise<LayoutApplyOutcome> {
  const { fence } = transaction
  const guarded = await deps.lease.withCurrent(fence.projectId, fence.holder, fence.leaseToken, (check) => {
    try {
      const refusal = validateLayoutTransaction(transaction, deps.current())
      if (refusal) return refusal
      // A slow evidence reader may have consumed the TTL while the lock was held.
      const leaseRefusal = check()
      if (leaseRefusal) return { kind: 'refused', reason: leaseRefusal.reason } as const
    } catch {
      return { kind: 'refused', reason: 'source-unknown' } as const
    }
    if (!transaction.plan.ops.length) return { kind: 'unchanged', plan: transaction.plan } as const
    deps.apply(transaction.plan)
    return { kind: 'applied', plan: transaction.plan } as const
  })
  return guarded.ok ? guarded.value : {
    kind: 'refused', reason: guarded.reason, ...(guarded.holder ? { holder: guarded.holder } : {})
  }
}
