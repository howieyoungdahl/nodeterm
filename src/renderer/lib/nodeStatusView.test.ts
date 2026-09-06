import { describe, expect, it } from 'vitest'
import { NODE_STATUS_STALE_MS } from '@shared/node-status'
import type { AgentNodeStatus } from '../state/agentStatus'
import {
  groupStatusRollUp,
  rollUpFromSignature,
  rollUpSignature,
  showsStatus,
  statusMembersOf,
  statusViewFor,
  type RollUpNodeInput
} from './nodeStatusView'

const NOW = 1_800_000_000_000

describe('statusViewFor', () => {
  it('reads freshness from stateAt (when the state was last asserted), not lastEventAt', () => {
    const status: AgentNodeStatus = {
      unread: false,
      state: 'working',
      stateAt: NOW - 120_000,
      lastEventAt: NOW - 7_200_000
    }
    expect(statusViewFor(status, NOW).age).toBe('2m')
  })

  it('is unknown for a node the store has never heard of', () => {
    expect(statusViewFor(undefined, NOW).kind).toBe('unknown')
  })

  it('carries the hook event reason onto the badge', () => {
    const status: AgentNodeStatus = {
      unread: false,
      state: 'blocked',
      stateAt: NOW,
      reason: 'Allow Bash(rm -rf build)?',
      askKind: 'approval'
    }
    const v = statusViewFor(status, NOW)
    expect(v.kind).toBe('blocked')
    expect(v.reason).toBe('Allow Bash(rm -rf build)?')
  })

  it('renders a latched failure even after the working state was swept away', () => {
    const status: AgentNodeStatus = {
      unread: false,
      state: undefined,
      failure: { at: NOW - 600_000, from: 'working' }
    }
    expect(statusViewFor(status, NOW).kind).toBe('failed')
  })

  it('renders a blocked node whose pane is proven dead as failed', () => {
    const status: AgentNodeStatus = {
      unread: false,
      state: 'blocked',
      stateAt: NOW - 600_000,
      pane: 'dead'
    }
    const v = statusViewFor(status, NOW)
    expect(v.kind).toBe('failed')
    expect(v.detail).toContain('can no longer be answered')
  })

  it('renders a finished node whose pane is proven dead as completed', () => {
    const status: AgentNodeStatus = {
      unread: false,
      state: 'done',
      stateAt: NOW - 600_000,
      pane: 'dead'
    }
    expect(statusViewFor(status, NOW).kind).toBe('completed')
  })

  it('renders a stale working we could not verify as unknown', () => {
    const status: AgentNodeStatus = {
      unread: false,
      state: 'working',
      stateAt: NOW - (NODE_STATUS_STALE_MS + 1),
      pane: 'unknown'
    }
    expect(statusViewFor(status, NOW).kind).toBe('unknown')
  })
})

describe('showsStatus', () => {
  it('is true only for a hook-capable agent terminal', () => {
    expect(showsStatus({ type: 'terminal', agentId: 'claude' })).toBe(true)
    expect(showsStatus({ type: 'terminal' })).toBe(false)
    expect(showsStatus({ type: 'sticky', agentId: 'claude' })).toBe(false)
    expect(showsStatus({ type: 'group' })).toBe(false)
  })
})

const tree: RollUpNodeInput[] = [
  { id: 'frame', type: 'group' },
  { id: 'inner', type: 'group', parentId: 'frame' },
  { id: 'a', type: 'terminal', parentId: 'frame', agentId: 'claude' },
  { id: 'b', type: 'terminal', parentId: 'inner', agentId: 'codex' },
  { id: 'shell', type: 'terminal', parentId: 'frame' },
  { id: 'note', type: 'sticky', parentId: 'frame' },
  { id: 'outside', type: 'terminal', agentId: 'claude' }
]

describe('statusMembersOf', () => {
  it('collects status-bearing descendants through nested frames', () => {
    expect(statusMembersOf('frame', tree).map((n) => n.id)).toEqual(expect.arrayContaining(['a', 'b']))
    expect(statusMembersOf('frame', tree)).toHaveLength(2)
  })

  it('excludes plain shells, stickies and nodes outside the frame', () => {
    const ids = statusMembersOf('frame', tree).map((n) => n.id)
    expect(ids).not.toContain('shell')
    expect(ids).not.toContain('note')
    expect(ids).not.toContain('outside')
  })

  it('terminates on a malformed parent cycle instead of hanging the render', () => {
    const cyclic: RollUpNodeInput[] = [
      { id: 'g1', type: 'group', parentId: 'g2' },
      { id: 'g2', type: 'group', parentId: 'g1' }
    ]
    expect(statusMembersOf('g1', cyclic)).toEqual([])
  })
})

describe('groupStatusRollUp', () => {
  const statuses: Record<string, AgentNodeStatus> = {
    a: { unread: false, state: 'working', stateAt: NOW },
    b: { unread: false, state: 'blocked', stateAt: NOW }
  }

  it('shows the worst member state on the frame', () => {
    const r = groupStatusRollUp('frame', tree, (id) => statuses[id], NOW)
    expect(r).toMatchObject({ kind: 'blocked', count: 1, total: 2 })
  })

  it('renders nothing for a frame with no status-bearing members', () => {
    expect(groupStatusRollUp('inner', [{ id: 'inner', type: 'group' }], () => undefined, NOW)).toBeNull()
  })

  it('reports a member with no status at all as unknown rather than hiding it', () => {
    const r = groupStatusRollUp('frame', tree, (id) => (id === 'a' ? statuses.a : undefined), NOW)
    expect(r?.kind).toBe('unknown')
  })
})

describe('roll-up signature', () => {
  it('round-trips a roll-up through its primitive form', () => {
    const r = groupStatusRollUp(
      'frame',
      tree,
      () => ({ unread: false, state: 'waiting', stateAt: NOW }) as AgentNodeStatus,
      NOW
    )
    const back = rollUpFromSignature(rollUpSignature(r))
    expect(back).toEqual(r)
  })

  it('renders nothing for an empty or malformed signature', () => {
    expect(rollUpFromSignature('')).toBeNull()
    expect(rollUpFromSignature('nonsense:1:2')).toBeNull()
    expect(rollUpFromSignature('blocked:x:2')).toBeNull()
  })
})
