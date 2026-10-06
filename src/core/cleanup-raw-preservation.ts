import type { ProjectFileV1, WorkspaceIndexV3 } from './workspace-files'
import type { CanvasNodeState } from '../shared/types'

// Fields this version deliberately projects/sanitizes. Absence can mean deletion for these;
// fields from a future version remain opaque and must survive a presentation round-trip.
const nodeFields = new Set(["assistantCreation", "cleanupArchiveId", "organization", "id", "kind", "position", "size", "controlSize", "role", "taskSummary", "taskFrame", "compactRect", "pinned", "manualPlacement", "title", "titleAuto", "color", "group", "tags", "collapsed", "hideFanout", "parentId", "shell", "cwd", "agentId", "agentModel", "pendingLaunch", "accountId", "agentSessionId", "ssh", "sshRemoteTmux", "sshFs", "text", "textUpdatedAt", "textUpdatedBy", "highScore", "filePath", "fileMissing", "url", "partition", "diffStaged", "commitOid", "worktree", "trigger", "appearance", "premaxRect"])
const projectFields = new Set(["loadedKanban", "organizationChange", "workspaceChange", "revision", "kanbanOrganization", "id", "name", "color", "icon", "cwd", "ssh", "viewport", "nodes", "defaultAccountId", "defaultPermissionMode", "layoutRules", "agentBrowserControl", "agentMessaging", "capabilityAck", "dinoHighScore", "kanban", "bridges", "ropes", "breadcrumbs", "closed", "unavailable", "remote", "version", "rev", "savedAt"])
const entryFields = new Set(["id", "localApprovalId", "name", "color", "closed", "viewport", "defaultAccountId", "capabilityAck", "breadcrumbs", "cwd", "ssh", "cache", "project", "localExec", "localSettings", "settingsCache", "execMigrated"])
const foreign = (old: object, known: Set<string>) => Object.fromEntries(Object.entries(old).filter(([key]) => !known.has(key)))
function preserveProject<T extends { nodes: CanvasNodeState[] }>(old: T | null | undefined, next: T): T {
  if (!old) return next
  const protectedIds = new Set(old.nodes.filter(n => n.cleanupArchiveId).map(n => n.id))
  for (const id of protectedIds) {
    const parent = old.nodes.find(n => n.id === id)?.parentId
    if (parent) protectedIds.add(parent)
  }
  const nodes = next.nodes.map(n => {
    const held = old.nodes.find(b => b.id === n.id)
    // Marker changes belong exclusively to the audited retained cleanup writer. An ordinary
    // client, including one that never understood this field, cannot create or undo them.
    const { cleanupArchiveId: _requestedMarker, ...ordinary } = n
    return held ? { ...foreign(held,nodeFields), ...ordinary,
      ...(held.cleanupArchiveId ? { cleanupArchiveId: held.cleanupArchiveId } : {}) } : ordinary
  })
  const retained = retainRows(old.nodes, nodes, n => n.id, protectedIds)
  const result = { ...foreign(old,projectFields), ...next, nodes: retained } as T & {
    kanban?: import('../shared/types').ProjectKanban; bridges?: Array<{ id: string; source: string; target: string }>;
    ropes?: Array<{ id: string; source: string; target: string }>
  }
  const previous = old as typeof result
  for (const key of ['bridges', 'ropes'] as const) {
    const held = previous[key]
    if (protectedIds.size && held) result[key] = retainRows(held, result[key] ?? [], e => e.id,
      new Set(held.filter(e => protectedIds.has(e.source) || protectedIds.has(e.target)).map(e => e.id)))
  }
  if (protectedIds.size && previous.kanban) {
    const board = result.kanban ?? previous.kanban
    const assignments = retainRows(previous.kanban.assignments, board.assignments, a => a.nodeId, protectedIds)
    if (assignments.some(a => protectedIds.has(a.nodeId) && !board.columns.some(c => c.id === a.columnId)))
      throw new Error('workspace_conflict: archived card column was omitted')
    result.kanban = { ...board, assignments,
      meta: retainRows(previous.kanban.meta ?? [], board.meta ?? [], m => m.nodeId, protectedIds),
      manualAssignments: { ...Object.fromEntries(Object.entries(previous.kanban.manualAssignments ?? {}).filter(([id]) => protectedIds.has(id))), ...board.manualAssignments },
      manualAssignmentVersions: { ...Object.fromEntries(Object.entries(previous.kanban.manualAssignmentVersions ?? {}).filter(([id]) => protectedIds.has(id))), ...board.manualAssignmentVersions } }
  }
  return result
}
/** Keep omitted protected rows beside their original surviving neighbours, without reordering
 * any submitted row. Ordinary metadata deletion remains meaningful for every unprotected row. */
function retainRows<T>(old: T[], next: T[], id: (row: T) => string, protectedIds: Set<string>): T[] {
  const result = [...next]
  for (let i = 0; i < old.length; i++) if (protectedIds.has(id(old[i])) && !result.some(row => id(row) === id(old[i]))) {
    const following = old.slice(i + 1).find(row => result.some(n => id(n) === id(row)))
    const at = following ? result.findIndex(row => id(row) === id(following)) : result.length
    result.splice(at, 0, old[i])
  }
  return result
}
export function preserveRawProject(old: ProjectFileV1 | null, next: ProjectFileV1): ProjectFileV1 {
  return preserveProject(old, next)
}
export function preserveRawIndex(old: WorkspaceIndexV3 | null, next: WorkspaceIndexV3,
  protectedEntries: ReadonlySet<string> = new Set()): WorkspaceIndexV3 {
  if (!old) return next
  return { ...foreign(old,new Set(['version','activeProjectId','entries'])), ...next,
    entries: retainRows(old.entries, next.entries, e => e.id,
      new Set(old.entries.filter(e => protectedEntries.has(e.id) || (e.project ?? e.cache)?.nodes.some(n => n.cleanupArchiveId)).map(e => e.id))).map(e => {
      const held = old.entries.find(b => b.id === e.id)
      return held ? { ...foreign(held,entryFields), ...e,
        ...(e.project ? { project: preserveProject(held.project, e.project) } : {}),
        ...(e.cache ? { cache: preserveProject(held.cache, e.cache) } : {}) } : e
    }) }
}
