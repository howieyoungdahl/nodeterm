import { parseNodeOrganization, parseOrganizationMetadata, parseOrganizationPolicy } from '../shared/kanban-organization'
import type { NodeOrganization, OrganizationMetadata } from '../shared/kanban-organization'
import type { CanvasNodeState, Project, ProjectKanban } from '../shared/types'

export interface NodePlacement {
  columnId: string | null
  index: number
  previous: string | null
  next: string | null
}

/** Raw assignment IDs, including dangling IDs. Never interpret a removed column as consent. */
export function nodePlacement(board: ProjectKanban | undefined, id: string): NodePlacement {
  const list = board?.assignments ?? []
  const index = list.findIndex((a) => a.nodeId === id)
  return { columnId: index < 0 ? null : list[index].columnId, index,
    previous: index > 0 ? list[index - 1].nodeId : null,
    next: index >= 0 && index + 1 < list.length ? list[index + 1].nodeId : null }
}

export function placeNode(board: ProjectKanban | undefined, id: string, target: NodePlacement): ProjectKanban | undefined {
  if (!board) return board
  const assignments = board.assignments.filter((a) => a.nodeId !== id)
  if (target.columnId !== null) {
    const before = target.next ? assignments.findIndex((a) => a.nodeId === target.next) : -1
    const after = target.previous ? assignments.findIndex((a) => a.nodeId === target.previous) : -1
    const index = before >= 0 ? before : after >= 0 ? after + 1 :
      target.index < 0 ? assignments.length : Math.min(target.index, assignments.length)
    assignments.splice(index, 0, { nodeId: id, columnId: target.columnId })
  }
  return { ...board, assignments }
}

export interface OrganizationPlan {
  action: 'apply' | 'skip'
  reason: string
  from: NodePlacement
  to: string | null
  organization?: NodeOrganization
}

/** Caller supplies server-owned creation/receipt evidence; project content never grants it. */
export function planOrganization(project: Project, node: CanvasNodeState, metadata: OrganizationMetadata,
  authority: { attested: boolean; creating?: boolean; managed?: NodeOrganization }): OrganizationPlan {
  const from = nodePlacement(project.kanban, node.id)
  const skip = (reason: string): OrganizationPlan => ({ action: 'skip', reason, from, to: from.columnId })
  if (!authority.attested) return skip('assistant_origin_unknown')
  if (project.ssh || project.unavailable || node.kind !== 'terminal') return skip('unsupported_target')
  if (node.role !== 'worker') return skip('primary_node')
  if (node.pinned || node.manualPlacement) return skip('pinned_or_manually_placed')
  const parsed = parseOrganizationMetadata(metadata)
  if (!parsed || metadata.projectId !== project.id) return skip('metadata_project_mismatch')
  const existing = parseNodeOrganization(node.organization)
  if (project.kanban?.manualAssignments?.[node.id] === true || existing?.mode === 'manual') return skip('manual_choice')
  if (!authority.creating) {
    if (!existing || !authority.managed || JSON.stringify(existing) !== JSON.stringify(authority.managed)) return skip('unmanaged_or_changed_provenance')
    if (existing.columnId !== from.columnId) return skip('assignment_drift')
  } else if (from.columnId !== null || existing) return skip('existing_assignment')
  const policy = parseOrganizationPolicy(project.kanbanOrganization)
  const route = policy?.projectId === project.id
    ? policy.overrides?.find((r) => r.workstream === metadata.workstream && r.functionalRole === metadata.functionalRole)?.columnId ??
      (Object.hasOwn(policy.roles, metadata.functionalRole) ? policy.roles[metadata.functionalRole] : undefined)
    : undefined
  const columns = project.kanban?.columns ?? []
  const to = route && columns.filter((c) => c?.id === route).length === 1 ? route : null
  if (existing && from.columnId === to && JSON.stringify(existing.metadata) === JSON.stringify(metadata)) return skip('already_current')
  return { action: 'apply', reason: route && to ? 'mapped' : 'ungrouped_fallback', from, to,
    organization: { version: 1, mode: 'auto', metadata: { ...metadata }, columnId: to, sequence: (existing?.sequence ?? 0) + 1 } }
}
