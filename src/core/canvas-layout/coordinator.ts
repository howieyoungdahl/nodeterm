import { randomUUID } from 'node:crypto'
import type { Project } from '../../shared/types'
import type { LayoutPlan, LayoutPlanRequest, LayoutCommitRequest, LayoutCommitOutcome, LayoutNode } from '../../shared/canvas-layout'
import { reconcileProjectDocuments, type ProjectDocument } from '../../shared/project-reconciliation'
import type { WorkspaceReconciliationStore } from '../workspace-reconciliation-store'
import { captureLayoutTransaction, validateLayoutTransaction, type LayoutApplyState, type LayoutTransaction } from './transaction'
import type { LayoutLeaseStore } from './lease'

export type OrganizerEvidence = Pick<LayoutApplyState, 'source' | 'inputRevision' | 'ownershipEpoch' |
  'activityComplete' | 'actives' | 'loopFrames' | 'owns'>
export interface OrganizerRuntime {
  /** Trusted host adapter: keep input/activity/assignment evidence stable until run settles.
   * Presence snapshots and browser operator authentication do NOT implement this contract. */
  withEvidence<T>(senderId: number, projectId: string, run: (read: () => OrganizerEvidence) => Promise<T>): Promise<T>
  /** Canonical host presentation transform, never caller-proposed nodes or session effects. */
  present(project: Project, plan: LayoutPlan): Project
}
interface Retained {
  senderId: number; clientId: string; localInput: string; before: Project; proposed: Project
  transaction: LayoutTransaction; at: number
  applied?: LayoutCommitOutcome; inverse?: LayoutCommitOutcome; running?: Promise<LayoutCommitOutcome>
}
const document = (project: Project): ProjectDocument => JSON.parse(JSON.stringify(project))
const nodes = (project: Project): LayoutNode[] => project.nodes.map((n) => ({
  id: n.id, kind: n.kind, parentId: n.parentId, title: n.title, role: n.role,
  pinned: n.pinned, manualPlacement: n.manualPlacement, taskFrame: n.taskFrame,
  collapsed: n.collapsed, controlSize: n.controlSize, position: n.position, size: n.size
}))

/** Retained previews are an ephemeral cache, not an ownership ledger. Durable operation receipts,
 * bases and publication remain solely in the existing project coordinator. Restart/eviction
 * refuses an unknown preview; it never rebuilds authority from caller-supplied plan data. */
export class OrganizerCoordinator {
  private retained = new Map<string, Retained>()
  private incarnation = randomUUID()
  constructor(private deps: { store: WorkspaceReconciliationStore; lease: LayoutLeaseStore;
    enabled(): boolean; runtime?: OrganizerRuntime; now?: () => number;
    plan(request: LayoutPlanRequest): Promise<LayoutPlan> }) {}
  private now(): number { return (this.deps.now ?? Date.now)() }
  private holder(senderId: number): string { return `${this.incarnation}:ui:${senderId}` }
  private refuse(request: LayoutPlanRequest, reason: string): LayoutPlan {
    return { trigger: request.trigger, ops: [], skipped: [], stoodDown: { reason: 'source-unavailable' }, refusal: reason }
  }
  async prepare(senderId: number, request: LayoutPlanRequest): Promise<LayoutPlan> {
    if (!this.deps.enabled()) return { trigger: request.trigger, ops: [], skipped: [], stoodDown: { reason: 'disabled' } }
    if (!this.deps.runtime) return this.refuse(request, 'activity-and-assignment-adapter-unavailable')
    const binding = request.binding
    if (!binding?.clientId || !binding.revision || !binding.inputRevision) return this.refuse(request, 'acknowledged-base-required')
    for (const [id, item] of this.retained) if (!item.running && this.now() - item.at > 300_000) this.retained.delete(id)
    if (this.retained.size >= 256) return this.refuse(request, 'preview-capacity')
    return this.deps.runtime.withEvidence(senderId, request.projectId, async (read) => {
      const before = await this.deps.store.organizerBase(binding.clientId, request.projectId, binding.revision)
      if (!before) return this.refuse(request, 'unknown-enrollment')
      const evidence = read(), holder = this.holder(senderId)
      if (evidence.source !== 'current' || !evidence.activityComplete) return this.refuse(request, 'activity-unknown')
      if (!evidence.ownershipEpoch || !evidence.owns) return this.refuse(request, 'ownership-unknown')
      const candidate = await this.deps.plan({ ...request, holder, nodes: nodes(before), projectRules: before.layoutRules,
        ropes: before.ropes, actives: [...evidence.actives], loopFrames: [...evidence.loopFrames] })
      if (candidate.stoodDown || !candidate.leaseToken) return candidate
      if (!candidate.ops.length) return { ...candidate, leaseHolder: holder }
      const transaction = captureLayoutTransaction(candidate, { projectId: request.projectId, revision: binding.revision,
        inputRevision: evidence.inputRevision, ownershipEpoch: evidence.ownershipEpoch, holder }, candidate.leaseToken)
      const state = { ...read(), nodes: nodes(before), projectId: request.projectId, revision: binding.revision,
        holder, enabled: this.deps.enabled() }
      const refusal = validateLayoutTransaction(transaction, state)
      if (refusal?.kind === 'refused') return this.refuse(request, refusal.reason)
      const proposed = this.deps.runtime!.present(structuredClone(before), structuredClone(candidate))
      const operationId = randomUUID()
      this.retained.set(operationId, { senderId, clientId: binding.clientId, localInput: binding.inputRevision,
        before, proposed: structuredClone(proposed), transaction, at: this.now() })
      return { ...candidate, operationId, leaseHolder: holder, baseRevision: binding.revision, inputRevision: binding.inputRevision }
    })
  }
  async commit(senderId: number, request: LayoutCommitRequest, inverse = false): Promise<LayoutCommitOutcome> {
    const operationId = request?.operationId
    const refusal = (reason: string): LayoutCommitOutcome => ({ kind: 'refused', operationId, reason })
    const item = this.retained.get(operationId)
    if (!item) return refusal('unknown-operation')
    const fence = item.transaction.fence
    if (senderId !== item.senderId || request.clientId !== item.clientId || request.projectId !== fence.projectId)
      return refusal('caller-project-mismatch')
    if (request.leaseToken !== fence.leaseToken) return refusal('lease-stale')
    if (item.running) { await item.running; return this.commit(senderId, request, inverse) }
    const settled = inverse ? item.inverse : item.applied
    // Settled receipts are read-only answers, not a second apply; TTL/opt-in cannot erase a commit.
    if (settled && !(request.settleOnly && settled.kind === 'unknown'))
      return { ...settled, kind: settled.kind === 'committed' ? 'already-applied' : settled.kind }
    if (request.settleOnly) {
      const receipt = await this.deps.store.settleOrganizer(item.clientId, request.projectId,
        inverse ? request.revision : fence.revision, inverse ? `${operationId}:inverse` : operationId)
      if (!receipt) return { kind: 'unknown', operationId, reason: 'receipt-unavailable; no publication attempted' }
      return { kind: receipt.kind === 'committed' || receipt.kind === 'already-applied' ? 'already-applied' :
        receipt.kind === 'publication-unknown' ? 'unknown' : 'refused', operationId,
        current: receipt.current, reason: receipt.message, recovery: receipt.recovery }
    }
    if (!this.deps.enabled()) return refusal('disabled')
    if (!inverse && (request.revision !== fence.revision || request.inputRevision !== item.localInput))
      return refusal('stale-input')
    if (inverse && !item.applied?.current) return refusal('not-applied')
    const runtime = this.deps.runtime
    if (!runtime) return refusal('activity-and-assignment-adapter-unavailable')
    const run = async (): Promise<LayoutCommitOutcome> => {
      try {
        return await runtime.withEvidence(senderId, request.projectId, async (read) =>
          this.deps.lease.withPublication(request.projectId, fence.holder, fence.leaseToken, async (leaseCheck) => {
            const before = inverse ? await this.deps.store.organizerBase(item.clientId, request.projectId, request.revision) : item.before
            if (!before) return refusal('unknown-enrollment')
            let proposed = item.proposed
            if (inverse) {
              const merged = reconcileProjectDocuments(document(item.applied!.current!.project), document(item.before), document(before))
              if (merged.kind !== 'merged') return refusal('inverse-conflict')
              proposed = merged.document as unknown as Project
            }
            const currentFence = inverse ? { ...fence, revision: request.revision, inputRevision: read().inputRevision } : fence
            const transaction = { ...item.transaction, fence: currentFence }
            const check = (): string | undefined => {
              try {
                const expired = leaseCheck(); if (expired) return expired
                const result = validateLayoutTransaction(transaction, { ...read(), nodes: nodes(before),
                  projectId: request.projectId, revision: currentFence.revision, holder: fence.holder, enabled: this.deps.enabled() })
                return result?.kind === 'refused' ? result.reason : undefined
              } catch { return 'source-unknown' }
            }
            const blocked = check(); if (blocked) return refusal(blocked)
            const result = await this.deps.store.commitOrganizer(item.clientId, request.projectId, currentFence.revision,
              inverse ? `${operationId}:inverse` : operationId, proposed, check)
            const kind = result.kind === 'committed' || result.kind === 'already-applied' ? result.kind :
              result.kind === 'publication-unknown' ? 'unknown' : 'refused'
            const outcome: LayoutCommitOutcome = { kind, operationId, current: result.current,
              reason: result.message ?? (kind === 'refused' ? result.kind : undefined), recovery: result.recovery }
            if (inverse) item.inverse = outcome; else item.applied = outcome
            return outcome
          }))
      } catch (error) {
        if (error instanceof Error && error.message === 'lease-stale') return refusal('lease-stale')
        return { kind: 'unknown', operationId, reason: String(error) }
      }
    }
    item.running = run()
    try { return await item.running } finally { item.running = undefined }
  }
}
