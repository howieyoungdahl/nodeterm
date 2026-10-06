import { expect, it } from 'vitest'
import { defaultTaskPlanning } from '@shared/task-planning'
import type { ProjectKanban } from '@shared/types'
import type { KanbanSession } from '../components/kanban/KanbanView'
import { taskBoardVisibility } from './taskBoardVisibility'
import { cardMeta, setCardCategory, setCardDue, setCardLabels, setCardPriority, toggleCardLabel } from './kanban'

const board: ProjectKanban = { columns: [{ id: 'column-1', title: 'Work', color: '#fff' }],
  assignments: [{ nodeId: 'support', columnId: 'column-1' }, { nodeId: 'root', columnId: 'column-1' }] }
const session = (id: string, support = false): KanbanSession => ({ id, title: id, kind: 'terminal', color: '#fff', spawn: {},
  taskPlanning: { ...defaultTaskPlanning(`task-${id}-1234`, 'research'),
    ...(support ? { relationship: 'support', parentTaskId: 'task-root-1234' } : {}) } })
it('folds explicit support under the present parent without editing assignment order or node data', () => {
  const root = session('root'), support = session('support', true), unrelated = session('unrelated')
  const original = structuredClone({ board, sessions: [root, support, unrelated] })
  const result = taskBoardVisibility([root, support, unrelated], board)
  expect([...result.hidden]).toEqual(['support'])
  expect(result.supports.get('root')).toEqual([support])
  expect({ board, sessions: [root, support, unrelated] }).toEqual(original)
})
it('keeps independent, legacy, orphaned, cyclic, ambiguous and manually placed work visible', () => {
  const root = session('root'), support = session('support', true)
  for (const sessions of [[support], [root, { ...support, pinned: true }], [root, { ...support, manualPlacement: true }],
    [root, { ...support, taskPlanning: undefined }], [root, { ...root, id: 'duplicate-root' }, support],
    [session('other', true), support]]) expect(taskBoardVisibility(sessions, board).hidden.size).toBe(0)
  expect(taskBoardVisibility([root, support], { ...board, manualAssignments: { support: true } }).hidden.size).toBe(0)
  expect(taskBoardVisibility([root, { ...support, taskPlanning: { ...support.taskPlanning!, relationship: 'independent', parentTaskId: undefined } }], board).hidden.size).toBe(0)
})
it('retains an explicit urgency clear across unrelated due and label edits', () => {
  let value = setCardPriority(board, 'root', null)
  value = setCardCategory(value, 'root', 'design')
  value = setCardDue(value, 'root', 1800000000000)
  value = setCardLabels(value, 'root', ['label-1'])
  value = toggleCardLabel(value, 'root', 'label-2')
  expect(cardMeta(value, 'root')).toMatchObject({ priorityManual: true, category: 'design', categoryReason: expect.any(String),
    dueAt: 1800000000000, labels: ['label-1', 'label-2'] })
  expect(cardMeta(value, 'root')?.priority).toBeUndefined()
})
