import { isSafeNodeId } from './safe-id'
import type { CanvasNodeState, ProjectKanban } from './types'

/** Content only. Neither this label nor a saved placement grants creator authority. */
export interface OrganizationMetadata {
  owner: string
  projectId: string
  workstream: string
  functionalRole: string
}

export interface OrganizationPolicy {
  version: 1
  projectId: string
  roles: Record<string, string>
  overrides?: Array<{ workstream: string; functionalRole: string; columnId: string }>
}

export interface NodeOrganization {
  version: 1
  mode: 'auto' | 'manual'
  metadata: OrganizationMetadata
  columnId: string | null
  sequence: number
  receiptId?: string
}

const forbidden = new Set(['__proto__', 'constructor', 'prototype'])
export const organizationId = (v: unknown): v is string =>
  typeof v === 'string' && isSafeNodeId(v) && !forbidden.has(v)
const label = (v: unknown): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= 160 && !/[\u0000-\u001f\u007f]/.test(v)
const dimension = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-Za-z0-9._-]{1,80}$/.test(v) && !forbidden.has(v)
export const organizationKey = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-Za-z0-9._-]{8,128}$/.test(v) && !forbidden.has(v)
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const keys = (v: Record<string, unknown>, allowed: string[]) =>
  Object.keys(v).every((k) => allowed.includes(k))

export function parseOrganizationMetadata(v: unknown): OrganizationMetadata | undefined {
  if (!object(v) || !keys(v, ['owner', 'projectId', 'workstream', 'functionalRole']) ||
    !label(v.owner) || !organizationId(v.projectId) || !dimension(v.workstream) ||
    !dimension(v.functionalRole)) return undefined
  return { owner: v.owner, projectId: v.projectId, workstream: v.workstream, functionalRole: v.functionalRole }
}

export function parseOrganizationPolicy(v: unknown): OrganizationPolicy | undefined {
  if (!object(v) || !keys(v, ['version', 'projectId', 'roles', 'overrides']) ||
    v.version !== 1 || !organizationId(v.projectId) || !object(v.roles) ||
    Object.keys(v.roles).length > 64 ||
    !Object.entries(v.roles).every(([k, id]) => dimension(k) && organizationId(id))) return undefined
  let overrides: OrganizationPolicy['overrides']
  if (v.overrides !== undefined) {
    if (!Array.isArray(v.overrides) || v.overrides.length > 128) return undefined
    const seen = new Set<string>()
    overrides = []
    for (const row of v.overrides) {
      if (!object(row) || !keys(row, ['workstream', 'functionalRole', 'columnId']) ||
        !dimension(row.workstream) || !dimension(row.functionalRole) || !organizationId(row.columnId)) return undefined
      const key = JSON.stringify([row.workstream, row.functionalRole])
      if (seen.has(key)) return undefined
      seen.add(key)
      overrides.push({ workstream: row.workstream, functionalRole: row.functionalRole, columnId: row.columnId })
    }
  }
  return { version: 1, projectId: v.projectId, roles: { ...v.roles } as Record<string, string>,
    ...(overrides ? { overrides } : {}) }
}

export function parseNodeOrganization(v: unknown): NodeOrganization | undefined {
  if (!object(v) || !keys(v, ['version', 'mode', 'metadata', 'columnId', 'sequence', 'receiptId']) ||
    v.version !== 1 || (v.mode !== 'auto' && v.mode !== 'manual') ||
    (v.columnId !== null && !organizationId(v.columnId)) ||
    !Number.isSafeInteger(v.sequence) || (v.sequence as number) < 1 ||
    (v.receiptId !== undefined && !organizationId(v.receiptId))) return undefined
  const metadata = parseOrganizationMetadata(v.metadata)
  if (!metadata) return undefined
  return { version: 1, mode: v.mode, metadata, columnId: v.columnId as string | null,
    sequence: v.sequence as number, ...(v.receiptId ? { receiptId: v.receiptId as string } : {}) }
}

/** Invalid markers become unmanaged content, never consent to adopt an existing node. */
export function sanitizeOrganizationNodes(nodes: CanvasNodeState[], board?: ProjectKanban): CanvasNodeState[] {
  return nodes.map((n) => {
    const parsed = parseNodeOrganization(n.organization)
    const organization = parsed && board?.manualAssignments?.[n.id] === true
      ? { ...parsed, mode: 'manual' as const } : parsed
    const { organization: _raw, ...rest } = n
    return organization ? { ...rest, organization } : rest
  })
}

/** Board intent is separate from assignment presence: Ungrouped and order-only moves count. */
export function withManualAssignment(board: ProjectKanban, nodeId: string): ProjectKanban {
  if (!organizationId(nodeId)) return board
  return { ...board, manualAssignments: { ...board.manualAssignments, [nodeId]: true },
    manualAssignmentVersions: { ...board.manualAssignmentVersions, [nodeId]: globalThis.crypto?.randomUUID?.() ??
      `manual-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}` } }
}
