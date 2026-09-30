import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { writeFileAtomic } from '../core/fs-atomic'
import { isOperatorTarget, safeOperatorId } from '../core/operator-session-bindings'
import type { OperatorMessageReceipt, OperatorSessionTarget } from '../shared/operator-conversations'

export interface StoredOperatorReceipt {
  callerId: string
  keyHash: string
  payloadHash: string
  receipt: OperatorMessageReceipt
}

export class OperatorStoreError extends Error {
  constructor(public code: string, public status = 503) { super(code) }
}

const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const STATES = new Set(['accepted', 'queued', 'failed', 'acknowledged'])
const OUTCOMES = new Set(['admitted', 'transport_accepted', 'server_restarted', 'delivery_failed',
  'delivered', 'queued', 'stalled', 'deliveredToReplacedTarget', 'expired', 'rateLimited',
  'queueFull', 'targetBusy', 'targetNotIdleUnknown', 'targetStatusUnverified', 'targetStatusStale',
  'targetHookScriptStale', 'targetPaneUnreadable', 'targetNotAgentPane', 'targetNotPasteAware',
  'targetGone', 'notPermitted', 'unknown', 'messageRejected'])
const EVIDENCE = new Set(['server_admission_only', 'delivery_unknown_no_replay',
  'awaiting_verified_receipt', 'verified_correlated_prompt'])
function exactKeys(value: unknown, required: string[], optional: string[] = []): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const keys = Object.keys(value)
  return required.every((key) => keys.includes(key)) && keys.every((key) => required.includes(key) || optional.includes(key))
}
const timestamp = (value: unknown): boolean => typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value))
function validStoredReceipt(entry: unknown): entry is StoredOperatorReceipt {
  if (!exactKeys(entry, ['callerId', 'keyHash', 'payloadHash', 'receipt']) ||
    !safeOperatorId(entry.callerId) || typeof entry.keyHash !== 'string' ||
    typeof entry.payloadHash !== 'string' || !/^[a-f0-9]{64}$/.test(entry.keyHash) ||
    !/^[a-f0-9]{64}$/.test(entry.payloadHash)) return false
  const r = entry.receipt
  return exactKeys(r, ['version', 'id', 'target', 'state', 'createdAt', 'updatedAt', 'outcome'], ['evidence']) &&
    r.version === 1 && typeof r.id === 'string' && /^[a-f0-9-]{36}$/.test(r.id) &&
    isOperatorTarget(r.target) && typeof r.state === 'string' && STATES.has(r.state) &&
    timestamp(r.createdAt) && timestamp(r.updatedAt) && typeof r.outcome === 'string' && OUTCOMES.has(r.outcome) &&
    (r.evidence === undefined || (typeof r.evidence === 'string' && EVIDENCE.has(r.evidence)))
}

/** Content-free durable deduplication. A restart fails pending receipts and never replays them. */
export class OperatorReceiptStore {
  private readonly records = new Map<string, StoredOperatorReceipt>()
  private pending: Promise<void> = Promise.resolve()
  private readonly file: string
  private healthy = true
  private recovered = false

  constructor(dataDir: string) {
    this.file = path.join(dataDir, 'operator-message-receipts.json')
    let fd: number | undefined
    try {
      fd = fs.openSync(this.file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
      const stat = fs.fstatSync(fd)
      if (!stat.isFile() || stat.size > 8 * 1024 * 1024 ||
        (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 ||
          (process.getuid && stat.uid !== process.getuid())))) throw new Error('unsafe')
      const data = JSON.parse(fs.readFileSync(fd, 'utf8'))
      if (!exactKeys(data, ['version', 'records']) || data.version !== 1 || !Array.isArray(data.records) || data.records.length > 2000)
        throw new Error('invalid')
      const dedupKeys = new Set<string>()
      for (const entry of data.records) {
        if (!validStoredReceipt(entry) || this.records.has(entry.receipt.id) ||
          dedupKeys.has(`${entry.callerId}:${entry.keyHash}`))
          throw new Error('invalid')
        dedupKeys.add(`${entry.callerId}:${entry.keyHash}`)
        if (entry.receipt.state === 'accepted' || entry.receipt.state === 'queued') {
          entry.receipt.state = 'failed'
          entry.receipt.outcome = 'server_restarted'
          entry.receipt.evidence = 'delivery_unknown_no_replay'
          entry.receipt.updatedAt = new Date().toISOString()
          this.recovered = true
        }
        this.records.set(entry.receipt.id, entry)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.healthy = false
    } finally { if (fd !== undefined) fs.closeSync(fd) }
  }

  private async persist(): Promise<void> {
    if (!this.healthy) throw new OperatorStoreError('receipt_store_unavailable')
    const task = this.pending.then(async () => {
      await writeFileAtomic(this.file, JSON.stringify({ version: 1, records: [...this.records.values()] }), { mode: 0o600 })
      this.recovered = false
    })
    this.pending = task.catch(() => { this.healthy = false })
    try { await task } catch { throw new OperatorStoreError('receipt_store_unavailable') }
  }

  find(callerId: string, key: string, target: OperatorSessionTarget, text: string): StoredOperatorReceipt | undefined {
    if (!this.healthy) throw new OperatorStoreError('receipt_store_unavailable')
    const keyHash = hash(JSON.stringify([callerId, key]))
    const payloadHash = hash(JSON.stringify([target.projectId, target.nodeId, target.sessionId, target.generation, text]))
    const existing = [...this.records.values()].find((r) => r.callerId === callerId && r.keyHash === keyHash)
    if (existing && existing.payloadHash !== payloadHash) throw new OperatorStoreError('idempotency_conflict', 409)
    return existing
  }

  async admit(callerId: string, key: string, target: OperatorSessionTarget, text: string): Promise<StoredOperatorReceipt> {
    if (!this.healthy) throw new OperatorStoreError('receipt_store_unavailable')
    if (this.records.size >= 2000) throw new OperatorStoreError('receipt_capacity')
    // The caller serializes admission; insertion precedes the first await.
    const at = new Date().toISOString()
    const entry: StoredOperatorReceipt = {
      callerId, keyHash: hash(JSON.stringify([callerId, key])),
      payloadHash: hash(JSON.stringify([target.projectId, target.nodeId, target.sessionId, target.generation, text])),
      receipt: { version: 1, id: randomUUID(), target: { ...target }, state: 'accepted',
        createdAt: at, updatedAt: at, outcome: 'admitted', evidence: 'server_admission_only' }
    }
    this.records.set(entry.receipt.id, entry)
    await this.persist()
    return entry
  }

  async get(id: string): Promise<StoredOperatorReceipt | undefined> {
    if (!this.healthy) throw new OperatorStoreError('receipt_store_unavailable')
    if (this.recovered) await this.persist()
    return this.records.get(id)
  }

  async update(id: string, state: OperatorMessageReceipt['state'], outcome: string, evidence?: string): Promise<void> {
    const entry = this.records.get(id)
    if (!entry || entry.receipt.state === 'acknowledged' || entry.receipt.state === 'failed') return
    entry.receipt = { ...entry.receipt, state, outcome, evidence, updatedAt: new Date().toISOString() }
    await this.persist()
  }
}

export interface OperatorAuditEntry {
  caller: string
  operation: 'targets' | 'read' | 'message' | 'receipt' | 'delivery'
  target?: OperatorSessionTarget
  receiptId?: string
  outcome: string
}

/** IDs and outcome codes only. Never record authorization headers, bodies, paths or exceptions. */
export function appendOperatorAudit(dataDir: string, entry: OperatorAuditEntry): void {
  let fd: number | undefined
  try {
    fd = fs.openSync(path.join(dataDir, 'operator-conversation-audit.jsonl'),
      fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW ?? 0), 0o600)
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)) throw new Error('unsafe')
    fs.writeSync(fd, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`)
    fs.fsyncSync(fd)
  } catch { throw new OperatorStoreError('audit_unavailable') }
  finally { if (fd !== undefined) fs.closeSync(fd) }
}
