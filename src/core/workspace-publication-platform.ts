import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { renameAtomic, writeFileAtomic } from './fs-atomic'

export const publicationPlatform = { nativePlatform: (): NodeJS.Platform => process.platform }
const code = (error: unknown) => (error as NodeJS.ErrnoException)?.code
export const publicationFence = (file: string) => path.join(path.dirname(file),
  `.workspace-publication-${createHash('sha256').update(path.basename(file)).digest('hex')}.lock`)

/** Windows ordinary saves and retained enrollment use the SAME exclusive admission fence.
 * No age/PID stealing. An interruption leaves evidence and refuses subsequent writers. */
export async function assertPublicationAdmission(file: string): Promise<void> {
  if (!(await absent(publicationFence(file)))) throw new Error(`workspace_conflict: publication admission unavailable at ${publicationFence(file)}`)
}
export async function withPublicationAdmissionFence<T>(file: string, work: () => Promise<T>): Promise<T> {
  const lock = publicationFence(file)
  try { await fs.mkdir(lock, { mode: 0o700 }) }
  catch (error) { throw new Error(`workspace_conflict: publication admission unavailable at ${lock}`, { cause: error }) }
  try { return await work() }
  finally { await fs.rm(lock, { recursive: true }) }
}

function portableEvidence(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  if (Array.isArray(value)) return value.some(portableEvidence)
  return Object.entries(value).some(([key, held]) =>
    key === '_reconciliation' || key === 'cleanupArchiveId' || portableEvidence(held))
}
async function absent(file: string): Promise<boolean> {
  try { await fs.lstat(file); return false }
  catch (error) { if (code(error) === 'ENOENT') return true; throw error }
}

/** Explicit Windows degradation, ONLY before retained enrollment. Successful saves promise
 * ordinary atomic visibility, not retained/power-loss durability. Actual displaced bytes are
 * compared and exclusive links prevent overwriting a competing destination. Unknown outcomes
 * keep this operation's lock, intent, original and candidate for explicit recovery. */
export async function publishUntouchedWindowsFile(file: string, proposed: string, expected: string | null,
  phase?: (phase: 'before-displace' | 'before-publish' | 'published', file: string) => Promise<void>,
  privateEvidenceRoot?: string): Promise<string> {
  const lock = publicationFence(file)
  try { await fs.mkdir(lock, { mode: 0o700 }) }
  catch (error) { throw new Error(`workspace_conflict: ordinary Windows publication fenced at ${lock}`, { cause: error }) }
  let started = false, finished = false, mutationAttempted = false
  const displaced = path.join(lock, 'displaced.json'), candidate = path.join(lock, 'candidate.json')
  const restore = async () => {
    try { await fs.link(displaced, file) }
    catch (error) { if (!['EEXIST', 'ENOENT'].includes(code(error) ?? '')) throw error }
  }
  const requireUntouched = async () => {
    const recovery = path.join(path.dirname(file), '.recovery', path.basename(file))
    const evidenceRoot = privateEvidenceRoot ?? (path.basename(file) === 'workspace.json' ? path.dirname(file) : undefined)
    const privateEvidence = evidenceRoot
      ? ['cleanup-enrollments', 'session-cleanup'].map(leaf => path.join(evidenceRoot, leaf)) : []
    if (!(await absent(recovery)) || (await Promise.all(privateEvidence.map(absent))).some(no => !no) ||
      portableEvidence(JSON.parse(proposed))) throw new Error('workspace_conflict: E_RETAINED_PLATFORM_UNSUPPORTED')
  }
  try {
    // Any history, even empty/invalid/unconfirmed, forbids downgrade. Ordinary host producers
    // also supply the index directory to fence private transactions before any folder writes.
    await requireUntouched()
    const missing = await absent(file)
    if (!missing && !(await fs.lstat(file)).isFile()) throw new Error('workspace_conflict: E_REGULAR_FILE_REQUIRED')
    const current = missing ? null : await fs.readFile(file, 'utf8')
    if (current !== expected || (current !== null && portableEvidence(JSON.parse(current))))
      throw new Error('workspace_conflict: E_RETAINED_OR_STALE_WINDOWS_BASE')
    // Intent is complete before the first displacement; the directory itself is the crash fence.
    await writeFileAtomic(path.join(lock, 'request.json'), JSON.stringify({ version: 1, operationId: randomUUID(),
      file, expected, proposed, durability: 'ordinary-windows-unconfirmed-directory' }), { mode: 0o600 })
    await writeFileAtomic(candidate, proposed, { mode: 0o600 })
    // These are this operation's private files. Use write-capable handles for portable flush;
    // a read-only Windows handle cannot supply that guarantee. Directory durability is unclaimed.
    for (const staged of [path.join(lock, 'request.json'), candidate]) {
      const handle = await fs.open(staged, 'r+')
      try { await handle.sync() } finally { await handle.close() }
    }
    started = true
    if (expected !== null) {
      await phase?.('before-displace', file)
      mutationAttempted = true
      try { await renameAtomic(file, displaced) }
      catch (error) {
        if (['EPERM', 'EACCES', 'EBUSY', 'ENOSPC'].includes(code(error) ?? '') && await absent(displaced) &&
          await fs.readFile(file, 'utf8') === expected) mutationAttempted = false
        throw error
      }
      if (await fs.readFile(displaced, 'utf8') !== expected) {
        await restore()
        throw new Error('workspace_conflict: external Windows bytes retained before publication')
      }
    }
    await phase?.('before-publish', file)
    try { await requireUntouched() }
    catch (error) { await restore(); throw error }
    mutationAttempted = true
    try { await fs.link(candidate, file) }
    catch (error) { await restore(); throw error }
    await phase?.('published', file)
    if (await fs.readFile(file, 'utf8') !== proposed)
      throw new Error('workspace_conflict: Windows publication outcome unknown; evidence retained')
    finished = true
    return proposed
  } catch (error) {
    // A definite refusal before changing the destination must not disable ordinary Windows
    // retry forever. Retain this exact rejected intent separately. Races, displaced files and
    // unknown outcomes keep the publication fence and require explicit recovery instead.
    if (started && !mutationAttempted && await absent(displaced) &&
      (await absent(file) ? null : await fs.readFile(file, 'utf8')) === expected) {
      const refused = path.join(path.dirname(file), '.ordinary-save-refusals')
      await fs.mkdir(refused, { recursive: true, mode: 0o700 })
      const attempt = path.join(refused, randomUUID())
      await fs.mkdir(attempt, { mode: 0o700 })
      await writeFileAtomic(path.join(attempt, 'outcome.json'), JSON.stringify({ version: 1, file,
        state: 'refused-before-mutation', directoryDurability: 'unconfirmed' }), { mode: 0o600 })
      await renameAtomic(lock, path.join(attempt, 'evidence'))
    }
    throw error
  } finally {
    if (!started || finished) await fs.rm(lock, { recursive: true, force: true })
  }
}
