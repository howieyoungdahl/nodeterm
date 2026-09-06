// The refusal table — the part of the engine that decides NOT to do things.
//
// It is written as its own module, ahead of any rule that produces an op, because the order
// matters and the order is a product decision: a node is refused for the FIRST reason that
// applies, walking from the operator's own explicit intent outward to the structural facts. When
// a pinned node is also inside a loop frame, the operator hears "you pinned this", which is the
// reason they can act on.
//
// Every refusal returns a reason. There is no path through this file that drops a node silently.

import { isWorkerNode } from './node-role'
import type { LayoutSkipReason, LayoutNode } from './canvas-layout'

export interface LayoutRefusalInput {
  nodes: readonly LayoutNode[]
  actives?: readonly string[]
  loopFrames?: readonly string[]
  owns?: (nodeId: string) => boolean
}

/** Everything the refusal table needs, resolved once per plan rather than per node. */
export interface RefusalContext {
  byId: Map<string, LayoutNode>
  actives: Set<string>
  loopFrames: Set<string>
  owns: (nodeId: string) => boolean
}

export function refusalContext(input: LayoutRefusalInput): RefusalContext {
  return {
    byId: new Map(input.nodes.map((node) => [node.id, node])),
    actives: new Set(input.actives ?? []),
    loopFrames: new Set(input.loopFrames ?? []),
    owns: input.owns ?? (() => true)
  }
}

/**
 * Is this node inside a frame another authority owns? Walks the whole ancestor chain, not just
 * the immediate parent: a loop that has organised its members into sub-frames still owns them,
 * and answering only for direct children would let the engine reach into the nesting.
 *
 * The walk is bounded by the node count, so a hand-edited `project.json` with a parent cycle
 * cannot hang the planner. A cycle answers `true` — "cannot establish that this is free to move"
 * is a refusal, which is the safe direction for a file we do not trust.
 */
export function insideLoopFrame(nodeId: string, ctx: RefusalContext): boolean {
  if (!ctx.loopFrames.size) return false
  const seen = new Set<string>()
  let cursor: string | undefined = nodeId
  while (cursor) {
    if (ctx.loopFrames.has(cursor)) return true
    if (seen.has(cursor)) return true
    seen.add(cursor)
    cursor = ctx.byId.get(cursor)?.parentId
  }
  return false
}

/**
 * Why the engine may not arrange this node, or `null` when it may.
 *
 * ORDER IS THE CONTRACT and it is asserted by its own test:
 *
 *  1. `pinned`            — the operator said so, in as many words. Nothing outranks that.
 *  2. `manual-placement`  — the operator said so with their hands.
 *  3. `active`            — the operator is saying so right now. (Re-asked at apply time.)
 *  4. `loop-owned`        — another authority's structure; presentation never takes it over.
 *  5. `foreign-authority` — the creator-ownership boundary.
 *  6. `primary-role`      — not a delegated worker at all; this is the operator's workspace.
 *
 * `primary-role` is LAST although it is the widest, because the reasons above it are more
 * specific and more useful: "you pinned it" tells the operator something they can undo, while
 * "it is not a worker" tells them a category. The node is refused either way.
 */
export function refuse(node: LayoutNode, ctx: RefusalContext): LayoutSkipReason | null {
  if (node.pinned) return 'pinned'
  if (node.manualPlacement) return 'manual-placement'
  if (ctx.actives.has(node.id)) return 'active'
  if (insideLoopFrame(node.id, ctx)) return 'loop-owned'
  if (!ctx.owns(node.id)) return 'foreign-authority'
  // Spawn trays predate role on group nodes. Their explicit taskFrame marker is sufficient
  // only when no role was chosen; an explicit promotion to primary still wins.
  const implicitWorkerTray = node.kind === 'group' && node.taskFrame === true && node.role === undefined
  if (!isWorkerNode(node) && !implicitWorkerTray) return 'primary-role'
  return null
}
