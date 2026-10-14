import type { KanbanCardMeta, KanbanPriority } from '@shared/types'
import { assessTaskUrgency, parseTaskPlanning } from '@shared/task-planning'

/** Explicit clears suppress automatic urgency; legacy stored values retain precedence. */
export function effectivePriority(meta: KanbanCardMeta | undefined, planning: unknown, now: number): KanbanPriority | undefined {
  if (meta?.priorityManual) return meta.priority
  if (meta?.priority) return meta.priority
  const task = parseTaskPlanning(planning)
  return task ? assessTaskUrgency(task, now).level : undefined
}

const rank: Record<KanbanPriority, number> = { urgent: 4, high: 3, medium: 2, low: 1 }
/** Derived view only. Equal priorities retain the existing visible/manual order. */
export function sortByPriority<T>(cards: readonly T[], priority: (card: T) => KanbanPriority | undefined): T[] {
  return cards.map((card, index) => ({ card, index, rank: rank[priority(card)!] ?? 0 }))
    .sort((a, b) => b.rank - a.rank || a.index - b.index).map(entry => entry.card)
}
