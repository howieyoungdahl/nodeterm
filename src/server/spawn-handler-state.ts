export const SPAWN_HANDLER_WEDGE_AFTER_MS = 30_000

export interface SpawnHandlerSnapshot {
  state: 'idle' | 'running' | 'wedged'
  operation: string | null
  startedAt: number | null
  activeForMs: number
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
  private active: { id: number; operation: string; startedAt: number } | null = null
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
        this.active = { id, operation, startedAt: this.now() }
      },
      finish: (error?: unknown) => {
        if (finished) return
        finished = true
        if (!started) this.queued = Math.max(0, this.queued - 1)
        if (this.active?.id === id) this.active = null
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
    const activeForMs = this.active ? Math.max(0, now - this.active.startedAt) : 0
    return {
      state: !this.active
        ? 'idle'
        : activeForMs >= this.wedgeAfterMs
          ? 'wedged'
          : 'running',
      operation: this.active?.operation ?? null,
      startedAt: this.active?.startedAt ?? null,
      activeForMs,
      queued: this.queued,
      wedgeAfterMs: this.wedgeAfterMs,
      lastSettledAt: this.lastSettledAt,
      lastError: this.lastError
    }
  }
}
