import type { CanvasNodeState, Project } from '@shared/types'

/** A missing card alone is not a deletion: it may have been opened while autosave was paused.
 * Only explicit evidence loaded with this exact project can exclude a card from resolution.
 * This updates the canvas projection, never its terminal backend or the retained records.
 */
export function applyDeletedEntities(local: Project, incoming: Project): Project {
  if (local.id !== incoming.id || !incoming.deletedEntities) return local
  const deleted = new Set(incoming.deletedEntities.nodes)
  const byId = new Map(local.nodes.map(n => [n.id, n]))
  const position = (node: CanvasNodeState) => {
    const result = { ...node.position }, seen = new Set([node.id])
    let parent = node.parentId ? byId.get(node.parentId) : undefined
    while (parent && !seen.has(parent.id)) {
      seen.add(parent.id)
      result.x += parent.position.x
      result.y += parent.position.y
      parent = parent.parentId ? byId.get(parent.parentId) : undefined
    }
    return result
  }
  const withoutDeletedKeys = <T>(values: Record<string, T>) =>
    Object.fromEntries(Object.entries(values).filter(([id]) => !deleted.has(id)))
  const nodes = local.nodes.filter(n => !deleted.has(n.id)).map(n => {
    if (!n.parentId || !deleted.has(n.parentId)) return n
    const { parentId: _parent, ...root } = n
    return { ...root, position: position(n) }
  })
  const links = (key: 'bridges' | 'ropes') => {
    const ids = new Set(incoming.deletedEntities![key])
    return local[key]?.filter(e => !ids.has(e.id) && !deleted.has(e.source) && !deleted.has(e.target))
  }
  const kanban = local.kanban && { ...local.kanban,
    assignments: local.kanban.assignments.filter(a => !deleted.has(a.nodeId)),
    ...(local.kanban.meta ? { meta: local.kanban.meta.filter(m => !deleted.has(m.nodeId)) } : {}),
    ...(local.kanban.manualAssignments ? { manualAssignments: withoutDeletedKeys(local.kanban.manualAssignments) } : {}),
    ...(local.kanban.manualAssignmentVersions ? { manualAssignmentVersions: withoutDeletedKeys(local.kanban.manualAssignmentVersions) } : {})
  }
  return { ...local, deletedEntities: incoming.deletedEntities, nodes,
    ...(local.bridges ? { bridges: links('bridges') } : {}),
    ...(local.ropes ? { ropes: links('ropes') } : {}), ...(kanban ? { kanban } : {}) }
}
