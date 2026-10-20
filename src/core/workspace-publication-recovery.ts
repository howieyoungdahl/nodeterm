import { promises as fs } from 'node:fs'
import path from 'node:path'
import { renameAtomic } from './fs-atomic'
import { readPublicationFile, revisionOf } from './project-commit-store'
import { publicationFence } from './workspace-publication-platform'
import { workspaceWriterHasExited, type WorkspaceWriterOwner } from './workspace-writer-identity'

export interface PublicationRecovery {
  file: string
  status: 'none' | 'recovered' | 'refused'
  reason?: string
}
const code = (error: unknown) => (error as NodeJS.ErrnoException).code
async function regular(file: string): Promise<string | undefined> {
  try {
    if (!(await fs.lstat(file)).isFile()) throw new Error('Recovery requires regular files')
    return await fs.readFile(file, 'utf8')
  } catch (error) { if (code(error) === 'ENOENT') return undefined; throw error }
}
async function absent(file: string): Promise<boolean> {
  try { await fs.lstat(file); return false }
  catch (error) { if (code(error) === 'ENOENT') return true; throw error }
}
async function directory(dir: string): Promise<void> {
  if (!(await fs.lstat(dir)).isDirectory()) throw new Error('Recovery requires real directories')
}
async function syncDirectory(dir: string): Promise<void> {
  const handle = await fs.open(dir, 'r')
  try { await handle.sync() } finally { await handle.close() }
}
async function retain(file: string, raw: string): Promise<void> {
  let handle, created = true
  try { handle = await fs.open(file, 'wx', 0o600) }
  catch (error) {
    if (code(error) !== 'EEXIST' || await regular(file) !== raw) throw error
    created = false
    handle = await fs.open(file, 'r')
  }
  try { if (created) await handle.writeFile(raw); await handle.sync() }
  finally { await handle.close() }
  await syncDirectory(path.dirname(file))
}
function document(raw: string): void {
  const value = JSON.parse(raw)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid recovery document')
}

/** Explicit host-startup recovery. Ordinary readers never clear locks or replay requests.
 * Preserve the current known winner, or restore the retained previous bytes exclusively.
 * Unknown phases/evidence remain fenced for operator review. */
export async function recoverInterruptedPublication(file: string): Promise<PublicationRecovery> {
  const recovery = path.join(path.dirname(file), '.recovery', path.basename(file))
  const lock = path.join(recovery, 'writer.lock')
  const refused = (reason: string): PublicationRecovery => ({ file, status: 'refused', reason })
  try {
    if (await absent(lock)) return { file, status: 'none' }
    if (!(await absent(publicationFence(file)))) return refused('publication admission is still fenced')
    for (const dir of [path.dirname(file), path.dirname(recovery), recovery, lock]) await directory(dir)
    const lockStat = await fs.lstat(lock), ownerRaw = await regular(path.join(lock, 'owner.json'))
    if (!ownerRaw) return refused('writer identity is missing')
    const owner = JSON.parse(ownerRaw) as WorkspaceWriterOwner
    if (!/^[a-f0-9]{64}$/.test(owner.operation) || !(await workspaceWriterHasExited(owner)))
      return refused('the exact writer is live or its exit cannot be proven')
    if ((await fs.readdir(lock)).join() !== 'owner.json') return refused('unexpected writer lock evidence')
    const op = path.join(recovery, 'operations', owner.operation)
    for (const dir of [path.dirname(op), op]) await directory(dir)
    // A deterministic NONEMPTY archive prevents a second recovering process from moving
    // a later writer's lock after the first recovery has already released this one.
    const retainedLock = path.join(op, 'interrupted-writer.lock')
    if (!(await absent(retainedLock))) return refused('this operation was already recovered')
    const requestRaw = await regular(path.join(op, 'request.json'))
    if (!requestRaw) return refused('the operation intent is incomplete')
    const request = JSON.parse(requestRaw)
    if (typeof request.clientId !== 'string' || typeof request.operationId !== 'string' ||
      revisionOf(`${request.clientId}\0${request.operationId}`) !== owner.operation)
      return refused('the operation does not match its owner')
    const candidate = await regular(path.join(op, 'candidate.json'))
    const displaced = await regular(path.join(op, 'displaced.json'))
    if (candidate !== undefined) document(candidate)
    if (displaced !== undefined) document(displaced)
    const known = async (raw: string): Promise<boolean> =>
      await regular(path.join(recovery, 'versions', `${revisionOf(raw)}.json`)) === raw
    let current = await regular(file)
    if (current === undefined) {
      if (displaced === undefined || !(await known(displaced))) return refused('no acknowledged file can be restored')
      // Keep displaced history independent of a future in-place edit of the restored file.
      const restoration = path.join(op, 'restart-restoration.json')
      await retain(restoration, displaced)
      try { await fs.link(restoration, file) }
      catch (error) { if (code(error) !== 'EEXIST') throw error }
      await syncDirectory(path.dirname(file))
      current = await regular(file)
    }
    if (current === undefined) return refused('the destination is unavailable')
    document(current)
    if (current !== candidate && !((displaced === undefined || current === displaced) && await known(current)))
      return refused('the destination differs from retained publication evidence')
    // Never mint a successful commit receipt for an interrupted request. Its original
    // outcome stays unknown, and a fresh save must enroll the recovered file normally.
    await retain(path.join(op, 'restart-recovery.json'), JSON.stringify({ version: 1,
      ownerRevision: revisionOf(ownerRaw), keptRevision: revisionOf(current), acknowledged: false }) + '\n')
    if (await regular(file) !== current || await regular(path.join(lock, 'owner.json')) !== ownerRaw ||
      (await fs.lstat(lock)).ino !== lockStat.ino) return refused('publication changed during recovery')
    await renameAtomic(lock, retainedLock)
    await syncDirectory(op)
    await syncDirectory(recovery)
    return { file, status: 'recovered' }
  } catch (error) { return refused(error instanceof Error ? error.message : String(error)) }
}

/** Index first, then local refs. Never follow SSH refs or scan unrelated project folders. */
export async function recoverWorkspacePublications(dataDir: string): Promise<PublicationRecovery[]> {
  const index = path.join(dataDir, 'workspace.json')
  const outcomes = [await recoverInterruptedPublication(index)]
  if (await absent(index)) return outcomes
  const value = JSON.parse(await readPublicationFile(index))
  if (value.version !== 3 || !Array.isArray(value.entries)) return outcomes
  const files = new Set<string>()
  for (const entry of value.entries) {
    if (entry && !entry.ssh && typeof entry.cwd === 'string' && path.isAbsolute(entry.cwd))
      files.add(path.join(entry.cwd, '.nodeterm', 'project.json'))
  }
  for (const file of files) outcomes.push(await recoverInterruptedPublication(file))
  return outcomes
}
