import { promises as fs } from 'node:fs'
import { writeFileAtomic } from '../core/fs-atomic'
import type { NodePlacement } from '../core/kanban-organization'
import { organizationId, organizationKey, parseNodeOrganization } from '../shared/kanban-organization'
import type { NodeOrganization } from '../shared/kanban-organization'

export const ORGANIZATION_AUDIT_LIMIT = 20
export const ORGANIZATION_CREATION_LIMIT = 25_000
export interface CreationReservation {
  id: string
  nodeId: string
  projectId: string
  fingerprint: string
  assistant: boolean
  stage: 'reserved' | 'launch_claimed' | 'finished'
  outcome?: 'success' | 'spawn_failed' | 'command_failed' | 'uncertain'
}
export interface OrganizationReceipt {
  id: string
  nodeId: string
  projectId: string
  at: number
  kind: 'create' | 'update' | 'undo'
  before: NodePlacement
  after: NodePlacement
  organization: NodeOrganization
  committed: boolean
  published: boolean
  undone?: boolean
}
export interface OrganizationJournalState {
  version: 1
  creations: Record<string, CreationReservation>
  receipts: Record<string, OrganizationReceipt[]>
  /** Current expected positions, separate from immutable historical receipt positions. */
  placements?: Record<string, { projectId: string; receiptId: string; columnId: string | null; index: number }>
}
const fresh = (): OrganizationJournalState => ({ version: 1, creations: {}, receipts: {} })
const hash = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
const fields = (v: unknown, allowed: string[]): boolean => !!v && typeof v === 'object' && !Array.isArray(v) &&
  Object.keys(v).every((key) => allowed.includes(key))
const placement = (v: NodePlacement) => fields(v, ['columnId', 'index', 'previous', 'next']) && (v.columnId === null || organizationId(v.columnId)) &&
  Number.isSafeInteger(v.index) && v.index >= -1 &&
  (v.previous === null || organizationId(v.previous)) && (v.next === null || organizationId(v.next))

/** Private, bounded server data. Corruption is a refusal, never an empty deduplication history. */
export class OrganizationJournal {
  private initialized = false
  constructor(private readonly file: string) {}

  async read(): Promise<OrganizationJournalState> {
    let raw: string
    try { raw = await fs.readFile(this.file, 'utf8') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !this.initialized) {
        try { await fs.stat(`${this.file}.initialized`) }
        catch (markerError) { if ((markerError as NodeJS.ErrnoException).code === 'ENOENT') return fresh() }
      }
      throw new Error('organization_journal_unavailable', { cause: error })
    }
    this.initialized = true
    if (Buffer.byteLength(raw) > 32 * 1024 * 1024) throw new Error('organization_journal_invalid')
    let data: OrganizationJournalState
    try { data = JSON.parse(raw) } catch { throw new Error('organization_journal_invalid') }
    if (!fields(data, ['version', 'creations', 'receipts', 'placements']) || data.version !== 1 ||
      !fields(data.creations, Object.keys(data.creations ?? {})) || !fields(data.receipts, Object.keys(data.receipts ?? {})) ||
      Array.isArray(data.creations) || Array.isArray(data.receipts) ||
      Object.keys(data.creations).length > ORGANIZATION_CREATION_LIMIT) throw new Error('organization_journal_invalid')
    for (const [key, r] of Object.entries(data.creations)) {
      if (!organizationKey(key) || !fields(r, ['id', 'nodeId', 'projectId', 'fingerprint', 'assistant', 'stage', 'outcome']) || !organizationId(r.id) || !organizationId(r.nodeId) ||
        !organizationId(r.projectId) || !hash(r.fingerprint) || typeof r.assistant !== 'boolean' ||
        !['reserved', 'launch_claimed', 'finished'].includes(r.stage) ||
        (r.outcome !== undefined && !['success', 'spawn_failed', 'command_failed', 'uncertain'].includes(r.outcome))) throw new Error('organization_journal_invalid')
    }
    for (const [id, rows] of Object.entries(data.receipts)) {
      if (!organizationId(id) || !Array.isArray(rows) || rows.length > ORGANIZATION_AUDIT_LIMIT ||
        rows.some((r) => !fields(r, ['id', 'nodeId', 'projectId', 'at', 'kind', 'before', 'after', 'organization', 'committed', 'published', 'undone']) || r.nodeId !== id || !organizationId(r.id) || !organizationId(r.projectId) ||
          !Number.isSafeInteger(r.at) || !['create', 'update', 'undo'].includes(r.kind) ||
          !placement(r.before) || !placement(r.after) || !parseNodeOrganization(r.organization) ||
          r.organization.metadata.projectId !== r.projectId ||
          typeof r.committed !== 'boolean' || typeof r.published !== 'boolean' ||
          (r.undone !== undefined && typeof r.undone !== 'boolean'))) throw new Error('organization_journal_invalid')
    }
    if (data.placements !== undefined) {
      if (!fields(data.placements, Object.keys(data.placements ?? {})) ||
        Object.keys(data.placements).length > ORGANIZATION_CREATION_LIMIT) throw new Error('organization_journal_invalid')
      for (const [id, p] of Object.entries(data.placements)) {
        if (!organizationId(id) || !fields(p, ['projectId', 'receiptId', 'columnId', 'index']) ||
          !organizationId(p.projectId) || !organizationId(p.receiptId) ||
          (p.columnId !== null && !organizationId(p.columnId)) || !Number.isSafeInteger(p.index) ||
          p.index < -1 || (p.columnId === null) !== (p.index === -1)) throw new Error('organization_journal_invalid')
      }
    }
    return data
  }

  async write(state: OrganizationJournalState): Promise<void> {
    if (Object.keys(state.creations).length > ORGANIZATION_CREATION_LIMIT ||
      Object.keys(state.placements ?? {}).length > ORGANIZATION_CREATION_LIMIT) throw new Error('organization_journal_full')
    const content = JSON.stringify(state)
    if (Buffer.byteLength(content) > 32 * 1024 * 1024) throw new Error('organization_journal_full')
    await writeFileAtomic(`${this.file}.initialized`, '1', { mode: 0o600 })
    await writeFileAtomic(this.file, content, { mode: 0o600 })
    this.initialized = true
  }

  addReceipt(state: OrganizationJournalState, receipt: OrganizationReceipt): void {
    const rows = state.receipts[receipt.nodeId] ?? []
    // Never discard an event still awaiting publication or a write with an uncertain outcome.
    if (rows.length >= ORGANIZATION_AUDIT_LIMIT && (!rows[0].published || !rows[0].committed)) throw new Error('organization_audit_full')
    state.receipts[receipt.nodeId] = [...rows.slice(-(ORGANIZATION_AUDIT_LIMIT - 1)), receipt]
  }

  /** Advance only positions explained by this durable operation; never adopt other observed drift. */
  commitReceipt(state: OrganizationJournalState, receipt: OrganizationReceipt): void {
    const placements = state.placements ??= {}
    if (placements[receipt.nodeId]?.receiptId !== receipt.id) {
      for (const [id, expected] of Object.entries(placements)) {
        if (id === receipt.nodeId || expected.projectId !== receipt.projectId || expected.index < 0) continue
        if (receipt.before.index >= 0 && receipt.before.index < expected.index) expected.index--
        if (receipt.after.index >= 0 && receipt.after.index <= expected.index) expected.index++
      }
      placements[receipt.nodeId] = { projectId: receipt.projectId, receiptId: receipt.id,
        columnId: receipt.after.columnId, index: receipt.after.index }
    }
    receipt.committed = true
  }
}
