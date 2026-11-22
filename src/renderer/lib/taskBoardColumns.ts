import type { ExternalTask, ExternalTaskColumns } from '@shared/external-task-board'
import type { KanbanSession } from '../components/kanban/KanbanView'

type Axis = 'workflow' | 'stage'
function axisNames(names: string[]) {
  return new Map<string | null, number>(names.map(name => [name, 0]))
}

export function taskBoardMatrix(
  cards: KanbanSession[],
  tasks: Map<string, ExternalTask>,
  catalog: ExternalTaskColumns,
  columnField: Axis,
  workflowFilter: string
) {
  const rowField = columnField === 'workflow' ? 'stage' : 'workflow'
  const workflows = axisNames(workflowFilter ? [workflowFilter] : catalog.workflows)
  const stages = axisNames(catalog.stages)
  const axes = { workflow: workflows, stage: stages }
  const columns = axes[columnField]
  const rows = axes[rowField]
  const cells = new Map<string | null, Map<string | null, KanbanSession[]>>()
  const unlinked: KanbanSession[] = []
  for (const card of cards) {
    const task = tasks.get(card.id)
    if (!task) {
      unlinked.push(card)
      continue
    }
    const column = task[columnField]
    const row = task[rowField]
    columns.set(column, (columns.get(column) ?? 0) + 1)
    rows.set(row, (rows.get(row) ?? 0) + 1)
    if (!cells.has(row)) cells.set(row, new Map())
    const rowCells = cells.get(row)!
    if (!rowCells.has(column)) rowCells.set(column, [])
    rowCells.get(column)!.push(card)
  }
  const headings = Array.from(columns, ([value, count]) => ({ value, title: value ?? 'Unassigned ' + columnField, count }))
  return {
    columns: headings,
    rows: Array.from(rows, ([value, count]) => ({
      value, title: value ?? 'Unassigned ' + rowField, count,
      cells: headings.map(col => cells.get(value)?.get(col.value) ?? [])
    })),
    unlinked
  }
}
