import { describe, it, expect } from 'vitest'
import { ServerPlatform } from './platform-server'
import { registerClientScope } from './client-scope'
import { IPC } from '../shared/ipc'

function sink() {
  const texts: string[] = []
  return { s: { sendText: (j: string) => texts.push(j), sendBinary: () => {} }, texts }
}

describe('registerClientScope', () => {
  it('a presence:project cast declares that connection\'s display scope', () => {
    const p = new ServerPlatform({ userDataDir: '/tmp', appVersion: '0' })
    registerClientScope(p)
    const a = sink(); const b = sink()
    const uiA = p.attach(a.s); const uiB = p.attach(b.s)
    p.cast(uiA, IPC.presenceProject, ['proj-a'])
    p.cast(uiB, IPC.presenceProject, ['proj-b'])
    expect(p.clientScope(uiA)).toBe('proj-a')
    p.broadcastScoped('agent:status', 'proj-a', { nodeId: 'n1' })
    expect(a.texts).toHaveLength(1)
    expect(b.texts).toHaveLength(0)
  })

  it('a null (or non-string) project clears the declaration back to everything', () => {
    const p = new ServerPlatform({ userDataDir: '/tmp', appVersion: '0' })
    registerClientScope(p)
    const a = sink()
    const uiA = p.attach(a.s)
    p.cast(uiA, IPC.presenceProject, ['proj-a'])
    p.cast(uiA, IPC.presenceProject, [null]) // the renderer's "no project open"
    expect(p.clientScope(uiA)).toBeUndefined()
    p.cast(uiA, IPC.presenceProject, [{ not: 'a string' }]) // off the wire, so re-validated
    expect(p.clientScope(uiA)).toBeUndefined()
    p.broadcastScoped('agent:status', 'proj-b', { nodeId: 'n2' })
    expect(a.texts).toHaveLength(1)
  })

  it('a connection that never declares receives everything (the pre-scoping behaviour)', () => {
    const p = new ServerPlatform({ userDataDir: '/tmp', appVersion: '0' })
    registerClientScope(p)
    const quiet = sink()
    p.attach(quiet.s)
    p.broadcastScoped('agent:status', 'proj-a', { nodeId: 'n1' })
    p.broadcastScoped('agent:status', 'proj-b', { nodeId: 'n2' })
    expect(quiet.texts).toHaveLength(2)
  })

  it('a co-listener on the same channel that DROPS the cast cannot drop the scope with it', () => {
    // The presence hub also listens on `presence:project` and rate-limits what it broadcasts to
    // peers. Losing a scope update to somebody else's limiter is the ONE failure this path must not
    // have — a stale scope is the only way a client here ends up receiving LESS than it should — so
    // the two listeners must be independent. Stand in for the hub with a listener that drops
    // everything after the first cast and assert the scope still tracks: ServerPlatform.cast fires
    // every listener regardless of what any one of them decides.
    const p = new ServerPlatform({ userDataDir: '/tmp', appVersion: '0' })
    let budget = 1
    const seenByCoListener: string[] = []
    p.onWithSender(IPC.presenceProject, (_sender: number, projectId: string) => {
      if (budget-- <= 0) return // "rate limited" — the hub's shape, not its implementation
      seenByCoListener.push(projectId)
    })
    registerClientScope(p)
    const a = sink()
    const uiA = p.attach(a.s)
    p.cast(uiA, IPC.presenceProject, ['proj-1'])
    p.cast(uiA, IPC.presenceProject, ['proj-2'])
    p.cast(uiA, IPC.presenceProject, ['proj-3'])
    expect(seenByCoListener).toEqual(['proj-1']) // the co-listener dropped two
    expect(p.clientScope(uiA)).toBe('proj-3') // …and the scope saw all three
  })
})
