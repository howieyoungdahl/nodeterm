import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { writeFileAtomic } from './fs-atomic'
import type { CanvasNodeState, Project, Workspace } from '../shared/types'

export const CLEANUP_IDLE_MS = 60 * 60_000
export const CLEANUP_PREVIEW_MS = 5 * 60_000
export type CleanupState = 'completed' | 'idle-shell' | 'active' | 'waiting' | 'blocked' | 'unknown' | 'dead'
export interface CleanupEvidence {
  generation: string
  activityAt: number | null
  state: CleanupState
  workChildren: number | null
  pending: boolean
  fingerprint: string
  reason: string
}
export interface CleanupRow {
  projectId: string; nodeId: string; title: string; eligible: boolean; idleMs: number | null
  archived: boolean; archiveId?: string; evidence: CleanupEvidence
}
interface Plan { id: string; createdAt: number; expiresAt: number; workspaceHash: string; rows: CleanupRow[] }
interface ReceiptItem { projectId: string; nodeId: string; generation: string; before: string; after: string }
export interface CleanupReceipt { version: 1; id: string; planId: string; at: number; state: 'prepared' | 'applied' | 'undo-prepared' | 'undone'; items: ReceiptItem[] }
export class CleanupError extends Error {
  constructor(readonly code: string, readonly status = 409) { super(code) }
}
function fail(code: string, status = 409): never { throw new CleanupError(code, status) }
export function cleanupHash(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex') }
function safeId(id: unknown): id is string { return typeof id === 'string' && /^[A-Za-z0-9._:-]{1,200}$/.test(id) }
function uuid(id: unknown): id is string { return typeof id === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id) }

/** Session-scoped archive/reaper leases. They never hold the workspace FIFO over subprocesses. */
export class CleanupReservations {
  private readonly busy = new Set<string>()
  reserve(names: string[]): (() => void) | null {
    if (names.some(n => this.busy.has(n))) return null
    for (const name of names) this.busy.add(name)
    let released = false
    return () => { if (!released) { released = true; for (const name of names) this.busy.delete(name) } }
  }
}

export function cleanupEligible(e: CleanupEvidence, now: number): boolean {
  return !!e && typeof e.generation === 'string' && e.generation.length > 0 &&
    typeof e.fingerprint === 'string' && e.fingerprint.length > 0 &&
    Number.isSafeInteger(e.activityAt) && e.activityAt! > 0 && e.activityAt! <= now &&
    now - e.activityAt! >= CLEANUP_IDLE_MS && (e.state === 'completed' || e.state === 'idle-shell') &&
    e.workChildren === 0 && e.pending === false
}

export interface SessionCleanupDeps {
  dataDir: string
  load(): Promise<Workspace>
  save(workspace: Workspace, check?: () => string | undefined): Promise<void>
  exclusive<T>(work: () => Promise<T>): Promise<T>
  probe(project: Project, node: CanvasNodeState): Promise<CleanupEvidence>
  publish?(project: Project): void
  activityVersion?(): number
  reserveSessions?(nodeIds: string[]): (() => void | Promise<void>) | null | Promise<(() => void | Promise<void>) | null>
  now?(): number
}

/** A presentation-only transaction. No callback can kill, write to or resume a terminal.
 * Receipts precede the workspace save so uncertain/partial publication always has an inverse.
 * Cooperative host mutations share the host FIFO; a second disk read fences external edits
 * observed during probing. This does not pretend the legacy workspace writer is a filesystem CAS. */
export class SessionCleanup {
  private readonly plans = new Map<string, Plan>()
  private readonly now: () => number
  private readonly dir: string
  constructor(private readonly deps: SessionCleanupDeps) {
    this.now = deps.now ?? Date.now
    this.dir = path.join(deps.dataDir, 'session-cleanup')
  }
  private async evidence(project: Project, node: CanvasNodeState): Promise<CleanupEvidence> {
    try {
      const e = await this.deps.probe(project, node)
      if (!e || typeof e.generation !== 'string' || typeof e.fingerprint !== 'string' || typeof e.reason !== 'string' ||
        !['completed','idle-shell','active','waiting','blocked','unknown','dead'].includes(e.state) || typeof e.pending !== 'boolean' ||
        !(e.activityAt === null || Number.isSafeInteger(e.activityAt)) || !(e.workChildren === null || Number.isSafeInteger(e.workChildren) && e.workChildren >= 0)) throw new Error('bad-probe-metadata')
      return e
    }
    catch { return { generation: '', activityAt: null, state: 'unknown', workChildren: null, pending: true, fingerprint: '', reason: 'probe-unavailable' } }
  }
  async preview(): Promise<{ version: 1; dryRun: true; plan: Plan }> {
    const workspace = await this.deps.load()
    const now = this.now()
    const ids = workspace.projects.flatMap(p => p.nodes.map(n => n.id))
    const rows: CleanupRow[] = []
    for (const project of workspace.projects) for (const node of project.nodes) {
      if (node.kind !== 'terminal') continue
      const evidence = await this.evidence(project, node)
      const unique = ids.filter(id => id === node.id).length === 1
      rows.push({ projectId: project.id, nodeId: node.id, title: node.title,
        eligible: !project.ssh && unique && safeId(project.id) && safeId(node.id) && !node.cleanupArchiveId && cleanupEligible(evidence, now),
        idleMs: Number.isSafeInteger(evidence.activityAt) && evidence.activityAt! <= now ? now - evidence.activityAt! : null,
        archived: !!node.cleanupArchiveId, archiveId: node.cleanupArchiveId,
        evidence: !unique ? { ...evidence, state: 'unknown', reason: 'ambiguous-node-id' } : evidence })
    }
    for (const [id, old] of this.plans) if (now >= old.expiresAt) this.plans.delete(id)
    if (this.plans.size >= 32) this.plans.delete(this.plans.keys().next().value!)
    const plan: Plan = { id: randomUUID(), createdAt: now, expiresAt: now + CLEANUP_PREVIEW_MS, workspaceHash: cleanupHash(workspace), rows }
    this.plans.set(plan.id, plan)
    return { version: 1, dryRun: true, plan }
  }
  private selections(input: unknown): { planId: string; nodeIds: string[] } {
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('invalid_cleanup_request', 400)
    const o = input as Record<string, unknown>
    if (Object.keys(o).sort().join(',') !== 'nodeIds,planId' || !uuid(o.planId) ||
      !Array.isArray(o.nodeIds) || o.nodeIds.length === 0 || o.nodeIds.length > 100 ||
      !o.nodeIds.every(safeId) || new Set(o.nodeIds).size !== o.nodeIds.length) fail('exact_id_allowlist_required', 400)
    return o as { planId: string; nodeIds: string[] }
  }
  private async write(receipt: CleanupReceipt): Promise<void> {
    const file = path.join(this.dir, `${receipt.id}.json`)
    await writeFileAtomic(file, JSON.stringify(receipt), { mode: 0o600 })
    const handle = await fs.open(file, 'r')
    try { await handle.sync() } finally { await handle.close() }
    // Linux publication requires a durable inverse, including a newly created ledger directory.
    if (process.platform !== 'win32') for (const dir of [this.dir, this.deps.dataDir]) {
      const parent = await fs.open(dir, 'r')
      try { await parent.sync() } finally { await parent.close() }
    }
  }
  private async locked<T>(work: () => Promise<T>): Promise<T> {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 })
    let lock: fs.FileHandle
    try { lock = await fs.open(path.join(this.dir, 'transaction.lock'), 'wx', 0o600) }
    catch { fail('cleanup_locked_or_unavailable') }
    try { return await work() }
    finally { await lock.close(); await fs.unlink(path.join(this.dir, 'transaction.lock')) }
  }
  async archive(input: unknown): Promise<{ version: 1; receipt: CleanupReceipt }> {
    const request = this.selections(input)
    return this.locked(async () => {
      const release = await this.deps.reserveSessions?.(request.nodeIds)
      if (release === null) fail('session_cleanup_or_reap_in_progress')
      try {
        const plan = this.plans.get(request.planId)
        if (!plan || this.now() >= plan.expiresAt || this.now() < plan.createdAt) fail('preview_expired_or_restarted')
        const selected = request.nodeIds.map(id => {
          const rows = plan.rows.filter(r => r.nodeId === id)
          if (rows.length !== 1 || !rows[0].eligible) fail('node_not_in_eligible_preview')
          return rows[0]
        })
        const workspace = await this.deps.load()
        if (cleanupHash(workspace) !== plan.workspaceHash) fail('workspace_changed')
        const id = randomUUID()
        const items: ReceiptItem[] = []
        for (const row of selected) {
          const p = workspace.projects.find(p => p.id === row.projectId)!
          const n = p.nodes.find(n => n.id === row.nodeId)!
          items.push({ projectId: p.id, nodeId: n.id, generation: row.evidence.generation,
            before: cleanupHash(n), after: cleanupHash({ ...n, cleanupArchiveId: id }) })
        }
        const receipt: CleanupReceipt = { version: 1, id, planId: plan.id, at: this.now(), state: 'prepared', items }
        // Preserve recovery evidence before the first mutation; disk/permission failure is a refusal.
        await this.write(receipt)
        const activityVersion = this.deps.activityVersion?.()
        for (const row of selected) {
          const p = workspace.projects.find(p => p.id === row.projectId)!
          const n = p.nodes.find(n => n.id === row.nodeId)!
          const current = await this.evidence(p, n)
          if (!cleanupEligible(current, this.now()) || cleanupHash(current) !== cleanupHash(row.evidence)) fail('activity_or_generation_changed')
        }
        await this.deps.exclusive(async () => {
          if (this.now() >= plan.expiresAt || cleanupHash(await this.deps.load()) !== plan.workspaceHash) fail('workspace_or_preview_changed')
          if (this.deps.activityVersion?.() !== activityVersion) fail('activity_during_validation')
          for (const item of items) workspace.projects.find(p => p.id === item.projectId)!.nodes.find(n => n.id === item.nodeId)!.cleanupArchiveId = id
          await this.deps.save(workspace, () => this.deps.activityVersion?.() !== activityVersion ?
            'activity_during_publication' : this.now() >= plan.expiresAt ? 'preview_expired_during_publication' : undefined)
        })
        // OS input/output cannot be locked by the workspace FIFO. Check again before hiding cards.
        // A raced turn gets its presentation restored; no terminal was stopped at either boundary.
        let raced = false
        for (const row of selected) {
          const p = workspace.projects.find(p => p.id === row.projectId)!
          const n = p.nodes.find(n => n.id === row.nodeId)!
          const current = await this.evidence(p, n)
          if (!cleanupEligible(current, this.now()) || cleanupHash(current) !== cleanupHash(row.evidence)) raced = true
        }
        if (this.deps.activityVersion?.() !== activityVersion) raced = true
        const restore = async (recovery: Workspace) => {
          for (const item of items) {
            const n = recovery.projects.find(p => p.id === item.projectId)?.nodes.find(n => n.id === item.nodeId)
            if (!n || n.cleanupArchiveId !== id) fail('activity_raced_recovery_needed')
            delete n.cleanupArchiveId
          }
          await this.deps.save(recovery)
          for (const p of recovery.projects) if (items.some(i => i.projectId === p.id)) this.deps.publish?.(p)
          receipt.state = 'undone'; await this.write(receipt)
        }
        if (raced) {
          await this.deps.exclusive(async () => restore(await this.deps.load()))
          fail('activity_raced_archive_restored')
        }
        // Publishing after a successful save never announces an uncommitted archive to the UI.
        await this.deps.exclusive(async () => {
          const latest = await this.deps.load()
          if (this.deps.activityVersion?.() !== activityVersion) {
            await restore(latest)
            fail('activity_raced_archive_restored')
          }
          for (const item of items) if (latest.projects.find(p=>p.id===item.projectId)?.nodes.find(n=>n.id===item.nodeId)?.cleanupArchiveId !== id) fail('archive_changed_recovery_needed')
          for (const p of latest.projects) if (items.some(i => i.projectId === p.id)) this.deps.publish?.(p)
        })
        receipt.state = 'applied'
        await this.write(receipt)
        this.plans.delete(plan.id)
        return { version: 1, receipt }
      } finally { await release?.() }
    })
  }
  async receipt(id: string): Promise<{ version: 1; receipt: CleanupReceipt }> {
    if (!uuid(id)) fail('invalid_receipt_id', 400)
    let value: CleanupReceipt
    try {
      const raw = await fs.readFile(path.join(this.dir, `${id}.json`), 'utf8')
      if (raw.length > 256_000) fail('invalid_cleanup_receipt')
      value = JSON.parse(raw)
    } catch { fail('cleanup_receipt_unavailable') }
    if (!value || typeof value !== 'object' || value.version !== 1 || value.id !== id || !uuid(value.planId) ||
      !Number.isSafeInteger(value.at) || value.at <= 0 ||
      !['prepared', 'applied', 'undo-prepared', 'undone'].includes(value.state) || !Array.isArray(value.items) || value.items.length < 1 || value.items.length > 100 ||
      !value.items.every(i => i && typeof i === 'object' && safeId(i.nodeId) && safeId(i.projectId) && typeof i.generation === 'string' && i.generation.length > 0 && /^[a-f0-9]{64}$/.test(i.before) && /^[a-f0-9]{64}$/.test(i.after)) ||
      new Set(value.items.map(i=>i.nodeId)).size !== value.items.length) fail('invalid_cleanup_receipt')
    return { version: 1, receipt: value }
  }
  async receipts(): Promise<{ version: 1; receiptIds: string[] }> {
    try {
      const files = await fs.readdir(this.dir)
      const receiptIds = files.filter(f => /^[a-f0-9-]{36}\.json$/.test(f)).map(f => f.slice(0, -5))
      if (receiptIds.length > 1000) fail('receipt_listing_limit')
      return { version: 1, receiptIds }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, receiptIds: [] }
      throw e
    }
  }
  /** Recovery receipts protect uncertain saves too. A legacy load's fallback empty workspace
   * cannot accidentally authorize the reaper to kill an archived backend. Corruption throws. */
  async protectedNodeIds(): Promise<string[]> {
    const ids = new Set<string>()
    for (const id of (await this.receipts()).receiptIds) {
      const { receipt } = await this.receipt(id)
      if (receipt.state !== 'undone') for (const item of receipt.items) ids.add(item.nodeId)
    }
    return [...ids]
  }
  undo(id: string): Promise<{ version: 1; receipt: CleanupReceipt }> {
    return this.deps.exclusive(() => this.locked(async () => {
      const { receipt } = await this.receipt(id)
      if (receipt.state === 'undone') return { version: 1, receipt }
      const workspace = await this.deps.load()
      const base = cleanupHash(workspace)
      for (const item of receipt.items) {
        const matches = workspace.projects.flatMap(p => p.nodes.filter(n => n.id === item.nodeId).map(n => ({p,n})))
        if (matches.length !== 1 || matches[0].p.id !== item.projectId) fail('undo_target_missing_or_ambiguous')
        const n = matches[0].n
        // An untouched prepared receipt may have saved nothing; an interrupted undo may already
        // have restored some projects. Neither permits replacing later edits or resurrecting IDs.
        if (!n.cleanupArchiveId) continue
        if (n.cleanupArchiveId !== id) fail('undo_conflict')
        delete n.cleanupArchiveId
      }
      receipt.state = 'undo-prepared'
      await this.write(receipt)
      if (cleanupHash(await this.deps.load()) !== base) fail('workspace_changed')
      await this.deps.save(workspace)
      for (const p of workspace.projects) if (receipt.items.some(i => i.projectId === p.id)) this.deps.publish?.(p)
      receipt.state = 'undone'
      await this.write(receipt)
      return { version: 1, receipt }
    }))
  }
}
