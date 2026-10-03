import { parseNodeOrganization, type NodeOrganization } from '@shared/kanban-organization'
import { useProjects } from '../state/projects'

/** Descriptive content in both node views. This badge never claims ownership authority. */
export function OrganizationBadge({ organization, nodeId }: { organization?: NodeOrganization; nodeId: string }): JSX.Element | null {
  const value = parseNodeOrganization(organization)
  const manual = useProjects((s) => s.projects.find((p) => p.id === value?.metadata.projectId)?.kanban?.manualAssignments?.[nodeId] === true)
  if (!value) return null
  const { owner, workstream, functionalRole } = value.metadata
  const isManual = manual || value.mode === 'manual'
  return <span className="node-account-chip" title={`${owner}: ${workstream} / ${functionalRole}. ${isManual ? 'Manual board placement' : 'Automatic board placement'}.`}>
    {workstream} / {functionalRole}{isManual ? ' (manual)' : ''}
  </span>
}
