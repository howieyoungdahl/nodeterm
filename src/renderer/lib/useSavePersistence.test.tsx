// @vitest-environment jsdom
import { act, useCallback, useEffect, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SaveFailureBar } from '../components/SaveFailureBar'
import { useAutosave, useSavePersistence } from './useSavePersistence'

let root: Root
let container: HTMLDivElement

function Harness({ write, conflict = false, initial = false }: {
  write: () => Promise<void>; conflict?: boolean; initial?: boolean
}) {
  const [dirty, setDirty] = useState(!initial)
  const { delivery, attemptSave, retrySave } = useSavePersistence()
  const persist = useCallback(async () => {
    if (await attemptSave(write)) setDirty(false)
  }, [attemptSave, write])
  useEffect(() => { if (initial) void persist() }, [initial, persist])
  useAutosave(dirty, conflict, persist, 0, delivery)
  return <>
    <span>{dirty ? 'unsaved' : 'clean'}</span>
    {delivery && <SaveFailureBar delivery={delivery} onRetry={() => {
      setDirty(true)
      retrySave()
    }} />}
  </>
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })

describe('workspace persistence in a mounted canvas', () => {
  it('retries a disconnected save without another edit and clears the warning only after success', async () => {
    let finish!: () => void
    const write = vi.fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('E_DISCONNECTED'))
      .mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve }))
    await act(async () => root.render(<Harness write={write} />))
    await advance(800)
    expect(write).toHaveBeenCalledTimes(1)
    expect(container.textContent).toContain('not being saved')
    await advance(500)
    expect(write).toHaveBeenCalledTimes(2)
    expect(container.textContent).toContain('unsaved')
    expect(container.textContent).toContain('not being saved')
    await act(async () => finish())
    expect(container.textContent).toBe('clean')
    await advance(60_000)
    expect(write).toHaveBeenCalledTimes(2)
  })

  it('retries a failed initial save even before any edit marks the canvas dirty', async () => {
    const write = vi.fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('E_DISCONNECTED')).mockResolvedValue(undefined)
    await act(async () => root.render(<Harness write={write} initial />))
    expect(write).toHaveBeenCalledTimes(1)
    await advance(500)
    expect(write).toHaveBeenCalledTimes(2)
    expect(container.textContent).toBe('clean')
  })

  it('stops after bounded retries, then the Retry button saves again', async () => {
    const write = vi.fn<() => Promise<void>>().mockRejectedValue(new Error('offline'))
    await act(async () => root.render(<Harness write={write} />))
    for (const delay of [800, 500, 1500, 4000, 10_000, 30_000]) await advance(delay)
    expect(write).toHaveBeenCalledTimes(6)
    expect(container.textContent).toContain('nothing will retry')
    await advance(60_000)
    expect(write).toHaveBeenCalledTimes(6)
    write.mockResolvedValue(undefined)
    await act(async () => container.querySelector('button')!.click())
    await advance(800)
    expect(write).toHaveBeenCalledTimes(7)
    expect(container.textContent).toBe('clean')
  })

  it('pauses a pending retry for a conflict and resumes when the conflict is resolved', async () => {
    const write = vi.fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined)
    await act(async () => root.render(<Harness write={write} />))
    await advance(800)
    await act(async () => root.render(<Harness write={write} conflict />))
    await advance(60_000)
    expect(write).toHaveBeenCalledTimes(1)
    await act(async () => root.render(<Harness write={write} />))
    await advance(500)
    expect(write).toHaveBeenCalledTimes(2)
    expect(container.textContent).toBe('clean')
  })
})
