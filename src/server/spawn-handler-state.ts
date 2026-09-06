export const SPAWN_HANDLER_WEDGE_AFTER_MS = 30_000

export interface SpawnHandlerSnapshot {
  state: 'idle' | 'running' | 'wedged'
  operation: string | null
  startedAt: number | null
  activeForMs: number
  /** Number of active preparations or external launches; `operation` names the oldest. */
  active: number
  queued: number
  wedgeAfterMs: number
  lastSettledAt: number | null
  lastError: string | null
}

export interface SpawnHandlerTicket {
  start(): void
  finish(error?: unknown): void
}

/**
 * Read-only observability for HeadlessNodeFactory's serialized handler.
 *
 * Snapshotting never waits on the handler it observes. That is the load-bearing property: when a
 * spawn promise never settles, `/opsapi/health` must remain able to name the active operation and
 * the requests backed up behind it.
 */
export class SpawnHandlerState {
  private readonly now: () => number
  private readonly wedgeAfterMs: number
  private queued = 0
  private nextId = 1
  private active = new Map<number, { id: number; operation: string; startedAt: number }>()
  private lastSettledAt: number | null = null
  private lastError: string | null = null

  constructor(opts: { now?: () => number; wedgeAfterMs?: number } = {}) {
    this.now = opts.now ?? Date.now
    this.wedgeAfterMs = opts.wedgeAfterMs ?? SPAWN_HANDLER_WEDGE_AFTER_MS
  }

  enqueue(operation: string): SpawnHandlerTicket {
    const id = this.nextId++
    let started = false
    let finished = false
    this.queued += 1
    return {
      start: () => {
        if (started || finished) return
        started = true
        this.queued = Math.max(0, this.queued - 1)
        this.active.set(id, { id, operation, startedAt: this.now() })
      },
      finish: (error?: unknown) => {
        if (finished) return
        finished = true
        if (!started) this.queued = Math.max(0, this.queued - 1)
        if (started) this.active.delete(id)
        this.lastSettledAt = this.now()
        this.lastError = error === undefined
          ? null
          : error instanceof Error
            ? error.message
            : String(error)
      }
    }
  }

  snapshot(): SpawnHandlerSnapshot {
    const now = this.now()
    const oldest = [...this.active.values()].sort(
      (left, right) => left.startedAt - right.startedAt || left.id - right.id
    )[0]
    const activeForMs = oldest ? Math.max(0, now - oldest.startedAt) : 0
    return {
      state: !oldest
        ? 'idle'
        : activeForMs >= this.wedgeAfterMs
          ? 'wedged'
          : 'running',
      operation: oldest?.operation ?? null,
      startedAt: oldest?.startedAt ?? null,
      activeForMs,
      active: this.active.size,
      queued: this.queued,
      wedgeAfterMs: this.wedgeAfterMs,
      lastSettledAt: this.lastSettledAt,
      lastError: this.lastError
    }
  }
}
