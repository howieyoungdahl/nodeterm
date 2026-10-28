import { describe, expect, it } from 'vitest'
import { createAgentStatusSession, STALE_WORKING_MS } from './agentStatus'
import { statusViewFor } from '../lib/nodeStatusView'
const now = 1_700_000_000_000
describe('status recovery', () => {
  it('retains old completed and blocked states while rejecting stale working', () => {
    const store = createAgentStatusSession().store
    store.getState().seedFromSnapshot({ takenAt: now, nodes: {
      done: { state: 'done', updatedAt: now - 2 * 60 * 60_000 },
      blocked: { state: 'blocked', updatedAt: now - 3 * 60 * 60_000 },
      working: { state: 'working', updatedAt: now - STALE_WORKING_MS - 1 }
    } }, now)
    expect(statusViewFor(store.getState().byId.done, now)).toMatchObject({ kind: 'completed', stale: true })
    expect(store.getState().byId.blocked?.state).toBe('blocked')
    expect(store.getState().byId.working).toBeUndefined()
  })
  it('session start, state, stale sweep and end preserve distinct facts', () => {
    const store = createAgentStatusSession().store
    store.getState().setSessionPhase('n', 'start', 'claude')
    expect(statusViewFor(store.getState().byId.n, Date.now()).kind).toBe('idle')
    store.getState().setState('n', 'working', 'claude', true)
    expect(store.getState().byId.n.idleSince).toBeUndefined()
    store.getState().sweepStaleWorking(-1)
    expect(statusViewFor(store.getState().byId.n, Date.now()).kind).toBe('unknown')
    store.getState().setSessionPhase('n', 'start', 'claude')
    store.getState().setSessionPhase('n', 'end', 'claude')
    expect(statusViewFor(store.getState().byId.n, Date.now()).kind).toBe('unknown')
    store.getState().seedFromSnapshot({ takenAt: now, nodes: { n: { updatedAt: now, idleSince: now } } }, now)
    expect(statusViewFor(store.getState().byId.n, Date.now()).kind).toBe('unknown')
  })
  it('seeds a positive idle fact but not a legacy stateless entry', () => {
    const store = createAgentStatusSession().store
    store.getState().seedFromSnapshot({ takenAt: now, nodes: {
      idle: { updatedAt: now, idleSince: now }, legacy: { updatedAt: now }
    } }, now)
    expect(statusViewFor(store.getState().byId.idle, now).kind).toBe('idle')
    expect(statusViewFor(store.getState().byId.legacy, now).kind).toBe('unknown')
  })
})
