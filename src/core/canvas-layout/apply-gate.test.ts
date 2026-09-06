// The active-node refusal is asked TWICE, and the second answer wins. A plan is previewed, read,
// and only then approved; in between, the operator can click into any card on it.
import { describe, it, expect } from 'vitest'
import { gateLayoutPlan } from './apply-gate'
import type { LayoutPlan } from '../../shared/canvas-layout'

const plan: LayoutPlan = {
  trigger: 'organize',
  ops: [
    { op: 'reparent', nodeId: 'a', parentId: 'tray' },
    { op: 'resize', nodeId: 'a', size: { width: 440, height: 320 } },
    { op: 'reparent', nodeId: 'b', parentId: 'tray' }
  ],
  skipped: [{ nodeId: 'c', reason: 'pinned' }]
}

describe('gateLayoutPlan', () => {
  it('keeps collapse ops for marked spawn trays that predate group roles', () => {
    const collapse: LayoutPlan = {
      trigger: 'node-created', ops: [{ op: 'collapse', nodeId: 'tray', collapsed: true }], skipped: []
    }
    expect(gateLayoutPlan(collapse, {
      isActive: () => false, current: { nodes: [{ id: 'tray', kind: 'group', taskFrame: true }] }
    })).toBe(collapse)
    expect(gateLayoutPlan(collapse, {
      isActive: () => false,
      current: { nodes: [{ id: 'tray', kind: 'group', taskFrame: true, role: 'primary' }] }
    }).ops).toEqual([])
  })
  it('drops EVERY op for a node that became active after the plan was built', () => {
    const gated = gateLayoutPlan(plan, { isActive: (id) => id === 'a' })
    expect(gated.ops).toEqual([{ op: 'reparent', nodeId: 'b', parentId: 'tray' }])
  })

  it('reports the drop as a refusal, so the applied result still accounts for every node', () => {
    const gated = gateLayoutPlan(plan, { isActive: (id) => id === 'a' })
    expect(gated.skipped).toEqual([
      { nodeId: 'c', reason: 'pinned' },
      { nodeId: 'a', reason: 'active' }
    ])
  })

  it('returns the SAME object when nothing changed — the preview is still exactly what applies', () => {
    expect(gateLayoutPlan(plan, { isActive: () => false })).toBe(plan)
  })

  it.each([
    [{ pinned: true }, 'pinned'],
    [{ manualPlacement: true }, 'manual-placement'],
    [{ role: 'primary' }, 'primary-role']
  ] as const)('honors changed operator intent when applying a preview: %s', (change, reason) => {
    const gated = gateLayoutPlan(plan, {
      isActive: () => false,
      current: { nodes: [{ id: 'a', kind: 'terminal', role: 'worker', ...change }] }
    })
    expect(gated.ops.some((op) => op.nodeId === 'a')).toBe(false)
    expect(gated.skipped).toContainEqual({ nodeId: 'a', reason })
  })

  it('honors a loop adopting the worker while the preview is open', () => {
    const gated = gateLayoutPlan(plan, {
      isActive: () => false,
      current: {
        nodes: [{ id: 'a', kind: 'terminal', role: 'worker', parentId: 'loop-frame' }],
        loopFrames: ['loop-frame']
      }
    })
    expect(gated.ops.some((op) => op.nodeId === 'a')).toBe(false)
    expect(gated.skipped).toContainEqual({ nodeId: 'a', reason: 'loop-owned' })
  })

  it('does not double-report a node the plan had already refused', () => {
    const already: LayoutPlan = { ...plan, skipped: [{ nodeId: 'a', reason: 'pinned' }] }
    const gated = gateLayoutPlan(already, { isActive: (id) => id === 'a' })
    expect(gated.skipped).toEqual([{ nodeId: 'a', reason: 'pinned' }])
  })

  it('drops everything when the operator is touching the whole canvas', () => {
    const gated = gateLayoutPlan(plan, { isActive: () => true })
    expect(gated.ops).toEqual([])
    expect(gated.skipped.map((s) => s.nodeId).sort()).toEqual(['a', 'b', 'c'])
  })
})
