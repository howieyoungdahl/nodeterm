import { describe, expect, it, vi } from 'vitest'
import type { AgentMessageOutcome } from './agent-message-decide'
import { DeliveryQueue, type DeliveryQueueDeps } from './delivery-queue'
import { sendOperatorMessage, type OperatorDeliveryInput } from './operator-messaging'
import type { OperatorSessionTarget } from '../../shared/operator-conversations'

const target: OperatorSessionTarget = { projectId: 'p1', nodeId: 'node-1', sessionId: 'session-a', generation: 'boot-a' }
const delivered: AgentMessageOutcome = { kind: 'delivered', traceId: 'receipt-1', traced: 'memory', receipt: 'observed', signal: 'newTurn' }

function setup(over: Partial<DeliveryQueueDeps> = {}) {
  let now = 1000
  const timers: (() => void)[] = []
  const outcomes: AgentMessageOutcome[] = []
  const sent: string[] = []
  const deps: DeliveryQueueDeps = {
    now: () => now,
    deliver: async () => ({ kind: 'unknown', reason: 'unexpected-agent-path' }),
    deliverOperator: async (req, beforeSend) => {
      const refusal = await beforeSend()
      if (refusal) return refusal
      sent.push(req.body)
      req.operator?.onAccepted?.()
      return delivered
    },
    trace: async () => ({ traceId: 'queued-trace', traced: 'memory' }),
    onExpired: () => {},
    onFlushed: () => {},
    schedule: (_ms, fn) => { timers.push(fn); return () => {} },
    ...over
  }
  const queue = new DeliveryQueue(deps, { ttlMs: 50 })
  let allowed = true
  let current = true
  const input: OperatorDeliveryInput = {
    callerId: 'operator-7', target, text: 'synthetic message', messageId: 'm-1',
    authorize: async () => allowed,
    onOutcome: (outcome) => outcomes.push(outcome)
  }
  const send = () => sendOperatorMessage(input, {
    queue,
    deliver: async (message, beforeSend) => {
      const refusal = await beforeSend()
      if (refusal) return refusal
      return message.text === 'busy' ? { kind: 'targetBusy', state: 'working' } : delivered
    },
    isCurrent: async (received) => current && received.generation === target.generation
  })
  return { queue, input, send, outcomes, sent, timers, setAllowed: (v: boolean) => { allowed = v }, setCurrent: (v: boolean) => { current = v }, setNow: (v: number) => { now = v } }
}

describe('operator-principal delivery adapter', () => {
  it('refuses an unauthorized operator before delivery or queue admission', async () => {
    const h = setup()
    h.setAllowed(false)
    await expect(h.send()).resolves.toMatchObject({ kind: 'notPermitted' })
    expect(h.queue.depth(target.nodeId)).toBe(0)
    expect(h.outcomes).toHaveLength(1)
  })

  it('refuses an operator queue request that also claims a canvas node identity', async () => {
    const h = setup()
    const outcome = await h.queue.enqueue({
      sourcePrincipal: 'operator', sourceNodeId: 'forged-node', sourceTitle: 'Operator',
      targetNodeId: target.nodeId, body: 'synthetic',
      operator: { target, callerId: 'operator-7', messageId: 'm-2', authorize: async () => true, onOutcome: () => {} }
    })
    expect(outcome).toMatchObject({ kind: 'messageRejected', reason: 'invalid-operator-principal' })
    expect(h.queue.depth(target.nodeId)).toBe(0)
  })

  it('rejects a target object changed while authorization is pending', async () => {
    let finish!: (allowed: boolean) => void
    const h = setup()
    h.input.target = { ...target }
    h.input.authorize = () => new Promise<boolean>((resolve) => { finish = resolve })
    const pending = h.send()
    h.input.target.sessionId = 'replacement-session'
    finish(true)
    await expect(pending).resolves.toMatchObject({ kind: 'notPermitted' })
    expect(h.queue.depth(target.nodeId)).toBe(0)
  })

  it('turns a direct transport exception into an uncertain receipt and does not queue it', async () => {
    const h = setup()
    const send = sendOperatorMessage(h.input, {
      queue: h.queue,
      deliver: async () => { throw new Error('possibly pasted') },
      isCurrent: () => true
    })
    await expect(send).resolves.toMatchObject({ kind: 'unknown', reason: 'delivery-exception' })
    expect(h.queue.depth(target.nodeId)).toBe(0)
    expect(h.outcomes.at(-1)).toMatchObject({ kind: 'unknown' })
  })

  it('revalidates a queued grant and target generation at flush, without using the agent sender', async () => {
    const h = setup({ deliverOperator: async (req, beforeSend) => {
      const refusal = await beforeSend()
      if (refusal) return refusal
      h.sent.push(req.body)
      return delivered
    } })
    h.input.text = 'busy'
    await expect(h.send()).resolves.toMatchObject({ kind: 'queued' })
    h.setCurrent(false)
    await h.queue.onTargetIdle(target.nodeId)
    expect(h.sent).toEqual([])
    expect(h.outcomes.at(-1)).toMatchObject({ kind: 'notPermitted' })
  })

  it('reports a verified receipt after a queued operator message flushes', async () => {
    const h = setup()
    const accepted = vi.fn()
    h.input.onAccepted = accepted
    h.input.text = 'busy'
    await h.send()
    await h.queue.onTargetIdle(target.nodeId)
    expect(h.sent).toEqual(['busy'])
    expect(h.outcomes.at(-1)).toMatchObject({ kind: 'delivered', receipt: 'observed' })
    expect(accepted).toHaveBeenCalledOnce()
    expect(delivered.receipt).toBe('observed')
  })

  it('surfaces an uncertain queue delivery error once and does not replay it', async () => {
    let attempts = 0
    const h = setup({ deliverOperator: async () => { attempts++; throw new Error('possibly pasted') } })
    h.input.text = 'busy'
    await h.send()
    await h.queue.onTargetIdle(target.nodeId)
    expect(attempts).toBe(1)
    expect(h.outcomes.at(-1)).toMatchObject({ kind: 'unknown', reason: 'delivery-exception' })
    expect(h.queue.depth(target.nodeId)).toBe(0)
  })

  it('treats a stalled operator submission as terminal because transport may have accepted bytes', async () => {
    let attempts = 0
    const h = setup({ deliverOperator: async () => {
      attempts++
      return { kind: 'stalled', traceId: 'stalled-1', traced: 'memory', waitedMs: 8000 }
    } })
    h.input.text = 'busy'
    await h.send()
    await h.queue.onTargetIdle(target.nodeId)
    await h.queue.onTargetIdle(target.nodeId)
    expect(attempts).toBe(1)
    expect(h.outcomes.at(-1)).toMatchObject({ kind: 'stalled' })
    expect(h.queue.depth(target.nodeId)).toBe(0)
  })

  it('updates the operator receipt on expiry and never records message text in traces', async () => {
    const traced: unknown[] = []
    const h = setup({ trace: async (entry) => { traced.push(entry); return { traceId: 'q', traced: 'memory' } } })
    h.input.text = 'busy'
    await h.send()
    h.setNow(1051)
    h.timers[0]()
    await vi.waitFor(() => expect(h.outcomes.at(-1)).toMatchObject({ kind: 'expired' }))
    expect(JSON.stringify(traced)).not.toContain('synthetic message')
    expect(JSON.stringify(traced)).not.toContain('busy')
  })
})
