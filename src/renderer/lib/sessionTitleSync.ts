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
  for (const assignment of board.assignments) {
    if (assignment.nodeId !== nodeId) continue
    const column = board.columns.find((candidate) => candidate.id === assignment.columnId)
    if (!column || typeof column.title !== 'string') return false
    if (column.title.trim().toLowerCase() === 'directors') return false
  }
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
