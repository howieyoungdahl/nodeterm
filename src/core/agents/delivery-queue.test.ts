import { describe, it, expect } from 'vitest'
import {
  DeliveryQueue,
  DELIVERY_QUEUE_CAPACITY,
  DELIVERY_QUEUE_TTL_MS,
  type DeliveryQueueDeps,
  type QueuedDeliveryRequest,
  type CancelTimer
} from './delivery-queue'
import type { AgentMessageOutcome } from './agent-message-decide'

/**
 * The bounded per-target queue, every rule driven with a fake clock, a fake scheduler and a
 * programmable `deliver` — so TTL expiry and flush-time re-validation are deterministic rather than
 * timing-dependent. The load-bearing test is the third-from-last: a grant revoked WHILE a message is
 * queued is dropped, not delivered, because the flush re-runs the whole delivery instead of trusting
 * the decision that queued it.
 */

interface FakeTimer {
  ms: number
  fn: () => void
  cancelled: boolean
}

function harness(over: Partial<DeliveryQueueDeps> = {}) {
  let clock = 1000
  const traced: { outcome: string; sourceNodeId: string; targetNodeId: string }[] = []
  const expired: { req: QueuedDeliveryRequest; info: { traceId: string; queuedForMs: number } }[] = []
  const flushed: { req: QueuedDeliveryRequest; outcome: AgentMessageOutcome }[] = []
  const woken: string[] = []
  const timers: FakeTimer[] = []
  let nextOutcome: AgentMessageOutcome = { kind: 'delivered', traceId: 'd', traced: 'memory', receipt: 'observed', signal: 'newTurn' }
  const delivered: QueuedDeliveryRequest[] = []

  const deps: DeliveryQueueDeps = {
    now: () => clock,
    deliver: async (req) => {
      delivered.push(req)
      return nextOutcome
    },
    trace: async (input) => {
      traced.push({ outcome: input.outcome, sourceNodeId: input.sourceNodeId, targetNodeId: input.targetNodeId })
      return { traceId: `trace-${traced.length}`, traced: 'memory' }
    },
    wake: (id) => woken.push(id),
    onExpired: (req, info) => expired.push({ req, info }),
    onFlushed: (req, outcome) => flushed.push({ req, outcome }),
    schedule: (ms, fn): CancelTimer => {
      const t: FakeTimer = { ms, fn, cancelled: false }
      timers.push(t)
      return () => {
        t.cancelled = true
      }
    },
    ...over
  }

  return {
    deps,
    traced,
    expired,
    flushed,
    woken,
    timers,
    delivered,
    setClock: (n: number): void => {
      clock = n
    },
    setOutcome: (o: AgentMessageOutcome): void => {
      nextOutcome = o
    },
    /** Fire the most recently armed (not-yet-cancelled) timer — a TTL lapse. */
    fireLatestTimer: (): void => {
      const live = timers.filter((t) => !t.cancelled)
      live[live.length - 1].fn()
    }
  }
}

const req = (over: Partial<QueuedDeliveryRequest> = {}): QueuedDeliveryRequest => ({
  sourceNodeId: 'src',
  targetNodeId: 'dst',
  sourceTitle: 'Alpha',
  body: 'ping',
  ...over
})

describe('DeliveryQueue', () => {
  it('enqueue returns a queued receipt with position + TTL, and traces `queued`', async () => {
    const h = harness()
    const q = new DeliveryQueue(h.deps)
    const out = await q.enqueue(req())
    expect(out).toEqual({ kind: 'queued', traceId: 'trace-1', position: 1, ttlMs: DELIVERY_QUEUE_TTL_MS })
    expect(q.depth('dst')).toBe(1)
    expect(h.traced).toEqual([{ outcome: 'queued', sourceNodeId: 'src', targetNodeId: 'dst' }])
  })

  it('positions count up per target', async () => {
    const h = harness()
    const q = new DeliveryQueue(h.deps)
    const a = await q.enqueue(req({ body: 'a' }))
    const b = await q.enqueue(req({ body: 'b' }))
    expect(a).toMatchObject({ kind: 'queued', position: 1 })
    expect(b).toMatchObject({ kind: 'queued', position: 2 })
    expect(q.depth('dst')).toBe(2)
  })

  it('reports per-target depths without exposing queue contents', async () => {
    const h = harness()
    const q = new DeliveryQueue(h.deps)
    await q.enqueue(req({ targetNodeId: 'z', body: 'one' }))
    await q.enqueue(req({ targetNodeId: 'a', body: 'two' }))
    await q.enqueue(req({ targetNodeId: 'z', body: 'three' }))
    expect(q.depths()).toEqual({ a: 1, z: 2 })
  })

  it('refuses with `queueFull` at capacity — never drops an accepted message', async () => {
    const h = harness()
    const q = new DeliveryQueue(h.deps, { capacity: 2 })
    await q.enqueue(req({ body: 'a' }))
    await q.enqueue(req({ body: 'b' }))
    const out = await q.enqueue(req({ body: 'c' }))
    expect(out).toEqual({ kind: 'queueFull', capacity: 2 })
    // The two already queued are untouched — capacity refuses the new one, it does not evict.
    expect(q.depth('dst')).toBe(2)
  })

  it('flushes on idle: delivers oldest-first and empties the queue', async () => {
    const h = harness()
    const q = new DeliveryQueue(h.deps)
    await q.enqueue(req({ body: 'first' }))
    await q.enqueue(req({ body: 'second' }))
    await q.onTargetIdle('dst')
    expect(h.delivered.map((r) => r.body)).toEqual(['first', 'second'])
    expect(q.depth('dst')).toBe(0)
    expect(h.flushed.map((f) => f.outcome.kind)).toEqual(['delivered', 'delivered'])
  })

  it('a hibernated target is WOKEN on enqueue, before it is idle', async () => {
    const h = harness()
    const q = new DeliveryQueue(h.deps)
    await q.enqueue(req(), { hibernated: true })
    expect(h.woken).toEqual(['dst'])
    // A merely-busy target is not woken.
    await q.enqueue(req({ targetNodeId: 'busy' }))
    expect(h.woken).toEqual(['dst'])
  })

  // ── THE LOAD-BEARING PROPERTY: flush-time re-validation ────────────────────────────────────────
  it('DROPS a message whose grant was revoked while it was queued — never delivers it', async () => {
    const h = harness()
    const q = new DeliveryQueue(h.deps)
    // Enqueued while the target was busy…
    await q.enqueue(req({ body: 'secret' }))
    expect(q.depth('dst')).toBe(1)
    // …and by flush time the grant is gone: `deliver` (the full re-validated path) now refuses.
    h.setOutcome({ kind: 'notPermitted', reason: 'switch-off' })
    await q.onTargetIdle('dst')
    // It was attempted through the real delivery (which is where the grant is checked) and DROPPED —
    // not re-queued, not delivered.
    expect(h.delivered.map((r) => r.body)).toEqual(['secret'])
    expect(q.depth('dst')).toBe(0)
    expect(h.flushed).toHaveLength(1)
    expect(h.flushed[0].outcome).toEqual({ kind: 'notPermitted', reason: 'switch-off' })
    // Never reported as delivered.
    expect(h.flushed.some((f) => f.outcome.kind === 'delivered')).toBe(false)
  })

  it('a still-busy target at flush keeps the message queued (TTL from the original enqueue)', async () => {
    const h = harness()
    const q = new DeliveryQueue(h.deps)
    await q.enqueue(req())
    h.setOutcome({ kind: 'targetBusy', state: 'working' })
    await q.onTargetIdle('dst')
    // Attempted, found busy again, put back — not lost, not delivered.
    expect(h.delivered).toHaveLength(1)
    expect(q.depth('dst')).toBe(1)
    expect(h.flushed).toHaveLength(0)
    // A later idle when it is truly free delivers it.
    h.setOutcome({ kind: 'delivered', traceId: 'd', traced: 'memory', receipt: 'observed', signal: 'newTurn' })
    await q.onTargetIdle('dst')
    expect(q.depth('dst')).toBe(0)
    expect(h.flushed.map((f) => f.outcome.kind)).toEqual(['delivered'])
  })

  // ── TTL expiry — never a silent drop ──────────────────────────────────────────────────────────
  it('a TTL lapse traces `expired` AND tells the sender, then removes the entry', async () => {
    const h = harness()
    const q = new DeliveryQueue(h.deps, { ttlMs: 1000 })
    await q.enqueue(req())
    expect(q.depth('dst')).toBe(1)
    h.setClock(1000 + 1000) // the TTL has elapsed
    h.fireLatestTimer()
    await Promise.resolve() // let the async expiry settle
    await Promise.resolve()
    expect(q.depth('dst')).toBe(0)
    // Both legs: the durable trace and the live notify.
    expect(h.traced.map((t) => t.outcome)).toContain('expired')
    expect(h.expired).toHaveLength(1)
    expect(h.expired[0].info.queuedForMs).toBe(1000)
    expect(h.expired[0].info.traceId).toBeTruthy()
  })

  it('an expiry timer that fires AFTER the entry already flushed is a no-op (no double drop)', async () => {
    const h = harness()
    const q = new DeliveryQueue(h.deps, { ttlMs: 1000 })
    await q.enqueue(req())
    await q.onTargetIdle('dst') // delivered — the entry is gone, its timer cancelled
    expect(q.depth('dst')).toBe(0)
    // A stale timer fire (belt-and-braces: the entry is no longer in any list) must not expire.
    const before = h.expired.length
    h.timers[0].fn()
    await Promise.resolve()
    expect(h.expired.length).toBe(before)
  })

  it('the constants are finite and positive — a real bound and a real TTL', () => {
    expect(DELIVERY_QUEUE_CAPACITY).toBeGreaterThan(0)
    expect(Number.isFinite(DELIVERY_QUEUE_CAPACITY)).toBe(true)
    expect(DELIVERY_QUEUE_TTL_MS).toBeGreaterThan(0)
    expect(Number.isFinite(DELIVERY_QUEUE_TTL_MS)).toBe(true)
  })
})
