// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TranscriptHit } from '@shared/types'
import { buildStubApi } from '../bridge/stubs'
import { CommandPalette } from '../components/CommandPalette'
import { usePaletteTranscriptSearch } from './usePaletteTranscriptSearch'

type Search = (query: string) => Promise<TranscriptHit[]>
let root: Root, element: HTMLDivElement, mounted: boolean
let state: ReturnType<typeof usePaletteTranscriptSearch>
let renders: number
const command = vi.fn(), close = vi.fn()
function Mounted({ open, search }: { open: boolean; search: Search }) {
  state = usePaletteTranscriptSearch(open, search)
  renders++
  return open ? <CommandPalette commands={[{ id: 'sticky', label: 'New sticky note', run: command }]}
    onQueryChange={state.onQueryChange} transcriptStatus={state.status}
    extraCommands={state.hits.map((hit) => ({ id: hit.sessionId, label: hit.sessionId, run: vi.fn() }))}
    onClose={() => { state.reset(); close() }} /> : null
}
const hit = (sessionId: string) => [{ sessionId } as TranscriptHit]
const pending = () => {
  let resolve!: (hits: TranscriptHit[]) => void, reject!: (reason: unknown) => void
  const promise = new Promise<TranscriptHit[]>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const render = async (search: Search, open = true) => {
  await act(async () => root.render(<Mounted open={open} search={search} />))
}
const query = async (value: string) => {
  await act(async () => state.onQueryChange(value))
}
const fire = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(180) }) }
const text = () => document.querySelector('.palette')?.textContent ?? ''
beforeEach(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  vi.useFakeTimers(); command.mockClear(); close.mockClear(); renders = 0
  element = document.createElement('div'); document.body.append(element)
  root = createRoot(element); mounted = true
})
afterEach(async () => {
  if (mounted) await act(async () => root.unmount())
  element.remove(); vi.useRealTimers()
})

describe('mounted command-palette transcript source', () => {
  it('consumes the actual browser bridge refusal visibly and keeps a normal command executable', async () => {
    const search = buildStubApi().transcripts.search
    await render(search)
    const input = document.querySelector('input')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'sticky')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await fire()
    expect(state.status).toBe('unavailable')
    expect(text()).toContain('Transcript search is unavailable here')
    expect(text()).not.toContain('No transcript matches')
    await act(async () => document.querySelector<HTMLButtonElement>('.palette__item')!.click())
    expect(command).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce()
  })
  it('debounces Desktop searches, exposes results and distinguishes a successful empty result', async () => {
    const search = vi.fn<Search>().mockResolvedValueOnce(hit('desktop-hit')).mockResolvedValueOnce([])
    await render(search); await query('fi'); await query('final')
    expect(search).not.toHaveBeenCalled(); expect(text()).toContain('Searching transcripts')
    await fire()
    expect(search).toHaveBeenCalledExactlyOnceWith('final')
    expect(text()).toContain('desktop-hit'); expect(state.status).toBe('success')
    await query('none'); expect(state.hits).toEqual([]); await fire()
    expect(text()).toContain('No transcript matches')
  })
  it.each(['reject', 'throw'])('shows ordinary %s failure without mislabelling it unsupported, then recovers', async (kind) => {
    const search = vi.fn<Search>().mockImplementationOnce(() => {
      if (kind === 'throw') throw new Error('private source detail')
      return Promise.reject(new Error('private source detail'))
    }).mockResolvedValueOnce(hit('recovered'))
    await render(search); await query('broken'); await fire()
    expect(state.status).toBe('error'); expect(text()).toContain('Transcript search failed')
    expect(text()).not.toContain('private source detail')
    await query('retry'); await fire(); expect(text()).toContain('recovered')
  })
  it.each(['success', 'error'])('ignores late stale %s after a newer successful query', async (kind) => {
    const old = pending()
    const search = vi.fn<Search>().mockReturnValueOnce(old.promise).mockResolvedValueOnce(hit('new'))
    await render(search); await query('old'); await fire(); await query('new'); await fire()
    await act(async () => { if (kind === 'success') old.resolve(hit('old')); else old.reject(new Error('old')) })
    expect(state.hits).toEqual(hit('new')); expect(state.status).toBe('success')
  })
  it('invalidates an old response even when the later query text is identical', async () => {
    const old = pending(), current = pending()
    const search = vi.fn<Search>().mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise)
    await render(search); await query('same'); await fire(); await query('different'); await query('same'); await fire()
    await act(async () => old.resolve(hit('old')))
    expect(state.hits).toEqual([]); expect(state.status).toBe('loading')
    await act(async () => current.resolve(hit('current')))
    expect(state.hits).toEqual(hit('current'))
  })
  it('short/blank queries cancel both pending debounce and in-flight rejection', async () => {
    const old = pending(), search = vi.fn<Search>().mockReturnValue(old.promise)
    await render(search); await query('pending'); await query(' x '); await fire()
    expect(search).not.toHaveBeenCalled()
    await query('flight'); await fire(); await query(' ')
    await act(async () => old.reject(new Error('late')))
    expect(state.status).toBe('idle'); expect(state.hits).toEqual([])
  })
  it('closing cancels the debounce and reopening cannot adopt old same-query results', async () => {
    const old = pending(), search = vi.fn<Search>().mockReturnValueOnce(old.promise).mockResolvedValueOnce(hit('fresh'))
    await render(search); await query('pending'); await render(search, false); await fire()
    expect(search).not.toHaveBeenCalled()
    await render(search); await query('same'); await fire(); await render(search, false)
    await render(search); await query('same'); await fire()
    await act(async () => old.resolve(hit('stale-opening')))
    expect(state.hits).toEqual(hit('fresh'))
  })
  it('Escape clears search state immediately without executing a command', async () => {
    const old = pending(), search = vi.fn<Search>().mockReturnValue(old.promise)
    await render(search); await query('flight'); await fire()
    await act(async () => document.querySelector('input')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    await act(async () => old.reject(new Error('late')))
    expect(state.status).toBe('idle'); expect(close).toHaveBeenCalledOnce(); expect(command).not.toHaveBeenCalled()
  })
  it.each(['debounce', 'success', 'error'])('unmount cancels %s without later rendering', async (kind) => {
    const old = pending(), search = vi.fn<Search>().mockReturnValue(old.promise)
    await render(search); await query('flight')
    if (kind !== 'debounce') await fire()
    await act(async () => root.unmount()); mounted = false
    const before = renders
    await fire()
    await act(async () => { if (kind === 'error') old.reject(new Error('late')); else old.resolve(hit('late')) })
    expect(renders).toBe(before)
    expect(search).toHaveBeenCalledTimes(kind === 'debounce' ? 0 : 1)
  })
})
