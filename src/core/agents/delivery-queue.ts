import type { AgentMessageOutcome } from './agent-message-decide'
import { RETRYABLE } from './agent-message-decide'
import type { DeliveryTraceInput } from './agent-message-trace'

/**
 * DELIVER-ON-IDLE — a bounded, per-target queue with a TTL, and never a silent drop.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────────
 *
 * Gate 2 refuses a BUSY target (`targetBusy`) and a target between sessions
 * (`targetNotIdleUnknown`), and Eco hibernation leaves an idle node's pane on a SHELL — so
 * `targetNotAgentPane` refuses it *forever* on exactly the nodes an orchestration is most likely to
 * message (the ones sitting idle). "Retry in a moment" pushes that onto a language model with a rate
 * limiter in front of it: a busy-loop that burns tokens. Wake-then-deliver is therefore not a
 * nicety — it is what makes messaging usable across a long-running canvas.
 *
 * So a `targetBusy` / hibernated target with queueing on is ENQUEUED, and delivered when the target
 * next goes idle. `queued` is NOT `delivered`: the bytes have not reached the pane, and the receipt
 * (Task 3.4) is what will close the loop once they do. A queue full stops the sender loudly
 * (`queueFull`), and a message that waits out its TTL EXPIRES loudly — to the trace and to the
 * sender — because a silent drop is the one outcome a security core may never have.
 *
 * ── THE DECSET-2004 MEASUREMENT MADE THIS SAFE (2026-08-15, this host) ───────────────────────────
 *
 * Deliver-on-idle only works if a queued message can be framed into the target's pane WITHOUT a
 * per-delivery bracketed-paste probe. Measured: all four agent CLIs (claude, codex, gemini,
 * opencode) keep DECSET 2004 ON at idle AND during startup, twice each, no flapping — so
 * `paste-buffer -p` frames every flush, including one into a still-starting agent after a wake. The
 * ONE unsafe surface is a NON-agent pane (a plain REPL/terminal): 2004 OFF ⇒ the payload lands as
 * raw keystrokes, one submit per newline. This queue therefore gates on NODE TYPE, not on a runtime
 * probe: it only ever enqueues for a target whose delivery attempt refused as `targetBusy` /
 * `hibernated` — i.e. a pane gate 1 already judged an AGENT pane — and the flush re-runs the whole
 * delivery (gate 1 included), so a pane that became a terminal while queued is refused, never
 * sprayed with unframed lines.
 *
 * ── FLUSH-TIME RE-VALIDATION IS THE LOAD-BEARING PROPERTY ───────────────────────────────────────
 *
 * A message queued for a busy agent must NOT trust the decision that queued it. Ownership can change
 * (the pane is respawned by another project), the grant can be revoked (the switch turned off, the
 * clone notice declined), the flow budget can move — all while the message waits. So the flush does
 * not cache anything: it calls `deps.deliver(req)` again, which is the SAME end-to-end path the verb
 * took (scope → ownership → grant → flow → `deliverAgentMessage`). A grant revoked while queued
 * therefore comes back `notPermitted` at flush and the message is DROPPED, never delivered — pinned
 * by `delivery-queue.test.ts`, which flips the injected `deliver` from `targetBusy` to
 * `notPermitted` between enqueue and flush and asserts nothing reached the pane.
 *
 * ── SHIPS ON BOTH SHELLS, USED ON ONE ──────────────────────────────────────────────────────────
 *
 * Pure `src/core`: no electron, no main import (`no-electron.test.ts`). Every side effect — the
 * clock, the delivery, the wake, the trace, the sender-notify, the timer — is injected, so the whole
 * lifecycle is driven without a pty or a window. The desktop is the only shell that wires a consumer
 * (messaging does not exist on the Server Edition, Task 5.3); the module still compiles and ships
 * there, like everything else in this directory.
 */

/** How long a message waits queued before it expires. Long enough for an orchestration turn (which
 *  can run minutes), bounded so a target that never goes idle cannot pin a message forever. */
export const DELIVERY_QUEUE_TTL_MS = 5 * 60_000

/** How many messages one target may have queued at once. Small and per-target: an unbounded queue
 *  is a memory-DoS surface, and refusing at the bound (rather than dropping the oldest) keeps FIFO
 *  fairness and tells the sender loudly instead of silently discarding a message already accepted. */
export const DELIVERY_QUEUE_CAPACITY = 16

/** The request the queue carries — opaque to the queue, handed straight back to `deps.deliver`. The
 *  queue keys everything on `targetNodeId` (the flush trigger and the per-target bound) and
 *  `sourceNodeId` (so an expiry can name who to tell); the rest travels untouched. */
export interface QueuedDeliveryRequest {
  sourceNodeId: string
  targetNodeId: string
  sourceTitle: string
  /** For the expiry trace's `bodyChars` — the body itself is never traced (see agent-message-trace). */
  body: string
  [k: string]: unknown
}

/** Cancels a scheduled timer. Returned by `schedule`. */
export type CancelTimer = () => void

export interface DeliveryQueueDeps {
  now(): number
  /**
   * The FULL, re-validated delivery — in production `deliverFromControl`. Called on every flush, so
   * the whole gate chain (scope, ownership, grant, flow, `deliverAgentMessage`) runs again against
   * live state. This is what makes the queue safe: it caches no authorization decision.
   */
  deliver(req: QueuedDeliveryRequest): Promise<AgentMessageOutcome>
  /** Record an outcome (`recordDelivery`). The queue traces `queued` on enqueue and `expired` on a
   *  TTL lapse; the flush's own outcomes are traced inside `deliver`. */
  trace(input: DeliveryTraceInput): Promise<{ traceId: string; traced: string }>
  /**
   * Wake a hibernated target through the existing registry (`agent-restart.ts` hibernate/wake
   * pair). Optional: a target that is merely busy (not hibernated) needs no wake, and a shell with
   * no registry (the Server Edition) wires nothing. A wake is fire-and-forget here — the target's
   * eventual idle event is what triggers the flush, not this call's resolution.
   */
  wake?(nodeId: string): void
  /**
   * Tell the SENDER a queued message expired. The trace is the durable leg (always written); this
   * is the live leg — the shell surfaces it (a board-log line for the sender, a push). Optional so
   * the core can be tested without a notify channel, but a production wiring that omits it turns the
   * "never a silent drop" guarantee into "durable-only", so the desktop always supplies it.
   */
  onExpired?(req: QueuedDeliveryRequest, info: { traceId: string; queuedForMs: number }): void
  /** Tell the sender how a flush ended (delivered, or refused because the world changed under it).
   *  Same optionality reasoning as `onExpired`. */
  onFlushed?(req: QueuedDeliveryRequest, outcome: AgentMessageOutcome): void
  /** Arm a one-shot timer, returning its cancel. Injected so tests drive TTL expiry deterministically
   *  instead of waiting real milliseconds; defaults to `setTimeout`/`clearTimeout`. */
  schedule?(ms: number, fn: () => void): CancelTimer
}

interface QueueEntry {
  req: QueuedDeliveryRequest
  enqueuedAt: number
  ttlMs: number
  cancelTimer: CancelTimer
  /** The traceId minted when this was queued, reused on its expiry so the two entries correlate. */
  queuedTraceId: string
}

/** Outcomes that mean "the target still is not ready, come back" — a flush that gets one of these
 *  RE-QUEUES the entry at the front (its TTL keeps counting from the original enqueue) and STOPS
 *  draining, because one idle event does not promise the target stays idle. Derived from `RETRYABLE`
 *  minus the two outcomes the queue itself produces (`queueFull`, `expired`) — so `deliver`'s
 *  retryable outcomes (`rateLimited`, `targetBusy`, `targetNotIdleUnknown`, `targetStatusStale`) all
 *  wait for the NEXT idle, and a new retryable outcome added upstream is handled here the moment it
 *  exists rather than silently dropped. `rateLimited` waiting for the next idle (not re-flushing on a
 *  timer) is what keeps the queue from spinning against the very limiter that refused it. */
const REQUEUE_ON: ReadonlySet<AgentMessageOutcome['kind']> = new Set(
  (Object.keys(RETRYABLE) as AgentMessageOutcome['kind'][]).filter(
    (k) => RETRYABLE[k] && k !== 'queueFull' && k !== 'expired'
  )
)

export class DeliveryQueue {
  private readonly queues = new Map<string, QueueEntry[]>()
  private readonly capacity: number
  private readonly ttlMs: number
  private readonly schedule: (ms: number, fn: () => void) => CancelTimer

  constructor(
    private readonly deps: DeliveryQueueDeps,
    opts: { capacity?: number; ttlMs?: number } = {}
  ) {
    this.capacity = opts.capacity ?? DELIVERY_QUEUE_CAPACITY
    this.ttlMs = opts.ttlMs ?? DELIVERY_QUEUE_TTL_MS
    this.schedule =
      deps.schedule ??
      ((ms, fn): CancelTimer => {
        const t = setTimeout(fn, ms)
        return () => clearTimeout(t)
      })
  }

  /** How many messages are queued for a target right now — for assertions and a position count. */
  depth(nodeId: string): number {
    return this.queues.get(nodeId)?.length ?? 0
  }

  /** Read-only health snapshot: target node id → current queue depth. */
  depths(): Record<string, number> {
    return Object.fromEntries(
      [...this.queues.entries()]
        .filter(([, entries]) => entries.length > 0)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([nodeId, entries]) => [nodeId, entries.length])
    )
  }

  /**
   * Enqueue a message whose initial delivery refused as `targetBusy` (or whose target is
   * hibernated). Returns the `queued` receipt (with its position and TTL) or `queueFull` at the
   * bound — never enqueues past capacity. A `hibernated` target is woken here, before it is idle;
   * the wake's eventual idle event is what triggers the flush.
   */
  async enqueue(
    req: QueuedDeliveryRequest,
    opts: { hibernated?: boolean } = {}
  ): Promise<
    Extract<AgentMessageOutcome, { kind: 'queued' } | { kind: 'queueFull' }>
  > {
    const list = this.queues.get(req.targetNodeId) ?? []
    if (list.length >= this.capacity) {
      // Refused, not dropped-oldest: an accepted message is never silently discarded to make room.
      return { kind: 'queueFull', capacity: this.capacity }
    }
    const now = this.deps.now()
    const t = await this.deps.trace({
      sourceNodeId: req.sourceNodeId,
      sourceTitle: req.sourceTitle,
      targetNodeId: req.targetNodeId,
      outcome: 'queued',
      bodyChars: req.body.length
    })
    const entry: QueueEntry = {
      req,
      enqueuedAt: now,
      ttlMs: this.ttlMs,
      queuedTraceId: t.traceId,
      cancelTimer: this.schedule(this.ttlMs, () => void this.expire(req.targetNodeId, entry))
    }
    list.push(entry)
    this.queues.set(req.targetNodeId, list)
    // Kick the wake for a hibernated target so it starts its resume; the flush waits on the idle
    // event, not on the wake. A busy (non-hibernated) target needs nothing — it will go idle on its
    // own turn end.
    if (opts.hibernated) this.deps.wake?.(req.targetNodeId)
    return { kind: 'queued', traceId: t.traceId, position: list.length, ttlMs: this.ttlMs }
  }

  /**
   * The target went idle — flush its queue, oldest first. Each entry is delivered through
   * `deps.deliver`, which RE-RUNS the whole gate chain against live state (the flush-time
   * re-validation). An entry whose flush says "still not ready" is put back (its TTL unchanged); any
   * other outcome is terminal and the entry is gone. Draining stops the moment the target is not
   * ready again — one idle event does not promise the target stays idle across N deliveries.
   */
  async onTargetIdle(nodeId: string): Promise<void> {
    for (;;) {
      const list = this.queues.get(nodeId)
      if (!list || list.length === 0) return
      const entry = list[0]
      // Take it off before delivering: a re-entrant idle event (deliver can await a real round-trip)
      // must not flush the same entry twice. It goes back on failure, at the FRONT, preserving order.
      list.shift()
      entry.cancelTimer()
      const outcome = await this.deps.deliver(entry.req)
      if (REQUEUE_ON.has(outcome.kind)) {
        // Not ready yet (busy again, still unverified, or rate-limited): keep it, TTL counting from
        // its ORIGINAL enqueue, and stop draining — the target is evidently not idle after all.
        this.requeueFront(nodeId, entry)
        return
      }
      // Terminal: delivered, or a refusal waiting will not fix (notPermitted from a revoked grant,
      // targetGone, targetNotAgentPane…). The entry is done; tell the sender and move to the next.
      if (this.queues.get(nodeId)?.length === 0) this.queues.delete(nodeId)
      this.deps.onFlushed?.(entry.req, outcome)
    }
  }

  /** Put an entry back at the front with its TTL re-armed for the time it has LEFT (never reset to a
   *  full TTL — the wait it has already served counts). A lapsed remainder expires it immediately. */
  private requeueFront(nodeId: string, entry: QueueEntry): void {
    const remaining = Math.max(0, entry.ttlMs - (this.deps.now() - entry.enqueuedAt))
    entry.cancelTimer = this.schedule(remaining, () => void this.expire(nodeId, entry))
    const list = this.queues.get(nodeId) ?? []
    list.unshift(entry)
    this.queues.set(nodeId, list)
  }

  /**
   * A queued message waited out its TTL. Remove it, trace `expired`, and tell the sender — both
   * legs, because a dropped message with no record anywhere is the failure this module refuses to
   * have. Idempotent against a flush that already removed the entry (the timer can fire in the seam
   * before its cancel runs).
   */
  private async expire(nodeId: string, entry: QueueEntry): Promise<void> {
    const list = this.queues.get(nodeId)
    if (!list) return
    const i = list.indexOf(entry)
    if (i < 0) return // already delivered/re-queued with a fresh timer — this fire is stale
    list.splice(i, 1)
    if (list.length === 0) this.queues.delete(nodeId)
    entry.cancelTimer()
    const queuedForMs = this.deps.now() - entry.enqueuedAt
    const t = await this.deps.trace({
      sourceNodeId: entry.req.sourceNodeId,
      sourceTitle: entry.req.sourceTitle,
      targetNodeId: entry.req.targetNodeId,
      outcome: 'expired',
      bodyChars: entry.req.body.length
    })
    this.deps.onExpired?.(entry.req, { traceId: t.traceId, queuedForMs })
  }

  /** Test seam / shutdown: cancel every timer and drop every queue WITHOUT tracing (a teardown is
   *  not an expiry the sender needs to hear about). */
  resetForTests(): void {
    for (const list of this.queues.values()) for (const e of list) e.cancelTimer()
    this.queues.clear()
  }
}
