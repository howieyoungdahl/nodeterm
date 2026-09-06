import type { OpsSweepResult } from './node-ops'

export type DeadCardReapTimer = ReturnType<typeof setInterval> | number

export interface ServerDeadCardReaperDeps {
  intervalMs: number
  /** The same operation exposed as POST /opsapi/sweep. The timer always requests an applied pass. */
  sweep(dryRun: boolean): Promise<OpsSweepResult>
  setInterval?: (callback: () => void, intervalMs: number) => DeadCardReapTimer
  clearInterval?: (timer: DeadCardReapTimer) => void
  info?: (message: string) => void
  warn?: (message: string, error: unknown) => void
}

/** Periodic trigger for the operator management plane's single dead-card mutation engine. */
export class ServerDeadCardReaper {
  private timer: DeadCardReapTimer | undefined
  private running = false

  constructor(private readonly deps: ServerDeadCardReaperDeps) {}

  start(): void {
    if (this.timer || !Number.isFinite(this.deps.intervalMs) || this.deps.intervalMs <= 0) return
    const setIntervalFn = this.deps.setInterval ?? setInterval
    this.timer = setIntervalFn(() => {
      void this.tick()
    }, this.deps.intervalMs)
    const timer = this.timer as { unref?: () => void }
    timer.unref?.()
  }

  stop(): void {
    if (!this.timer) return
    const clearIntervalFn = this.deps.clearInterval ?? clearInterval
    clearIntervalFn(this.timer)
    this.timer = undefined
  }

  private async tick(): Promise<void> {
    // A slow pane probe must not build an unbounded queue of identical mutations.
    if (this.running) return
    this.running = true
    try {
      const result = await this.deps.sweep(false)
      if (result.affectedIds.length) {
        const info = this.deps.info ?? console.info
        info(
          `[nodeterm-server] reaped ${result.affectedIds.length} dead terminal card(s)`
        )
      }
    } catch (error) {
      const warn = this.deps.warn ?? console.warn
      warn('[nodeterm-server] dead-card reap failed', error)
    } finally {
      this.running = false
    }
  }
}
