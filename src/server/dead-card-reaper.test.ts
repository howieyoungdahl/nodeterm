import { describe, expect, it, vi } from 'vitest'

import type { OpsSweepResult } from './node-ops'
import { ServerDeadCardReaper, type DeadCardReapTimer } from './dead-card-reaper'

function result(affectedIds: string[] = []): OpsSweepResult {
  return { dryRun: false, affectedIds, scanned: 3 }
}

describe('ServerDeadCardReaper', () => {
  it('runs the shared sweep engine in apply mode on the configured interval', async () => {
    let tick: (() => void) | undefined
    let delay: number | undefined
    const unref = vi.fn()
    const sweep = vi.fn(async () => result(['term-dead']))
    const info = vi.fn()
    const reaper = new ServerDeadCardReaper({
      intervalMs: 1_234,
      sweep,
      info,
      setInterval: (callback, intervalMs) => {
        tick = callback
        delay = intervalMs
        return { unref } as unknown as DeadCardReapTimer
      }
    })

    reaper.start()
    expect(delay).toBe(1_234)
    expect(unref).toHaveBeenCalledOnce()
    tick!()
    await vi.waitFor(() => expect(sweep).toHaveBeenCalledWith(false))
    expect(info).toHaveBeenCalledWith('[nodeterm-server] reaped 1 dead terminal card(s)')
  })

  it('does not overlap a slow sweep and resumes after it settles', async () => {
    let tick: (() => void) | undefined
    let release!: (value: OpsSweepResult) => void
    const first = new Promise<OpsSweepResult>((resolve) => {
      release = resolve
    })
    const sweep = vi
      .fn()
      .mockImplementationOnce(() => first)
      .mockResolvedValue(result())
    const reaper = new ServerDeadCardReaper({
      intervalMs: 10,
      sweep,
      setInterval: (callback) => {
        tick = callback
        return 1
      }
    })

    reaper.start()
    tick!()
    tick!()
    expect(sweep).toHaveBeenCalledTimes(1)
    release(result())
    await first
    await vi.waitFor(() => {
      tick!()
      expect(sweep).toHaveBeenCalledTimes(2)
    })
  })

  it('reports a failed pass without disabling later passes', async () => {
    let tick: (() => void) | undefined
    const sweep = vi
      .fn()
      .mockRejectedValueOnce(new Error('probe failed'))
      .mockResolvedValue(result())
    const warn = vi.fn()
    const reaper = new ServerDeadCardReaper({
      intervalMs: 10,
      sweep,
      warn,
      setInterval: (callback) => {
        tick = callback
        return 1
      }
    })

    reaper.start()
    tick!()
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        '[nodeterm-server] dead-card reap failed',
        expect.any(Error)
      )
    )
    tick!()
    await vi.waitFor(() => expect(sweep).toHaveBeenCalledTimes(2))
  })

  it('can be disabled with zero and clears an enabled timer exactly once', () => {
    const disabledSet = vi.fn(() => 1)
    new ServerDeadCardReaper({
      intervalMs: 0,
      sweep: async () => result(),
      setInterval: disabledSet
    }).start()
    expect(disabledSet).not.toHaveBeenCalled()

    const clearInterval = vi.fn()
    const enabled = new ServerDeadCardReaper({
      intervalMs: 10,
      sweep: async () => result(),
      setInterval: () => 7,
      clearInterval
    })
    enabled.start()
    enabled.stop()
    enabled.stop()
    expect(clearInterval).toHaveBeenCalledOnce()
    expect(clearInterval).toHaveBeenCalledWith(7)
  })
})
