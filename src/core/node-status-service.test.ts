import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC } from '../shared/ipc'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'
import {
  MAX_PANE_PROBE_IDS,
  confirmedPaneEvidence,
  probePaneEvidence,
  registerNodeStatusIpc
} from './node-status-service'
import type { PaneEvidence } from '../shared/node-status'

describe('confirmedPaneEvidence — the double check', () => {
  it('returns alive on the first answer, without asking twice', async () => {
    const probe = vi.fn(async (): Promise<PaneEvidence> => 'alive')
    await expect(confirmedPaneEvidence('n1', { panePresence: probe })).resolves.toBe('alive')
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('returns unknown on the first answer, without asking twice', async () => {
    const probe = vi.fn(async (): Promise<PaneEvidence> => 'unknown')
    await expect(confirmedPaneEvidence('n1', { panePresence: probe })).resolves.toBe('unknown')
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('re-confirms before reporting dead', async () => {
    const probe = vi.fn(async (): Promise<PaneEvidence> => 'dead')
    await expect(confirmedPaneEvidence('n1', { panePresence: probe })).resolves.toBe('dead')
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('a dead-then-alive pair reports alive — one miss is not a fact', async () => {
    const answers: PaneEvidence[] = ['dead', 'alive']
    const probe = vi.fn(async () => answers.shift() as PaneEvidence)
    await expect(confirmedPaneEvidence('n1', { panePresence: probe })).resolves.toBe('alive')
  })

  it('a dead-then-unreadable pair reports unknown, never dead', async () => {
    const answers: PaneEvidence[] = ['dead', 'unknown']
    const probe = vi.fn(async () => answers.shift() as PaneEvidence)
    await expect(confirmedPaneEvidence('n1', { panePresence: probe })).resolves.toBe('unknown')
  })

  it('a thrown probe is unknown, not dead', async () => {
    const probe = vi.fn(async () => {
      throw new Error('tmux: connect failed')
    })
    await expect(confirmedPaneEvidence('n1', { panePresence: probe })).resolves.toBe('unknown')
  })

  it('a throw on the SECOND probe is unknown too', async () => {
    let n = 0
    const probe = vi.fn(async (): Promise<PaneEvidence> => {
      if (n++ === 0) return 'dead'
      throw new Error('socket closed')
    })
    await expect(confirmedPaneEvidence('n1', { panePresence: probe })).resolves.toBe('unknown')
  })

  it('NO PROBER answers unknown — never failed, whatever the caller wanted', async () => {
    await expect(confirmedPaneEvidence('n1', {})).resolves.toBe('unknown')
  })
})

describe('probePaneEvidence', () => {
  it('answers every requested id, so an absent key can never be mistaken for "nobody asked"', async () => {
    const probe = async (id: string): Promise<PaneEvidence> => (id === 'a' ? 'alive' : 'unknown')
    await expect(probePaneEvidence(['a', 'b'], { panePresence: probe })).resolves.toEqual({
      a: 'alive',
      b: 'unknown'
    })
  })

  it('de-duplicates ids', async () => {
    const probe = vi.fn(async (): Promise<PaneEvidence> => 'alive')
    await probePaneEvidence(['a', 'a', 'a'], { panePresence: probe })
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('drops empty and non-string ids instead of probing them', async () => {
    const probe = vi.fn(async (): Promise<PaneEvidence> => 'alive')
    const out = await probePaneEvidence(['', null as unknown as string, 'a'], {
      panePresence: probe
    })
    expect(out).toEqual({ a: 'alive' })
  })

  it('bounds the batch and answers unknown past the cap', async () => {
    const probe = vi.fn(async (): Promise<PaneEvidence> => 'alive')
    const ids = Array.from({ length: MAX_PANE_PROBE_IDS + 3 }, (_, i) => `n${i}`)
    const out = await probePaneEvidence(ids, { panePresence: probe })
    expect(probe).toHaveBeenCalledTimes(MAX_PANE_PROBE_IDS)
    expect(Object.keys(out)).toHaveLength(ids.length)
    expect(out[`n${MAX_PANE_PROBE_IDS}`]).toBe('unknown')
  })

  it('answers unknown for every id when the shell wired no prober', async () => {
    await expect(probePaneEvidence(['a', 'b'], {})).resolves.toEqual({ a: 'unknown', b: 'unknown' })
  })
})

describe('registerNodeStatusIpc', () => {
  let fake: ReturnType<typeof fakePlatform>
  beforeEach(() => {
    fake = fakePlatform()
    initPlatform(fake)
  })
  afterEach(() => resetPlatformForTests())

  // Both shells call this one body (src/main/index.ts and src/server/index.ts). A shell that
  // stopped calling it leaves the badge with no way to reach `failed` — and no error.
  it('registers the pane-evidence channel and answers it from the injected prober', async () => {
    registerNodeStatusIpc({ panePresence: async (id) => (id === 'gone' ? 'dead' : 'alive') })
    const handler = fake.handlers[IPC.nodeStatusPanes]
    expect(handler).toBeDefined()
    await expect(handler(['gone', 'here'])).resolves.toEqual({ gone: 'dead', here: 'alive' })
  })

  it('answers a non-array payload with an empty map instead of throwing', async () => {
    registerNodeStatusIpc({ panePresence: async () => 'alive' })
    await expect(fake.handlers[IPC.nodeStatusPanes]('nonsense')).resolves.toEqual({})
  })

  it('is a pull only — it registers no listener and broadcasts nothing', () => {
    registerNodeStatusIpc({})
    expect(fake.listeners[IPC.nodeStatusPanes]).toBeUndefined()
    expect(fake.sent).toEqual([])
  })
})
