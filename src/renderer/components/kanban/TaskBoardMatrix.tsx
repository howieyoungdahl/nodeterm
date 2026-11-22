import type { ReactNode } from 'react'
import type { taskBoardMatrix } from '../../lib/taskBoardColumns'
import type { KanbanSession } from './KanbanView'

export function TaskBoardMatrix({ matrix, columnField, renderCards }: {
  matrix: ReturnType<typeof taskBoardMatrix>
  columnField: 'workflow' | 'stage'
  renderCards: (cards: KanbanSession[]) => ReactNode
}) {
  return (
    <table className="kanban-matrix" aria-label="Workflows and stages"
      style={{ minWidth: `calc(var(--kanban-row-width) + ${matrix.columns.length} * var(--kanban-column-width))` }}>
      <thead><tr>
        <th scope="col" className="kanban-matrix__corner">{columnField === 'workflow' ? 'Stage' : 'Workflow'}</th>
        {matrix.columns.map(col => (
          <th scope="col" key={JSON.stringify(col.value)}>
            <span className="kanban-col__title">{col.title}</span>
            <span className="kanban-col__count">{col.count}</span>
          </th>
        ))}
      </tr></thead>
      <tbody>{matrix.rows.map(row => (
        <tr key={JSON.stringify(row.value)}>
          <th scope="row">{row.title}</th>
          {row.cells.map((cards, index) => (
            <td key={JSON.stringify(matrix.columns[index].value)} data-column={matrix.columns[index].title}>
              {cards.length > 0 && <div className="kanban-matrix__cards">{renderCards(cards)}</div>}
            </td>
          ))}
        </tr>
      ))}</tbody>
    </table>
  )
}
