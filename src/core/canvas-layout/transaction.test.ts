import { describe, expect, it, vi } from 'vitest'
import { LayoutLeaseStore } from './lease'
import { applyLayoutTransaction, captureLayoutTransaction, type LayoutApplyState } from './transaction'
import type { LayoutPlan } from '../../shared/canvas-layout'

async function fixture() {
  let file: string | null = null
  let now = 1_000
  const lease = new LayoutLeaseStore({
    read: () => file, write: async (text) => { file = text }, now: () => now
  })
  const grant = await lease.acquire('p1', 'ui-a')
  if (!grant.ok) throw new Error('fixture failed to acquire')
  const state: LayoutApplyState = {
    projectId: 'p1', revision: 'content-1', inputRevision: 'view-1', holder: 'ui-a',
    ownershipEpoch: 'assignment-1', enabled: true, source: 'current', activityComplete: true,
    nodes: [{ id: 'a', kind: 'terminal', role: 'worker', position: { x: 1, y: 2 } }],
    actives: [], loopFrames: [], owns: () => true
  }
  const plan: LayoutPlan = {
    trigger: 'organize', skipped: [], ops: [{ op: 'place', nodeId: 'a', position: { x: 10, y: 20 } }]
  }
  const transaction = captureLayoutTransaction(plan, state, grant.lease.token)
  const apply = vi.fn((candidate: LayoutPlan): undefined => {
    for (const op of candidate.ops) {
      if (op.op === 'place') state.nodes.find((node) => node.id === op.nodeId)!.position = op.position
    }
    state.inputRevision = 'view-2'
  })
  const run = () => applyLayoutTransaction(transaction, { lease, current: () => state, apply })
  return { lease, state, plan, transaction, apply, run, advance: () => { now += 60_000 } }
}

describe('organizer effect boundary', () => {
  it('does not mutate an already tidy canvas', async () => {
    const f = await fixture()
    f.transaction.plan.ops = []
    expect(await f.run()).toMatchObject({ kind: 'unchanged' })
    expect(f.apply).not.toHaveBeenCalled()
  })
  it('applies a captured plan once and refuses replay after the input revision advances', async () => {
    const f = await fixture()
    f.plan.ops = []
    expect(await f.run()).toMatchObject({ kind: 'applied' })
    expect(f.state.nodes[0].position).toEqual({ x: 10, y: 20 })
    expect(await f.run()).toEqual({ kind: 'refused', reason: 'stale-inputRevision' })
    expect(f.apply).toHaveBeenCalledTimes(1)
  })

  it.each(['projectId', 'revision', 'inputRevision', 'holder', 'ownershipEpoch'] as const)(
    'does not mutate after %s changes while the preview is open', async (key) => {
      const f = await fixture()
      f.state[key] = 'changed'
      expect(await f.run()).toEqual({ kind: 'refused', reason: `stale-${key}` })
      expect(f.apply).not.toHaveBeenCalled()
      expect(f.state.nodes[0].position).toEqual({ x: 1, y: 2 })
    }
  )

  it.each([
    [{ source: 'stale' }, 'source-stale'],
    [{ source: 'unknown' }, 'source-unknown'],
    [{ enabled: false }, 'disabled'],
    [{ enabled: 'true' }, 'disabled'],
    [{ activityComplete: false }, 'activity-unknown'],
    [{ activityComplete: 'yes' }, 'activity-unknown'],
    [{ actives: undefined }, 'source-unknown'],
    [{ owns: undefined }, 'ownership-unknown']
  ] as const)('refuses incomplete current evidence %j', async (patch, reason) => {
    const f = await fixture()
    Object.assign(f.state, patch)
    expect(await f.run()).toEqual({ kind: 'refused', reason })
    expect(f.apply).not.toHaveBeenCalled()
  })

  it.each(['pinned', 'manualPlacement'] as const)('preserves newly set %s', async (flag) => {
    const f = await fixture()
    f.state.nodes[0][flag] = true
    expect(await f.run()).toMatchObject({ kind: 'refused', reason: 'ineligible' })
    expect(f.apply).not.toHaveBeenCalled()
  })

  it('preserves activity, loop ownership, primary roles and creator exclusions at apply time', async () => {
    for (const change of [
      (s: LayoutApplyState) => { s.actives = ['a'] },
      (s: LayoutApplyState) => { s.loopFrames = ['a'] },
      (s: LayoutApplyState) => { s.nodes[0].role = 'primary' },
      (s: LayoutApplyState) => { s.owns = () => false }
    ]) {
      const f = await fixture()
      change(f.state)
      expect(await f.run()).toMatchObject({ kind: 'refused', reason: 'ineligible' })
      expect(f.apply).not.toHaveBeenCalled()
    }
  })

  it('refuses a resize whose parent refit would move a pinned sibling', async () => {
    const f = await fixture()
    f.state.nodes = [
      { ...f.state.nodes[0], parentId: 'tray' },
      { id: 'tray', kind: 'group', taskFrame: true },
      { id: 'b', kind: 'terminal', role: 'worker', parentId: 'tray', pinned: true }
    ]
    f.transaction.plan.ops = [{ op: 'resize', nodeId: 'a', size: { width: 440, height: 320 } }]
    expect(await f.run()).toMatchObject({ kind: 'refused', skipped: [{ nodeId: 'b', reason: 'pinned' }] })
    expect(f.apply).not.toHaveBeenCalled()
  })

  it('refuses missing nodes, missing parents and cyclic ancestry without a partial apply', async () => {
    for (const parentId of ['absent', 'a']) {
      const f = await fixture()
      f.state.nodes[0].parentId = parentId
      expect(await f.run()).toMatchObject({ kind: 'refused', reason: 'invalid-hierarchy' })
      expect(f.apply).not.toHaveBeenCalled()
    }
    const f = await fixture()
    f.state.nodes = []
    expect(await f.run()).toMatchObject({ kind: 'refused', reason: 'invalid-hierarchy' })
    expect(f.apply).not.toHaveBeenCalled()
  })

  it('rejects expiry and an expired grant replaced by another holder', async () => {
    const f = await fixture()
    f.advance()
    expect(await f.run()).toMatchObject({ kind: 'refused', reason: 'lease-stale' })
    await f.lease.acquire('p1', 'ui-b')
    expect(await f.run()).toMatchObject({ kind: 'refused', reason: 'lease-stale', holder: 'ui-b' })
    expect(f.apply).not.toHaveBeenCalled()
  })

  it('refuses an old preview after the same holder renews', async () => {
    const f = await fixture()
    await f.lease.acquire('p1', 'ui-a')
    expect(await f.run()).toMatchObject({ kind: 'refused', reason: 'lease-stale' })
    expect(f.apply).not.toHaveBeenCalled()
  })

  it('reads current state after queue admission, not before awaiting the lease', async () => {
    const f = await fixture()
    const outcome = f.run()
    f.state.ownershipEpoch = 'assignment-2'
    expect(await outcome).toMatchObject({ kind: 'refused', reason: 'stale-ownershipEpoch' })
    expect(f.apply).not.toHaveBeenCalled()
  })

  it('does not relabel an effect failure as a refusal that invites replay', async () => {
    const f = await fixture()
    await expect(applyLayoutTransaction(f.transaction, {
      lease: f.lease, current: () => f.state, apply: () => { throw new Error('publication unknown') }
    })).rejects.toThrow('publication unknown')
  })

  it('checks expiry again after reading current evidence', async () => {
    const f = await fixture()
    expect(await applyLayoutTransaction(f.transaction, {
      lease: f.lease, current: () => { f.advance(); return f.state }, apply: f.apply
    })).toMatchObject({ kind: 'refused', reason: 'lease-stale' })
    expect(f.apply).not.toHaveBeenCalled()
  })

  it('refuses a cycle introduced by multiple individually valid reparent operations', async () => {
    const f = await fixture()
    f.state.nodes = [{ id: 'a', kind: 'group', taskFrame: true }, { id: 'b', kind: 'group', taskFrame: true }]
    f.transaction.plan.ops = [
      { op: 'reparent', nodeId: 'a', parentId: 'b' }, { op: 'reparent', nodeId: 'b', parentId: 'a' }
    ]
    expect(await f.run()).toMatchObject({ kind: 'refused', reason: 'invalid-hierarchy' })
    expect(f.apply).not.toHaveBeenCalled()
  })
})
