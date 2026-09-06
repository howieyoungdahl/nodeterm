import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  STATUS_TICK_MS,
  _resetStatusClockForTest,
  statusClockSnapshot,
  subscribeStatusClock
} from './statusClock'

afterEach(() => {
  _resetStatusClockForTest()
  vi.useRealTimers()
})

describe('the shared status clock', () => {
  it('runs ONE interval for any number of subscribers', () => {
    vi.useFakeTimers()
    const spy = vi.spyOn(globalThis, 'setInterval')
    const off1 = subscribeStatusClock(() => {})
    const off2 = subscribeStatusClock(() => {})
    expect(spy).toHaveBeenCalledTimes(1)
    off1()
    off2()
  })

  it('notifies every subscriber on a tick and advances the snapshot', () => {
    vi.useFakeTimers()
    const a = vi.fn()
    const b = vi.fn()
    const off1 = subscribeStatusClock(a)
    const off2 = subscribeStatusClock(b)
    const before = statusClockSnapshot()
    vi.advanceTimersByTime(STATUS_TICK_MS)
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
    expect(statusClockSnapshot()).toBe(before + 1)
    off1()
    off2()
  })

  it('stops the interval when the last badge unmounts', () => {
    vi.useFakeTimers()
    const clear = vi.spyOn(globalThis, 'clearInterval')
    const off = subscribeStatusClock(() => {})
    off()
    expect(clear).toHaveBeenCalledTimes(1)
  })

  it('survives a subscriber that unsubscribes from inside its own tick', () => {
    vi.useFakeTimers()
    const seen: string[] = []
    let offA = () => {}
    offA = subscribeStatusClock(() => {
      seen.push('a')
      offA()
    })
    const offB = subscribeStatusClock(() => seen.push('b'))
    vi.advanceTimersByTime(STATUS_TICK_MS)
    expect(seen).toEqual(['a', 'b'])
    offB()
  })
})
