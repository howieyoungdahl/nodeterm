import type { Project, Workspace } from './types'
import type { ProjectMerge } from './project-reconciliation'

export interface ProjectRevisionView { revision: string; project: Project }
export interface WorkspaceRevisionView {
  clientId: string
  workspace: Workspace
  projects: Record<string, ProjectRevisionView>
  indexRevision: string
  unsupported: string[]
  /** Host-enrolled virgin workspace absence; not a revision or permission to reset history. */
  bootstrap?: { kind: 'empty-v3'; token: string }
}
export interface WorkspaceRevisionRequest {
  clientId: string
  operationId: string
  expected: Record<string, string>
  indexRevision: string
  workspace: Workspace
  /** Explicit virgin inline-file intent; missing expected revisions never imply creation. */
  createInline?: string[]
  bootstrap?: { kind: 'empty-v3'; token: string }
}
export interface ProjectRevisionOutcome {
  kind: 'committed' | 'already-applied' | 'conflict' | 'stale-base' | 'busy' |
    'publication-refused' | 'publication-unknown' | 'unavailable'
  recovery: string
  current?: ProjectRevisionView
  merge?: ProjectMerge
  message?: string
}
export interface WorkspaceRevisionOutcome {
  projects: Record<string, ProjectRevisionOutcome>
  index: { kind: ProjectRevisionOutcome['kind']; revision?: string; recovery: string; message?: string }
  /** Empty-index publication is a separate effect, never a whole-workspace acknowledgment. */
  bootstrap?: { kind: ProjectRevisionOutcome['kind']; revision?: string; recovery: string; message?: string }
}
