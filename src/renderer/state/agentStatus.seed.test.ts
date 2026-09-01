import { describe, it, expect, vi, afterEach } from 'vitest'
import type { AgentStatusSnapshot, AgentStatusSnapshotEntry } from '@shared/types'
import {
  createAgentStatusSession,
  useAgentStatus,
  SEED_MAX_AGE_MS,
  STALE_WORKING_MS
} from './agentStatus'

/** `now` is injected everywhere below, so every age in these fixtures is exact rather than
 *  whatever the clock did between two lines. */
const NOW = 1_700_000_000_000

function snap(nodes: Record<string, AgentStatusSnapshotEntry>): AgentStatusSnapshot {
  return { takenAt: NOW, nodes }
}

/** A keyless session: `save()` is a no-op, so these tests exercise the rules and not localStorage
 *  (the persistence rule has its own test at the bottom, against a real key). */
function session() {
  return createAgentStatusSession().store
}

/** The in-memory localStorage the persistence test needs (node env has none). */
function memStorage(): Storage {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    get length() {
      return m.size
    }
  } as Storage
}

afterEach(() => vi.unstubAllGlobals())

describe('seedFromSnapshot — what it paints', () => {
  it('writes state and BOTH clocks from the mirror stamp, not from now', () => {
    // The clocks are the sidebar age and the Eco idle clock. Stamping them `now` would tell both
    // that a session which has been quiet for ten minutes just spoke.
    const store = session()
    const updatedAt = NOW - 5 * 60_000
    store.getState().seedFromSnapshot(snap({ n1: { state: 'waiting', updatedAt } }), NOW)
    expect(store.getState().byId.n1).toMatchObject({
      state: 'waiting',
      stateAt: updatedAt,
      lastEventAt: updatedAt,
      unread: false
    })
  })

  it('fills agentId/sessionId only when the store has none of its own', () => {
    // Local identity wins: `agentId`/`sessionId` hydrate from localStorage for a hand-launched
    // agent, and the mirror can lag a pane relaunched while the app was down.
    const store = session()
    store.setState({
      byId: { n1: { unread: false, agentId: 'codex', sessionId: 'local-sess' } }
    })
    store.getState().seedFromSnapshot(
      snap({
        n1: { state: 'done', updatedAt: NOW, agentId: 'claude', sessionId: 'mirror-sess' },
        n2: { state: 'done', updatedAt: NOW, agentId: 'claude', sessionId: 'mirror-sess' }
      }),
      NOW
    )
    expect(store.getState().byId.n1).toMatchObject({ agentId: 'codex', sessionId: 'local-sess' })
    expect(store.getState().byId.n2).toMatchObject({ agentId: 'claude', sessionId: 'mirror-sess' })
  })

  it('ignores entries with no state — the mirror also holds identity-only rows', () => {
    const store = session()
    store.getState().seedFromSnapshot(snap({ n1: { updatedAt: NOW, agentId: 'claude' } }), NOW)
    expect(store.getState().byId.n1).toBeUndefined()
  })

  it('survives an empty / malformed snapshot without touching the table', () => {
    const store = session()
    const before = store.getState().byId
    store.getState().seedFromSnapshot(snap({}), NOW)
    store.getState().seedFromSnapshot(undefined as unknown as AgentStatusSnapshot, NOW)
    expect(store.getState().byId).toBe(before)
  })
})

describe('seedFromSnapshot — the freshness cut', () => {
  it('applies the SHORTER working window and the longer one to every other state', () => {
    // One age, two verdicts — the fixture has to discriminate, or a single shared cut would pass
    // it. 25 min is past the working sweep window (20) and inside the seed cut (30): a `working`
    // that old would be swept back to idle by the next 60 s sweep anyway, so painting it only
    // flickers, while a `waiting` that old is still exactly what the user came back to.
    const store = session()
    const updatedAt = NOW - 25 * 60_000
    expect(updatedAt).toBeLessThan(NOW - STALE_WORKING_MS)
    expect(updatedAt).toBeGreaterThan(NOW - SEED_MAX_AGE_MS)
    store.getState().seedFromSnapshot(
      snap({ w: { state: 'working', updatedAt }, q: { state: 'waiting', updatedAt } }),
      NOW
    )
    expect(store.getState().byId.w).toBeUndefined()
    expect(store.getState().byId.q?.state).toBe('waiting')
  })

  it('keeps a working entry just inside its window and drops one just outside', () => {
    const store = session()
    store.getState().seedFromSnapshot(
      snap({
        fresh: { state: 'working', updatedAt: NOW - STALE_WORKING_MS + 1000 },
        stale: { state: 'working', updatedAt: NOW - STALE_WORKING_MS - 1000 }
      }),
      NOW
    )
    expect(store.getState().byId.fresh?.state).toBe('working')
    expect(store.getState().byId.stale).toBeUndefined()
  })

  it('drops a done/waiting older than the seed cut — hours ago is not a badge you are waiting on', () => {
    const store = session()
    store.getState().seedFromSnapshot(
      snap({
        old: { state: 'done', updatedAt: NOW - SEED_MAX_AGE_MS - 1000 },
        recent: { state: 'done', updatedAt: NOW - SEED_MAX_AGE_MS + 1000 }
      }),
      NOW
    )
    expect(store.getState().byId.old).toBeUndefined()
    expect(store.getState().byId.recent?.state).toBe('done')
  })
})

describe('seedFromSnapshot — never clobbers a live state', () => {
  it('skips a node whose live state is NEWER than the snapshot', () => {
    // The round-trip is async: a hook event for this node can land while the snapshot is in
    // flight, and the mirror's copy is then strictly the older fact.
    const store = session()
    store.setState({
      byId: { n1: { unread: false, state: 'working', stateAt: NOW - 1000, lastEventAt: NOW - 1000 } }
    })
    store.getState().seedFromSnapshot(snap({ n1: { state: 'done', updatedAt: NOW - 60_000 } }), NOW)
    expect(store.getState().byId.n1.state).toBe('working')
  })

  it('reads lastEventAt too, not only stateAt', () => {
    // A same-state event refreshes `stateAt` only; a transition stamps both. Either clock being
    // at/after the snapshot means this run already heard something newer.
    const store = session()
    store.setState({
      byId: { n1: { unread: false, state: 'working', lastEventAt: NOW - 1000 } }
    })
    store.getState().seedFromSnapshot(snap({ n1: { state: 'done', updatedAt: NOW - 60_000 } }), NOW)
    expect(store.getState().byId.n1.state).toBe('working')
  })

  it('DOES seed over a state older than the snapshot — the guard is a comparison, not a blanket skip', () => {
    const store = session()
    store.setState({
      byId: { n1: { unread: false, state: 'done', stateAt: NOW - 120_000, lastEventAt: NOW - 120_000 } }
    })
    store.getState().seedFromSnapshot(snap({ n1: { state: 'blocked', updatedAt: NOW - 60_000 } }), NOW)
    expect(store.getState().byId.n1.state).toBe('blocked')
  })

  it('leaves an idle (stateless) entry seedable — that is the whole point after a reload', () => {
    const store = session()
    store.setState({ byId: { n1: { unread: true, sessionId: 's1' } } })
    store.getState().seedFromSnapshot(snap({ n1: { state: 'done', updatedAt: NOW } }), NOW)
    expect(store.getState().byId.n1).toMatchObject({ state: 'done', unread: true, sessionId: 's1' })
  })
})

describe('seedFromSnapshot — a seed is not an event', () => {
  it('never marks a node unread and never clears an existing unread', () => {
    const store = session()
    store.setState({ byId: { read: { unread: false }, flagged: { unread: true } } })
    store.getState().seedFromSnapshot(
      snap({ read: { state: 'done', updatedAt: NOW }, flagged: { state: 'done', updatedAt: NOW } }),
      NOW
    )
    expect(store.getState().byId.read.unread).toBe(false)
    expect(store.getState().byId.flagged.unread).toBe(true)
  })

  it('does NOT run setState’s side effects: the background-task stamp and the hibernated flag stand', () => {
    // The discriminating test for "bypasses setState": routed through it, a done→working edge
    // would delete `backgroundTaskAt` (silently un-protecting a running background shell from
    // Eco) and the live state would clear `hibernated`. Neither is warranted by a SEED: no event
    // happened this run, and the flag's self-heal belongs to real hook traffic.
    const store = session()
    store.setState({
      byId: {
        n1: {
          unread: false,
          state: 'done',
          stateAt: NOW - 120_000,
          lastEventAt: NOW - 120_000,
          backgroundTaskAt: NOW - 120_000,
          hibernated: true,
          hibernatedPane: 'nu'
        }
      }
    })
    store.getState().seedFromSnapshot(snap({ n1: { state: 'working', updatedAt: NOW } }), NOW)
    expect(store.getState().byId.n1).toMatchObject({
      state: 'working',
      backgroundTaskAt: NOW - 120_000,
      hibernated: true,
      hibernatedPane: 'nu'
    })
  })

  it('asserts no identity evidence and keeps the approval ticket only while blocked', () => {
    const store = session()
    store.setState({
      byId: {
        a: { unread: false, state: 'blocked', stateAt: NOW - 120_000, stateVerified: true, pendingId: 'p1' },
        b: { unread: false, state: 'blocked', stateAt: NOW - 120_000, stateVerified: true, pendingId: 'p2' }
      }
    })
    store.getState().seedFromSnapshot(
      snap({ a: { state: 'blocked', updatedAt: NOW }, b: { state: 'done', updatedAt: NOW } }),
      NOW
    )
    // A seed carries no per-node token, so it may never leave a `true` standing.
    expect(store.getState().byId.a.stateVerified).toBeUndefined()
    expect(store.getState().byId.b.stateVerified).toBeUndefined()
    expect(store.getState().byId.a.pendingId).toBe('p1') // still blocked → buttons still aimed
    expect(store.getState().byId.b.pendingId).toBeUndefined() // moved on → buttons must go
  })
})

describe('seedFromSnapshot — idempotence', () => {
  it('seeding the same snapshot twice writes nothing the second time', () => {
    // Both call sites (Canvas’s listener effect and the session registry) can fire for the same
    // core, and a second `byId` object would re-render every node header for no change.
    const store = session()
    const s = snap({ n1: { state: 'waiting', updatedAt: NOW - 1000 } })
    store.getState().seedFromSnapshot(s, NOW)
    const afterFirst = store.getState().byId
    const entry = afterFirst.n1
    store.getState().seedFromSnapshot(s, NOW + 500)
    expect(store.getState().byId).toBe(afterFirst)
    expect(store.getState().byId.n1).toBe(entry)
  })

  it('returns the same table when every entry is stale', () => {
    const store = session()
    const before = store.getState().byId
    store
      .getState()
      .seedFromSnapshot(snap({ n1: { state: 'done', updatedAt: NOW - 10 * 3600_000 } }), NOW)
    expect(store.getState().byId).toBe(before)
  })
})

describe('seedFromSnapshot — persistence is unaffected', () => {
  it('writes nothing to localStorage, and the durable record still carries no state', async () => {
    // The docblock rule: `state` and its clocks are transient. The mirror is what survives a
    // restart — a copy on disk here would just be a second, staler one.
    const store = memStorage()
    vi.stubGlobal('localStorage', store)
    const key = 'nodeterm.agentStatus.seedtest'
    const s = createAgentStatusSession(key).store
    s.getState().seedFromSnapshot(snap({ n1: { state: 'working', updatedAt: NOW } }), NOW)
    expect(store.getItem(key)).toBeNull()
    // …and a later durable write still records nothing transient.
    s.getState().setSessionId('n1', 'sess-1')
    const saved = JSON.parse(store.getItem(key)!)
    expect(saved.n1.sessionId).toBe('sess-1')
    expect(saved.n1.state).toBeUndefined()
    expect(saved.n1.stateAt).toBeUndefined()
    expect(saved.n1.lastEventAt).toBeUndefined()
  })
})

describe('seedFromSnapshot — availability', () => {
  it('exists on the default store and on every createAgentStatusSession instance', () => {
    expect(typeof useAgentStatus.getState().seedFromSnapshot).toBe('function')
    expect(typeof createAgentStatusSession().store.getState().seedFromSnapshot).toBe('function')
    expect(typeof createAgentStatusSession('nodeterm.agentStatus.other').store.getState().seedFromSnapshot).toBe(
      'function'
    )
  })
})
