// A GROUP FRAME IS A CONTAINER, AND A CONTAINER HAS NO COLLAPSIBLE BODY.
//
// Every parented node is emitted with `extent: 'parent'`, so React Flow clamps each child into
// the parent's rect (`clampPositionToParent`: `y = clamp(y, 0, parentHeight - childHeight)`).
// A frame shrunk to `COLLAPSED_HEIGHT` (40) therefore hands every 440px-tall member the range
// `[0, -400]` — INVERTED, so `Math.min` wins unconditionally and every member is pinned to the
// same constant `-400`, stacked on one horizontal line and overlapping each other.
//
// This test drives the REAL `@xyflow/system` `adoptUserNodes` over a REAL captured canvas rather
// than re-implementing the clamp, because the clamp is the part that was never in our code: a
// hand-rolled version would have agreed with whatever we believed about it.

import { describe, it, expect } from 'vitest'
import { adoptUserNodes } from '@xyflow/system'
import {
  COLLAPSED_HEIGHT,
  applyWorkerFramePlan,
  flowToNodeStates,
  nodeStatesToFlow,
  type CanvasNode
} from './workspace'
import { COLLAPSED_TRAY_CANVAS, COLLAPSED_TRAY_ID } from './__fixtures__/collapsed-tray-canvas'

interface Rendered {
  id: string
  title: string
  x: number
  y: number
  width: number
  height: number
  parentId?: string
}

/**
 * What React Flow actually puts on screen for these nodes. `adoptUserNodes` is run twice on
 * purpose: the first pass builds the internals a node needs, the second runs with `measured` set,
 * which is the state the browser reaches once the DOM has been measured — and the state in which
 * the parent clamp uses the child's real height.
 */
function render(nodes: CanvasNode[]): Rendered[] {
  const nodeLookup = new Map()
  const parentLookup = new Map()
  adoptUserNodes(nodes as never[], nodeLookup, parentLookup, { elevateNodesOnSelect: false })
  for (const node of nodes) {
    node.measured = {
      width: (node.width ?? (node.style?.width as number)) || 0,
      height: (node.height ?? (node.style?.height as number)) || 0
    }
  }
  nodeLookup.clear()
  parentLookup.clear()
  adoptUserNodes(nodes as never[], nodeLookup, parentLookup, { elevateNodesOnSelect: false })
  const out: Rendered[] = []
  for (const node of nodeLookup.values()) {
    const internal = node as {
      id: string
      data: { title: string }
      parentId?: string
      measured: { width: number; height: number }
      internals: { positionAbsolute: { x: number; y: number } }
    }
    out.push({
      id: internal.id,
      title: internal.data.title,
      x: internal.internals.positionAbsolute.x,
      y: internal.internals.positionAbsolute.y,
      width: internal.measured.width,
      height: internal.measured.height,
      parentId: internal.parentId
    })
  }
  return out
}

function overlappingPairs(cards: Rendered[]): string[] {
  const pairs: string[] = []
  for (let i = 0; i < cards.length; i++) {
    for (let j = i + 1; j < cards.length; j++) {
      const a = cards[i]
      const b = cards[j]
      const ox = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
      const oy = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
      if (ox > 0 && oy > 0) pairs.push(`${a.title} <-> ${b.title} (${Math.round(ox)}x${Math.round(oy)})`)
    }
  }
  return pairs
}

describe('a persisted `collapsed` group frame', () => {
  const rendered = () => {
    const flow = render(nodeStatesToFlow(COLLAPSED_TRAY_CANVAS))
    const frame = flow.find((n) => n.id === COLLAPSED_TRAY_ID)!
    return { frame, members: flow.filter((n) => n.parentId === COLLAPSED_TRAY_ID) }
  }

  it('renders at its full persisted height, so the child clamp is not inverted', () => {
    const { frame, members } = rendered()
    expect(members.length).toBe(8)
    const saved = COLLAPSED_TRAY_CANVAS.find((n) => n.id === COLLAPSED_TRAY_ID)!
    expect(saved.collapsed).toBe(true) // the fixture really is the broken state
    expect(frame.height).toBe(saved.size.height)
    expect(frame.height).not.toBe(COLLAPSED_HEIGHT)
  })

  it('leaves its members non-overlapping', () => {
    const { members } = rendered()
    expect(overlappingPairs(members)).toEqual([])
  })

  it('pins no member to the collapsed bar', () => {
    // `COLLAPSED_HEIGHT - height` is the signature of the inverted clamp: the one y every member
    // lands on when `Math.min(top, top + 40 - h)` decides. Two of the fixture's members carry
    // exactly that value in their SAVED position (the damage was autosaved back), so this also
    // proves the full-height frame clamps them into itself instead of leaving them there.
    const { frame, members } = rendered()
    for (const member of members) {
      expect(
        { title: member.title, relY: member.y - frame.y },
        `${member.title} is pinned to the collapsed bar`
      ).not.toEqual({ title: member.title, relY: COLLAPSED_HEIGHT - member.height })
    }
  })

  it('loads inert and is dropped on the next save, repairing the file with no migration', () => {
    const flow = nodeStatesToFlow(COLLAPSED_TRAY_CANVAS)
    const frame = flow.find((n) => n.id === COLLAPSED_TRAY_ID)!
    expect(frame.data.collapsed).toBeFalsy()

    const saved = flowToNodeStates(flow).find((n) => n.id === COLLAPSED_TRAY_ID)!
    expect(saved.collapsed).toBeUndefined()
    // No position rewrite and no height rewrite: the repair is the flag going away.
    const before = COLLAPSED_TRAY_CANVAS.find((n) => n.id === COLLAPSED_TRAY_ID)!
    expect(saved.size).toEqual(before.size)
    expect(saved.position).toEqual(before.position)
  })

  it('still collapses the cards inside it', () => {
    // The fix is about frames, not about collapse. A member that IS persisted collapsed still is.
    const states = COLLAPSED_TRAY_CANVAS.map((n) =>
      n.kind === 'terminal' && n.parentId === COLLAPSED_TRAY_ID ? { ...n, collapsed: true } : n
    )
    const card = nodeStatesToFlow(states).find((n) => n.parentId === COLLAPSED_TRAY_ID)!
    expect(card.data.collapsed).toBe(true)
    expect(card.height).toBe(COLLAPSED_HEIGHT)
    expect(flowToNodeStates([card])[0].collapsed).toBe(true)
  })
})

describe('applyWorkerFramePlan', () => {
  const node = (id: string, x: number): CanvasNode =>
    ({
      id,
      type: 'terminal',
      position: { x, y: 0 },
      width: 440,
      height: 320,
      data: { title: id, color: '#fff', group: null, role: 'worker' }
    }) as CanvasNode

  it('creates the spawn tray EXPANDED', () => {
    // It used to ship `collapsed: true` ("a tray that opens expanded has put nothing away") — but
    // a collapsed frame puts nothing away either. It shrinks the container its members are
    // clamped into and stacks them on one line. Creating a real "put members away" affordance is
    // an unbuilt follow-up; until it exists the tray is a label around a group of cards.
    const out = applyWorkerFramePlan([node('a', 0), node('b', 600)], {
      kind: 'create',
      memberIds: ['a', 'b']
    } as never, 'Alpha · workers')
    const frame = out.find((n) => n.type === 'group')!
    expect(frame.data.taskFrame).toBe(true)
    expect(frame.data.title).toBe('Alpha · workers')
    expect(frame.data.collapsed).toBeFalsy()
    expect(frame.height).not.toBe(COLLAPSED_HEIGHT)
  })
})
