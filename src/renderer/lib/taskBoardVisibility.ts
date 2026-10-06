import { parseTaskPlanning } from '@shared/task-planning'
import type { ProjectKanban } from '@shared/types'
import type { KanbanSession } from '../components/kanban/KanbanView'

/** One board, unchanged assignments. Only an explicit support link to a unique present root folds. */
export function taskBoardVisibility(sessions: KanbanSession[], board: ProjectKanban): {
  hidden: Set<string>; supports: Map<string, KanbanSession[]>
} {
  const planning = new Map(sessions.map(s => [s.id, parseTaskPlanning(s.taskPlanning)]))
  const roots = new Map<string, KanbanSession[]>()
  for (const session of sessions) {
    const task = planning.get(session.id)
    if (task?.relationship === 'independent') roots.set(task.taskId, [...(roots.get(task.taskId) ?? []), session])
  }
  const hidden = new Set<string>()
  const supports = new Map<string, KanbanSession[]>()
  for (const session of sessions) {
    const task = planning.get(session.id)
    if (task?.relationship !== 'support' || session.pinned || session.manualPlacement || board.manualAssignments?.[session.id]) continue
    const parents = roots.get(task.parentTaskId!)
    if (parents?.length !== 1 || parents[0].id === session.id) continue
    hidden.add(session.id)
    const parent = parents[0].id
    supports.set(parent, [...(supports.get(parent) ?? []), session])
  }
  return { hidden, supports }
}
