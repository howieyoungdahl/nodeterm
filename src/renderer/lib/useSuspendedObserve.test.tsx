// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SUSPENDED_REPORT_DELAY_MS, SUSPENDED_REPORT_INTERVAL_MS, useCreateFlush, useSuspendedObserve } from './useSavePersistence'

let root: Root
let request: () => void = () => {}
let setSuspended: (v: boolean) => void = () => {}
function Harness({ persist, report }: { persist: () => Promise<void>; report: () => void }) {
  const [suspended, set] = useState(true)
  setSuspended = set
  useSuspendedObserve(suspended, report)
  request = useCreateFlush(persist, !suspended, suspended ? report : undefined)
  return null
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(() => { act(() => root.unmount()); vi.useRealTimers(); vi.unstubAllGlobals() })

// Field 2026-11-17: 64 minutes behind the bar, no write and no report, and a refresh lost a live card.
it('reports (never saves) while saves are suspended, at once for a new card and on a steady cadence', () => {
  const persist = vi.fn(async () => {}), report = vi.fn()
  act(() => root.render(<Harness persist={persist} report={report} />))
  act(() => request())
  expect(report).toHaveBeenCalledTimes(1)
  act(() => { vi.advanceTimersByTime(SUSPENDED_REPORT_DELAY_MS) })
  expect(report).toHaveBeenCalledTimes(2)
  act(() => { vi.advanceTimersByTime(SUSPENDED_REPORT_INTERVAL_MS) })
  expect(report).toHaveBeenCalledTimes(3)
  expect(persist).not.toHaveBeenCalled()
  act(() => setSuspended(false))
  act(() => { vi.advanceTimersByTime(SUSPENDED_REPORT_INTERVAL_MS * 3) })
  act(() => request())
  expect(report).toHaveBeenCalledTimes(3)
  expect(persist).toHaveBeenCalledTimes(1)
})
