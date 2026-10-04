import { organizationKey, parseOrganizationMetadata, type OrganizationMetadata } from './kanban-organization'

/** Declared task ownership is descriptive content, never authenticated creator identity. */
export interface AssistantCreation {
  version: 1
  taskId: string
  creationId: string
  declaredOwner: string
}
export function parseAssistantCreation(value: unknown): AssistantCreation | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const v = value as Record<string, unknown>
  if (Object.keys(v).some(k => !['version', 'taskId', 'creationId', 'declaredOwner'].includes(k)) ||
    v.version !== 1 || !organizationKey(v.taskId) || !organizationKey(v.creationId) ||
    typeof v.declaredOwner !== 'string' || !v.declaredOwner || v.declaredOwner.length > 160 || /[\x00-\x1f\x7f]/.test(v.declaredOwner)) return
  return { version: 1, taskId: v.taskId, creationId: v.creationId, declaredOwner: v.declaredOwner }
}
export function creationAdmission(creation: unknown, organization: unknown, projectId: unknown, key?: unknown): string | undefined {
  const c = parseAssistantCreation(creation), o = parseOrganizationMetadata(organization)
  if (!c || !o || o.projectId !== projectId || c.declaredOwner !== o.owner || (key !== undefined && c.creationId !== key))
    return 'assistant_creation_requires_task_owner_organization_and_exact_creation_key'
}
export function creationFromArgs(args: Record<string, string>): { creation?: AssistantCreation; organization?: OrganizationMetadata } {
  return { creation: parseAssistantCreation({ version: 1, taskId: args['task-id'], creationId: args['creation-id'], declaredOwner: args.owner }),
    organization: parseOrganizationMetadata({ owner: args.owner, projectId: args['organization-project'], workstream: args.workstream, functionalRole: args['functional-role'] }) }
}
export const creationFlags = ['task-id', 'creation-id', 'owner', 'workstream', 'functional-role', 'organization-project']
