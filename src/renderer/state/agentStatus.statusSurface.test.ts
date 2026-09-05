// The status-surface fields on the agent-status store: the reason a badge shows, the pane evidence
// a probe recorded, and the latched failure — plus the two rules that keep them honest (a live
// hook event supersedes both, and none of them reaches disk).
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { useAgentStatus } from './agentStatus'

let seq = 0
const nid = (): string => `status-node-${++seq}`

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('the badge reason (B3)', () => {
  it('records the reason and ask kind the hook event carried', () => {
    const id = nid()
    useAgentStatus
      .getState()
      .setState(id, 'blocked', 'claude', false, 'p1', true, {
        reason: 'Allow Bash(git push)?',
        askKind: 'approval'
      })
    expect(useAgentStatus.getState().byId[id]).toMatchObject({
      reason: 'Allow Bash(git push)?',
      askKind: 'approval'
    })
  })

  it('clears the previous reason when the new state carries none — a new ask is never captioned with an old explanation', () => {
    const id = nid()
    const s = useAgentStatus.getState()
    s.setState(id, 'blocked', 'claude', false, undefined, true, { reason: 'Allow Write(x)?' })
    s.setState(id, 'working', 'claude', true)
    expect(useAgentStatus.getState().byId[id].reason).toBeUndefined()
  })

  it('refreshes the reason on a same-state re-assert', () => {
    const id = nid()
    const s = useAgentStatus.getState()
    s.setState(id, 'working', 'claude', true, undefined, true, { reason: 'first' })
    s.setState(id, 'working', 'claude', false, undefined, true, { reason: 'second' })
    expect(useAgentStatus.getState().byId[id].reason).toBe('second')
  })

  it('a caller that omits the evidence asserts nothing', () => {
    const id = nid()
    useAgentStatus.getState().setState(id, 'waiting', 'claude')
    expect(useAgentStatus.getState().byId[id].reason).toBeUndefined()
    expect(useAgentStatus.getState().byId[id].askKind).toBeUndefined()
  })
})

describe('pane evidence', () => {
  it('records what a probe proved for a node the table knows', () => {
    const id = nid()
    const s = useAgentStatus.getState()
    s.setState(id, 'working', 'claude', true)
    s.setPaneEvidence({ [id]: 'dead' })
    expect(useAgentStatus.getState().byId[id].pane).toBe('dead')
  })

  it('ignores a node the table has never heard of — a probe answer must not mint a badge', () => {
    useAgentStatus.getState().setPaneEvidence({ 'never-seen': 'dead' })
    expect(useAgentStatus.getState().byId['never-seen']).toBeUndefined()
  })

  it('is superseded by any hook event — the node just spoke', () => {
    const id = nid()
    const s = useAgentStatus.getState()
    s.setState(id, 'working', 'claude', true)
    s.setPaneEvidence({ [id]: 'unknown' })
    s.setState(id, 'done', 'claude')
    expect(useAgentStatus.getState().byId[id].pane).toBeUndefined()
  })

  it('is superseded by a same-state re-assert too', () => {
    const id = nid()
    const s = useAgentStatus.getState()
    s.setState(id, 'working', 'claude', true)
    s.setPaneEvidence({ [id]: 'unknown' })
    s.setState(id, 'working', 'claude', false)
    expect(useAgentStatus.getState().byId[id].pane).toBeUndefined()
  })
})

describe('the failure latch', () => {
  it('latches a proven failure on a working node', () => {
    const id = nid()
    const s = useAgentStatus.getState()
    s.setState(id, 'working', 'claude', true)
    s.markFailed(id, 1234, 'session gone')
    expect(useAgentStatus.getState().byId[id].failure).toEqual({
      at: 1234,
      from: 'working',
      reason: 'session gone'
    })
  })

  it('REFUSES a node that is no longer working — eligibility is re-asked at write time', () => {
    // The probe is asynchronous: between planning it and its answer the node may have posted a
    // new turn or finished. A `failed` badge on a demonstrably running node is the expensive
    // error this whole derivation is careful about.
    const id = nid()
    const s = useAgentStatus.getState()
    s.setState(id, 'working', 'claude', true)
    s.setState(id, 'waiting', 'claude')
    s.markFailed(id, 1234)
    expect(useAgentStatus.getState().byId[id].failure).toBeUndefined()
  })

  it('refuses a node the table has never heard of', () => {
    useAgentStatus.getState().markFailed('never-seen', 1234)
    expect(useAgentStatus.getState().byId['never-seen']).toBeUndefined()
  })

  it('survives the stale-working sweep, so a proven failure does not decay back to unknown', () => {
    const id = nid()
    const s = useAgentStatus.getState()
    s.setState(id, 'working', 'claude', true)
    s.markFailed(id, 1234)
    vi.advanceTimersByTime(60 * 60_000)
    useAgentStatus.getState().sweepStaleWorking()
    const entry = useAgentStatus.getState().byId[id]
    expect(entry.state).toBeUndefined()
    expect(entry.failure).toMatchObject({ from: 'working' })
  })

  it('is cleared by any live hook state — the one thing that disproves it', () => {
    const id = nid()
    const s = useAgentStatus.getState()
    s.setState(id, 'working', 'claude', true)
    s.markFailed(id, 1234)
    s.setState(id, 'working', 'claude', true)
    expect(useAgentStatus.getState().byId[id].failure).toBeUndefined()
  })

  it('is cleared by a done too — a turn that ended is proof the pane was there to end it', () => {
    const id = nid()
    const s = useAgentStatus.getState()
    s.setState(id, 'working', 'claude', true)
    s.markFailed(id, 1234)
    s.setState(id, 'done', 'claude')
    expect(useAgentStatus.getState().byId[id].failure).toBeUndefined()
  })
})
