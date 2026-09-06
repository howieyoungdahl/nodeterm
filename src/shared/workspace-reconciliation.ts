import type { Project, Workspace } from './types'
import type { ProjectMerge } from './project-reconciliation'

export interface ProjectRevisionView { revision: string; project: Project }
export interface WorkspaceRevisionView {
  clientId: string
  workspace: Workspace
  projects: Record<string, ProjectRevisionView>
  indexRevision: string
  unsupported: string[]
}
export interface WorkspaceRevisionRequest {
  clientId: string
  operationId: string
  expected: Record<string, string>
  indexRevision: string
  workspace: Workspace
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
}
