import { randomUUID } from 'node:crypto'
import { publicationPlatform, publishUntouchedWindowsFile } from './workspace-publication-platform'
import { ProjectCommitStore, PublicationDurabilityError, revisionOf, type PublicationPhase } from './project-commit-store'

/** Only previously observed bytes (or definite virgin absence) authorize a producer. A fresh
 * observe cannot upgrade a stale caller. All outcomes retain the immutable operation intent. */
export async function publishWorkspaceFile(file: string, proposed: string, expected: string | null | undefined,
  phase?: (phase: PublicationPhase, file: string) => Promise<void>, externalNodeIds?: ReadonlySet<string>,
  privateEvidenceRoot?: string): Promise<string> {
  // Cross-project control/context edges already exist in this integration. Only the loaded
  // workspace can supply their endpoints; a dangling ID in request content cannot grant itself.
  const store = new ProjectCommitStore(file, phase ? at => phase(at, file) : undefined,
    file.endsWith('workspace.json') ? new Set() : undefined, externalNodeIds)
  const clientId = 'workspace-producer', operationId = randomUUID()
  if (expected === undefined) throw new Error(`workspace_conflict: E_EXPECTED_REVISION_REQUIRED; recovery at ${store.recovery}`)
  if (publicationPlatform.nativePlatform() === 'win32')
    return publishUntouchedWindowsFile(file, proposed, expected, phase, privateEvidenceRoot)
  let result
  if (expected === null) {
    const doc = JSON.parse(proposed)
    if (doc.version === 3) {
      result = await store.bootstrapIndex({ clientId, operationId, expectedAbsence: true,
        bootstrapToken: revisionOf(operationId), intent: proposed }, async () => undefined)
      if (result.kind === 'committed' && result.current) {
        result = await store.commit({ clientId, operationId: `${operationId}:index`,
          expectedRevision: result.current.revision, proposed }, { check: () => undefined, allowLegacyIdentityChange: true })
      }
    } else result = await store.create({ clientId, operationId, expectedAbsence: true,
      indexRevision: revisionOf(operationId), proposed })
  } else {
    // Retain the observation without changing the caller's expected revision.
    const request = { clientId, operationId, expectedRevision: revisionOf(expected), proposed }
    try {
      await store.observe()
      result = await store.commit(request, { check: () => undefined, allowLegacyIdentityChange: true })
    } catch (error) {
      if (!(error instanceof PublicationDurabilityError)) throw error
      result = await store.retainUnconfirmed(request, error)
    }
  }
  if (!['committed', 'already-applied'].includes(result.kind) || !result.current)
    throw new Error(`workspace_conflict: retained publication ${result.kind}${result.message ? ': ' + result.message : ''}; recovery at ${result.recovery}`)
  return result.current.raw
}
