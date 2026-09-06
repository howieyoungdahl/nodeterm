import { describe, expect, it } from 'vitest'

import { WorkspaceMutationQueue } from './workspace-mutation-queue'

describe('WorkspaceMutationQueue', () => {
  it('runs transactions in FIFO order and continues after a rejected transaction', async () => {
    const queue = new WorkspaceMutationQueue()
    const events: string[] = []
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })

    const first = queue.run(async () => {
      events.push('first:start')
      await blocked
      events.push('first:end')
    })
    const rejected = queue.run(async () => {
      events.push('second')
      throw new Error('expected')
    })
    const third = queue.run(async () => {
      events.push('third')
    })

    await Promise.resolve()
    expect(events).toEqual(['first:start'])
    release()
    await first
    await expect(rejected).rejects.toThrow('expected')
    await third
    expect(events).toEqual(['first:start', 'first:end', 'second', 'third'])
  })
})
