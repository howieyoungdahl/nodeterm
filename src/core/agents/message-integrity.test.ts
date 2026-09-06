import { describe, expect, it, vi } from 'vitest'
import { MessageIntegrity, MESSAGE_BODY_MAX_BYTES, type MessageIdentity } from './message-integrity'
import { DeliveryQueue, type DeliveryQueueDeps, type QueuedDeliveryRequest } from './delivery-queue'
import { buildEnvelope } from './agent-message-envelope'
import type { AgentMessageOutcome } from './agent-message-decide'

function request(over: Partial<MessageIdentity> = {}): QueuedDeliveryRequest {
  return { sourceNodeId: 'sender', targetNodeId: 'target', sourceTitle: 'Sender', body: 'do the task', verb: 'send',
    message: { message_id: 'm1', action_id: 'a1', task_id: 'task', assignment_id: 'assignment',
      assignment_epoch: 1, actor: { agent_id: 'worker', node: 'target', pane: '%3',
        session_id: 'session1', incarnation: 'run1', provider: 'codex' },
      contract_ref: { uri: 'C:\\tasks\\contract.md', sha256: 'a'.repeat(64) },
      policy_ref: { uri: '/tasks/policy.md', sha256: 'b'.repeat(64) },
      created_at: 1000, expires_at: 2000, ...over } }
}
const delivered: AgentMessageOutcome = { kind: 'delivered', traceId: 't', traced: 'memory', receipt: 'observed', signal: 'newTurn' }
function fixture(over: Partial<DeliveryQueueDeps> = {}) {
  let clock = 1000
  let epoch = 1
  const envelopes: string[] = []
  const deps: DeliveryQueueDeps = {
    now: () => clock,
    validateAssignment: async (binding) => ({ ok: binding.assignment_epoch === epoch,
      code: binding.assignment_epoch === epoch ? 'ok' : 'stale_epoch' }),
    deliver: vi.fn(async (req, beforeSend) => {
      const refused = await beforeSend()
      if (refused) return refused
      envelopes.push(buildEnvelope({ nonce: 'nonce', sourceId: req.sourceNodeId,
        sourceTitle: req.sourceTitle, replyTo: req.sourceNodeId, body: req.body, message: req.message }))
      return delivered
    }),
    trace: async () => ({ traceId: 't', traced: 'memory' }),
    schedule: () => () => {},
    ...over
  }
  const queue = new DeliveryQueue(deps)
  return { deps, queue, envelopes, setClock: (n: number) => { clock = n }, setEpoch: (n: number) => { epoch = n } }
}

describe('correlated queued messages', () => {
  it('deduplicates concurrent retries and distinguishes delivery, acknowledgment and work acceptance', async () => {
    const f = fixture()
    const req = request()
    const receipts = await Promise.all([f.queue.enqueue(req), f.queue.enqueue(structuredClone(req))])
    expect(receipts).toEqual([receipts[0], receipts[0]])
    expect(receipts[0].message).toMatchObject({ message_id: 'm1', action_id: 'a1', status: 'queued' })
    expect(f.queue.depth('target')).toBe(1)
    await f.queue.onTargetIdle('target')
    expect(f.envelopes).toHaveLength(1)
    expect(f.envelopes[0]).toContain('"message_id":"m1"')
    expect(f.envelopes[0]).toContain('C:\\\\tasks\\\\contract.md')
    expect(f.queue.messages.receipt(req).message?.status).toBe('delivered')
    expect((await f.queue.messages.acknowledge(req, 'acknowledged')).message?.status).toBe('acknowledged')
    expect((await f.queue.messages.acknowledge(req, 'accepted')).message?.status).toBe('accepted')
    expect((await f.queue.messages.acknowledge(req, 'acknowledged')).message?.status).toBe('accepted')
    expect((await f.queue.enqueue(req)).message?.status).toBe('accepted')
    expect(f.deps.deliver).toHaveBeenCalledTimes(1)
  })

  it('refuses changed payloads and fresh message IDs reusing one action', async () => {
    const f = fixture()
    await f.queue.enqueue(request())
    expect(await f.queue.enqueue({ ...request(), body: 'different' })).toMatchObject({ kind: 'messageRejected', reason: 'message-id-conflict' })
    expect(await f.queue.enqueue(request({ message_id: 'm2' }))).toMatchObject({ kind: 'messageRejected', reason: 'action-id-conflict' })
    expect(f.queue.depth('target')).toBe(1)
  })

  it('snapshots queued requests, including nested actor and contract fields', async () => {
    const f = fixture()
    const req = request()
    await f.queue.enqueue(req)
    req.body = 'replacement'
    req.message!.actor.session_id = 'replacement'
    req.message!.contract_ref.uri = '/replacement'
    await f.queue.onTargetIdle('target')
    expect(f.envelopes[0]).not.toContain('replacement')
  })

  it.each(['stale_epoch', 'actor_mismatch', 'reference_mismatch', 'suspended', 'missing'])('refuses %s at admission', async (code) => {
    const f = fixture({ validateAssignment: async () => ({ ok: false, code }) })
    expect(await f.queue.enqueue(request())).toMatchObject({ kind: 'messageRejected', reason: code })
    expect(f.queue.depth('target')).toBe(0)
    expect(f.deps.deliver).not.toHaveBeenCalled()
  })

  it('refuses a missing or throwing assignment adapter', async () => {
    for (const validateAssignment of [undefined, async () => { throw new Error('unreadable') }]) {
      const f = fixture({ validateAssignment })
      expect((await f.queue.enqueue(request())).kind).toBe('messageRejected')
      expect(f.deps.deliver).not.toHaveBeenCalled()
    }
  })

  it('fences queued delivery and late recipient acceptance after transfer', async () => {
    const f = fixture()
    const req = request()
    await f.queue.enqueue(req)
    f.setEpoch(2)
    await f.queue.onTargetIdle('target')
    expect(f.deps.deliver).not.toHaveBeenCalled()
    expect(f.queue.messages.receipt(req)).toMatchObject({ kind: 'messageRejected', reason: 'stale_epoch' })
    const g = fixture()
    await g.queue.enqueue(req)
    await g.queue.onTargetIdle('target')
    g.setEpoch(2)
    expect(await g.queue.messages.acknowledge(req, 'accepted')).toMatchObject({ kind: 'messageRejected', reason: 'stale_epoch' })
    expect(g.queue.messages.receipt(req).message?.status).toBe('delivered')
  })

  it('rechecks after an asynchronous delivery probe', async () => {
    let f: ReturnType<typeof fixture>
    f = fixture({ deliver: async (_req, guard) => { f.setEpoch(2); return (await guard()) ?? delivered } })
    await f.queue.enqueue(request())
    await f.queue.onTargetIdle('target')
    expect(f.queue.messages.receipt(request())).toMatchObject({ kind: 'messageRejected', reason: 'stale_epoch' })
  })

  it('does not renew a deadline during validation or slow tracing', async () => {
    let f: ReturnType<typeof fixture>
    f = fixture({ validateAssignment: async () => { f.setClock(2000); return { ok: true, code: 'ok' } } })
    expect((await f.queue.enqueue(request())).message?.status).toBe('expired')
    const expired = vi.fn()
    let g: ReturnType<typeof fixture>
    g = fixture({ trace: async () => { g.setClock(2001); return { traceId: 't', traced: 'memory' } }, onExpired: expired })
    expect((await g.queue.enqueue(request())).message?.status).toBe('expired')
    expect(expired).toHaveBeenCalledTimes(1)
    expect(g.queue.depth('target')).toBe(0)
  })

  it('retains an unknown receipt when delivery and notification fail, without replay', async () => {
    const f = fixture({ deliver: vi.fn(async () => { throw new Error('partial write') }),
      onFlushed: () => { throw new Error('observer') } })
    await f.queue.enqueue(request())
    await f.queue.onTargetIdle('target')
    expect((await f.queue.enqueue(request())).message?.status).toBe('unknown')
    expect(f.deps.deliver).toHaveBeenCalledTimes(1)
  })

  it('bounds transient attempts and rejects oversized payloads', async () => {
    const f = fixture({ deliver: vi.fn(async (): Promise<AgentMessageOutcome> => ({ kind: 'targetBusy', state: 'working' })) })
    await f.queue.enqueue(request())
    for (let i = 0; i < 4; i++) await f.queue.onTargetIdle('target')
    expect(f.deps.deliver).toHaveBeenCalledTimes(3)
    expect(f.queue.messages.receipt(request())).toMatchObject({ kind: 'messageRejected', reason: 'retry-limit' })
    expect((await f.queue.enqueue({ ...request({ message_id: 'large', action_id: 'large' }),
      body: 'x'.repeat(MESSAGE_BODY_MAX_BYTES + 1) })).kind).toBe('messageRejected')
  })

  it('bounds receipts without evicting an unexpired deduplication record', async () => {
    const store = new MessageIntegrity({ now: () => 1000, validateAssignment: async () => ({ ok: true, code: 'ok' }) }, 1)
    const send = vi.fn(async () => delivered)
    await store.admit(request(), send)
    expect(await store.admit(request({ message_id: 'm2', action_id: 'a2' }), send)).toMatchObject({ kind: 'messageRejected', reason: 'receipt-capacity' })
    await store.admit(request(), send)
    expect(send).toHaveBeenCalledTimes(1)
    expect(new MessageIntegrity({ now: () => 1000 }).receipt(request())).toMatchObject({ kind: 'unknown', message: { message_id: 'm1' } })
  })
})
