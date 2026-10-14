import { expect, it } from 'vitest'
import { defaultTaskPlanning } from '@shared/task-planning'
import { effectivePriority, sortByPriority } from './kanbanPriority'
import { setCardPriority } from './kanban'
import type { ProjectKanban } from '@shared/types'

it('resolves all stored levels, legacy choices and explicit clears before task urgency', () => {
  const planning = { ...defaultTaskPlanning('synthetic-task-1234', 'implementation'), urgency: { mode: 'manual' as const, level: 'urgent' as const, reason: 'Synthetic urgency evidence', signals: [] } }
  for (const priority of ['low', 'medium', 'high', 'urgent'] as const) {
    expect(effectivePriority({ nodeId: 'n', priority }, planning, 100)).toBe(priority)
    expect(effectivePriority({ nodeId: 'n', priority, priorityManual: true }, planning, 100)).toBe(priority)
  }
  expect(effectivePriority(undefined, planning, 100)).toBe('urgent')
  expect(effectivePriority({ nodeId: 'n', priorityManual: true }, planning, 100)).toBeUndefined()
  expect(effectivePriority(undefined, undefined, 100)).toBeUndefined()
})
it('sorts descending, preserves ties and unprioritized order without mutating input', () => {
  const cards = Object.freeze(['none1', 'low', 'high1', 'urgent', 'medium', 'high2', 'none2'])
  const priorities = { low: 'low', high1: 'high', urgent: 'urgent', medium: 'medium', high2: 'high' } as const
  const result = sortByPriority(cards, id => priorities[id as keyof typeof priorities])
  expect(result).toEqual(['urgent', 'high1', 'high2', 'medium', 'low', 'none1', 'none2'])
  expect(cards).toEqual(['none1', 'low', 'high1', 'urgent', 'medium', 'high2', 'none2'])
})
it('manual priority choices and clears retain placement and unrelated metadata', () => {
  const board: ProjectKanban = { columns: [], assignments: [], meta: [{ nodeId: 'n', category: 'implementation', categoryReason: 'User choice', dueAt: 12, labels: ['label'], assignees: [{ name: 'Synthetic', color: '#fff' }] }] }
  const chosen = setCardPriority(board, 'n', 'high')
  expect(chosen.meta![0]).toEqual({ ...board.meta![0], priority: 'high', priorityManual: true })
  expect(chosen.assignments).toBe(board.assignments)
  expect(setCardPriority(chosen, 'n', null).meta![0]).toEqual({ ...board.meta![0], priority: undefined, priorityManual: true })
  expect(board.meta![0].priorityManual).toBeUndefined()
})
