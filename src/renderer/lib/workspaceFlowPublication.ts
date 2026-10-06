import type { Project, WorkspacePublication } from '@shared/types'
import { flowToNodeStates, nodeStatesToFlow, type CanvasNode } from '../state/workspace'
import { isKeepAliveKind } from './webviewKeepAlive'
import { mergeWorkspacePublication } from './workspacePublication'

/** The Canvas adoption seam. Persisted fields come only from the reconciled projection; runtime
 * data/callbacks and selection survive. Do not spread old Flow geometry: omitted parentId/extent
 * or stale measured sizes would resurrect a saved deletion on the very next autosave. */
export function planWorkspaceFlowPublication(input: {
  revision: string | undefined; projects: Project[]; activeProjectId: string
  nodes: CanvasNode[]; change: WorkspacePublication | undefined
}) {
  const projects = input.projects.map(p => p.id === input.activeProjectId
    ? { ...p, nodes: flowToNodeStates(input.nodes) } : p)
  const result = mergeWorkspacePublication(input.revision, projects, input.change)
  if (result.kind !== 'adopt') return result
  const active = result.projects.find(p => p.id === input.activeProjectId)
  const changed = !!active && !!input.change?.changes.some(c => c.after.id === active.id)
  const held = new Map(input.nodes.map(n => [n.id, n]))
  const nodes = changed ? nodeStatesToFlow(active.nodes).map(incoming => {
    const old = held.get(incoming.id)
    if (!old) return incoming
    return { ...incoming, selected: old.selected, dragging: old.dragging,
      data: { ...old.data, ...incoming.data } }
  }) : input.nodes
  // Pool entries already own their stable order. Live webviews not enrolled in that pool yet
  // must also keep their surviving relative order, even when a saved node list is reordered.
  const webviews = new Map(nodes.filter(isKeepAliveKind).map(n => [n.id, n]))
  const stable = [...input.nodes.filter(isKeepAliveKind).map(n => webviews.get(n.id)).filter((n): n is CanvasNode => !!n),
    ...nodes.filter(n => isKeepAliveKind(n) && !held.has(n.id))]
  let webIndex = 0
  const stableNodes = changed ? nodes.map(n => isKeepAliveKind(n) ? stable[webIndex++] : n) : nodes
  const created = changed ? active.nodes.filter(n => !held.has(n.id)).map(n => n.id) : []
  const removed = (input.change?.changes ?? []).flatMap(c => c.before.nodes.filter(n => !c.after.nodes.some(a => a.id === n.id)).map(n => n.id))
  return { ...result, nodes: stableNodes, active: changed ? active : undefined, created, removed }
}

/** Keep transaction ordering testable: every content installation completes before evidence
 * advances, then the same deferred node-created layout trigger runs over the installed IDs. */
export function applyWorkspaceFlowPublication(plan: ReturnType<typeof planWorkspaceFlowPublication>, sinks: {
  content(plan: Extract<ReturnType<typeof planWorkspaceFlowPublication>, { kind: 'adopt' }>): void
  acknowledge(projects: Project[], revision: string): void
  created(ids: string[]): void
  defer(work: () => void): void
}): void {
  if (plan.kind !== 'adopt') return
  sinks.content(plan)
  sinks.acknowledge(plan.projects, plan.revision)
  if (plan.created.length) sinks.defer(() => sinks.created(plan.created))
}
