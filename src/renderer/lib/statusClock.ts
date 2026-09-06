// One clock for every status badge on the canvas.
//
// A badge shows a freshness age, so it has to re-render as time passes even when nothing changed.
// A timer per node would mean one interval per terminal on a canvas that already runs dozens, so
// this is a single module-level interval with a subscriber set: it starts when the first badge
// mounts and stops when the last one unmounts, and every badge re-renders on the same tick.
//
// The cadence is coarse on purpose. The age is rendered as `now / 12m / 3h`, so a 15-second tick is
// already finer than anything it can display; it exists to move the number, not to animate it.

import { useSyncExternalStore } from 'react'

export const STATUS_TICK_MS = 15_000

type Listener = () => void

const listeners = new Set<Listener>()
let timer: ReturnType<typeof setInterval> | null = null
let tick = 0

function start(): void {
  if (timer) return
  timer = setInterval(() => {
    tick += 1
    for (const l of [...listeners]) l()
  }, STATUS_TICK_MS)
}

function stop(): void {
  if (!timer) return
  clearInterval(timer)
  timer = null
}

export function subscribeStatusClock(listener: Listener): () => void {
  listeners.add(listener)
  start()
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) stop()
  }
}

/** The current tick counter. Only meaningful as a change signal. */
export function statusClockSnapshot(): number {
  return tick
}

/** Test seam: drop every subscriber and stop the interval. */
export function _resetStatusClockForTest(): void {
  listeners.clear()
  stop()
  tick = 0
}

/**
 * Re-render on the shared tick and return the wall clock to derive from. Deliberately returns
 * `Date.now()` rather than the tick: the caller wants an instant, and reading it at render time
 * means a badge that mounts between two ticks is correct immediately.
 */
export function useStatusNow(): number {
  useSyncExternalStore(subscribeStatusClock, statusClockSnapshot, statusClockSnapshot)
  return Date.now()
}
