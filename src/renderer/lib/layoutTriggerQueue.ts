import type { LayoutTrigger } from '@shared/canvas-layout'

export interface PendingLayoutTrigger {
  projectId: string
  trigger: LayoutTrigger
  createdIds: string[]
}

/** Coalesce a spawn burst without losing attention or rule changes during an async plan. */
export class LayoutTriggerQueue {
  private readonly pending = new Map<string, PendingLayoutTrigger>()
  private running: Promise<void> | undefined

  constructor(private readonly execute: (request: PendingLayoutTrigger) => Promise<void>) {}

  enqueue(request: PendingLayoutTrigger): Promise<void> {
    const key = JSON.stringify([request.projectId, request.trigger])
    const previous = this.pending.get(key)
    this.pending.set(key, {
      ...request,
      createdIds: [...new Set([...(previous?.createdIds ?? []), ...request.createdIds])]
    })
    return this.start()
  }

  private start(): Promise<void> {
    if (this.running) return this.running
    const work = Promise.resolve().then(async () => {
      let failure: unknown
      let failed = false
      while (this.pending.size) {
        const [key, request] = this.pending.entries().next().value!
        this.pending.delete(key)
        try {
          await this.execute(request)
        } catch (error) {
          failure = error
          failed = true
        }
      }
      if (failed) throw failure
    })
    this.running = work.finally(() => {
      this.running = undefined
      // A caller can enqueue between the drain's resolution and this continuation.
      if (this.pending.size) return this.start()
    })
    return this.running
  }
}
