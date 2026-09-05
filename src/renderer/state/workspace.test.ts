import { describe, it, expect } from 'vitest'
import {
  addSelectionToGroup,
  alignNodes,
  applyWorkerFramePlan,
  arrangeNodes,
  commonParentId,
  compactToggleState,
  canvasControlNodeGeometry,
  createAccountLoginNode,
  createCodexAccountLoginNode,
  createAgentNode,
  createDinoNode,
  createSystemLoginNode,
  isAccountLoginNode,
  fitGroupToChildren,
  flowToNodeStates,
  groupSelectedNodes,
  markManualPlacement,
  nodeStatesToFlow,
  nodeSshFor,
  normalizeLegacyServerControlSpawnMutation,
  reorderGroupWithinParent,
  reorderNodeBefore,
  reparentNode,
  resolveNewNodeAccount,
  resizeTerminalNodeGeometry,
  selectedRootIds,
  setNodesPinned,
  toggleCompactNode,
  ungroupNodes,
  workerFrameNodeOf
} from './workspace'
import type { CanvasNode } from './workspace'

const term = (id: string, pos: { x: number; y: number }, parentId?: string): CanvasNode =>
  ({
    id,
    type: 'terminal',
    position: pos,
    width: 320,
    height: 240,
    data: { title: id, color: '#888', group: null },
    ...(parentId ? { parentId, extent: 'parent' as const } : {})
  }) as unknown as CanvasNode

const grp = (id: string, pos: { x: number; y: number }, parentId?: string): CanvasNode =>
  ({
    id,
    type: 'group',
    position: pos,
    width: 400,
    height: 300,
    data: { title: id, color: '#fff', group: null },
    ...(parentId ? { parentId, extent: 'parent' as const } : {})
  }) as unknown as CanvasNode

describe('reparentNode', () => {
  it('adds a top-level node to a group with a group-relative position', () => {
    const nodes = [term('t1', { x: 200, y: 150 }), grp('g1', { x: 50, y: 50 })]
    const out = reparentNode(nodes, 't1', 'g1')
    const t1 = out.find((n) => n.id === 't1')!
    expect(t1.parentId).toBe('g1')
    expect(t1.extent).toBe('parent')
    expect(t1.position).toEqual({ x: 150, y: 100 })
  })

  it('removes a node from its group, restoring the absolute position', () => {
    const nodes = [grp('g1', { x: 50, y: 50 }), term('t1', { x: 10, y: 10 }, 'g1')]
    const out = reparentNode(nodes, 't1', null)
    const t1 = out.find((n) => n.id === 't1')!
    expect(t1.parentId).toBeUndefined()
    expect(t1.extent).toBeUndefined()
    expect(t1.position).toEqual({ x: 60, y: 60 })
  })

  it('orders group nodes before their children', () => {
    const nodes = [term('t1', { x: 200, y: 150 }), grp('g1', { x: 50, y: 50 })]
    const out = reparentNode(nodes, 't1', 'g1')
    expect(out.findIndex((n) => n.id === 'g1')).toBeLessThan(out.findIndex((n) => n.id === 't1'))
  })

  it('is a no-op when the node is already in the target group', () => {
    const nodes = [grp('g1', { x: 50, y: 50 }), term('t1', { x: 10, y: 10 }, 'g1')]
    expect(reparentNode(nodes, 't1', 'g1')).toBe(nodes)
  })

  it('is a no-op when the node is missing or the target is not a group', () => {
    const nodes = [grp('g1', { x: 50, y: 50 }), term('t1', { x: 10, y: 10 })]
    expect(reparentNode(nodes, 'nope', 'g1')).toBe(nodes)
    expect(reparentNode(nodes, 't1', 't1')).toBe(nodes) // target is a terminal, not a group
  })

  it('moves a whole group subtree between nested containers without moving it in root space', () => {
    const nodes = [
      grp('outer', { x: 100, y: 80 }),
      grp('inner', { x: 30, y: 40 }, 'outer'),
      term('leaf', { x: 10, y: 12 }, 'inner'),
      grp('target', { x: 500, y: 200 })
    ]
    const out = reparentNode(nodes, 'inner', 'target')
    const inner = out.find((node) => node.id === 'inner')!
    expect(inner.parentId).toBe('target')
    expect(inner.position).toEqual({ x: -370, y: -80 })
    expect(out.find((node) => node.id === 'leaf')!.position).toEqual({ x: 10, y: 12 })
    expect(out.findIndex((node) => node.id === 'target')).toBeLessThan(
      out.findIndex((node) => node.id === 'inner')
    )
  })

  it('rejects parenting a group into itself or one of its descendants', () => {
    const nodes = [grp('outer', { x: 0, y: 0 }), grp('inner', { x: 20, y: 20 }, 'outer')]
    expect(reparentNode(nodes, 'outer', 'outer')).toBe(nodes)
    expect(reparentNode(nodes, 'outer', 'inner')).toBe(nodes)
  })
})

describe('addSelectionToGroup', () => {
  it('adds selected sibling objects to the already selected group', () => {
    const nodes = [
      grp('target', { x: 100, y: 80 }),
      term('a', { x: 500, y: 200 }),
      term('b', { x: 700, y: 300 })
    ]
    const out = addSelectionToGroup(nodes, ['target', 'a', 'b'], 'target')
    expect(out.find((node) => node.id === 'a')!.parentId).toBe('target')
    expect(out.find((node) => node.id === 'b')!.parentId).toBe('target')
    // Root-space positions are unchanged: the frame was re-fitted around its new children, so
    // frame origin + child offset still lands on the node's old absolute position.
    const target = out.find((node) => node.id === 'target')!
    const a = out.find((node) => node.id === 'a')!
    expect(target.position.x + a.position.x).toBe(500)
    expect(target.position.y + a.position.y).toBe(200)
  })

  it('moves only a selected subtree root and rejects cycles through reparenting', () => {
    const nodes = [
      grp('target', { x: 500, y: 200 }),
      grp('outer', { x: 100, y: 80 }),
      term('leaf', { x: 10, y: 12 }, 'outer')
    ]
    const out = addSelectionToGroup(nodes, ['target', 'outer', 'leaf'], 'target')
    expect(out.find((node) => node.id === 'outer')!.parentId).toBe('target')
    expect(out.find((node) => node.id === 'leaf')!.parentId).toBe('outer')
    const nested = [grp('outer', { x: 0, y: 0 }), grp('target', { x: 20, y: 20 }, 'outer')]
    expect(addSelectionToGroup(nested, ['outer', 'target'], 'target')).toBe(nested)
  })

  it('is a no-op without a valid target or movable selected object', () => {
    const nodes = [grp('target', { x: 0, y: 0 }), term('inside', { x: 10, y: 10 }, 'target')]
    expect(addSelectionToGroup(nodes, ['target', 'inside'], 'target')).toBe(nodes)
    expect(addSelectionToGroup(nodes, ['target'], 'missing')).toBe(nodes)
  })
})

describe('selectedRootIds', () => {
  it('normalizes box-selected group subtrees to their selected roots', () => {
    const nodes = [
      grp('outer', { x: 0, y: 0 }),
      grp('inner', { x: 10, y: 10 }, 'outer'),
      term('leaf', { x: 5, y: 5 }, 'inner'),
      grp('sibling', { x: 500, y: 0 })
    ]
    expect(selectedRootIds(nodes, ['outer', 'inner', 'leaf', 'sibling'])).toEqual([
      'outer',
      'sibling'
    ])
  })

  it('drops unknown ids and preserves independent selection order', () => {
    const nodes = [term('a', { x: 0, y: 0 }), term('b', { x: 10, y: 10 })]
    expect(selectedRootIds(nodes, ['missing', 'b', 'a'])).toEqual(['b', 'a'])
  })
})

describe('commonParentId', () => {
  it('is null when every id is top-level', () => {
    const nodes = [term('t1', { x: 0, y: 0 }), grp('g1', { x: 5, y: 5 })]
    expect(commonParentId(nodes, ['t1', 'g1'])).toBeNull()
  })
  it('is the group id when every id is a child of the same group', () => {
    const nodes = [grp('g1', { x: 0, y: 0 }), term('t1', { x: 10, y: 10 }, 'g1'), term('t2', { x: 20, y: 20 }, 'g1')]
    expect(commonParentId(nodes, ['t1', 't2'])).toBe('g1')
  })
  it('is undefined for a mixed set (framed + loose, or two frames) or no matching ids', () => {
    const nodes = [
      grp('g1', { x: 0, y: 0 }),
      term('t1', { x: 10, y: 10 }, 'g1'),
      term('loose', { x: 500, y: 0 })
    ]
    expect(commonParentId(nodes, ['t1', 'loose'])).toBeUndefined()
    expect(commonParentId(nodes, ['nope'])).toBeUndefined()
  })
})

describe('arrange/align inside a frame', () => {
  // Children of one frame arrange in the frame's coordinate space — the gap this closes: after
  // grouping, the frame's contents could not be tidied from the canvas-control CLI.
  const framed = () => [
    grp('g1', { x: 100, y: 100 }),
    term('a', { x: 5, y: 5 }, 'g1'),
    term('b', { x: 400, y: 300 }, 'g1'), // scattered inside the frame
    term('c', { x: 900, y: 40 }, 'g1')
  ]

  it('arranges a frame\'s children in a row without touching the frame or top-level nodes', () => {
    const out = arrangeNodes(framed(), ['a', 'b', 'c'], { layout: 'row', gap: 40 })
    const pos = (id: string) => out.find((n) => n.id === id)!.position
    // Row starts at the bounding-box top-left of the children (relative coords), y shared.
    expect(pos('a')).toEqual({ x: 5, y: 5 })
    expect(pos('b')).toEqual({ x: 5 + 320 + 40, y: 5 })
    expect(pos('c')).toEqual({ x: 5 + (320 + 40) * 2, y: 5 })
  })

  it('refuses a set spanning two containers (no-op)', () => {
    const nodes = [
      grp('g1', { x: 0, y: 0 }),
      term('a', { x: 10, y: 10 }, 'g1'),
      term('loose', { x: 800, y: 0 })
    ]
    expect(arrangeNodes(nodes, ['a', 'loose'], { layout: 'row' })).toBe(nodes)
    expect(alignNodes(nodes, ['a', 'loose'], 'left')).toBe(nodes)
  })

  it('aligns a frame\'s children to a shared left edge', () => {
    const out = alignNodes(framed(), ['a', 'b', 'c'], 'left')
    const xs = ['a', 'b', 'c'].map((id) => out.find((n) => n.id === id)!.position.x)
    expect(new Set(xs)).toEqual(new Set([5])) // all snapped to the leftmost (a.x = 5)
  })
})

describe('fitGroupToChildren', () => {
  it('shrinks the frame to hug its children and keeps them fixed on canvas', () => {
    // Frame is oversized (400×300) but its two children sit in a small cluster.
    const nodes = [
      grp('g1', { x: 100, y: 100 }),
      term('a', { x: 20, y: 40 }, 'g1'), // abs (120,140), 320×240
      term('b', { x: 60, y: 20 }, 'g1') // abs (160,120)
    ]
    const out = fitGroupToChildren(nodes, 'g1')
    const g = out.find((n) => n.id === 'g1')!
    const a = out.find((n) => n.id === 'a')!
    const b = out.find((n) => n.id === 'b')!
    // Children keep their ABSOLUTE canvas positions (frame origin + relative pos unchanged).
    expect({ x: g.position.x + a.position.x, y: g.position.y + a.position.y }).toEqual({ x: 120, y: 140 })
    expect({ x: g.position.x + b.position.x, y: g.position.y + b.position.y }).toEqual({ x: 160, y: 120 })
    // Frame hugs the child bbox with the standard pad (28) + header (34) on top.
    const GROUP_PAD = 28
    const GROUP_HEADER = 34
    const minX = 120, minY = 120
    const maxX = 160 + 320, maxY = 140 + 240
    expect(g.position).toEqual({ x: minX - GROUP_PAD, y: minY - GROUP_PAD - GROUP_HEADER })
    expect(g.width).toBe(maxX - minX + GROUP_PAD * 2)
    expect(g.height).toBe(maxY - minY + GROUP_PAD * 2 + GROUP_HEADER)
  })

  it('is a no-op for a missing id, a non-group, or an empty frame', () => {
    const nodes = [grp('g1', { x: 0, y: 0 }), term('t1', { x: 0, y: 0 })]
    expect(fitGroupToChildren(nodes, 'nope')).toBe(nodes)
    expect(fitGroupToChildren(nodes, 't1')).toBe(nodes)
    expect(fitGroupToChildren(nodes, 'g1')).toBe(nodes) // g1 has no children
  })
})

describe('groupSelectedNodes', () => {
  it('wraps the selection in a group frame with group-relative child positions', () => {
    const nodes = [term('t1', { x: 100, y: 100 }), term('t2', { x: 500, y: 300 })]
    const out = groupSelectedNodes(nodes, ['t1', 't2'], 0)
    const group = out[0]
    expect(group.type).toBe('group') // parent placed first (React Flow requirement)
    const t1 = out.find((n) => n.id === 't1')!
    expect(t1.parentId).toBe(group.id)
    expect(t1.extent).toBe('parent')
    // absolute position preserved: group position + relative child position
    expect(group.position.x + t1.position.x).toBe(100)
    expect(group.position.y + t1.position.y).toBe(100)
    // frame encloses both members (t2 spans to x=820, y=540)
    expect(group.position.x + (group.width as number)).toBeGreaterThanOrEqual(820)
    expect(group.position.y + (group.height as number)).toBeGreaterThanOrEqual(540)
  })

  it('groups a single node', () => {
    const out = groupSelectedNodes([term('t1', { x: 100, y: 100 })], ['t1'], 0)
    expect(out[0].type).toBe('group')
    expect(out.find((n) => n.id === 't1')!.parentId).toBe(out[0].id)
  })

  it('refuses an ancestor together with its descendant', () => {
    const nodes = [grp('g1', { x: 0, y: 0 }), term('t1', { x: 10, y: 10 }, 'g1')]
    expect(groupSelectedNodes(nodes, ['g1', 't1'], 1)).toBe(nodes)
  })

  it('refuses members that live in different containers', () => {
    const nodes = [
      grp('g1', { x: 0, y: 0 }),
      term('inside', { x: 10, y: 10 }, 'g1'),
      term('loose', { x: 900, y: 900 })
    ]
    expect(groupSelectedNodes(nodes, ['inside', 'loose'], 1)).toBe(nodes)
  })

  it('wraps sibling groups in a nested group while preserving root-space positions', () => {
    const nodes = [grp('a', { x: 100, y: 120 }), grp('b', { x: 600, y: 180 })]
    const out = groupSelectedNodes(nodes, ['a', 'b'], 2)
    const wrapper = out.find((node) => !nodes.some((old) => old.id === node.id))!
    const a = out.find((node) => node.id === 'a')!
    expect(wrapper.type).toBe('group')
    expect(a.parentId).toBe(wrapper.id)
    expect(wrapper.position.x + a.position.x).toBe(100)
    expect(wrapper.position.y + a.position.y).toBe(120)
    expect(out.indexOf(wrapper)).toBeLessThan(out.indexOf(a))
  })

  it("creates the wrapper inside the siblings' existing parent", () => {
    const nodes = [
      grp('outer', { x: 100, y: 80 }),
      grp('a', { x: 20, y: 30 }, 'outer'),
      grp('b', { x: 500, y: 60 }, 'outer')
    ]
    const out = groupSelectedNodes(nodes, ['a', 'b'], 3)
    const wrapper = out.find((node) => !nodes.some((old) => old.id === node.id))!
    const outer = out.find((node) => node.id === 'outer')!
    const a = out.find((node) => node.id === 'a')!
    expect(wrapper.parentId).toBe('outer')
    expect(a.parentId).toBe(wrapper.id)
    // Root space is unchanged: 'a' sat at (120, 110) before and must still sit there.
    expect(outer.position.x + wrapper.position.x + a.position.x).toBe(120)
    expect(outer.position.y + wrapper.position.y + a.position.y).toBe(110)
  })

  /**
   * The pure arithmetic above can be perfectly right while the canvas is wrong: a wrapper is
   * created at (minX - 28, minY - 62) RELATIVE to its new parent — routinely negative — and
   * carries `extent: 'parent'`. React Flow then clamps it into `[0, parentSize - wrapperSize]`,
   * which for a wrapper bigger than its parent is an inverted range: the frame snaps hundreds of
   * px away and drags the whole wrapped subtree with it. So assert the FRAME FITS, not just that
   * the offsets add up. Fails without the ancestor re-fit.
   */
  it('grows the parent frame so the new wrapper fits inside it', () => {
    const nodes = [
      grp('outer', { x: 100, y: 80 }),
      grp('a', { x: 20, y: 30 }, 'outer'),
      grp('b', { x: 500, y: 60 }, 'outer')
    ]
    const out = groupSelectedNodes(nodes, ['a', 'b'], 3)
    const outer = out.find((node) => node.id === 'outer')!
    const wrapper = out.find((node) => !nodes.some((old) => old.id === node.id))!
    expect(wrapper.position.x).toBeGreaterThanOrEqual(0)
    expect(wrapper.position.y).toBeGreaterThanOrEqual(0)
    expect(wrapper.position.x + (wrapper.width as number)).toBeLessThanOrEqual(
      outer.width as number
    )
    expect(wrapper.position.y + (wrapper.height as number)).toBeLessThanOrEqual(
      outer.height as number
    )
  })

  it('grows every ancestor frame, not just the immediate parent', () => {
    const nodes = [
      grp('root', { x: 0, y: 0 }),
      grp('outer', { x: 10, y: 10 }, 'root'),
      grp('a', { x: 20, y: 30 }, 'outer'),
      grp('b', { x: 500, y: 60 }, 'outer')
    ]
    const out = groupSelectedNodes(nodes, ['a', 'b'], 4)
    const root = out.find((node) => node.id === 'root')!
    const outer = out.find((node) => node.id === 'outer')!
    expect(outer.position.x).toBeGreaterThanOrEqual(0)
    expect(outer.position.x + (outer.width as number)).toBeLessThanOrEqual(root.width as number)
    expect(outer.position.y + (outer.height as number)).toBeLessThanOrEqual(root.height as number)
  })
})

describe('ungroupNodes', () => {
  it('removes the frame and restores children to absolute positions', () => {
    const nodes = [grp('g1', { x: 50, y: 50 }), term('t1', { x: 10, y: 10 }, 'g1')]
    const out = ungroupNodes(nodes, 'g1')
    expect(out.find((n) => n.id === 'g1')).toBeUndefined()
    const t1 = out.find((n) => n.id === 't1')!
    expect(t1.parentId).toBeUndefined()
    expect(t1.extent).toBeUndefined()
    expect(t1.position).toEqual({ x: 60, y: 60 })
  })

  it('round-trips with groupSelectedNodes', () => {
    const nodes = [term('t1', { x: 100, y: 100 }), term('t2', { x: 500, y: 300 })]
    const grouped = groupSelectedNodes(nodes, ['t1', 't2'], 0)
    const out = ungroupNodes(grouped, grouped[0].id)
    expect(out.find((n) => n.id === 't1')!.position).toEqual({ x: 100, y: 100 })
    expect(out.find((n) => n.id === 't2')!.position).toEqual({ x: 500, y: 300 })
  })

  it("promotes direct children into the removed group's parent without moving them", () => {
    const nodes = [
      grp('outer', { x: 100, y: 80 }),
      grp('inner', { x: 30, y: 40 }, 'outer'),
      term('leaf', { x: 10, y: 12 }, 'inner')
    ]
    const out = ungroupNodes(nodes, 'inner')
    const leaf = out.find((node) => node.id === 'leaf')!
    expect(leaf.parentId).toBe('outer')
    expect(leaf.position).toEqual({ x: 40, y: 52 })
  })

  it('is a no-op when the group is missing', () => {
    const nodes = [term('t1', { x: 0, y: 0 })]
    expect(ungroupNodes(nodes, 'nope')).toBe(nodes)
  })
})

describe('nested group persistence order', () => {
  it('hydrates every parent group before its descendants even from reversed persisted order', () => {
    const live = [
      grp('outer', { x: 100, y: 80 }),
      grp('inner', { x: 30, y: 40 }, 'outer'),
      term('leaf', { x: 10, y: 12 }, 'inner')
    ]
    const hydrated = nodeStatesToFlow(flowToNodeStates(live).reverse())
    expect(hydrated.findIndex((node) => node.id === 'outer')).toBeLessThan(
      hydrated.findIndex((node) => node.id === 'inner')
    )
    expect(hydrated.findIndex((node) => node.id === 'inner')).toBeLessThan(
      hydrated.findIndex((node) => node.id === 'leaf')
    )
  })

  it('hydrates groups with the label-only drag handle', () => {
    const [group] = nodeStatesToFlow(flowToNodeStates([grp('outer', { x: 0, y: 0 })]))
    expect(group.dragHandle).toBe('.group-node__label')
  })
})

describe('reorderGroupWithinParent', () => {
  it('moves a nested group subtree before a sibling without changing geometry or parenting', () => {
    const nodes = [
      grp('outer', { x: 0, y: 0 }),
      grp('a', { x: 10, y: 10 }, 'outer'),
      grp('a-child', { x: 5, y: 5 }, 'a'),
      grp('b', { x: 20, y: 20 }, 'outer'),
      term('inside-a', { x: 2, y: 3 }, 'a')
    ]
    const out = reorderGroupWithinParent(nodes, 'b', 'outer', 'a')
    expect(out.map((node) => node.id)).toEqual(['outer', 'b', 'a', 'a-child', 'inside-a'])
    expect(out.find((node) => node.id === 'b')).toMatchObject({
      parentId: 'outer',
      position: { x: 20, y: 20 }
    })
  })

  it('appends a whole group subtree after its last sibling', () => {
    const nodes = [
      grp('a', { x: 0, y: 0 }),
      grp('a-child', { x: 0, y: 0 }, 'a'),
      grp('b', { x: 0, y: 0 }),
      term('inside-a', { x: 0, y: 0 }, 'a')
    ]
    expect(reorderGroupWithinParent(nodes, 'a', null, null).map((node) => node.id)).toEqual([
      'b',
      'a',
      'a-child',
      'inside-a'
    ])
  })

  it('rejects cross-parent and invalid-target reorders', () => {
    const nodes = [
      grp('outer', { x: 0, y: 0 }),
      grp('a', { x: 0, y: 0 }, 'outer'),
      grp('b', { x: 0, y: 0 })
    ]
    expect(reorderGroupWithinParent(nodes, 'a', null, 'b')).toBe(nodes)
    expect(reorderGroupWithinParent(nodes, 'a', 'outer', 'missing')).toBe(nodes)
  })
})

describe('reorderNodeBefore', () => {
  const ids = (out: CanvasNode[]): string[] => out.filter((n) => n.type !== 'group').map((n) => n.id)

  it('reorders within the same container (moves dragged before target)', () => {
    const nodes = [term('a', { x: 0, y: 0 }), term('b', { x: 0, y: 0 }), term('c', { x: 0, y: 0 })]
    expect(ids(reorderNodeBefore(nodes, 'c', 'a'))).toEqual(['c', 'a', 'b'])
    expect(ids(reorderNodeBefore(nodes, 'a', 'c'))).toEqual(['b', 'a', 'c'])
  })

  it('keeps position unchanged for a same-container reorder', () => {
    const nodes = [term('a', { x: 5, y: 5 }), term('b', { x: 9, y: 9 })]
    const out = reorderNodeBefore(nodes, 'b', 'a')
    expect(out.find((n) => n.id === 'b')!.position).toEqual({ x: 9, y: 9 })
  })

  it('moves across containers (joins target group) and lands before the target', () => {
    const nodes = [
      grp('g1', { x: 50, y: 50 }),
      term('t1', { x: 10, y: 10 }, 'g1'),
      term('t2', { x: 200, y: 150 }) // ungrouped
    ]
    const out = reorderNodeBefore(nodes, 't2', 't1')
    const t2 = out.find((n) => n.id === 't2')!
    expect(t2.parentId).toBe('g1')
    expect(t2.position).toEqual({ x: 150, y: 100 }) // 200-50, 150-50
    expect(ids(out)).toEqual(['t2', 't1']) // t2 placed before t1
  })

  it('keeps group nodes first and is a no-op for same/ missing / group drags', () => {
    const nodes = [grp('g1', { x: 0, y: 0 }), term('a', { x: 0, y: 0 }), term('b', { x: 0, y: 0 })]
    expect(reorderNodeBefore(nodes, 'a', 'a')).toBe(nodes)
    expect(reorderNodeBefore(nodes, 'nope', 'a')).toBe(nodes)
    expect(reorderNodeBefore(nodes, 'g1', 'a')).toBe(nodes) // can't drag a group row
    const out = reorderNodeBefore(nodes, 'b', 'a')
    expect(out[0].id).toBe('g1')
  })
})

describe('group worktree serialization', () => {
  it('round-trips data.worktree on a group node', () => {
    const group = {
      id: 'group_1',
      type: 'group',
      position: { x: 0, y: 0 },
      width: 400,
      height: 300,
      data: {
        title: 'G',
        color: '#fff',
        group: null,
        worktree: {
          repoPath: '/repo',
          branch: 'feature/x',
          baseRef: 'main',
          path: '/wt/feature-x',
          createdByApp: true
        }
      }
    } as unknown as CanvasNode

    const states = flowToNodeStates([group])
    expect(states[0].worktree).toEqual(group.data.worktree)

    const back = nodeStatesToFlow(states)
    expect(back[0].data.worktree).toEqual(group.data.worktree)
  })

  it('leaves worktree undefined for unbound groups', () => {
    const group = {
      id: 'group_2', type: 'group', position: { x: 0, y: 0 }, width: 1, height: 1,
      data: { title: 'G', color: '#fff', group: null }
    } as unknown as CanvasNode
    expect(flowToNodeStates([group])[0].worktree).toBeUndefined()
  })
})

describe('resolveNewNodeAccount', () => {
  const accounts = [{ id: 'a1', label: 'work', createdAt: 0 }]
  it('prefers the explicit pick', () =>
    expect(resolveNewNodeAccount('a1', { defaultAccountId: 'a2' }, accounts)).toBe('a1'))
  it('falls back to the project default', () =>
    expect(resolveNewNodeAccount(undefined, { defaultAccountId: 'a1' }, accounts)).toBe('a1'))
  it('drops ids that no longer exist', () =>
    expect(resolveNewNodeAccount('gone', { defaultAccountId: 'gone' }, accounts)).toBeUndefined())
  it('undefined when nothing set', () =>
    expect(resolveNewNodeAccount(undefined, {}, accounts)).toBeUndefined())
  it('undefined when the project is undefined', () =>
    expect(resolveNewNodeAccount(undefined, undefined, accounts)).toBeUndefined())
  // #419 — the "picked X, ran as Y" legs.
  it('null = the EXPLICIT System pick — it must not resolve to the project default (#419)', () =>
    // Before null existed, the submenu's System row (labelled with the system email) passed
    // "no account", which this resolver read as "apply the project default".
    expect(resolveNewNodeAccount(null, { defaultAccountId: 'a1' }, accounts)).toBeUndefined())
  it('a PENDING default never stamps its id — its dir exists but holds no login (#419)', () =>
    expect(
      resolveNewNodeAccount(
        undefined,
        { defaultAccountId: 'p1' },
        [...accounts, { id: 'p1', label: 'new account', createdAt: 0, pending: true }]
      )
    ).toBeUndefined())
  it("a default pinned to another machine's host never lands on a LOCAL project (#419)", () =>
    // Its config dir exists only on that host, so locally the spawn would fall into the
    // missing-dir fallback — and pre-fix, from there into whatever the shared tmux server held.
    expect(
      resolveNewNodeAccount(
        undefined,
        { defaultAccountId: 'r1' },
        [{ id: 'r1', label: 'server', createdAt: 0, host: 'u@h' }]
      )
    ).toBeUndefined())
  it('an SSH project keeps its own host-matched account', () =>
    expect(
      resolveNewNodeAccount(
        'r1',
        { ssh: { server: { host: 'h', user: 'u' } } },
        [{ id: 'r1', label: 'server', createdAt: 0, host: 'u@h' }]
      )
    ).toBe('r1'))
})

describe('accountId on Claude node factories', () => {
  it('stamps accountId onto a Claude agent node', () => {
    const node = createAgentNode('claude', 0, undefined, undefined, undefined, undefined, 'a1')
    expect(node.data.accountId).toBe('a1')
  })
  it('stamps accountId onto a Codex agent node (S6 per-node account picker)', () => {
    const node = createAgentNode('codex', 0, undefined, undefined, undefined, undefined, 'a1')
    expect(node.data.accountId).toBe('a1')
  })
  it('does not stamp accountId onto a non-account agent node', () => {
    // Accounts bind to the Claude/Codex builtins only — another agent never carries one.
    const node = createAgentNode('gemini', 0, undefined, undefined, undefined, undefined, 'a1')
    expect(node.data.accountId).toBeUndefined()
  })
  it('omits accountId when none is given', () => {
    const node = createAgentNode('claude', 0)
    expect(node.data.accountId).toBeUndefined()
  })
})

describe('model on agent node factory', () => {
  it('stamps agentModel and threads --model into the launch command for a switch-capable agent', () => {
    const node = createAgentNode('claude', 0, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'claude-sonnet-5')
    expect(node.data.agentModel).toBe('claude-sonnet-5')
    expect(node.data.initialCommand).toContain('--model')
    expect(node.data.initialCommand).toContain('claude-sonnet-5')
  })
  it('omits agentModel and the --model flag when no model is given', () => {
    const node = createAgentNode('claude', 0)
    expect(node.data.agentModel).toBeUndefined()
    expect(node.data.initialCommand).not.toContain('--model')
  })
  it('drops the model (no --model) for a non-switch-capable agent', () => {
    // gemini is not in MODEL_SWITCH_CAPABLE — withAgentModel no-ops, and agentModel is still stamped
    // (it is harmless to persist; the point is the launch line carries no --model).
    const node = createAgentNode('gemini', 0, undefined, undefined, undefined, undefined, undefined, undefined, undefined, 'gemini-2.5')
    expect(node.data.agentModel).toBe('gemini-2.5')
    expect(node.data.initialCommand).not.toContain('--model')
  })
})

describe('canvas-control agent geometry', () => {
  it('keeps manual factories normal-sized while persisting the compact control override', () => {
    const manual = createAgentNode('claude', 0)
    expect({ width: manual.width, height: manual.height }).toEqual({ width: 640, height: 440 })

    const compact = canvasControlNodeGeometry()
    expect(compact).toEqual({ name: 'compact', size: { width: 440, height: 320 } })
    const controlled = createAgentNode(
      'claude',
      1,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      compact ?? undefined
    )
    expect({ width: controlled.width, height: controlled.height }).toEqual(compact?.size)
    expect(controlled.data.controlSize).toBe('compact')
    expect(flowToNodeStates([controlled])[0]).toMatchObject({
      size: compact?.size,
      controlSize: 'compact'
    })
  })

  it('drops stale measurements so a resize survives serialization', () => {
    const node = createAgentNode('claude', 0)
    node.measured = { width: 640, height: 440 }
    const resized = resizeTerminalNodeGeometry(node, {
      name: 'compact',
      size: { width: 440, height: 320 }
    })

    expect(resized.measured).toBeUndefined()
    expect({ width: resized.width, height: resized.height }).toEqual({ width: 440, height: 320 })
    expect(resized.style).toMatchObject({ width: 440, height: 320 })
    expect(flowToNodeStates([resized])[0]).toMatchObject({
      size: { width: 440, height: 320 },
      controlSize: 'compact'
    })
  })

  it('keeps a collapsed node at header height while changing its persisted expanded size', () => {
    const node = createAgentNode('claude', 0)
    node.data = { ...node.data, collapsed: true, expandedHeight: 440 }
    node.height = 40
    node.style = { ...node.style, height: 40 }
    const resized = resizeTerminalNodeGeometry(node, {
      name: 'compact',
      size: { width: 440, height: 320 }
    })

    expect(resized.height).toBe(40)
    expect(resized.data.expandedHeight).toBe(320)
    expect(flowToNodeStates([resized])[0].size).toEqual({ width: 440, height: 320 })
  })

  it('compacts only a new source-less legacy Server spawn and stamps the durable choice', () => {
    const legacyNode = flowToNodeStates([createAgentNode('claude', 0)])[0]
    const legacy = { op: 'upsert' as const, node: legacyNode, seq: 1 }
    const migrated = normalizeLegacyServerControlSpawnMutation(legacy, false)

    expect(migrated).toMatchObject({
      op: 'upsert',
      node: { size: { width: 440, height: 320 }, controlSize: 'compact' }
    })
    expect(normalizeLegacyServerControlSpawnMutation({ ...legacy, src: 'browser-a' }, false))
      .toEqual({ ...legacy, src: 'browser-a' })
    expect(normalizeLegacyServerControlSpawnMutation(legacy, true)).toBe(legacy)

    const plainTerminal = {
      ...legacy,
      node: { ...legacyNode, agentId: undefined }
    }
    expect(normalizeLegacyServerControlSpawnMutation(plainTerminal, false)).toBe(plainTerminal)

    const explicitNormal = {
      ...legacy,
      node: { ...legacyNode, controlSize: 'normal' as const }
    }
    expect(normalizeLegacyServerControlSpawnMutation(explicitNormal, false)).toBe(explicitNormal)
  })
})

describe('accountId serialization', () => {
  it('round-trips data.accountId on a terminal node', () => {
    const node = {
      id: 'term-1',
      type: 'terminal',
      position: { x: 0, y: 0 },
      width: 600,
      height: 400,
      data: {
        title: 'T',
        color: '#888',
        group: null,
        agentId: 'claude',
        agentModel: 'openai/gpt-5',
        accountId: 'a1'
      }
    } as unknown as CanvasNode
    const states = flowToNodeStates([node])
    expect(states[0].accountId).toBe('a1')
    expect(states[0].agentModel).toBe('openai/gpt-5')
    const back = nodeStatesToFlow(states)
    expect(back[0].data.accountId).toBe('a1')
    expect(back[0].data.agentModel).toBe('openai/gpt-5')
  })
  it('leaves accountId undefined when unset', () => {
    const node = {
      id: 'term-2', type: 'terminal', position: { x: 0, y: 0 }, width: 1, height: 1,
      data: { title: 'T', color: '#888', group: null }
    } as unknown as CanvasNode
    expect(flowToNodeStates([node])[0].accountId).toBeUndefined()
  })
})

describe('nodeSshFor', () => {
  const projectSsh = {
    server: { host: 'h', user: 'u' },
    remoteCwd: '/srv/app'
  } as unknown as NonNullable<Parameters<typeof nodeSshFor>[0]>

  it('is undefined for a local project, so nothing changes there', () => {
    expect(nodeSshFor(undefined)).toBeUndefined()
    expect(nodeSshFor(undefined, '/some/dir')).toBeUndefined()
  })

  it('threads the caller cwd through remoteCwd — the factories read a node cwd from there', () => {
    // Passing the project's ssh unchanged would silently replace an explicit --cwd with the
    // project root, which is the second half of this bug.
    expect(nodeSshFor(projectSsh, '/srv/app/sub')).toEqual({
      server: projectSsh.server,
      remoteCwd: '/srv/app/sub'
    })
  })

  it('falls back to the project root when no cwd is given', () => {
    expect(nodeSshFor(projectSsh)).toEqual({ server: projectSsh.server, remoteCwd: '/srv/app' })
    expect(nodeSshFor(projectSsh, '')).toEqual({ server: projectSsh.server, remoteCwd: '/srv/app' })
  })

  it('produces a node that actually runs on the host (remote tmux, remote cwd)', () => {
    const node = createAgentNode('claude', 0, undefined, undefined, undefined, nodeSshFor(projectSsh, '/srv/app/sub'))
    expect(node.data.sshRemoteTmux).toBe(true)
    expect(node.data.ssh).toEqual(projectSsh.server)
    expect(node.data.cwd).toBe('/srv/app/sub')
  })
})

describe('pendingLaunch round-trip', () => {
  // Unlike initialCommand (one-shot, deliberately NOT persisted), an armed node's held launch
  // must survive a reload — the station it waits on can take hours, and a restart in between
  // must not silently turn the node into an idle shell that never runs anything.
  it('persists the held launch and its dependencies', () => {
    const node = {
      id: 'term-3',
      type: 'terminal',
      position: { x: 0, y: 0 },
      width: 600,
      height: 400,
      data: {
        title: 'T',
        color: '#888',
        group: null,
        agentId: 'claude',
        pendingLaunch: { after: ['term-1', 'term-2'], command: 'claude "go"' }
      }
    } as unknown as CanvasNode
    const states = flowToNodeStates([node])
    expect(states[0].pendingLaunch).toEqual({ after: ['term-1', 'term-2'], command: 'claude "go"' })
    expect(nodeStatesToFlow(states)[0].data.pendingLaunch).toEqual({
      after: ['term-1', 'term-2'],
      command: 'claude "go"'
    })
  })

  it('stays undefined for an ordinary node', () => {
    const node = {
      id: 'term-4', type: 'terminal', position: { x: 0, y: 0 }, width: 1, height: 1,
      data: { title: 'T', color: '#888', group: null, initialCommand: 'claude' }
    } as unknown as CanvasNode
    const states = flowToNodeStates([node])
    expect(states[0].pendingLaunch).toBeUndefined()
    // initialCommand is still not persisted — arming is what makes a launch durable.
    expect((states[0] as { initialCommand?: string }).initialCommand).toBeUndefined()
  })
})

describe('createAccountLoginNode', () => {
  it('produces a terminal node that logs the given account in', () => {
    const node = createAccountLoginNode('acct-1', 0)
    expect(node.type).toBe('terminal')
    expect(node.data.title).toBe('Claude login')
    expect(node.data.accountId).toBe('acct-1')
    expect(node.data.initialCommand).toBe('claude /login')
  })
})

describe('createCodexAccountLoginNode', () => {
  it('produces a terminal node that logs the given Codex account in', () => {
    const node = createCodexAccountLoginNode('acct-2', 0)
    expect(node.type).toBe('terminal')
    expect(node.data.title).toBe('Codex login')
    expect(node.data.accountId).toBe('acct-2')
    expect(node.data.initialCommand).toBe('codex login')
  })

  it('carries NO agentId — the agent-less shape is what the Codex scope gate keys on', () => {
    // With an agentId of 'codex' this would be an agent node and take the agent paths; the login
    // terminal is scoped purely because its account id is a managed CODEX one (see #345/#346).
    expect(createCodexAccountLoginNode('acct-2', 0).data.agentId).toBeUndefined()
  })
})

describe('createSystemLoginNode (issue #420)', () => {
  it('produces a SYSTEM-scoped login terminal: no accountId, no agentId, its own title', () => {
    const node = createSystemLoginNode(0)
    expect(node.type).toBe('terminal')
    expect(node.data.title).toBe('Switch Claude account')
    // No accountId = the plain-terminal spawn env, so `claude /login` writes ~/.claude — the
    // whole point of the switch. Agent-less like the managed login nodes.
    expect(node.data.accountId).toBeUndefined()
    expect(node.data.agentId).toBeUndefined()
    expect(node.data.initialCommand).toBe('claude /login')
  })

  it('is never swept by account removal, and a serialized copy sheds the login signature', () => {
    const node = createSystemLoginNode(0)
    // Live (pre-first-open) data matches isAccountLoginNode via initialCommand — harmless,
    // because both destroy paths (Canvas + AccountsSection) additionally require accountId
    // equality with the removed account, and this node has none.
    expect(isAccountLoginNode(node.data)).toBe(true)
    expect(node.data.accountId).toBeUndefined()
    // The durable half: initialCommand never survives a serialize, and the title is NOT the
    // managed factory's 'Claude login' — so a persisted copy fails isAccountLoginNode outright.
    // That is also the anti-respawn guarantee: a restarted app rehydrates this node with no
    // command at all, so `claude /login` can only ever run the once the user clicked for.
    const persisted = flowToNodeStates([node])[0]
    expect((persisted as { initialCommand?: string }).initialCommand).toBeUndefined()
    const back = nodeStatesToFlow([persisted])[0]
    expect(isAccountLoginNode(back.data)).toBe(false)
  })
})

describe('dino node serialization', () => {
  it('round-trips a dino node and its highScore', () => {
    const dino = {
      id: 'dino-1',
      type: 'dino',
      position: { x: 10, y: 20 },
      width: 600,
      height: 200,
      data: { title: 'Dino', color: '#a2a2a2', group: null, highScore: 1337 }
    } as unknown as CanvasNode

    const states = flowToNodeStates([dino])
    expect(states[0].kind).toBe('dino')
    expect(states[0].highScore).toBe(1337)

    const back = nodeStatesToFlow(states)
    expect(back[0].type).toBe('dino')
    expect(back[0].data.highScore).toBe(1337)
  })

  it('createDinoNode produces a dino node with highScore 0', () => {
    const node = createDinoNode(0)
    expect(node.type).toBe('dino')
    expect(node.data.highScore).toBe(0)
    expect(node.width).toBe(600)
  })
})

describe('chat node tombstone', () => {
  it('converts a persisted chat node into a sticky with the resume hint', () => {
    const flow = nodeStatesToFlow([
      {
        id: 'chat-1', kind: 'chat', x: 10, y: 20, width: 420, height: 520,
        title: 'API brainstorm', color: '#8b5cf6', chatSessionId: 'sess-abc123'
      } as any
    ])
    expect(flow).toHaveLength(1)
    const n = flow[0]
    expect(n.type).toBe('sticky')
    expect(n.position).toEqual({ x: 10, y: 20 })
    expect(n.data.title).toBe('API brainstorm')
    expect(String(n.data.text)).toContain('claude --resume sess-abc123')
  })
  it('converts a chat node without a session id into a plain explanatory sticky', () => {
    const flow = nodeStatesToFlow([{ id: 'chat-2', kind: 'chat', x: 0, y: 0 } as any])
    expect(flow[0].type).toBe('sticky')
    expect(String(flow[0].data.text)).toContain('removed')
    expect(String(flow[0].data.text)).not.toContain('--resume')
  })
})

describe('createAgentNode permission mode', () => {
  it('appends the flag for claude', () => {
    const node = createAgentNode('claude', 0, undefined, undefined, undefined, undefined, undefined, 'auto')
    expect(node.data.initialCommand).toBe('claude --permission-mode auto')
  })

  it('stays bare in manual mode (legacy parity)', () => {
    const node = createAgentNode('claude', 0, undefined, undefined, undefined, undefined, undefined, 'manual')
    expect(node.data.initialCommand).toBe('claude')
  })

  it('stays bare when no mode is passed at all (legacy parity)', () => {
    const node = createAgentNode('claude', 0)
    expect(node.data.initialCommand).toBe('claude')
  })

  it('keeps the flag after the initial prompt so the prompt stays claude argv', () => {
    const node = createAgentNode('claude', 0, undefined, undefined, 'fix the bug', undefined, undefined, 'auto')
    expect(node.data.initialCommand).toBe("claude 'fix the bug' --permission-mode auto")
  })

  // opencode has no approval flag at all, and a custom agent is in no capability list. codex and
  // gemini DO have one, each spelled its own way — those composed commands are pinned in
  // workspace.agent-prompt.test.ts, next to grok's separator rule.
  it('never flags a non-capable agent', () => {
    const node = createAgentNode('opencode', 0, undefined, undefined, undefined, undefined, undefined, 'auto')
    expect(node.data.initialCommand).toBe('opencode')
    const custom = createAgentNode('custom:x', 0, undefined, undefined, undefined, undefined, undefined, 'auto')
    expect(custom.data.initialCommand).toBe('custom:x')
  })
})

describe('createAgentNode prompt injection', () => {
  it('uses --prompt for flag-prompt agents (opencode)', () => {
    const n = createAgentNode('opencode', 0, undefined, undefined, "rerank the results")
    expect(n.data.initialCommand).toBe("opencode --prompt 'rerank the results'")
  })
  it('uses --interactive for Copilot so the prompted session stays open', () => {
    const n = createAgentNode('copilot', 0, undefined, undefined, 'fix the bug')
    expect(n.data.initialCommand).toContain("copilot --interactive 'fix the bug'")
    expect(n.data.initialCommand).toContain('--session-id=')
    expect(n.data.initialCommand).not.toContain('--prompt')
  })
  it('shell-quotes a flag-prompt safely', () => {
    const n = createAgentNode('opencode', 0, undefined, undefined, "it's tricky")
    expect(n.data.initialCommand).toBe("opencode --prompt 'it'\\''s tricky'")
  })
  it('keeps argv injection byte-identical for codex and gemini', () => {
    expect(createAgentNode('codex', 0, undefined, undefined, 'do X').data.initialCommand).toBe("codex 'do X'")
    expect(createAgentNode('gemini', 0, undefined, undefined, 'do X').data.initialCommand).toBe("gemini 'do X'")
  })
})

// ---------------------------------------------------------------------------
// PR-A A3 — "Put away / Expand", the one action.
//
// The toggle is a canvas-state transform and nothing else. Two properties carry the feature:
// the round-trip gives back the EXACT rect (size and position, remembered rather than
// recomputed), and it never reaches the transport — putting a worker away is filing it, not
// ending it, so the tmux session and its PTY are untouched by construction.
// ---------------------------------------------------------------------------

/** The configured "normal" size, passed explicitly so these never depend on the settings store. */
const NORMAL = { width: 640, height: 440 }
/** What a control-spawned worker arrives at (COMPACT_CONTROL_NODE_SIZE). */
const COMPACT = { width: 440, height: 320 }

const compactTerm = (
  id: string,
  pos: { x: number; y: number },
  parentId?: string,
  data: Partial<CanvasNode['data']> = {}
): CanvasNode =>
  ({
    id,
    type: 'terminal',
    position: pos,
    width: COMPACT.width,
    height: COMPACT.height,
    data: { title: id, color: '#888', group: null, role: 'worker', controlSize: 'compact', ...data },
    ...(parentId ? { parentId, extent: 'parent' as const } : {})
  }) as unknown as CanvasNode

describe('compactToggleState', () => {
  it('offers EXPAND for a card smaller than the configured normal size', () => {
    expect(compactToggleState(compactTerm('t1', { x: 0, y: 0 }), NORMAL)).toBe('expand')
  })

  it('offers PUT AWAY for a card that remembers a compact rect', () => {
    const node = compactTerm('t1', { x: 0, y: 0 }, undefined, {
      compactRect: { x: 0, y: 0, ...COMPACT }
    })
    expect(compactToggleState({ ...node, width: 640, height: 440 } as CanvasNode, NORMAL)).toBe(
      'put-away'
    )
  })

  it('offers nothing for a card already at the normal size — the toggle is never a no-op', () => {
    const normal = { ...compactTerm('t1', { x: 0, y: 0 }), width: 640, height: 440 } as CanvasNode
    expect(compactToggleState(normal, NORMAL)).toBeNull()
  })

  it('stands down for a collapsed card, a maximized one, a frame and a missing node', () => {
    const base = compactTerm('t1', { x: 0, y: 0 })
    expect(
      compactToggleState({ ...base, data: { ...base.data, collapsed: true } } as CanvasNode, NORMAL)
    ).toBeNull()
    expect(
      compactToggleState(
        {
          ...base,
          data: { ...base.data, premaxRect: { x: 0, y: 0, width: 10, height: 10 } }
        } as CanvasNode,
        NORMAL
      )
    ).toBeNull()
    expect(compactToggleState(grp('g1', { x: 0, y: 0 }), NORMAL)).toBeNull()
    expect(compactToggleState(undefined, NORMAL)).toBeNull()
  })
})

describe('toggleCompactNode', () => {
  it('round-trips size AND position exactly — the rect is remembered, not recomputed', () => {
    const nodes = [compactTerm('t1', { x: 120, y: 80 })]
    const expanded = toggleCompactNode(nodes, 't1', NORMAL)
    const grown = expanded.find((n) => n.id === 't1')!
    expect(grown.width).toBe(NORMAL.width)
    expect(grown.height).toBe(NORMAL.height)
    expect(grown.data.compactRect).toEqual({ x: 120, y: 80, ...COMPACT })
    expect(grown.data.controlSize).toBe('normal')

    const restored = toggleCompactNode(expanded, 't1', NORMAL).find((n) => n.id === 't1')!
    expect(restored.position).toEqual({ x: 120, y: 80 })
    expect(restored.width).toBe(COMPACT.width)
    expect(restored.height).toBe(COMPACT.height)
    expect(restored.data.compactRect).toBeUndefined()
    expect(restored.data.controlSize).toBe('compact')
  })

  it('round-trips a card inside a frame to its own slot, not to the frame origin', () => {
    // The remembered rect is ROOT-space, so a frame that grows around the expanded card (and
    // therefore moves its own origin) must not shift the card on the way back.
    const nodes = [grp('g1', { x: 400, y: 300 }), compactTerm('t1', { x: 40, y: 60 }, 'g1')]
    const expanded = toggleCompactNode(nodes, 't1', NORMAL)
    expect(expanded.find((n) => n.id === 't1')!.data.compactRect).toEqual({
      x: 440,
      y: 360,
      ...COMPACT
    })

    const after = toggleCompactNode(expanded, 't1', NORMAL)
    const restored = after.find((n) => n.id === 't1')!
    const frame = after.find((n) => n.id === 'g1')!
    expect(restored.parentId).toBe('g1')
    // Root-space position is what was promised back; the frame may sit anywhere by now.
    expect({
      x: restored.position.x + frame.position.x,
      y: restored.position.y + frame.position.y
    }).toEqual({ x: 440, y: 360 })
    expect(restored.width).toBe(COMPACT.width)
    expect(restored.height).toBe(COMPACT.height)
  })

  it('is a no-op when the toggle has nothing to offer', () => {
    const nodes = [{ ...compactTerm('t1', { x: 0, y: 0 }), width: 640, height: 440 } as CanvasNode]
    expect(toggleCompactNode(nodes, 't1', NORMAL)).toBe(nodes)
    expect(toggleCompactNode(nodes, 'nope', NORMAL)).toBe(nodes)
  })

  it('touches NOTHING that could reach the PTY — no transport call, no respawn', () => {
    // "Put away" is filing, not closing. The transform is pure over the nodes array: it must not
    // read window.nodeTerminal (the only route to the transport from the renderer) and must not
    // bump respawnNonce or re-arm initialCommand, either of which restarts the session.
    const touched: string[] = []
    const prior = Object.getOwnPropertyDescriptor(globalThis, 'window')
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      get() {
        touched.push('window')
        throw new Error('the compact toggle must not reach the transport')
      }
    })
    try {
      const nodes = [
        compactTerm('t1', { x: 10, y: 20 }, undefined, {
          respawnNonce: 7,
          initialCommand: 'claude'
        } as Partial<CanvasNode['data']>)
      ]
      const expanded = toggleCompactNode(nodes, 't1', NORMAL)
      const back = toggleCompactNode(expanded, 't1', NORMAL).find((n) => n.id === 't1')!
      expect(touched).toEqual([])
      expect(back.data.respawnNonce).toBe(7)
      expect(back.data.initialCommand).toBe('claude')
      expect(back.id).toBe('t1')
      expect(back.type).toBe('terminal')
    } finally {
      if (prior) Object.defineProperty(globalThis, 'window', prior)
      else delete (globalThis as Record<string, unknown>).window
    }
  })
})

// ---------------------------------------------------------------------------
// PR-A A5 — pin and manual placement.
//
// The durable memory of "I put it there". Nothing in this release reads it (the layout engine is
// PR-C); what matters here is that a HAND gesture writes it and a programmatic placement never
// does — the distinction is the whole value of the flag.
// ---------------------------------------------------------------------------

describe('markManualPlacement', () => {
  it('flags a hand-moved node, and only that node', () => {
    const nodes = [term('t1', { x: 0, y: 0 }), term('t2', { x: 100, y: 0 })]
    const out = markManualPlacement(nodes, ['t1'])
    expect(out.find((n) => n.id === 't1')!.data.manualPlacement).toBe(true)
    expect(out.find((n) => n.id === 't2')!.data.manualPlacement).toBeUndefined()
  })

  it('returns the SAME array when nothing changes — an already-flagged node re-renders nothing', () => {
    const nodes = [term('t1', { x: 0, y: 0 })]
    const once = markManualPlacement(nodes, ['t1'])
    expect(markManualPlacement(once, ['t1'])).toBe(once)
    expect(markManualPlacement(nodes, [])).toBe(nodes)
    expect(markManualPlacement(nodes, ['ghost'])).toBe(nodes)
  })

  it('is never set by PROGRAMMATIC placement — that is the distinction it exists to make', () => {
    const nodes = [term('t1', { x: 0, y: 0 }), term('t2', { x: 900, y: 700 })]
    for (const n of arrangeNodes(nodes, ['t1', 't2'])) {
      expect(n.data.manualPlacement).toBeUndefined()
    }
    const tidied = applyWorkerFramePlan(
      nodes.map((n) => ({ ...n, data: { ...n.data, role: 'worker' as const } })),
      { kind: 'create', memberIds: ['t1', 't2'] },
      'owner workers'
    )
    for (const n of tidied) expect(n.data.manualPlacement).toBeUndefined()
  })
})

describe('setNodesPinned', () => {
  it('pins and unpins, and an unpinned node carries no key at all', () => {
    const nodes = [term('t1', { x: 0, y: 0 }), term('t2', { x: 10, y: 0 })]
    const pinned = setNodesPinned(nodes, ['t1'], true)
    expect(pinned.find((n) => n.id === 't1')!.data.pinned).toBe(true)
    expect(pinned.find((n) => n.id === 't2')!.data.pinned).toBeUndefined()
    // Cleared to undefined rather than false: the shared project file should not grow a key for
    // every node the operator ever unpinned.
    const cleared = setNodesPinned(pinned, ['t1'], false)
    expect(cleared.find((n) => n.id === 't1')!.data.pinned).toBeUndefined()
    expect(setNodesPinned(cleared, ['t1'], false)).toBe(cleared)
    expect(setNodesPinned(nodes, [], true)).toBe(nodes)
  })
})

// ---------------------------------------------------------------------------
// PR-A A2 — the renderer half of the tray. The DECISION is shared
// (@shared/worker-frame, unit-tested there); this is the geometry application, which goes
// through the same transforms a hand-made frame does.
// ---------------------------------------------------------------------------

describe('applyWorkerFramePlan', () => {
  it('wraps the members in a new frame, labelled and marked as a tray', () => {
    const nodes = [
      term('t1', { x: 0, y: 0 }),
      term('t2', { x: 400, y: 0 })
    ].map((n) => ({ ...n, data: { ...n.data, role: 'worker' as const } })) as CanvasNode[]
    const out = applyWorkerFramePlan(nodes, { kind: 'create', memberIds: ['t1', 't2'] }, 'lane workers')
    const frame = out.find((n) => n.type === 'group')!
    expect(frame.data.title).toBe('lane workers')
    expect(frame.data.taskFrame).toBe(true)
    // …and it ships collapsed, the same as the Server path.
    expect(frame.data.collapsed).toBe(true)
    expect(out.find((n) => n.id === 't1')!.parentId).toBe(frame.id)
    expect(out.find((n) => n.id === 't2')!.parentId).toBe(frame.id)
  })

  it('joins an existing frame without disturbing what is already in it', () => {
    const nodes = [
      grp('g1', { x: 50, y: 50 }),
      term('t1', { x: 20, y: 20 }, 'g1'),
      term('t2', { x: 500, y: 400 })
    ]
    const out = applyWorkerFramePlan(nodes, { kind: 'join', groupId: 'g1', memberIds: ['t2'] }, 'x')
    expect(out.find((n) => n.id === 't2')!.parentId).toBe('g1')
    // The existing member keeps its exact slot.
    expect(out.find((n) => n.id === 't1')!.position).toEqual({ x: 20, y: 20 })
  })

  it('returns the canvas untouched for a plan with nothing to do, and for a refused wrap', () => {
    const nodes = [term('t1', { x: 0, y: 0 })]
    expect(applyWorkerFramePlan(nodes, { kind: 'none', reason: 'single-worker' }, 'x')).toBe(nodes)
    // groupSelectedNodes refuses a set that does not share one container; a refusal must leave
    // the canvas alone rather than half-forming a tray.
    const mixed = [grp('g1', { x: 0, y: 0 }), term('t1', { x: 5, y: 5 }, 'g1'), term('t2', { x: 900, y: 0 })]
    expect(applyWorkerFramePlan(mixed, { kind: 'create', memberIds: ['t1', 't2'] }, 'x')).toBe(mixed)
  })
})

describe('workerFrameNodeOf', () => {
  it('reports exactly the facts the shared planner reads', () => {
    const node = compactTerm('t1', { x: 0, y: 0 }, 'g1', {
      pinned: true,
      manualPlacement: true,
      taskFrame: true
    })
    expect(workerFrameNodeOf(node)).toEqual({
      id: 't1',
      kind: 'terminal',
      parentId: 'g1',
      role: 'worker',
      pinned: true,
      manualPlacement: true,
      taskFrame: true
    })
  })
})

// ---------------------------------------------------------------------------
// PR-A persistence. The new fields are a statement about THIS CANVAS, so they ride the shared
// project file (plan D6). Backward compatibility is the load-bearing half: a canvas saved before
// any of this existed must come back byte-identically, with no role, which reads as `primary`.
// ---------------------------------------------------------------------------

describe('PR-A node fields survive a save/load round trip', () => {
  it('carries role, taskSummary, taskFrame, compactRect, pinned and manualPlacement', () => {
    const nodes = [
      compactTerm('t1', { x: 10, y: 20 }, undefined, {
        taskSummary: 'Opened by lane — do the thing',
        compactRect: { x: 10, y: 20, ...COMPACT },
        pinned: true,
        manualPlacement: true
      }),
      { ...grp('g1', { x: 0, y: 0 }), data: { ...grp('g1', { x: 0, y: 0 }).data, taskFrame: true } } as CanvasNode
    ]
    const back = nodeStatesToFlow(flowToNodeStates(nodes))
    const t1 = back.find((n) => n.id === 't1')!
    expect(t1.data.role).toBe('worker')
    expect(t1.data.taskSummary).toBe('Opened by lane — do the thing')
    expect(t1.data.compactRect).toEqual({ x: 10, y: 20, ...COMPACT })
    expect(t1.data.pinned).toBe(true)
    expect(t1.data.manualPlacement).toBe(true)
    expect(back.find((n) => n.id === 'g1')!.data.taskFrame).toBe(true)
  })

  it('leaves a pre-feature canvas alone — absent role reads as the operator’s own node', () => {
    const back = nodeStatesToFlow(flowToNodeStates([term('t1', { x: 0, y: 0 })]))
    const t1 = back.find((n) => n.id === 't1')!
    expect(t1.data.role).toBeUndefined()
    expect(t1.data.pinned).toBeUndefined()
    expect(t1.data.manualPlacement).toBeUndefined()
    expect(t1.data.compactRect).toBeUndefined()
    expect(t1.data.taskSummary).toBeUndefined()
  })
})
