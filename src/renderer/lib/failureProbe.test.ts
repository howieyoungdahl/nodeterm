import { describe, expect, it, vi } from 'vitest'
import { NODE_STATUS_STALE_MS } from '@shared/node-status'
import { runFailureProbe, type FailureProbeDeps, type FailureProbeEntry } from './failureProbe'

const NOW = 1_800_000_000_000
const stale = NOW - (NODE_STATUS_STALE_MS + 60_000)
const fresh = NOW - 5_000

function deps(entries: FailureProbeEntry[], over: Partial<FailureProbeDeps> = {}) {
  const setPaneEvidence = vi.fn()
  const markFailed = vi.fn()
  return {
    d: {
      entries: () => entries,
      setPaneEvidence,
      markFailed,
      now: () => NOW,
      ...over
    } as FailureProbeDeps,
    setPaneEvidence,
    markFailed
  }
}

describe('runFailureProbe', () => {
  it('probes nothing when no node is a stale working one', async () => {
    const probe = vi.fn()
    const { d, setPaneEvidence } = deps([{ id: 'a', state: 'working', updatedAt: fresh }], {
      probe
    })
    await expect(runFailureProbe(d)).resolves.toEqual({ probed: [], failed: [], evidence: {} })
    expect(probe).not.toHaveBeenCalled()
    expect(setPaneEvidence).not.toHaveBeenCalled()
  })

  it('marks a stale working node failed when its pane is proven dead', async () => {
    const { d, markFailed, setPaneEvidence } = deps([{ id: 'a', state: 'working', updatedAt: stale }], {
      probe: async () => ({ a: 'dead' })
    })
    const r = await runFailureProbe(d)
    expect(r.failed).toEqual(['a'])
    expect(markFailed).toHaveBeenCalledWith('a', NOW)
    expect(setPaneEvidence).toHaveBeenCalledWith({ a: 'dead' })
  })

  it('records an alive pane and marks nothing failed', async () => {
    const { d, markFailed, setPaneEvidence } = deps([{ id: 'a', state: 'working', updatedAt: stale }], {
      probe: async () => ({ a: 'alive' })
    })
    expect((await runFailureProbe(d)).failed).toEqual([])
    expect(markFailed).not.toHaveBeenCalled()
    expect(setPaneEvidence).toHaveBeenCalledWith({ a: 'alive' })
  })

  it('records inconclusive for every candidate when the surface has NO prober', async () => {
    const { d, markFailed, setPaneEvidence } = deps([
      { id: 'a', state: 'working', updatedAt: stale },
      { id: 'b', state: 'working', updatedAt: stale }
    ])
    await runFailureProbe(d)
    expect(setPaneEvidence).toHaveBeenCalledWith({ a: 'unknown', b: 'unknown' })
    expect(markFailed).not.toHaveBeenCalled()
  })

  it('records inconclusive when the round trip rejects — never dead', async () => {
    const { d, markFailed, setPaneEvidence } = deps([{ id: 'a', state: 'working', updatedAt: stale }], {
      probe: async () => {
        throw new Error('E_UNSUPPORTED')
      }
    })
    await runFailureProbe(d)
    expect(setPaneEvidence).toHaveBeenCalledWith({ a: 'unknown' })
    expect(markFailed).not.toHaveBeenCalled()
  })

  it('treats a malformed or missing answer as inconclusive', async () => {
    const { d, markFailed, setPaneEvidence } = deps([{ id: 'a', state: 'working', updatedAt: stale }], {
      probe: async () => ({ a: 'gone' }) as never
    })
    await runFailureProbe(d)
    expect(setPaneEvidence).toHaveBeenCalledWith({ a: 'unknown' })
    expect(markFailed).not.toHaveBeenCalled()
  })

  it('ignores answers for ids it did not ask about', async () => {
    const { d, setPaneEvidence } = deps([{ id: 'a', state: 'working', updatedAt: stale }], {
      probe: async () => ({ a: 'alive', b: 'dead' })
    })
    await runFailureProbe(d)
    expect(setPaneEvidence).toHaveBeenCalledWith({ a: 'alive' })
  })

  it('does not re-probe a node whose failure is already latched', async () => {
    const probe = vi.fn(async () => ({}))
    const { d } = deps([{ id: 'a', state: 'working', updatedAt: stale, failed: true }], { probe })
    await runFailureProbe(d)
    expect(probe).not.toHaveBeenCalled()
  })

  it('re-reads the table at call time rather than closing over a snapshot', async () => {
    let entries: FailureProbeEntry[] = []
    const probe = vi.fn(async () => ({ a: 'alive' as const }))
    const { d } = deps([], { entries: () => entries, probe })
    await runFailureProbe(d)
    expect(probe).not.toHaveBeenCalled()
    entries = [{ id: 'a', state: 'working', updatedAt: stale }]
    await runFailureProbe(d)
    expect(probe).toHaveBeenCalledWith(['a'])
  })
})
