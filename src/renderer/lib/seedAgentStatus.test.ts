import { describe, it, expect, vi, afterEach } from 'vitest'
import { E_UNSUPPORTED } from '@shared/rpc'
import type { AgentStatusSnapshot } from '@shared/types'
import { seedAgentStatusFromHost, type SeedableAgentStatusStore } from './seedAgentStatus'

const SNAPSHOT: AgentStatusSnapshot = {
  takenAt: 1_700_000_000_000,
  nodes: { n1: { state: 'waiting', updatedAt: 1_700_000_000_000 } }
}

/** A store fake with just the one member the helper touches — the point of the narrow interface. */
function fakeStore(): { store: SeedableAgentStatusStore; seed: ReturnType<typeof vi.fn> } {
  const seed = vi.fn()
  return { store: { getState: () => ({ seedFromSnapshot: seed }) }, seed }
}

const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
afterEach(() => warn.mockClear())

describe('seedAgentStatusFromHost', () => {
  it('passes the host snapshot (and the injected now) straight to the store', async () => {
    const { store, seed } = fakeStore()
    const api = { agentStatusSnapshot: vi.fn().mockResolvedValue(SNAPSHOT) }
    await expect(seedAgentStatusFromHost(api, store, 42)).resolves.toBe(true)
    expect(seed).toHaveBeenCalledWith(SNAPSHOT, 42)
  })

  it('swallows E_UNSUPPORTED silently — that is a fact about the surface, not a failure', async () => {
    // The Server Edition browser bridge rejects this way on a host that predates the handler.
    const { store, seed } = fakeStore()
    const api = {
      agentStatusSnapshot: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('unsupported'), { code: E_UNSUPPORTED }))
    }
    await expect(seedAgentStatusFromHost(api, store)).resolves.toBe(false)
    expect(seed).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })

  it('swallows any other rejection too, but says so once in the debug ring', async () => {
    // A seed that quietly never runs looks exactly like the bug it fixes, so an UNEXPECTED
    // failure leaves a trace — while still never throwing into the caller's effect.
    const { store, seed } = fakeStore()
    const api = { agentStatusSnapshot: vi.fn().mockRejectedValue(new Error('socket closed')) }
    await expect(seedAgentStatusFromHost(api, store)).resolves.toBe(false)
    expect(seed).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('does nothing when the api does not expose the member at all', async () => {
    // A relay/stub api may simply not carry it; calling it would be a TypeError inside an effect.
    const { store, seed } = fakeStore()
    await expect(seedAgentStatusFromHost({}, store)).resolves.toBe(false)
    await expect(seedAgentStatusFromHost(undefined, store)).resolves.toBe(false)
    await expect(seedAgentStatusFromHost(null, store)).resolves.toBe(false)
    expect(seed).not.toHaveBeenCalled()
    expect(warn).not.toHaveBeenCalled()
  })

  it('ignores a resolved value that carries no nodes map', async () => {
    // Degrade to nothing, never to something wrong: a half-answer is not a snapshot.
    const { store, seed } = fakeStore()
    const api = { agentStatusSnapshot: vi.fn().mockResolvedValue(undefined) }
    await expect(seedAgentStatusFromHost(api, store)).resolves.toBe(false)
    expect(seed).not.toHaveBeenCalled()
  })

  it('never throws, whatever the api does synchronously', async () => {
    const { store } = fakeStore()
    const api = {
      agentStatusSnapshot: (() => {
        throw new Error('boom')
      }) as () => Promise<AgentStatusSnapshot>
    }
    await expect(seedAgentStatusFromHost(api, store)).resolves.toBe(false)
  })
})
