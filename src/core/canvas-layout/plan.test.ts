// THE REFUSAL TABLE IS THE FEATURE, so it is the bulk of this file: one test per refusal, each
// proving the node is left alone AND that the reason is reported. A silent skip and a refusal look
// identical from outside — an empty `ops` array either way — so an assertion that only checked
// `ops` would pass for a version of this engine that dropped nodes on the floor.
import { describe, it, expect } from 'vitest'
import { plan } from './plan'
import { resolveLayoutRules } from '../../shared/canvas-layout-rules'
import { LAYOUT_SKIP_LABELS, LAYOUT_SKIP_REASONS } from '../../shared/canvas-layout'
import type { LayoutInput, LayoutNode } from './types'

const SIZES = {
  compact: { width: 440, height: 320 },
  normal: { width: 640, height: 440 }
}

function node(id: string, over: Partial<LayoutNode> = {}): LayoutNode {
  return {
    id,
    kind: 'terminal',
    role: 'worker',
    position: { x: 0, y: 0 },
    size: { width: 640, height: 440 },
    ...over
  }
}

function frame(id: string, over: Partial<LayoutNode> = {}): LayoutNode {
  return {
    id,
    kind: 'group',
    title: 'Tray',
    taskFrame: true,
    position: { x: 0, y: 0 },
    size: { width: 900, height: 700 },
    ...over
  }
}

function input(over: Partial<LayoutInput> = {}): LayoutInput {
  return {
    trigger: 'node-created',
    nodes: [],
    rules: resolveLayoutRules(),
    sizes: SIZES,
    now: 1_000,
    ...over
  }
}

/** The canvas every refusal test varies one field of: a spawner already inside a tray, so the
 *  engine has somewhere to file the new worker and therefore something to refuse. */
function canvasWithTray(worker: LayoutNode): LayoutNode[] {
  return [
    frame('tray'),
    node('spawner', { parentId: 'tray', role: 'worker' }),
    worker
  ]
}

const TRAY_ROPES = [{ source: 'spawner', target: 'w1' }]

describe('plan() — the refusals', () => {
  it.each([
    [{ manualPlacement: true }, 'manual-placement'],
    [{}, 'active'],
    [{ role: 'primary' }, 'primary-role']
    // The refusal table applies to a FRAME exactly as it does to a card. Asked through `organize`
    // (where a tray is a subject — it gets packed and labelled) rather than through the
    // node-created collapse this used to ride: the engine no longer proposes a frame collapse at
    // all, so there is nothing left for a refusal to decline on that trigger.
  ] as const)('refuses a protected tray as a subject: %s', (change, reason) => {
    const result = plan(input({
      trigger: 'organize',
      nodes: [frame('tray', change), node('spawner', { parentId: 'tray' }), node('w1', { parentId: 'tray' })],
      ropes: TRAY_ROPES, actives: reason === 'active' ? ['tray'] : []
    }))
    expect(result.ops.some((op) => op.nodeId === 'tray')).toBe(false)
    expect(result.skipped).toContainEqual({ nodeId: 'tray', reason })
  })
  it('places a plain new worker (the control case every refusal below is measured against)', () => {
    const result = plan(
      input({ nodes: canvasWithTray(node('w1')), ropes: TRAY_ROPES, createdIds: ['w1'] })
    )
    expect(result.skipped).toEqual([])
    expect(result.ops).toContainEqual({ op: 'reparent', nodeId: 'w1', parentId: 'tray' })
    expect(result.ops).toContainEqual({
      op: 'resize',
      nodeId: 'w1',
      size: SIZES.compact,
      controlSize: 'compact'
    })
  })

  it('refuses a PINNED node, and says so', () => {
    const result = plan(
      input({
        nodes: canvasWithTray(node('w1', { pinned: true })),
        ropes: TRAY_ROPES,
        createdIds: ['w1']
      })
    )
    expect(result.ops).toEqual([])
    expect(result.skipped).toEqual([{ nodeId: 'w1', reason: 'pinned' }])
  })

  it('refuses a node the operator PLACED BY HAND, and says so', () => {
    const result = plan(
      input({
        nodes: canvasWithTray(node('w1', { manualPlacement: true })),
        ropes: TRAY_ROPES,
        createdIds: ['w1']
      })
    )
    expect(result.ops).toEqual([])
    expect(result.skipped).toEqual([{ nodeId: 'w1', reason: 'manual-placement' }])
  })

  it('refuses a member of a LOOP-OWNED frame, and says so', () => {
    const result = plan(
      input({
        nodes: [frame('loop', { taskFrame: false }), frame('tray'), node('spawner', { parentId: 'tray' }), node('w1', { parentId: 'loop' })],
        ropes: TRAY_ROPES,
        loopFrames: ['loop'],
        createdIds: ['w1']
      })
    )
    expect(result.ops).toEqual([])
    expect(result.skipped).toEqual([{ nodeId: 'w1', reason: 'loop-owned' }])
  })

  it('refuses a loop-owned frame’s member NESTED one level deeper — ownership is the whole chain', () => {
    const result = plan(
      input({
        nodes: [
          frame('loop', { taskFrame: false }),
          frame('inner', { parentId: 'loop', taskFrame: false }),
          frame('tray'),
          node('spawner', { parentId: 'tray' }),
          node('w1', { parentId: 'inner' })
        ],
        ropes: TRAY_ROPES,
        loopFrames: ['loop'],
        createdIds: ['w1']
      })
    )
    expect(result.skipped).toEqual([{ nodeId: 'w1', reason: 'loop-owned' }])
  })

  it('refuses the node the operator is ACTIVELY USING, and says so', () => {
    const result = plan(
      input({
        nodes: canvasWithTray(node('w1')),
        ropes: TRAY_ROPES,
        actives: ['w1'],
        createdIds: ['w1']
      })
    )
    expect(result.ops).toEqual([])
    expect(result.skipped).toEqual([{ nodeId: 'w1', reason: 'active' }])
  })

  it('refuses a node ANOTHER AUTHORITY created, and says so', () => {
    const result = plan(
      input({
        nodes: canvasWithTray(node('w1')),
        ropes: TRAY_ROPES,
        owns: (id) => id !== 'w1',
        createdIds: ['w1']
      })
    )
    expect(result.ops).toEqual([])
    expect(result.skipped).toEqual([{ nodeId: 'w1', reason: 'foreign-authority' }])
  })

  it('refuses a PRIMARY node — the operator’s own workspace is never arranged', () => {
    const result = plan(
      input({
        nodes: canvasWithTray(node('w1', { role: 'primary' })),
        ropes: TRAY_ROPES,
        createdIds: ['w1']
      })
    )
    expect(result.ops).toEqual([])
    expect(result.skipped).toEqual([{ nodeId: 'w1', reason: 'primary-role' }])
  })

  it('treats an ABSENT role as primary — a canvas saved before the field existed is untouched', () => {
    const worker = node('w1')
    delete (worker as { role?: unknown }).role
    const result = plan(
      input({ nodes: canvasWithTray(worker), ropes: TRAY_ROPES, createdIds: ['w1'] })
    )
    expect(result.ops).toEqual([])
    expect(result.skipped).toEqual([{ nodeId: 'w1', reason: 'primary-role' }])
  })

  it('reports the FIRST reason when several apply — the one the operator can act on', () => {
    const result = plan(
      input({
        nodes: canvasWithTray(node('w1', { pinned: true, manualPlacement: true, role: 'primary' })),
        ropes: TRAY_ROPES,
        actives: ['w1'],
        owns: () => false,
        createdIds: ['w1']
      })
    )
    expect(result.skipped).toEqual([{ nodeId: 'w1', reason: 'pinned' }])
  })

  it('every reason the union declares has a sentence — a code with no words is a silent skip', () => {
    for (const reason of LAYOUT_SKIP_REASONS) {
      expect(LAYOUT_SKIP_LABELS[reason]).toBeTruthy()
    }
    expect(new Set(Object.values(LAYOUT_SKIP_LABELS)).size).toBe(LAYOUT_SKIP_REASONS.length)
  })

  it('reports a refused node ONCE even when two rules would consider it', () => {
    const result = plan(
      input({
        trigger: 'organize',
        nodes: [
          frame('tray'),
          node('spawner', { parentId: 'tray' }),
          node('w1', { parentId: 'tray', pinned: true }),
          node('w2', { parentId: 'tray', pinned: true })
        ],
        ropes: [
          { source: 'spawner', target: 'w1' },
          { source: 'spawner', target: 'w2' }
        ]
      })
    )
    expect(result.skipped.filter((s) => s.nodeId === 'w1')).toHaveLength(1)
  })
})

describe('plan() — node-created', () => {
  it('leaves a worker loose when its spawner has no tray yet — the engine never CREATES a frame', () => {
    const result = plan(
      input({
        nodes: [node('spawner', { role: 'primary' }), node('w1')],
        ropes: TRAY_ROPES,
        createdIds: ['w1']
      })
    )
    expect(result.ops.filter((op) => op.op === 'reparent')).toEqual([])
    expect(result.ops.some((op) => op.op === 'resize')).toBe(true)
  })

  // It used to CLOSE the tray it filed into ("ships the tray it filed into CLOSED, once, however
  // many workers landed"). It must not: `collapsed` on a frame shrinks it to 40px, and a frame's
  // height is its children's `extent: 'parent'` clamp bounds, so closing a tray pins every member
  // to `frameTop - memberHeight` and stacks them on one line (@shared/node-collapse). The engine
  // may not propose an op that cannot do what its name promises.
  it('leaves the tray it filed into OPEN, whatever the rules say about closing it', () => {
    const result = plan(
      input({
        nodes: [frame('tray'), node('spawner', { parentId: 'tray' }), node('w1'), node('w2')],
        ropes: [
          { source: 'spawner', target: 'w1' },
          { source: 'spawner', target: 'w2' }
        ],
        createdIds: ['w1', 'w2'],
        // The persisted rule key is still readable and still round-trips; it just decides nothing.
        rules: resolveLayoutRules({ tray: { collapsed: true } })
      })
    )
    expect(result.ops.some((op) => op.op === 'collapse')).toBe(false)
    // The workers are still filed — dropping the collapse dropped nothing else.
    expect(result.ops).toContainEqual({ op: 'reparent', nodeId: 'w1', parentId: 'tray' })
    expect(result.ops).toContainEqual({ op: 'reparent', nodeId: 'w2', parentId: 'tray' })
  })

  it('says nothing at all about the tray on node-created', () => {
    // No op and no refusal: the tray is not a subject of this trigger any more, and reporting a
    // pinned frame as "skipped" for work nobody proposed would be noise in the preview table.
    const result = plan(
      input({
        nodes: [frame('tray', { pinned: true }), node('spawner', { parentId: 'tray' }), node('w1')],
        ropes: TRAY_ROPES,
        createdIds: ['w1']
      })
    )
    expect(result.ops.some((op) => op.nodeId === 'tray')).toBe(false)
    expect(result.skipped.some((s) => s.nodeId === 'tray')).toBe(false)
  })

  it('emits no resize when the worker is already at the wanted size', () => {
    const result = plan(
      input({
        nodes: canvasWithTray(node('w1', { size: SIZES.compact })),
        ropes: TRAY_ROPES,
        createdIds: ['w1']
      })
    )
    expect(result.ops.some((op) => op.op === 'resize')).toBe(false)
  })

  it('honours `spawn.size: none` and `spawn.place: none`', () => {
    const result = plan(
      input({
        nodes: canvasWithTray(node('w1')),
        ropes: TRAY_ROPES,
        createdIds: ['w1'],
        rules: resolveLayoutRules({ spawn: { place: 'none', size: 'none' } })
      })
    )
    expect(result.ops).toEqual([])
  })

  it('addresses ONLY the created node — a spawn burst never rearranges what is already there', () => {
    const result = plan(
      input({
        nodes: [
          frame('tray'),
          node('spawner', { parentId: 'tray' }),
          node('old', { position: { x: 900, y: 900 } }),
          node('w1')
        ],
        ropes: [
          { source: 'spawner', target: 'old' },
          { source: 'spawner', target: 'w1' }
        ],
        createdIds: ['w1']
      })
    )
    expect(result.ops.every((op) => op.nodeId === 'w1' || op.nodeId === 'tray')).toBe(true)
  })
})

// DORMANT, and the tests below say what they now pin. `floatOnAttention` exists so that a tray
// shipped CLOSED cannot hide an approval — nothing closes a frame any more (@shared/node-collapse),
// so no canvas this build produces reaches these branches. They are kept, and the guard is kept
// narrow rather than widened to `taskFrame` alone: floating a member out answers "the frame is
// hiding this", and an OPEN tray hides nothing, so a wider rule would yank visible cards out of
// frames the operator arranged. It reactivates verbatim the day a real put-away exists.
describe('plan() — status-changed', () => {
  const closedTray = [
    frame('tray', { collapsed: true }),
    node('spawner', { parentId: 'tray' }),
    node('w1', { parentId: 'tray' })
  ]

  it('emits nothing for a tray this build can actually produce (no frame is ever closed)', () => {
    const result = plan(
      input({
        trigger: 'status-changed',
        nodes: [frame('tray'), node('spawner', { parentId: 'tray' }), node('w1', { parentId: 'tray' })],
        statuses: { w1: 'blocked' },
        ropes: TRAY_ROPES
      })
    )
    expect(result.ops).toEqual([])
  })

  it('floats a BLOCKED member out of a closed tray so the approval is reachable', () => {
    const result = plan(
      input({
        trigger: 'status-changed',
        nodes: closedTray,
        statuses: { w1: 'blocked' },
        ropes: TRAY_ROPES
      })
    )
    expect(result.ops).toEqual([{ op: 'reparent', nodeId: 'w1', parentId: null }])
  })

  it('floats a FAILED member out too', () => {
    const result = plan(
      input({
        trigger: 'status-changed',
        nodes: closedTray,
        statuses: { w1: 'failed' },
        ropes: TRAY_ROPES
      })
    )
    expect(result.ops).toEqual([{ op: 'reparent', nodeId: 'w1', parentId: null }])
  })

  it('leaves a working, waiting, completed or unknown member where it is', () => {
    for (const status of ['working', 'waiting', 'completed', 'unknown'] as const) {
      const result = plan(
        input({
          trigger: 'status-changed',
          nodes: closedTray,
          statuses: { w1: status },
          ropes: TRAY_ROPES
        })
      )
      expect(result.ops).toEqual([])
    }
  })

  it('leaves a blocked member inside an OPEN tray — it is already visible', () => {
    const result = plan(
      input({
        trigger: 'status-changed',
        nodes: [frame('tray'), node('spawner', { parentId: 'tray' }), node('w1', { parentId: 'tray' })],
        statuses: { w1: 'blocked' },
        ropes: TRAY_ROPES
      })
    )
    expect(result.ops).toEqual([])
  })

  it('emits nothing at all when `tray.floatOnAttention` is off', () => {
    const result = plan(
      input({
        trigger: 'status-changed',
        nodes: closedTray,
        statuses: { w1: 'blocked' },
        ropes: TRAY_ROPES,
        rules: resolveLayoutRules({ tray: { floatOnAttention: false } })
      })
    )
    expect(result.ops).toEqual([])
  })

  it('still refuses a pinned member that is blocked', () => {
    const result = plan(
      input({
        trigger: 'status-changed',
        nodes: [
          frame('tray', { collapsed: true }),
          node('spawner', { parentId: 'tray' }),
          node('w1', { parentId: 'tray', pinned: true })
        ],
        statuses: { w1: 'blocked' },
        ropes: TRAY_ROPES
      })
    )
    expect(result.ops).toEqual([])
    expect(result.skipped).toEqual([{ nodeId: 'w1', reason: 'pinned' }])
  })
})

describe('plan() — organize', () => {
  it('files a loose worker into its spawner’s tray and packs what is inside', () => {
    const result = plan(
      input({
        trigger: 'organize',
        nodes: [
          frame('tray'),
          node('spawner', { parentId: 'tray' }),
          node('w1', { parentId: 'tray', position: { x: 500, y: 500 } }),
          node('w2', { position: { x: 2000, y: 2000 } })
        ],
        ropes: [
          { source: 'spawner', target: 'w1' },
          { source: 'spawner', target: 'w2' }
        ]
      })
    )
    expect(result.ops).toContainEqual({ op: 'reparent', nodeId: 'w2', parentId: 'tray' })
    expect(result.ops.some((op) => op.op === 'place')).toBe(true)
  })

  it('is a NO-OP on a canvas it already tidied — running it twice writes nothing the second time', () => {
    const nodes: LayoutNode[] = [
      frame('tray', { collapsed: true }),
      node('spawner', { parentId: 'tray', role: 'primary' }),
      node('w1', { parentId: 'tray', size: SIZES.compact, position: { x: 28, y: 62 } }),
      // Second column: inset + the compact cell + the gap. Sized from the MEMBERS, so a tray of
      // compact cards is packed on compact cells.
      node('w2', { parentId: 'tray', size: SIZES.compact, position: { x: 496, y: 62 } })
    ]
    const ropes = [
      { source: 'spawner', target: 'w1' },
      { source: 'spawner', target: 'w2' }
    ]
    const result = plan(input({ trigger: 'organize', nodes, ropes }))
    expect(result.ops).toEqual([])
  })

  it('labels an unnamed tray from the node that opened its members', () => {
    const result = plan(
      input({
        trigger: 'organize',
        nodes: [
          frame('tray', { title: 'Group 3', collapsed: true }),
          node('spawner', { title: 'reviewer', role: 'primary' }),
          node('w1', { parentId: 'tray', size: SIZES.compact, position: { x: 28, y: 62 } }),
          node('w2', { parentId: 'tray', size: SIZES.compact, position: { x: 496, y: 62 } })
        ],
        ropes: [
          { source: 'spawner', target: 'w1' },
          { source: 'spawner', target: 'w2' }
        ]
      })
    )
    expect(result.ops).toContainEqual({ op: 'label', nodeId: 'tray', title: 'reviewer workers' })
  })

  it('never renames a tray somebody named', () => {
    const result = plan(
      input({
        trigger: 'organize',
        nodes: [
          frame('tray', { title: 'Release review', collapsed: true }),
          node('spawner', { title: 'reviewer', role: 'primary' }),
          node('w1', { parentId: 'tray', size: SIZES.compact, position: { x: 28, y: 62 } })
        ],
        ropes: [{ source: 'spawner', target: 'w1' }]
      })
    )
    expect(result.ops.some((op) => op.op === 'label')).toBe(false)
  })

  it('never considers a node nothing opened — a sticky note is not a refusal row', () => {
    const result = plan(
      input({
        trigger: 'organize',
        nodes: [node('note', { kind: 'sticky', role: 'primary' }), node('mine', { role: 'primary' })],
        ropes: []
      })
    )
    expect(result.ops).toEqual([])
    expect(result.skipped).toEqual([])
  })

  it('refuses a tray another authority created', () => {
    const result = plan(
      input({
        trigger: 'organize',
        nodes: [frame('tray'), node('spawner', { role: 'primary' }), node('w1', { parentId: 'tray' })],
        ropes: [{ source: 'spawner', target: 'w1' }],
        owns: (id) => id !== 'tray'
      })
    )
    expect(result.skipped).toContainEqual({ nodeId: 'tray', reason: 'foreign-authority' })
    expect(result.ops.some((op) => op.nodeId === 'tray')).toBe(false)
  })
})

describe('plan() — triggers', () => {
  it('stands down with a REASON for a trigger the project’s rules exclude', () => {
    const result = plan(
      input({
        trigger: 'organize',
        rules: resolveLayoutRules({ triggers: ['node-created'] })
      })
    )
    expect(result.ops).toEqual([])
    expect(result.stoodDown).toEqual({ reason: 'disabled' })
  })

  it('survives a parent CYCLE in a hand-edited file rather than hanging', () => {
    const result = plan(
      input({
        trigger: 'node-created',
        nodes: [
          { ...frame('a'), parentId: 'b' },
          { ...frame('b'), parentId: 'a' },
          node('w1', { parentId: 'a' })
        ],
        loopFrames: ['a'],
        createdIds: ['w1']
      })
    )
    expect(result.skipped).toEqual([{ nodeId: 'w1', reason: 'loop-owned' }])
  })
})
