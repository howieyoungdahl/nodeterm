// The layout engine: `plan(input) -> LayoutPlan`. Pure — no clock of its own, no store, no
// filesystem, nothing async. Everything it needs arrives as data, and everything it decides
// leaves as ops and refusals.
//
// WHAT IT DELIBERATELY CANNOT DO
//
//  * **Create a frame.** The op set the plan of record fixes is `place | resize | reparent |
//    collapse | label`, and that is not an oversight: the spawn path already creates the tray
//    (`HeadlessNodeFactory.applyWorkerFrame` over @shared/worker-frame), with the "no frame around
//    a single card" rule that keeps a canvas from filling with one-member boxes. An engine that
//    could also mint frames would be a second frame-creator racing the first, which is the frame
//    churn risk §8 of the plan names. The engine FILES INTO trays; it does not open them.
//  * **Touch a PTY.** No op here creates a session, attaches, kills, closes, types or moves loop
//    authority. Presentation is never authority (plan D8, registry contract §7).
//  * **Rearrange existing members on an automatic trigger.** `node-created` and `status-changed`
//    only ever address the node the event was about. Repacking what is already on the canvas
//    happens ONLY under `organize` / `rules-changed` — an explicit operator action, previewed
//    before it applies. That line is what keeps a spawn burst from reshuffling the canvas under
//    someone's hands.

import {
  standDownPlan,
  type LayoutOp,
  type LayoutPlan,
  type LayoutSkip,
  type LayoutSkipReason
} from '../../shared/canvas-layout'
import { workerFrameLabel } from '../../shared/worker-frame'
import { isWorkerNode } from '../../shared/node-role'
import type { NodeStatusKind } from '../../shared/node-status'
import { refuse, refusalContext, type RefusalContext } from './refusals'
import type { LayoutInput, LayoutNode } from './types'

/** Gap between two cards packed inside a tray, and the tray's own inset. Matches the padding the
 *  renderer's `groupSelectedNodes` leaves around a fresh frame, so a packed tray looks like a
 *  hand-made one. */
const PACK_GAP = 28
const PACK_INSET_X = 28
const PACK_INSET_Y = 62

/** Statuses that mean the operator is being waited on. The one thing `status-changed` acts on. */
const ATTENTION: readonly NodeStatusKind[] = ['blocked', 'failed']

/** A title the engine treats as "not named yet" and may replace. Anything else is someone's
 *  choice — an automatic rename over a name a human or an agent chose is a bug, not a tidy. */
function unnamed(title: string | undefined): boolean {
  const clean = (title ?? '').trim()
  return !clean || /^(group|frame)\s*\d*$/i.test(clean)
}

/** Root-space position of a node, following its parent chain. Bounded by the node count so a
 *  hand-edited cycle in `project.json` cannot hang the planner. */
function rootPosition(node: LayoutNode, byId: Map<string, LayoutNode>): { x: number; y: number } {
  let x = node.position?.x ?? 0
  let y = node.position?.y ?? 0
  const seen = new Set<string>([node.id])
  let parentId = node.parentId
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId)
    const parent = byId.get(parentId)
    if (!parent) break
    x += parent.position?.x ?? 0
    y += parent.position?.y ?? 0
    parentId = parent.parentId
  }
  return { x, y }
}

/** The node that opened `nodeId`, per the lineage ropes the control plane already writes. */
function spawnerOf(nodeId: string, ropes: readonly { source: string; target: string }[]): string | undefined {
  return ropes.find((rope) => rope.target === nodeId)?.source
}

/** The tray a spawner's workers already sit in, found by fact (`taskFrame`) rather than by name,
 *  so a frame the operator renamed is still the same tray. Ambiguity declines. */
function trayFor(
  spawnerId: string,
  input: LayoutInput,
  byId: Map<string, LayoutNode>
): LayoutNode | undefined {
  const spawner = byId.get(spawnerId)
  // The spawner's own frame first — the same first rule @shared/worker-frame applies, so the two
  // paths cannot disagree about where a fan-out belongs.
  const own = spawner?.parentId ? byId.get(spawner.parentId) : undefined
  if (own?.kind === 'group') return own
  const trays = [
    ...new Set(
      (input.ropes ?? [])
        .filter((rope) => rope.source === spawnerId)
        .map((rope) => byId.get(rope.target)?.parentId)
        .filter((id): id is string => !!id)
    )
  ]
    .map((id) => byId.get(id))
    .filter((node): node is LayoutNode => !!node && node.kind === 'group' && !!node.taskFrame)
  return trays.length === 1 ? trays[0] : undefined
}

interface Collector {
  ops: LayoutOp[]
  skipped: LayoutSkip[]
  seen: Set<string>
}

/** Record a refusal once per node. A node considered by two rules is one row in the table. */
function skip(collector: Collector, nodeId: string, reason: LayoutSkipReason): void {
  if (collector.seen.has(nodeId)) return
  collector.seen.add(nodeId)
  collector.skipped.push({ nodeId, reason })
}

/**
 * Consider a node: either it is refused (and the reason is recorded) or the caller may emit ops
 * for it. Returns whether the node is free to arrange.
 */
function consider(node: LayoutNode, ctx: RefusalContext, collector: Collector): boolean {
  const reason = refuse(node, ctx)
  if (!reason) return true
  skip(collector, node.id, reason)
  return false
}

/** Spawn-time geometry: open a worker at the size the rules ask for, if it is not already there. */
function spawnResize(node: LayoutNode, input: LayoutInput): LayoutOp | null {
  const want = input.rules.spawn.size
  if (want === 'none') return null
  const size = want === 'compact' ? input.sizes.compact : input.sizes.normal
  if (node.size && node.size.width === size.width && node.size.height === size.height) return null
  return { op: 'resize', nodeId: node.id, size, controlSize: want }
}

/** Spawn-time filing: put a worker into its spawner's tray, when one exists. The engine never
 *  creates the tray (see the header) — a spawner with no tray yet leaves its worker loose, which
 *  is exactly what @shared/worker-frame's single-worker rule already decided. */
function fileIntoTray(
  node: LayoutNode,
  input: LayoutInput,
  byId: Map<string, LayoutNode>
): LayoutOp | null {
  if (input.rules.spawn.place !== 'tray') return null
  const spawnerId = spawnerOf(node.id, input.ropes ?? [])
  if (!spawnerId) return null
  const tray = trayFor(spawnerId, input, byId)
  if (!tray || tray.id === node.parentId || tray.id === node.id) return null
  return { op: 'reparent', nodeId: node.id, parentId: tray.id }
}

/**
 * Pack a tray's members into a grid anchored at the tray's own origin, in their current reading
 * order. Only ever runs under an explicit organize (see the header). Emits nothing for a member
 * already where the pack would put it, so re-running an organize on a tidy canvas is a no-op —
 * which is what makes the preview honest about there being nothing to do.
 */
function packTray(
  tray: LayoutNode,
  members: readonly LayoutNode[],
  byId: Map<string, LayoutNode>,
  normal: { width: number; height: number }
): LayoutOp[] {
  if (members.length < 2) return []
  const origin = rootPosition(tray, byId)
  const ordered = [...members].sort((a, b) => {
    const ra = rootPosition(a, byId)
    const rb = rootPosition(b, byId)
    return ra.y - rb.y || ra.x - rb.x
  })
  const columns = Math.max(1, Math.ceil(Math.sqrt(ordered.length)))
  // The cell is sized from the members ACTUALLY present, not floored at the normal footprint: a
  // tray of compact cards laid out on normal-sized cells leaves a 200px gutter between every pair,
  // which reads as a bug rather than as a grid. `normal` is only the fallback for a member React
  // Flow has not measured yet.
  const cell = {
    width: Math.max(...ordered.map((n) => n.size?.width || normal.width)),
    height: Math.max(...ordered.map((n) => n.size?.height || normal.height))
  }
  const ops: LayoutOp[] = []
  ordered.forEach((member, i) => {
    const target = {
      x: origin.x + PACK_INSET_X + (i % columns) * (cell.width + PACK_GAP),
      y: origin.y + PACK_INSET_Y + Math.floor(i / columns) * (cell.height + PACK_GAP)
    }
    const at = rootPosition(member, byId)
    if (Math.round(at.x) === Math.round(target.x) && Math.round(at.y) === Math.round(target.y)) return
    ops.push({ op: 'place', nodeId: member.id, position: target })
  })
  return ops
}

/** The nodes an explicit organize addresses: the delegated fan-out and its trays, never the
 *  operator's own cards. A node nothing opened and no tray holds is not considered at all — a
 *  refusal row for every sticky note on the canvas would bury the rows that matter. */
function organizeCandidates(input: LayoutInput, byId: Map<string, LayoutNode>): LayoutNode[] {
  const roped = new Set((input.ropes ?? []).map((rope) => rope.target))
  return input.nodes.filter((node) => {
    if (node.kind === 'group') return false
    if (roped.has(node.id)) return true
    const parent = node.parentId ? byId.get(node.parentId) : undefined
    return !!parent?.taskFrame
  })
}

export function plan(input: LayoutInput): LayoutPlan {
  if (!input.rules.triggers.includes(input.trigger)) {
    return standDownPlan(input.trigger, 'disabled')
  }
  const ctx = refusalContext(input)
  const byId = ctx.byId
  const collector: Collector = { ops: [], skipped: [], seen: new Set() }

  if (input.trigger === 'node-created') {
    for (const id of input.createdIds ?? []) {
      const node = byId.get(id)
      if (!node || node.kind === 'group') continue
      if (!consider(node, ctx, collector)) continue
      const resize = spawnResize(node, input)
      if (resize) collector.ops.push(resize)
      const file = fileIntoTray(node, input, byId)
      if (file) collector.ops.push(file)
    }
    // Close the trays this spawn filled, once each. A tray is a frame, so the ownership and
    // pinned refusals apply to it exactly as they do to a card.
    if (input.rules.tray.collapsed) {
      const trays = new Set(
        collector.ops
          .filter((op): op is Extract<LayoutOp, { op: 'reparent' }> => op.op === 'reparent')
          .map((op) => op.parentId)
          .filter((id): id is string => !!id)
      )
      for (const trayId of trays) {
        const tray = byId.get(trayId)
        if (!tray || tray.collapsed) continue
        if (tray.pinned) {
          skip(collector, tray.id, 'pinned')
          continue
        }
        collector.ops.push({ op: 'collapse', nodeId: tray.id, collapsed: true })
      }
    }
    return { trigger: input.trigger, ops: collector.ops, skipped: collector.skipped }
  }

  if (input.trigger === 'status-changed') {
    // The ONLY layout consequence of a status change, and it exists so that shipping a tray
    // closed is safe: a member that needs the operator leaves the closed frame rather than
    // waiting inside it. One-directional on purpose — filing it back is what an organize does,
    // and a "put it back where it was" rule would need persisted memory of where that was.
    if (!input.rules.tray.floatOnAttention) {
      return { trigger: input.trigger, ops: [], skipped: [] }
    }
    for (const [nodeId, status] of Object.entries(input.statuses ?? {})) {
      if (!ATTENTION.includes(status)) continue
      const node = byId.get(nodeId)
      if (!node || !node.parentId) continue
      const tray = byId.get(node.parentId)
      if (!tray?.taskFrame || !tray.collapsed) continue
      if (!consider(node, ctx, collector)) continue
      collector.ops.push({ op: 'reparent', nodeId: node.id, parentId: null })
    }
    return { trigger: input.trigger, ops: collector.ops, skipped: collector.skipped }
  }

  // `organize` and `rules-changed`: re-apply the rules to what is already on the canvas. Both are
  // explicit operator actions and both render as a preview before anything is applied.
  const candidates = organizeCandidates(input, byId)
  for (const node of candidates) {
    if (!consider(node, ctx, collector)) continue
    const resize = spawnResize(node, input)
    if (resize) collector.ops.push(resize)
    const file = fileIntoTray(node, input, byId)
    if (file) collector.ops.push(file)
  }

  const moved = new Map(
    collector.ops
      .filter((op): op is Extract<LayoutOp, { op: 'reparent' }> => op.op === 'reparent')
      .map((op) => [op.nodeId, op.parentId])
  )
  for (const tray of input.nodes) {
    if (tray.kind !== 'group' || !tray.taskFrame) continue
    if (tray.pinned) {
      skip(collector, tray.id, 'pinned')
      continue
    }
    if (!ctx.owns(tray.id)) {
      skip(collector, tray.id, 'foreign-authority')
      continue
    }
    // Members after this plan's own re-parents, so a pack accounts for the cards it just filed.
    const members = input.nodes.filter((node) => {
      if (node.kind === 'group') return false
      const parentId = moved.has(node.id) ? moved.get(node.id) : node.parentId
      return parentId === tray.id
    })
    const free = members.filter((node) => !refuse(node, ctx) || moved.has(node.id))
    collector.ops.push(...packTray(tray, free, byId, input.sizes.normal))
    if (unnamed(tray.title)) {
      const owner = input.nodes.find(
        (node) =>
          !node.taskFrame &&
          (input.ropes ?? []).some(
            (rope) => rope.source === node.id && members.some((m) => m.id === rope.target)
          )
      )
      if (owner) collector.ops.push({ op: 'label', nodeId: tray.id, title: workerFrameLabel(owner.title ?? '') })
    }
    if (input.rules.tray.collapsed && !tray.collapsed && members.length > 0) {
      collector.ops.push({ op: 'collapse', nodeId: tray.id, collapsed: true })
    }
  }
  return { trigger: input.trigger, ops: collector.ops, skipped: collector.skipped }
}

/** True when a node is a delegated worker the engine would consider at all. Exported for the
 *  shells, so neither has to re-spell `role === 'worker'`. */
export function isLayoutSubject(node: LayoutNode): boolean {
  return node.kind !== 'group' && isWorkerNode(node)
}
