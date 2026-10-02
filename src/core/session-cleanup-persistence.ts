import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { CleanupError } from './session-cleanup'
import type { Project, Workspace } from '../shared/types'

/** Structural contract shared with PR30. No legacy serializer fallback is safe here. */
interface RetainedStore {
  load(options: { sideline: false }): Promise<Workspace>
  loadReconciled?(): Promise<{ clientId: string; projects: Record<string, { revision: string; project: Project }> }>
  organizerCoordinator?(): {
    commitOrganizer(clientId: string, projectId: string, revision: string, operationId: string,
      proposed: Project, check: () => string | undefined): Promise<{ kind: string; recovery: string; current?: { project: Project } }>
  }
}
const withoutMarkers = (project: Project): Project => {
  const copy = structuredClone(project)
  for (const node of copy.nodes) delete node.cleanupArchiveId
  return copy
}

/** Publish only selected project marker deltas over caller-enrolled raw revisions. Index bytes,
 * siblings, unknown fields, and local execution metadata never pass through a whole-workspace save.
 * Enrollment occurs only on an authorized save, so preview stays read-only. */
export function createCleanupPersistence(store: RetainedStore) {
  const originals = new WeakMap<Workspace, Workspace>()
  const requireContract = () => {
    if (!store.loadReconciled || !store.organizerCoordinator)
      throw new CleanupError('revision_aware_cleanup_required', 503)
  }
  return {
    async load(): Promise<Workspace> {
      requireContract()
      const workspace = await store.load({ sideline: false })
      originals.set(workspace, structuredClone(workspace))
      return workspace
    },
    async save(workspace: Workspace, check: () => string | undefined = () => undefined): Promise<void> {
      requireContract()
      const before = originals.get(workspace)
      if (!before) throw new CleanupError('cleanup_base_not_retained')
      const proposed = structuredClone(workspace)
      const stripped = structuredClone(proposed)
      for (const project of stripped.projects) for (const node of project.nodes) {
        const original = before.projects.find(p => p.id === project.id)?.nodes.find(n => n.id === node.id)
        if (!original) throw new CleanupError('cleanup_shape_changed')
        if (original.cleanupArchiveId === undefined) delete node.cleanupArchiveId
        else node.cleanupArchiveId = original.cleanupArchiveId
      }
      if (!isDeepStrictEqual(stripped, before)) throw new CleanupError('cleanup_non_marker_change')
      const changed = proposed.projects.filter(p => !isDeepStrictEqual(p, before.projects.find(b => b.id === p.id)))
      if (!changed.length) return
      // Capture one enrollment for this operation; never upgrade a failed write to a newer base.
      const enrolled = await store.loadReconciled!()
      for (const project of changed) {
        const bound = enrolled.projects[project.id]
        const original = before.projects.find(p => p.id === project.id)!
        if (project.ssh || !bound || !isDeepStrictEqual(bound.project, original))
          throw new CleanupError('cleanup_revision_changed')
        if (!isDeepStrictEqual(withoutMarkers(project), withoutMarkers(original)))
          throw new CleanupError('cleanup_non_marker_change')
      }
      const operationId = randomUUID()
      for (const project of changed) {
        const bound = enrolled.projects[project.id]
        const outcome = await store.organizerCoordinator!().commitOrganizer(enrolled.clientId,
          project.id, bound.revision, `cleanup:${operationId}:${project.id}`, project, check)
        if (!['committed', 'already-applied'].includes(outcome.kind) || !outcome.current ||
          !isDeepStrictEqual(outcome.current.project.nodes, project.nodes))
          throw new CleanupError(`cleanup_publication_${outcome.kind}_recovery_required`)
      }
      originals.set(workspace, proposed)
    }
  }
}
