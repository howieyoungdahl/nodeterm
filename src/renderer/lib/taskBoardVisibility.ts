import { parseTaskPlanning } from '@shared/task-planning'
import type { ExternalTask } from '@shared/external-task-board'
import type { ProjectKanban } from '@shared/types'
import type { KanbanSession } from '../components/kanban/KanbanView'

/** One board, unchanged assignments. Only an explicit support link to a unique present root folds. */
export function taskBoardVisibility(sessions: KanbanSession[], board: ProjectKanban, externalTasks?: Map<string, ExternalTask>): {
  hidden: Set<string>; supports: Map<string, KanbanSession[]>
} {
  const planning = new Map(sessions.map(s => [s.id, parseTaskPlanning(s.taskPlanning)]))
  const roots = new Map<string, KanbanSession[]>()
  for (const session of sessions) {
    const task = planning.get(session.id)
    if (task?.relationship === 'independent') roots.set(task.taskId, [...(roots.get(task.taskId) ?? []), session])
  }
  // Launch-linked cards need their own rows so the board can show the parent and its workers.
  const launchParents = new Set(sessions.flatMap(s => s.parentNodeId ? [s.parentNodeId] : []))
  const hidden = new Set<string>()
  const supports = new Map<string, KanbanSession[]>()
  for (const session of sessions) {
    const task = planning.get(session.id)
    if (task?.relationship !== 'support' || session.pinned || session.manualPlacement || board.manualAssignments?.[session.id]) continue
    if (session.parentNodeId || launchParents.has(session.id)) continue
    const parents = roots.get(task.parentTaskId!)
    if (parents?.length !== 1 || parents[0].id === session.id) continue
    // A support session with a different verified outcome belongs in its own task column.
    const outcome = externalTasks?.get(session.id)
    if (outcome && outcome.task !== externalTasks?.get(parents[0].id)?.task) continue
    hidden.add(session.id)
    const parent = parents[0].id
    supports.set(parent, [...(supports.get(parent) ?? []), session])
  }
  return { hidden, supports }
}
