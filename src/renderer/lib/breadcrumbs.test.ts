import { describe, it, expect } from 'vitest'
import {
  BREADCRUMB_CAP, buildNote, recordBreadcrumb, stepBreadcrumb,
  type BreadcrumbState, type BreadcrumbTarget
} from './breadcrumbs'
import type { AgentNodeStatus } from '../state/agentStatus'

const target = (over: Partial<BreadcrumbTarget> = {}): BreadcrumbTarget => ({
  id: 'n1', kind: 'terminal', title: 'My Terminal', ...over
})

describe('buildNote', () => {
  it('non-agent node: "<kind> · <title>"', () => {
    expect(buildNote(target({ kind: 'sticky', title: 'Deploy notes' }), undefined))
      .toBe('sticky · Deploy notes')
  })

  it('agent node with no session and no title falls back to the agent label', () => {
    expect(buildNote(target({ agentId: 'claude', title: '' }), undefined))
      .toBe('Claude Code · Task unobserved')
  })

  it('agent node with no session names the NODE rather than the bare agent label', () => {
    // The common case right after an app restart: `agentStatus.state` is transient, so neither a
    // session name nor a live state exists — "Claude Code · Task unobserved" would name neither the node
    // nor what was happening. The node's title auto-tracks the session name via `titleAuto`.
    expect(buildNote(target({ agentId: 'claude', title: 'fix-auth-bug' }), undefined))
      .toBe('fix-auth-bug · Task unobserved')
  })

  it('agent node with a live state uses the sessions-sidebar phrasing', () => {
    const status: AgentNodeStatus = { state: 'waiting', unread: false }
    expect(buildNote(target({ agentId: 'claude', title: '' }), status))
      .toBe('Claude Code · Waiting for your response')
  })

  it('agent node with a session name prefers it over the node title', () => {
    const status: AgentNodeStatus = { state: 'working', unread: false, session: 'fix-auth-bug' }
    expect(buildNote(target({ agentId: 'claude', title: 'stale name' }), status))
      .toBe('fix-auth-bug · Running')
  })

  it('custom agent id with no builtin config falls back to the raw id', () => {
    expect(buildNote(target({ agentId: 'my-custom-agent', title: '' }), undefined))
      .toBe('my-custom-agent · Task unobserved')
  })

  it('a missing kind defaults to the terminal label', () => {
    expect(buildNote(target({ kind: undefined, title: 'Untitled' }), undefined))
      .toBe('terminal · Untitled')
  })
})

describe('recordBreadcrumb', () => {
  const empty: BreadcrumbState = { list: [], index: -1 }

  it('appends the first stop', () => {
    const next = recordBreadcrumb(empty, target(), undefined, 1000)
    expect(next.list).toEqual([{ nodeId: 'n1', at: 1000, note: 'terminal · My Terminal' }])
    expect(next.index).toBe(0)
  })

  it('dedupes the same node within the debounce window', () => {
    const first = recordBreadcrumb(empty, target(), undefined, 1000)
    const second = recordBreadcrumb(first, target(), undefined, 1500)
    expect(second).toBe(first) // same object identity — a true no-op
  })

  it('records the same node again after the debounce window passes', () => {
    const first = recordBreadcrumb(empty, target(), undefined, 1000)
    const second = recordBreadcrumb(first, target(), undefined, 5000)
    expect(second.list).toHaveLength(2)
    expect(second.index).toBe(1)
  })

  it('records a DIFFERENT node inside the debounce window', () => {
    const first = recordBreadcrumb(empty, target({ id: 'a' }), undefined, 1000)
    const second = recordBreadcrumb(first, target({ id: 'b' }), undefined, 1100)
    expect(second.list.map((x) => x.nodeId)).toEqual(['a', 'b'])
    expect(second.index).toBe(1)
  })

  it('truncates the forward tail on a fresh navigation from a non-tip cursor', () => {
    let s = recordBreadcrumb(empty, target({ id: 'a' }), undefined, 1000)
    s = recordBreadcrumb(s, target({ id: 'b' }), undefined, 5000)
    s = recordBreadcrumb(s, target({ id: 'c' }), undefined, 9000)
    expect(s.list.map((x) => x.nodeId)).toEqual(['a', 'b', 'c'])
    // Go back to 'a' (index 0), then land somewhere new — 'b' and 'c' must be dropped.
    const backAtA: BreadcrumbState = { list: s.list, index: 0 }
    const fresh = recordBreadcrumb(backAtA, target({ id: 'd' }), undefined, 13000)
    expect(fresh.list.map((x) => x.nodeId)).toEqual(['a', 'd'])
    expect(fresh.index).toBe(1)
  })

  it('caps at BREADCRUMB_CAP, dropping the oldest', () => {
    let s = empty
    for (let i = 0; i < BREADCRUMB_CAP + 5; i++) {
      s = recordBreadcrumb(s, target({ id: `n${i}` }), undefined, 1000 + i * 5000)
    }
    expect(s.list).toHaveLength(BREADCRUMB_CAP)
    expect(s.list[0].nodeId).toBe('n5') // the first 5 were evicted
    expect(s.list[s.list.length - 1].nodeId).toBe(`n${BREADCRUMB_CAP + 4}`)
    expect(s.index).toBe(BREADCRUMB_CAP - 1)
  })

  it('does not mutate the state it was handed', () => {
    const first = recordBreadcrumb(empty, target({ id: 'a' }), undefined, 1000)
    const before = [...first.list]
    recordBreadcrumb(first, target({ id: 'b' }), undefined, 5000)
    expect(first.list).toEqual(before)
    expect(first.index).toBe(0)
  })
})

describe('stepBreadcrumb', () => {
  const exists = (ids: string[]) => (id: string) => ids.includes(id)

  it('moves back one stop', () => {
    const state: BreadcrumbState = {
      list: [
        { nodeId: 'a', at: 1, note: '' },
        { nodeId: 'b', at: 2, note: '' }
      ],
      index: 1
    }
    expect(stepBreadcrumb(state, 'back', exists(['a', 'b']))).toEqual({ ...state, index: 0 })
  })

  it('moves forward one stop', () => {
    const state: BreadcrumbState = {
      list: [
        { nodeId: 'a', at: 1, note: '' },
        { nodeId: 'b', at: 2, note: '' }
      ],
      index: 0
    }
    expect(stepBreadcrumb(state, 'forward', exists(['a', 'b']))?.index).toBe(1)
  })

  it('returns null at the start of the list going back', () => {
    const state: BreadcrumbState = { list: [{ nodeId: 'a', at: 1, note: '' }], index: 0 }
    expect(stepBreadcrumb(state, 'back', exists(['a']))).toBeNull()
  })

  it('returns null at the end of the list going forward', () => {
    const state: BreadcrumbState = { list: [{ nodeId: 'a', at: 1, note: '' }], index: 0 }
    expect(stepBreadcrumb(state, 'forward', exists(['a']))).toBeNull()
  })

  it('returns null on an empty list', () => {
    const state: BreadcrumbState = { list: [], index: -1 }
    expect(stepBreadcrumb(state, 'back', exists([]))).toBeNull()
    expect(stepBreadcrumb(state, 'forward', exists([]))).toBeNull()
  })

  it('skips a deleted node in the walked direction instead of landing on it', () => {
    const state: BreadcrumbState = {
      list: [
        { nodeId: 'a', at: 1, note: '' },
        { nodeId: 'deleted', at: 2, note: '' },
        { nodeId: 'c', at: 3, note: '' }
      ],
      index: 2
    }
    // Going back from 'c': 'deleted' is skipped, lands on 'a'.
    expect(stepBreadcrumb(state, 'back', exists(['a', 'c']))?.index).toBe(0)
  })

  it('returns null when every stop in the walked direction is deleted', () => {
    const state: BreadcrumbState = {
      list: [
        { nodeId: 'gone1', at: 1, note: '' },
        { nodeId: 'gone2', at: 2, note: '' },
        { nodeId: 'c', at: 3, note: '' }
      ],
      index: 2
    }
    expect(stepBreadcrumb(state, 'back', exists(['c']))).toBeNull()
  })

  it('keeps the list identity when it moves — only the cursor changes', () => {
    const state: BreadcrumbState = {
      list: [
        { nodeId: 'a', at: 1, note: '' },
        { nodeId: 'b', at: 2, note: '' }
      ],
      index: 1
    }
    expect(stepBreadcrumb(state, 'back', exists(['a', 'b']))?.list).toBe(state.list)
  })
})
