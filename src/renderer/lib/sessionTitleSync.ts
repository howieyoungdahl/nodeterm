import { useProjects } from '../state/projects'

export function canAutoSyncSessionTitle(projectId: string, nodeId: string, titleAuto: boolean): boolean {
  if (!titleAuto || !projectId || !nodeId) return false
  const state = useProjects.getState()
  if (state.activeProjectId !== projectId) return false
  const project = state.getProject(projectId)
  if (!project) return false
  const board = project.kanban
  // Undefined baseline means the owning board has not been observed yet.
  if (board === undefined) return project.loadedKanban === null
  if (!board || !Array.isArray(board.columns) || !Array.isArray(board.assignments)) return false
  // Treat the complete board as one inventory. Ambiguous ids or dangling assignments
  // cannot establish that a card is outside Directors, even on an unrelated row.
  const columns = new Map<string, string>()
  for (const column of board.columns) {
    if (!column || typeof column !== 'object' ||
      typeof column.id !== 'string' || !column.id.trim() ||
      typeof column.title !== 'string' || !column.title.trim() || columns.has(column.id)) return false
    columns.set(column.id, column.title.trim().toLowerCase())
  }
  const assigned = new Set<string>()
  let protectedCard = false
  for (const assignment of board.assignments) {
    if (!assignment || typeof assignment !== 'object' ||
      typeof assignment.nodeId !== 'string' || !assignment.nodeId.trim() ||
      typeof assignment.columnId !== 'string' || !assignment.columnId.trim() ||
      assigned.has(assignment.nodeId) || !columns.has(assignment.columnId)) return false
    assigned.add(assignment.nodeId)
    if (assignment.nodeId === nodeId && columns.get(assignment.columnId) === 'directors') protectedCard = true
  }
  if (protectedCard) return false
  return true
}

/** Recheck publication authority after the asynchronous session-name read. */
export async function syncSessionTitle(
  canUpdate: () => boolean,
  readName: () => Promise<string | null>,
  applyName: (name: string) => void
): Promise<void> {
  if (!canUpdate()) return
  const name = await readName()
  if (name && canUpdate()) applyName(name)
}
