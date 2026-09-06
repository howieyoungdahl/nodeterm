// The renderer's half of the layout engine: turn a `LayoutPlan` into a new node array, and build
// the request that produced it.
//
// The engine decides; this applies. Every op goes through a transform the canvas ALREADY uses for
// the equivalent manual gesture — `reparentNode` for a drag into a frame, `placeNodeInRect` for a
// move, `resizeTerminalNodeGeometry` for the size menu — so an automatic placement and a hand
// placement produce the same canvas, and there is no second geometry implementation to drift.
//
// TWO PROPERTIES A REFACTOR MUST NOT LOSE
//
//  1. **It never calls the transport.** No `create`, `write`, `sendText`, `destroy` or `resize`
//     reaches a PTY from here. A layout op is a canvas-state write and nothing else (plan D8);
//     `layoutPlanApply.test.ts` asserts it against a transport that throws on every member.
//  2. **`manualPlacement` is never set.** These writes go through `setNodes` directly and never
//     reach the React Flow change handler that records a hand gesture — which is exactly the
//     distinction that flag has to make. An engine that marked its own placements as manual would
//     pin every node against itself after one run.

import type { LayoutOp, LayoutPlan, LayoutNode, LayoutPlanRequest } from '@shared/canvas-layout'
import { oneLine } from '@shared/one-line'
import {
  COLLAPSED_HEIGHT,
  fitGroupToChildren,
  placeNodeInRect,
  reparentNode,
  resizeTerminalNodeGeometry,
  type CanvasNode
} from '../state/workspace'

/** Read the shape the engine plans over off a live React Flow node. */
export function layoutNodeOf(node: CanvasNode): LayoutNode {
  const width = (node.measured?.width ?? node.width ?? (node.style?.width as number) ?? 0) || 0
  const height = (node.measured?.height ?? node.height ?? (node.style?.height as number) ?? 0) || 0
  return {
    id: node.id,
    kind: node.type ?? 'terminal',
    ...(node.parentId ? { parentId: node.parentId } : {}),
    title: node.data.title,
    role: node.data.role,
    pinned: node.data.pinned,
    manualPlacement: node.data.manualPlacement,
    taskFrame: node.data.taskFrame,
    collapsed: node.data.collapsed,
    controlSize: node.data.controlSize,
    position: { x: node.position.x, y: node.position.y },
    size: { width, height }
  }
}

export function layoutNodesOf(nodes: readonly CanvasNode[]): LayoutNode[] {
  return nodes.map(layoutNodeOf)
}

/** Collapse or expand one node, exactly as the header chevron does. */
function setCollapsed(nodes: CanvasNode[], nodeId: string, collapsed: boolean): CanvasNode[] {
  return nodes.map((n) => {
    if (n.id !== nodeId || !!n.data.collapsed === collapsed) return n
    const expandedHeight =
      (n.data.expandedHeight as number) ?? n.measured?.height ?? (n.height as number) ?? 300
    const height = collapsed ? COLLAPSED_HEIGHT : expandedHeight
    return {
      ...n,
      height,
      style: { ...n.style, height },
      data: { ...n.data, collapsed, expandedHeight }
    }
  })
}

function applyOp(nodes: CanvasNode[], op: LayoutOp): CanvasNode[] {
  const node = nodes.find((n) => n.id === op.nodeId)
  if (!node) return nodes
  switch (op.op) {
    case 'place': {
      const width = (node.measured?.width ?? node.width ?? (node.style?.width as number) ?? 0) || 0
      const height =
        (node.measured?.height ?? node.height ?? (node.style?.height as number) ?? 0) || 0
      if (!width || !height) return nodes
      return placeNodeInRect(nodes, op.nodeId, { ...op.position, width, height })
    }
    case 'resize': {
      if (node.type !== 'terminal') return nodes
      const resized = resizeTerminalNodeGeometry(node, {
        name: op.controlSize ?? 'normal',
        size: op.size
      })
      // Re-fit the frame around it: a card that grew inside a tray would otherwise be clamped by
      // `extent: 'parent'` into an inverted range, which is the snap `groupSelectedNodes` warns
      // about and reads to the operator as the frame jumping across the canvas.
      const next = nodes.map((n) => (n.id === op.nodeId ? resized : n))
      return node.parentId ? fitGroupToChildren(next, node.parentId) : next
    }
    case 'reparent': {
      const from = node.parentId
      const next = reparentNode(nodes, op.nodeId, op.parentId)
      if (next === nodes) return nodes
      // Both ends shrink back around what they now hold — the same pair of re-fits the canvas
      // control `move` verb performs, so an engine move and an agent move leave one shape.
      const fitted = op.parentId ? fitGroupToChildren(next, op.parentId) : next
      return from ? fitGroupToChildren(fitted, from) : fitted
    }
    case 'collapse':
      return setCollapsed(nodes, op.nodeId, op.collapsed)
    case 'label': {
      // A title reaches a `/rename` line elsewhere in the app, so it is one line by construction
      // here too rather than by the engine's good manners.
      const title = oneLine(op.title).trim()
      if (!title) return nodes
      return nodes.map((n) =>
        n.id === op.nodeId ? { ...n, data: { ...n.data, title } } : n
      )
    }
  }
}

/**
 * Apply every op, in order. Returns the SAME array when the plan changed nothing, so the caller
 * can skip the undo entry and the dirty mark entirely — re-running an organize on a tidy canvas
 * must not write `project.json`.
 */
export function applyLayoutPlan(nodes: CanvasNode[], plan: LayoutPlan): CanvasNode[] {
  let next = nodes
  for (const op of plan.ops) next = applyOp(next, op)
  return next
}

export interface LayoutRequestParts {
  projectId: string
  trigger: LayoutPlanRequest['trigger']
  nodes: readonly CanvasNode[]
  ropes?: { source: string; target: string }[]
  statuses?: Record<string, string>
  actives?: string[]
  loopFrames?: string[]
  createdIds?: string[]
  projectRules?: unknown
  sizes: LayoutPlanRequest['sizes']
  holder: string
}

/** Assemble the request. Kept beside the applier so the shape the engine is asked about and the
 *  shape its answer is applied to are read off the same node array in the same tick. */
export function layoutPlanRequest(parts: LayoutRequestParts): LayoutPlanRequest {
  return {
    projectId: parts.projectId,
    trigger: parts.trigger,
    nodes: layoutNodesOf(parts.nodes),
    ropes: parts.ropes ?? [],
    statuses: parts.statuses ?? {},
    actives: parts.actives ?? [],
    loopFrames: parts.loopFrames ?? [],
    createdIds: parts.createdIds ?? [],
    projectRules: parts.projectRules,
    sizes: parts.sizes,
    holder: parts.holder
  }
}
