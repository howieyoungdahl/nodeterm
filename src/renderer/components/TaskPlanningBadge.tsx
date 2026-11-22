import { assessTaskUrgency, parseTaskPlanning } from '@shared/task-planning'
import type { TaskPlanning } from '@shared/task-planning'
import { useProjects } from '../state/projects'
import { useExternalBoard } from '../state/externalTaskBoard'

export function TaskPlanningBadge({ planning, nodeId }: { planning?: TaskPlanning; nodeId?: string }): JSX.Element {
  const project = useProjects(s => s.projects.find(p => p.nodes.some(n => n.id === nodeId)))
  const meta = project?.kanban?.meta?.find(m => m.nodeId === nodeId)
  const linked = useExternalBoard(s => nodeId ? s.tasks.get(nodeId) : undefined)
  const boardUrl = useExternalBoard(s => s.project === project?.id ? s.url : null)
  const available = useExternalBoard(s => s.available)
  if (boardUrl && linked) return <span className="node-account-chip" title={[linked.task,linked.reason].filter(Boolean).join(' · ')}>
    {[linked.workflow ?? 'Unassigned workflow', linked.stage, linked.urgency, linked.priority].filter(Boolean).join(' / ')}
  </span>
  if (boardUrl) return <span className="node-account-chip">
    {[meta?.category && meta.category !== 'needs-classification' ? meta.category.replaceAll('-', ' ') : undefined, available ? 'No verified task link' : 'Work board unavailable'].filter(Boolean).join(' / ')}
  </span>
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
