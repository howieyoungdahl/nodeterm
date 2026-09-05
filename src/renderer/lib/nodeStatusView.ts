// Renderer glue for the status surface: turn a live `AgentNodeStatus` into the badge's view model,
// and work out which members a group frame rolls up.
//
// Everything decided here is decided by `shared/node-status.ts`; this file only maps this
// renderer's field names onto that input and answers the "which nodes" question React Flow's tree
// poses. It is pure and takes its clock injected, so the badge and the frame can be tested without
// a canvas.

import { hasHooks, type AgentId } from '@shared/agents/config'
import {
  NODE_STATUS_PRESENTATION,
  NODE_STATUS_STALE_MS,
  deriveNodeStatus,
  rollUpNodeStatus,
  type NodeStatusKind,
  type NodeStatusRollUp,
  type NodeStatusView
} from '@shared/node-status'
import type { AgentNodeStatus } from '../state/agentStatus'

/**
 * Freshness comes from `stateAt` — "when the last hook event ASSERTED the current state" — not
 * from `lastEventAt`, which is when the state last CHANGED. The badge answers "how current is
 * this?", so a tool event mid-turn refreshes it, and a node that has been blocked for an hour
 * without saying so again reads as an hour old. (`stateAt` carried a "never rendered" note before
 * this surface existed; this is the reader it now has.)
 */
export function statusViewFor(
  status: AgentNodeStatus | undefined,
  now: number,
  staleMs: number = NODE_STATUS_STALE_MS
): NodeStatusView {
  return deriveNodeStatus({
    state: status?.state,
    updatedAt: status?.stateAt,
    pane: status?.pane,
    failure: status?.failure,
    reason: status?.reason,
    askKind: status?.askKind,
    now,
    staleMs
  })
}

/** Does this node show a status badge at all? The same gate the node header uses, so a frame can
 *  never roll up a badge its member does not show — a sticky, an editor or a plain shell has no
 *  hook-fed state and must not be reported as `unknown`. */
export function showsStatus(node: { type?: string; agentId?: AgentId }): boolean {
  return node.type === 'terminal' && !!node.agentId && hasHooks(node.agentId)
}

export interface RollUpNodeInput {
  id: string
  type?: string
  parentId?: string
  agentId?: AgentId
}

/**
 * Every status-bearing node inside a frame, nested frames included.
 *
 * Descendants rather than direct children on purpose: frames nest, so a tray inside a tray would
 * otherwise report nothing on the outer label — and the outer label is exactly the one still on
 * screen when everything under it is put away.
 */
export function statusMembersOf(
  groupId: string,
  nodes: readonly RollUpNodeInput[]
): RollUpNodeInput[] {
  const childrenOf = new Map<string, RollUpNodeInput[]>()
  for (const n of nodes) {
    if (!n.parentId) continue
    const list = childrenOf.get(n.parentId)
    if (list) list.push(n)
    else childrenOf.set(n.parentId, [n])
  }
  const out: RollUpNodeInput[] = []
  const seen = new Set<string>([groupId])
  const stack = [groupId]
  while (stack.length > 0) {
    const id = stack.pop() as string
    for (const child of childrenOf.get(id) ?? []) {
      if (seen.has(child.id)) continue // a malformed cycle must not hang the render
      seen.add(child.id)
      stack.push(child.id)
      if (showsStatus(child)) out.push(child)
    }
  }
  return out
}

/** The frame's rolled-up badge: worst member state wins. `null` = render nothing. */
export function groupStatusRollUp(
  groupId: string,
  nodes: readonly RollUpNodeInput[],
  statusById: (id: string) => AgentNodeStatus | undefined,
  now: number,
  staleMs: number = NODE_STATUS_STALE_MS
): NodeStatusRollUp | null {
  const members = statusMembersOf(groupId, nodes)
  return rollUpNodeStatus(
    members.map((m) => ({ id: m.id, kind: statusViewFor(statusById(m.id), now, staleMs).kind }))
  )
}

/**
 * A frame's roll-up as ONE primitive, so a zustand selector can return it.
 *
 * The status table's identity changes on every hook event anywhere on the canvas, so a group frame
 * that selected `s.byId` would re-render on every event in every other frame — the same mistake
 * `Canvas` documents about `armedDepSig`. Selecting a string means a frame re-renders only when
 * its own summary actually changed. `''` = render no badge.
 */
export function rollUpSignature(rollUp: NodeStatusRollUp | null): string {
  return rollUp ? `${rollUp.kind}:${rollUp.count}:${rollUp.total}` : ''
}

/** Rebuild the roll-up from its signature. Returns `null` for `''` or anything malformed. */
export function rollUpFromSignature(signature: string): NodeStatusRollUp | null {
  const [kind, count, total] = signature.split(':')
  const presentation = NODE_STATUS_PRESENTATION[kind as NodeStatusKind]
  if (!presentation) return null
  const c = Number(count)
  const t = Number(total)
  if (!Number.isFinite(c) || !Number.isFinite(t)) return null
  return { kind: kind as NodeStatusKind, ...presentation, count: c, total: t }
}
