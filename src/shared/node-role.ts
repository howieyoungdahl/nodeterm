// Who a canvas node belongs to: the operator's own workspace, or a delegated worker an agent
// spawned through canvas control.
//
// The distinction is the gate on every automatic placement decision. A node the operator opened
// from the UI is `primary` and nothing automatic may move, resize or re-parent it; a node a
// control-capable agent opened is a `worker` and is the only thing the spawn-time grouping (and,
// later, the layout engine) is allowed to arrange.
//
// ABSENT MEANS PRIMARY, deliberately: every canvas saved before this field existed, and every
// manual open, reads as the operator's own. Backward compatibility here is not a nicety — the
// alternative is a release that starts rearranging canvases nobody asked it to touch.

export type NodeRole = 'primary' | 'worker'

/** What a node with no persisted role is. Never change this to 'worker'. */
export const DEFAULT_NODE_ROLE: NodeRole = 'primary'

export function isNodeRole(value: unknown): value is NodeRole {
  return value === 'primary' || value === 'worker'
}

/**
 * The role to act on. A hand-edited or newer-build value that is not a known role degrades to
 * `primary` rather than being rejected: project.json is git-shared and hand-editable, and the
 * safe answer for an unrecognized value is "leave this node alone".
 */
export function resolveNodeRole(value: unknown): NodeRole {
  return isNodeRole(value) ? value : DEFAULT_NODE_ROLE
}

/** True only for a node explicitly persisted as a delegated worker. */
export function isWorkerNode(node: { role?: unknown } | undefined | null): boolean {
  return resolveNodeRole(node?.role) === 'worker'
}
