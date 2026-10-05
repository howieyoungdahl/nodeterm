import { assessTaskUrgency, parseTaskPlanning } from '@shared/task-planning'
import type { TaskPlanning } from '@shared/task-planning'
import { useProjects } from '../state/projects'

export function TaskPlanningBadge({ planning, nodeId }: { planning?: TaskPlanning; nodeId?: string }): JSX.Element {
  const meta = useProjects(s => s.projects.find(p => p.nodes.some(n => n.id === nodeId))?.kanban?.meta?.find(m => m.nodeId === nodeId))
  const value = parseTaskPlanning(planning)
  if (!value) return <span className="node-account-chip" title={meta?.categoryReason ?? 'No verified creation-time category or urgency assessment is recorded.'}>
    {meta?.category?.replaceAll('-', ' ') ?? 'Needs classification'}
  </span>
  const urgency = assessTaskUrgency(value, Date.now())
  const level = meta?.priorityManual ? meta.priority : meta?.priority ?? urgency.level
  const reason = meta?.priority !== undefined || meta?.priorityManual ? 'Manual urgency override' : urgency.reason
  return <span className="node-account-chip" title={`${meta?.categoryReason ?? value.categoryReason}. ${level ?? 'cleared'}: ${reason}${value.blockedReason ? `. Blocked: ${value.blockedReason}` : ''}`}>
    {(meta?.category ?? value.category).replaceAll('-', ' ')} / {level ?? 'urgency cleared'}
    {value.stage ? ` / ${value.stage}` : ''}{value.blockedReason ? ' / blocked' : ''}
  </span>
}
