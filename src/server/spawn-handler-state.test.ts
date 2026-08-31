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
      active: 1,
      queued: 1
    })

    now = 1_501
    expect(state.snapshot()).toMatchObject({
      state: 'wedged',
      operation: 'open-agent',
      activeForMs: 501,
      active: 1,
      queued: 1
    })

    active.finish()
    queued.start()
    queued.finish(new Error('launch failed'))
    expect(state.snapshot()).toMatchObject({
      state: 'idle',
      active: 0,
      queued: 0,
      lastError: 'launch failed',
      lastSettledAt: 1_501
    })
  })

  it('keeps parallel launches visible and reports the oldest active operation', () => {
    let now = 2_000
    const state = new SpawnHandlerState({ now: () => now, wedgeAfterMs: 100 })
    const first = state.enqueue('open-agent:launch')
    first.start()
    now += 10
    const second = state.enqueue('open-terminal:launch')
    second.start()

    now += 91
    expect(state.snapshot()).toMatchObject({
      state: 'wedged',
      operation: 'open-agent:launch',
      startedAt: 2_000,
      activeForMs: 101,
      active: 2,
      queued: 0
    })

    first.finish()
    expect(state.snapshot()).toMatchObject({
      state: 'running',
      operation: 'open-terminal:launch',
      startedAt: 2_010,
      activeForMs: 91,
      active: 1
    })
    second.finish()
    expect(state.snapshot()).toMatchObject({ state: 'idle', active: 0 })
  })
})
