import { createHash, randomUUID } from 'crypto'
import type { AgentMessageOutcome } from './agent-message-decide'

/** Claims to validate against the canonical assignment authority, never grants. */
export interface MessageAssignment {
  task_id: string
  assignment_id: string
  assignment_epoch: number
  actor: {
    agent_id: string
    node: string
    pane: string
    session_id: string
    incarnation: string
    provider: string
  }
  contract_ref: { uri: string; sha256: string }
  policy_ref: { uri: string; sha256: string }
}

export interface MessageIdentity extends MessageAssignment {
  message_id: string
  action_id: string
  created_at: number
  expires_at: number
}

export interface IdentifiedMessage {
  sourceNodeId: string
  targetNodeId: string
  body: string
  verb?: unknown
  message?: MessageIdentity
}

export interface MessageReceipt {
  message_id: string
  action_id: string
  assignment_epoch: number
  status: 'queued' | 'delivered' | 'acknowledged' | 'accepted' | 'expired' | 'unknown' | 'rejected'
}

export type AssignmentValidator = (
  binding: MessageAssignment,
  phase: 'admission' | 'delivery' | 'acknowledgment'
) => Promise<{ ok: boolean; code: string }>

export const MESSAGE_BODY_MAX_BYTES = 64 * 1024
export const MESSAGE_RECEIPT_CAPACITY = 200
export const MESSAGE_LIFETIME_MS = 5 * 60_000

const short = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= 192 && !/[\x00-\x20\x7f]/.test(v)
const ref = (v: MessageAssignment['contract_ref'] | undefined): boolean =>
  !!v && typeof v.uri === 'string' && v.uri.length > 0 && v.uri.length <= 1024 &&
  !/[\x00-\x1f\x7f]/.test(v.uri) && /^[a-f0-9]{64}$/.test(v.sha256)

/** Parse to one bounded, ordered shape so key ordering cannot defeat deduplication. */
export function canonicalMessage(value: MessageIdentity, target: string): MessageIdentity | undefined {
  const m = value
  if (!m || !short(m.message_id) || !short(m.action_id) || !short(m.task_id) ||
      !short(m.assignment_id) || !Number.isSafeInteger(m.assignment_epoch) || m.assignment_epoch < 1 ||
      !Number.isSafeInteger(m.created_at) || !Number.isSafeInteger(m.expires_at) ||
      m.created_at < 0 || m.expires_at <= m.created_at ||
      m.expires_at - m.created_at > MESSAGE_LIFETIME_MS || !ref(m.contract_ref) || !ref(m.policy_ref)) return
  const a = m.actor
  if (!a || ![a.agent_id, a.node, a.pane, a.session_id, a.incarnation, a.provider].every(short) ||
      a.node !== target) return
  return {
    message_id: m.message_id, action_id: m.action_id, task_id: m.task_id,
    assignment_id: m.assignment_id, assignment_epoch: m.assignment_epoch,
    actor: { agent_id: a.agent_id, node: a.node, pane: a.pane, session_id: a.session_id,
      incarnation: a.incarnation, provider: a.provider },
    contract_ref: { uri: m.contract_ref.uri, sha256: m.contract_ref.sha256 },
    policy_ref: { uri: m.policy_ref.uri, sha256: m.policy_ref.sha256 },
    created_at: m.created_at, expires_at: m.expires_at
  }
}

const rejected = (reason: string): AgentMessageOutcome => ({ kind: 'messageRejected', reason })
const key = (req: IdentifiedMessage): string => JSON.stringify([req.sourceNodeId, req.message?.message_id])
const fingerprint = (req: IdentifiedMessage): string => createHash('sha256')
  .update(JSON.stringify([req.sourceNodeId, req.targetNodeId, req.verb ?? null, req.body, req.message]))
  .digest('hex')

interface ReceiptEntry {
  fingerprint: string
  source: string
  message: MessageIdentity
  pending: Promise<AgentMessageOutcome>
  outcome?: AgentMessageOutcome
}

/** Bounded process-local delivery receipts. No task authority, persisted replay or payload ledger. */
export class MessageIntegrity {
  private readonly receipts = new Map<string, ReceiptEntry>()

  constructor(private readonly deps: { now(): number; validateAssignment?: AssignmentValidator },
    private readonly capacity = MESSAGE_RECEIPT_CAPACITY) {}

  async admit<T extends IdentifiedMessage>(req: T, send: (snapshot: T) => Promise<AgentMessageOutcome>): Promise<AgentMessageOutcome> {
    if (!req.message) return send({ ...req })
    const message = canonicalMessage(req.message, req.targetNodeId)
    if (!message || Buffer.byteLength(req.body) > MESSAGE_BODY_MAX_BYTES) return rejected('invalid-message')
    const snapshot = { ...req, message }
    const id = key(snapshot)
    const hash = fingerprint(snapshot)
    const existing = this.receipts.get(id)
    if (existing) {
      if (existing.fingerprint !== hash) return this.attach(message, rejected('message-id-conflict'))
      const outcome = await existing.pending
      return structuredClone(existing.outcome ?? this.record(snapshot, outcome))
    }
    for (const [oldId, entry] of this.receipts) {
      // Never evict pending admissions or unexpired identities to make room for new work.
      if (entry.outcome && entry.message.expires_at <= this.deps.now()) this.receipts.delete(oldId)
      else if (entry.source === req.sourceNodeId && entry.message.action_id === message.action_id)
        return this.attach(message, rejected('action-id-conflict'))
    }
    if (message.expires_at <= this.deps.now()) return this.attach(message, this.expired())
    if (message.created_at > this.deps.now()) return this.attach(message, rejected('future-message'))
    if (this.receipts.size >= this.capacity) return this.attach(message, rejected('receipt-capacity'))
    const entry: ReceiptEntry = { fingerprint: hash, source: req.sourceNodeId, message,
      pending: Promise.resolve().then(async () => {
        const refusal = await this.guard(snapshot, 'admission')
        return refusal ?? send(snapshot)
      }).catch(() => ({ kind: 'unknown', reason: 'admission-exception' })) }
    this.receipts.set(id, entry)
    const outcome = await entry.pending
    return this.record(snapshot, outcome)
  }

  async guard(req: IdentifiedMessage, phase: Parameters<AssignmentValidator>[1]): Promise<AgentMessageOutcome | undefined> {
    if (!req.message) return
    if (req.message.expires_at <= this.deps.now()) return this.expired()
    if (!this.deps.validateAssignment) return rejected('assignment-validator-unavailable')
    try {
      // Pass a copy: the callback may read authority, but cannot rewrite the queued envelope.
      const m = req.message
      const result = await this.deps.validateAssignment(structuredClone({
        task_id: m.task_id, assignment_id: m.assignment_id, assignment_epoch: m.assignment_epoch,
        actor: m.actor, contract_ref: m.contract_ref, policy_ref: m.policy_ref
      }), phase)
      if (result?.ok !== true) return rejected(short(result?.code) ? result.code : 'assignment-unverifiable')
    } catch { return rejected('assignment-validation-failed') }
    // A slow authority read cannot extend the original deadline.
    if (req.message.expires_at <= this.deps.now()) return this.expired()
  }

  record(req: IdentifiedMessage, outcome: AgentMessageOutcome): AgentMessageOutcome {
    if (!req.message) return outcome
    const next = this.attach(req.message, outcome)
    const entry = this.receipts.get(key(req))
    if (entry) {
      // An idle drain may complete as enqueue resolves. Its final receipt wins over queued.
      if (outcome.kind !== 'queued' || !entry.outcome) entry.outcome = structuredClone(next)
      return structuredClone(entry.outcome!)
    }
    return next
  }

  receipt(req: IdentifiedMessage): AgentMessageOutcome {
    const m = req.message && canonicalMessage(req.message, req.targetNodeId)
    if (!m) return rejected('invalid-message')
    const entry = this.receipts.get(key(req))
    if (entry && entry.fingerprint !== fingerprint({ ...req, message: m })) return this.attach(m, rejected('message-id-conflict'))
    return structuredClone(entry?.outcome ?? this.attach(m, { kind: 'unknown', reason: 'receipt-unavailable' }))
  }

  /** Call only after authenticating a recipient receipt; a hook turn alone cannot call this. */
  async acknowledge(req: IdentifiedMessage, status: 'acknowledged' | 'accepted'): Promise<AgentMessageOutcome> {
    const previous = this.receipt(req)
    if (previous.kind !== 'delivered' || !req.message) return rejected('message-not-delivered')
    const refusal = await this.guard(req, 'acknowledgment')
    if (refusal) return this.attach(req.message, refusal)
    const entry = this.receipts.get(key(req))!
    const current = entry.outcome!
    const outcome = { ...current, message: { ...current.message!,
      status: current.message?.status === 'accepted' ? 'accepted' as const : status } }
    entry.outcome = structuredClone(outcome)
    return outcome
  }

  private attach(m: MessageIdentity, outcome: AgentMessageOutcome): AgentMessageOutcome {
    const status: MessageReceipt['status'] = outcome.kind === 'delivered' || outcome.kind === 'queued' || outcome.kind === 'expired'
      ? outcome.kind : ['stalled', 'deliveredToReplacedTarget', 'unknown'].includes(outcome.kind) ? 'unknown' : 'rejected'
    return { ...outcome, message: { message_id: m.message_id, action_id: m.action_id,
      assignment_epoch: m.assignment_epoch, status } }
  }

  private expired(): AgentMessageOutcome { return { kind: 'expired', traceId: randomUUID(), queuedForMs: 0 } }
}
