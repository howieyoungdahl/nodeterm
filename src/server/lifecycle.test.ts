import { describe, expect, it, vi } from 'vitest'
import type { MirrorEntry } from '../core/agent-status-mirror'
import { ServerLifecycleReader, PROMPT_PROBE_INTERVAL_MS, SILENT_HOOK_MS } from './lifecycle'
import prompts from '../core/__fixtures__/lifecycle/prompts.json'

const alive = { paneState: 'alive' as const, isAgent: true, provider: 'codex', createdAt: 0 }
function harness(initial?: MirrorEntry) {
  let entry = initial
  let now = 1_000_000
  const capture = vi.fn(async () => prompts['codex-hooks-review'])
  const paneCommand = vi.fn(async (): Promise<string | null> => 'node')
  const transcriptDone = vi.fn(async (): Promise<{ at: number; clean: boolean } | null> => null)
  const reader = new ServerLifecycleReader({ entry: () => entry, now: () => now, userDataDir: '/unused', capture, paneCommand, transcriptDone })
  return { reader, capture, paneCommand, transcriptDone, tick: (ms: number) => { now += ms }, set: (value?: MirrorEntry) => { entry = value } }
}
describe('ServerLifecycleReader', () => {
  it('detects silent hooks once per node per 30 seconds and preserves blockedSince', async () => {
    const h = harness()
    const first = await h.reader.read('n', alive)
    expect(first).toMatchObject({ state: 'blocked', blockedOn: { kind: 'codex-hooks-review', since: 1_000_000 } })
    await h.reader.read('n', alive)
    expect(h.capture).toHaveBeenCalledTimes(1)
    h.tick(PROMPT_PROBE_INTERVAL_MS)
    expect((await h.reader.read('n', alive)).blockedOn?.since).toBe(1_000_000)
    expect(h.capture).toHaveBeenCalledTimes(2)
  })
  it('probes working only after 60 seconds of silence, and never probes done or blocked', async () => {
    const h = harness({ state: 'working', updatedAt: 1_000_000 - SILENT_HOOK_MS })
    expect((await h.reader.read('n', alive)).state).toBe('working')
    expect(h.capture).not.toHaveBeenCalled()
    h.tick(1)
    expect((await h.reader.read('n', alive)).state).toBe('blocked')
    for (const state of ['done', 'blocked', 'waiting'] as const) {
      h.set({ state, updatedAt: 0 })
      await h.reader.read('n', alive)
    }
    expect(h.capture).toHaveBeenCalledTimes(1)
  })
  it('skips dead, remote/unknown and non-agent panes', async () => {
    const h = harness()
    for (const input of [{ ...alive, paneState: 'dead' as const }, { ...alive, paneState: 'unknown' as const }, { ...alive, isAgent: false }]) await h.reader.read('n', input)
    expect(h.capture).not.toHaveBeenCalled()
    expect(h.paneCommand).not.toHaveBeenCalled()
  })
  it('shell foreground proves exited even when mirror is working', async () => {
    const h = harness({ state: 'working', updatedAt: 1 })
    h.paneCommand.mockResolvedValue('bash')
    expect((await h.reader.read('n', alive)).state).toBe('exited')
    expect(h.capture).not.toHaveBeenCalled()
  })
  it('failed pane or capture probes do not invent exited or blocked evidence', async () => {
    const h = harness()
    h.paneCommand.mockRejectedValue(new Error('unavailable'))
    h.capture.mockRejectedValue(new Error('unavailable'))
    expect((await h.reader.read('n', alive)).state).toBe('unknown')
  })
  it('a fresh hook arriving during capture wins over the prompt', async () => {
    const h = harness({ state: 'working', updatedAt: 0 })
    h.capture.mockImplementation(async () => {
      h.set({ state: 'done', lastDoneAt: 1_000_000, lastDoneClean: true, updatedAt: 1_000_000 })
      return prompts['codex-hooks-review']
    })
    expect((await h.reader.read('n', alive)).state).toBe('idle-warm')
  })
  it('active hooks do not reset the per-node capture rate limit', async () => {
    const h = harness()
    await h.reader.read('n', alive)
    h.set({ state: 'working', updatedAt: 1_000_000, lastEventAt: 1_000_000 })
    await h.reader.read('n', alive)
    h.set(undefined)
    await h.reader.read('n', alive)
    expect(h.capture).toHaveBeenCalledTimes(1)
  })
  it('concurrent inventory polls share an in-flight probe', async () => {
    const h = harness()
    await Promise.all([h.reader.read('n', alive), h.reader.read('n', alive)])
    expect(h.capture).toHaveBeenCalledTimes(1)
  })
  it('restored state uses transcript timestamp or stays unknown, without changing mirror authority', async () => {
    const entry: MirrorEntry = { state: 'done', updatedAt: 0, restored: true, lastDoneAt: 123, lastDoneClean: true }
    const h = harness(entry)
    expect((await h.reader.read('n', alive)).state).toBe('unknown')
    h.tick(PROMPT_PROBE_INTERVAL_MS)
    h.transcriptDone.mockResolvedValue({ at: 1_000_000, clean: false })
    expect(await h.reader.read('n', alive)).toMatchObject({ state: 'idle-warm', lastDoneAt: 1_000_000, lastDoneClean: false })
    expect(entry).toMatchObject({ restored: true, lastDoneAt: 123 })
  })
})
