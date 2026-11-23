import { assessTaskUrgency, parseTaskPlanning } from '@shared/task-planning'
import type { TaskPlanning } from '@shared/task-planning'
import { useProjects } from '../state/projects'
import { useProjectTaskLink } from '../state/externalTaskBoard'

export function TaskPlanningBadge({ planning, nodeId, boardHasStatus }: { planning?: TaskPlanning; nodeId?: string; boardHasStatus?: boolean }): JSX.Element | null {
  const external = useProjectTaskLink(nodeId)
  const meta = useProjects(s => s.projects.find(p => p.nodes.some(n => n.id === nodeId))?.kanban?.meta?.find(m => m.nodeId === nodeId))
  if (external) {
    if (boardHasStatus && !external.available) return null
    const task = external.task
    if (!task) return <span className="task-planning-facts">
      {meta?.category && meta.category !== 'needs-classification' && <span className="task-planning-chip"
        title="Local category">{meta.category.replaceAll('-', ' ')}</span>}
      {external.manageUrl ? <a className="kanban-card__task" href={external.manageUrl} target="_blank" rel="noreferrer"
        draggable={false} onClick={event => event.stopPropagation()}>Link to task…</a> :
        <span className="task-planning-note">{external.available ? 'No verified task link' : 'Work board unavailable'}</span>}
    </span>
    return <span className="task-planning-facts" aria-label="Task details">
      <span className="task-planning-chip task-planning-chip--workflow" title={`Workflow for ${task.task}`}>
        {task.workflow ?? 'Unassigned workflow'}
      </span>
      <span className="task-planning-chip" title="Work Board stage">{task.stage}</span>
      {task.urgency && <span className="task-planning-timing" data-urgent={task.urgent || undefined}
        title={task.reason ?? 'Work Board urgency'}>{task.urgency}</span>}
      {task.priority && <span className="task-planning-rank" title="Assigned priority">{task.priority}</span>}
    </span>
  }
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
