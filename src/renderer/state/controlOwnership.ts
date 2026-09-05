/**
 * nodeId → the node that OPENED it, for nodes an agent opened through canvas control during THIS
 * app run. One hop of hierarchy, recorded where it is actually known, so the `list` verb can hand a
 * reading agent the fan-out tree instead of a flat list it has to reconstruct by asking again.
 *
 * ── WHY IT IS TRANSIENT, AND WHY THAT IS THE HONEST SHAPE ───────────────────────────────────────
 * This mirrors the Server Edition's creator ledger (`HeadlessNodeOwnership`) deliberately: recorded
 * only on a genuine open-by-this-source, empty after a restart, and never repopulated from
 * persisted data. `project.json` is git-shared and hand-editable, and titles, tmux names and rope
 * edges are not creator proof — a rope in particular cannot say whether its source OPENED the node
 * or is merely a `--after` dependency it once waited on, so deriving the opener from the edge set
 * would report a dependency as a parent. An absent entry therefore means "not recorded here", the
 * field is omitted from the row, and the row is byte-identical to what it was before this existed.
 *
 * This is DISPLAY ONLY. Nothing gates a mutation on it — the desktop shell's control path has never
 * had a creator-ownership gate, and adding one here disguised as a listing feature would be exactly
 * the "filtering mistaken for access control" this lane exists to prevent. See
 * docs/remote-session-scoping.md.
 */

const openers = new Map<string, string>()

/** Record that `sourceNodeId` opened `nodeId`. Called from the ONE canvas-control funnel that
 *  appends an agent-opened node and draws its opener rope. */
export function recordControlOpener(nodeId: string, sourceNodeId: string): void {
  if (!nodeId || !sourceNodeId || nodeId === sourceNodeId) return
  openers.set(nodeId, sourceNodeId)
}

/** Who opened this node this run, or undefined when unproven. Undefined is a real answer. */
export function controlOpenerOf(nodeId: string): string | undefined {
  return openers.get(nodeId)
}

/** Forget a node that is gone. A stale entry would name a deleted node as somebody's parent. */
export function forgetControlOpener(nodeId: string): void {
  openers.delete(nodeId)
}

/** Test seam only. */
export function resetControlOpenersForTests(): void {
  openers.clear()
}
