import { describe, expect, it } from 'vitest'

import { SpawnHandlerState } from './spawn-handler-state'

describe('SpawnHandlerState', () => {
  it('makes an unfinished handler machine-readably wedged after the deadline', () => {
    let now = 1_000
    const state = new SpawnHandlerState({ now: () => now, wedgeAfterMs: 500 })
    const active = state.enqueue('open-agent')
    const queued = state.enqueue('open-terminal')
    active.start()

    expect(state.snapshot()).toMatchObject({
      state: 'running',
      operation: 'open-agent',
      activeForMs: 0,
      queued: 1
    })

    now = 1_501
    expect(state.snapshot()).toMatchObject({
      state: 'wedged',
      operation: 'open-agent',
      activeForMs: 501,
      queued: 1
    })

    active.finish()
    queued.start()
    queued.finish(new Error('launch failed'))
    expect(state.snapshot()).toMatchObject({
      state: 'idle',
      queued: 0,
      lastError: 'launch failed',
      lastSettledAt: 1_501
    })
  })
})
