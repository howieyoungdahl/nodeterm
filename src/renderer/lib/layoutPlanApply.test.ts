// Applying a plan is a canvas-state write and NOTHING else. The window-trap test below is the one
// that matters: `window.nodeTerminal` is the renderer's only route to a transport, so a getter that
// throws proves the property rather than asserting it in a comment.
import { describe, it, expect } from 'vitest'
import { applyLayoutPlan, layoutNodeOf, layoutNodesOf, layoutPlanRequest } from './layoutPlanApply'
import type { CanvasNode } from '../state/workspace'
import type { LayoutPlan } from '@shared/canvas-layout'

function term(id: string, over: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id,
    type: 'terminal',
    position: { x: 0, y: 0 },
    width: 640,
    height: 440,
    data: { title: id, color: '#0a84ff', group: null, tags: [], role: 'worker' },
    ...over
  } as CanvasNode
}

function frame(id: string, over: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id,
    type: 'group',
    position: { x: 0, y: 0 },
    width: 900,
    height: 700,
    data: { title: 'Tray', color: '#0a84ff', group: null, tags: [], taskFrame: true },
    ...over
  } as CanvasNode
}

function planOf(ops: LayoutPlan['ops']): LayoutPlan {
  return { trigger: 'organize', ops, skipped: [] }
}

describe('applyLayoutPlan', () => {
  it('returns the SAME array for an empty plan — a tidy canvas writes nothing', () => {
    const nodes = [term('a')]
    expect(applyLayoutPlan(nodes, planOf([]))).toBe(nodes)
  })

  it('ignores an op for a node that is gone', () => {
    const nodes = [term('a')]
    expect(applyLayoutPlan(nodes, planOf([{ op: 'collapse', nodeId: 'ghost', collapsed: true }]))).toBe(
      nodes
    )
  })

  it('reparents into a frame', () => {
    const nodes = [frame('tray'), term('a', { position: { x: 400, y: 300 } })]
    const next = applyLayoutPlan(nodes, planOf([{ op: 'reparent', nodeId: 'a', parentId: 'tray' }]))
    expect(next.find((n) => n.id === 'a')?.parentId).toBe('tray')
  })

  it('reparents back out to top level', () => {
    const nodes = [frame('tray'), term('a', { parentId: 'tray', position: { x: 30, y: 60 } })]
    const next = applyLayoutPlan(nodes, planOf([{ op: 'reparent', nodeId: 'a', parentId: null }]))
    expect(next.find((n) => n.id === 'a')?.parentId).toBeUndefined()
  })

  it('resizes and records the named geometry so `--size` stays truthful', () => {
    const nodes = [term('a')]
    const next = applyLayoutPlan(
      nodes,
      planOf([
        { op: 'resize', nodeId: 'a', size: { width: 440, height: 320 }, controlSize: 'compact' }
      ])
    )
    const a = next.find((n) => n.id === 'a')!
    expect(a.width).toBe(440)
    expect(a.height).toBe(320)
    expect(a.data.controlSize).toBe('compact')
  })

  it('never resizes a FRAME — a group has no control geometry', () => {
    const nodes = [frame('tray')]
    const next = applyLayoutPlan(
      nodes,
      planOf([{ op: 'resize', nodeId: 'tray', size: { width: 100, height: 100 } }])
    )
    expect(next).toBe(nodes)
  })

  it('places at a ROOT-space position, converting for the parent frame', () => {
    const nodes = [
      frame('tray', { position: { x: 1000, y: 500 } }),
      term('a', { parentId: 'tray', position: { x: 0, y: 0 } })
    ]
    const next = applyLayoutPlan(
      nodes,
      planOf([{ op: 'place', nodeId: 'a', position: { x: 1028, y: 562 } }])
    )
    expect(next.find((n) => n.id === 'a')?.position).toEqual({ x: 28, y: 62 })
  })

  it('collapses and expands', () => {
    const nodes = [frame('tray')]
    const closed = applyLayoutPlan(nodes, planOf([{ op: 'collapse', nodeId: 'tray', collapsed: true }]))
    expect(closed.find((n) => n.id === 'tray')?.data.collapsed).toBe(true)
    const open = applyLayoutPlan(closed, planOf([{ op: 'collapse', nodeId: 'tray', collapsed: false }]))
    expect(open.find((n) => n.id === 'tray')?.data.collapsed).toBe(false)
  })

  it('labels — and a title that tried to become TWO lines becomes one', () => {
    const nodes = [frame('tray')]
    const next = applyLayoutPlan(
      nodes,
      planOf([{ op: 'label', nodeId: 'tray', title: 'reviewer\nrm -rf /' }])
    )
    // `oneLine` substitutes a space for the control character rather than deleting it: the two
    // words stay two words, and what is gone is the ability to end the line.
    expect(next.find((n) => n.id === 'tray')?.data.title).toBe('reviewer rm -rf /')
  })

  it('refuses an empty label rather than blanking a frame', () => {
    const nodes = [frame('tray')]
    expect(applyLayoutPlan(nodes, planOf([{ op: 'label', nodeId: 'tray', title: '   ' }]))).toBe(nodes)
  })

  it('NEVER sets manualPlacement — an engine that pinned its own work would stop after one run', () => {
    const nodes = [frame('tray'), term('a')]
    const next = applyLayoutPlan(
      nodes,
      planOf([
        { op: 'reparent', nodeId: 'a', parentId: 'tray' },
        { op: 'place', nodeId: 'a', position: { x: 30, y: 60 } },
        { op: 'resize', nodeId: 'a', size: { width: 440, height: 320 }, controlSize: 'compact' }
      ])
    )
    expect(next.find((n) => n.id === 'a')?.data.manualPlacement).toBeUndefined()
    expect(next.find((n) => n.id === 'a')?.data.pinned).toBeUndefined()
  })

  it('touches NOTHING that could reach the PTY — no transport call, no respawn, no relaunch', () => {
    const touched: string[] = []
    const prior = Object.getOwnPropertyDescriptor(globalThis, 'window')
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      get() {
        touched.push('window')
        throw new Error('applying a layout plan must not reach the transport')
      }
    })
    try {
      const nodes = [
        frame('tray'),
        term('a', {
          data: {
            title: 'a',
            color: '#0a84ff',
            group: null,
            tags: [],
            role: 'worker',
            respawnNonce: 7,
            initialCommand: 'claude'
          }
        } as Partial<CanvasNode>)
      ]
      const next = applyLayoutPlan(
        nodes,
        planOf([
          { op: 'reparent', nodeId: 'a', parentId: 'tray' },
          { op: 'resize', nodeId: 'a', size: { width: 440, height: 320 }, controlSize: 'compact' },
          { op: 'collapse', nodeId: 'tray', collapsed: true },
          { op: 'label', nodeId: 'tray', title: 'reviewer workers' }
        ])
      )
      const a = next.find((n) => n.id === 'a')!
      expect(touched).toEqual([])
      expect(a.data.respawnNonce).toBe(7)
      expect(a.data.initialCommand).toBe('claude')
      expect(a.id).toBe('a')
      expect(a.type).toBe('terminal')
    } finally {
      if (prior) Object.defineProperty(globalThis, 'window', prior)
      else delete (globalThis as Record<string, unknown>).window
    }
  })
})

describe('layoutNodeOf / layoutPlanRequest', () => {
  it('carries the refusal flags the engine reads', () => {
    const shaped = layoutNodeOf(
      term('a', {
        parentId: 'tray',
        data: {
          title: 'a',
          color: '#0a84ff',
          group: null,
          tags: [],
          role: 'worker',
          pinned: true,
          manualPlacement: true,
          taskFrame: false,
          collapsed: true,
          controlSize: 'compact'
        }
      } as Partial<CanvasNode>)
    )
    expect(shaped).toMatchObject({
      id: 'a',
      kind: 'terminal',
      parentId: 'tray',
      role: 'worker',
      pinned: true,
      manualPlacement: true,
      collapsed: true,
      controlSize: 'compact'
    })
  })

  it('prefers React Flow’s MEASURED size over the persisted one', () => {
    const shaped = layoutNodeOf(term('a', { measured: { width: 500, height: 300 } } as Partial<CanvasNode>))
    expect(shaped.size).toEqual({ width: 500, height: 300 })
  })

  it('assembles a request with every optional list defaulted, never undefined', () => {
    const request = layoutPlanRequest({
      projectId: 'p1',
      trigger: 'organize',
      nodes: [term('a')],
      sizes: { compact: { width: 440, height: 320 }, normal: { width: 640, height: 440 } },
      holder: 'ui-a'
    })
    expect(request.ropes).toEqual([])
    expect(request.actives).toEqual([])
    expect(request.loopFrames).toEqual([])
    expect(request.createdIds).toEqual([])
    expect(request.nodes).toHaveLength(1)
  })

  it('layoutNodesOf maps the whole canvas', () => {
    expect(layoutNodesOf([term('a'), frame('tray')]).map((n) => n.kind)).toEqual([
      'terminal',
      'group'
    ])
  })
})
