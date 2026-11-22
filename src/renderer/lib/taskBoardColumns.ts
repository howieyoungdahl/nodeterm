import type { ExternalTask } from '@shared/external-task-board'
import type { KanbanSession } from '../components/kanban/KanbanView'

export function taskBoardColumns(
  cards: KanbanSession[],
  tasks: Map<string, ExternalTask>,
  field: 'workflow' | 'stage',
  names: string[],
  available: boolean
) {
  const columns = new Map(names.map(name => [name, [] as KanbanSession[]]))
  const unassigned: KanbanSession[] = []
  const unlinked: KanbanSession[] = []
  for (const card of cards) {
    const task = tasks.get(card.id)
    if (!task) {
      unlinked.push(card)
      continue
    }
    const name = task[field]
    if (!name) {
      unassigned.push(card)
      continue
    }
    if (!columns.has(name)) columns.set(name, [])
    columns.get(name)!.push(card)
  }
  const result = Array.from(columns, ([title, cards]) => ({ id: 'field:' + title, title, cards }))
  if (unassigned.length) result.push({ id: 'unassigned', title: 'Unassigned ' + field, cards: unassigned })
  if (unlinked.length) result.push({
    id: 'unlinked', title: available ? 'No linked task' : 'Task board unavailable', cards: unlinked
  })
  return result
}
