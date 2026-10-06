import { organizationKey, parseOrganizationMetadata, type OrganizationMetadata } from './kanban-organization'
import { defaultTaskPlanning, parseTaskPlanning, type TaskPlanning } from './task-planning'

/** Declared task ownership is descriptive content, never authenticated creator identity. */
export interface AssistantCreation {
  version: 1
  taskId: string
  creationId: string
  declaredOwner: string
  planning?: TaskPlanning
}
export function parseAssistantCreation(value: unknown): AssistantCreation | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const v = value as Record<string, unknown>
  if (Object.keys(v).some(k => !['version', 'taskId', 'creationId', 'declaredOwner', 'planning'].includes(k)) ||
    v.version !== 1 || !organizationKey(v.taskId) || !organizationKey(v.creationId) ||
    typeof v.declaredOwner !== 'string' || !v.declaredOwner || v.declaredOwner.length > 160 || /[\x00-\x1f\x7f]/.test(v.declaredOwner)) return
  const planning = v.planning === undefined ? undefined : parseTaskPlanning(v.planning)
  if (v.planning !== undefined && (!planning || planning.taskId !== v.taskId)) return
  return { version: 1, taskId: v.taskId, creationId: v.creationId, declaredOwner: v.declaredOwner,
    ...(planning ? { planning } : {}) }
}
export function completeCreationPlanning(creation: AssistantCreation, organization: OrganizationMetadata): AssistantCreation {
  // Fingerprints bind declarations, not clock-dependent assessments. Assess only on first creation.
  return { ...creation, planning: creation.planning ?? defaultTaskPlanning(creation.taskId, organization.functionalRole) }
}
export function creationAdmission(creation: unknown, organization: unknown, projectId: unknown, key?: unknown): string | undefined {
  const c = parseAssistantCreation(creation), o = parseOrganizationMetadata(organization)
  if (!c || !o || o.projectId !== projectId || c.declaredOwner !== o.owner || (key !== undefined && c.creationId !== key))
    return 'assistant_creation_requires_task_owner_organization_and_exact_creation_key'
}
export function creationFromArgs(args: Record<string, string>): { creation?: AssistantCreation; organization?: OrganizationMetadata } {
  let planning: unknown
  if (args['task-planning'] !== undefined) {
    try { planning = JSON.parse(args['task-planning']) } catch { return {} }
  }
  const creation = parseAssistantCreation({ version: 1, taskId: args['task-id'], creationId: args['creation-id'], declaredOwner: args.owner,
    ...(planning !== undefined ? { planning } : {}) })
  const organization = parseOrganizationMetadata({ owner: args.owner, projectId: args['organization-project'], workstream: args.workstream, functionalRole: args['functional-role'] })
  return { creation: creation && organization ? completeCreationPlanning(creation, organization) : creation, organization }
}
export const creationFlags = ['task-id', 'creation-id', 'owner', 'workstream', 'functional-role', 'organization-project', 'task-planning']
