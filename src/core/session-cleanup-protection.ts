import fs from 'node:fs/promises'
import path from 'node:path'
import { sessionName } from './tmux-naming'
import { FileCleanupReservations } from './session-cleanup-reservations'

/** Both runtime compositions consume exactly these fail-closed guards. */
export function cleanupReaperGuards(dataDir: string, leases = new FileCleanupReservations(),
  extraNodeIds: () => Promise<string[]> = async () => []) {
  return {
    reserveKill: (socket: string, name: string) => leases.reserve([name], socket),
    protectedSessions: async () => [...await readCleanupProtection(path.join(dataDir, 'workspace.json')),
      ...(await extraNodeIds()).map(sessionName)]
  }
}

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
/** Raw read, never a WorkspaceStore fallback to empty. Missing, corrupt or publishing metadata
 * freezes reaping. Checking both bytes and PR30's writer lock fences observed publication races. */
export async function readCleanupProtection(indexPath: string): Promise<string[]> {
  const read = async (file: string): Promise<Record<string, unknown>> => {
    const lock = path.join(path.dirname(file), '.recovery', path.basename(file), 'writer.lock')
    const unlocked = async () => {
      try { await fs.lstat(lock); throw new Error('cleanup-protection-publication-busy') }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
    }
    await unlocked()
    const raw = await fs.readFile(file, 'utf8')
    const value: unknown = JSON.parse(raw)
    if (!object(value) || await fs.readFile(file, 'utf8') !== raw) throw new Error('cleanup-protection-unavailable')
    await unlocked()
    return value
  }
  const index = await read(indexPath)
  const names = new Set<string>()
  const inspect = (project: Record<string, unknown>) => {
    if (!Array.isArray(project.nodes)) throw new Error('cleanup-protection-invalid-project')
    for (const node of project.nodes) {
      if (!object(node) || typeof node.id !== 'string' || !/^[A-Za-z0-9._:-]{1,200}$/.test(node.id))
        throw new Error('cleanup-protection-invalid-node')
      if (node.cleanupArchiveId) names.add(sessionName(node.id))
    }
  }
  if (index.version === 2 && Array.isArray(index.projects)) {
    for (const project of index.projects) { if (!object(project)) throw new Error('cleanup-protection-invalid-project'); inspect(project) }
  } else if (index.version === 3 && Array.isArray(index.entries)) {
    for (const entry of index.entries) {
      if (!object(entry)) throw new Error('cleanup-protection-invalid-entry')
      if (entry.ssh) { if (object(entry.cache)) inspect(entry.cache); continue }
      if (typeof entry.cwd === 'string') inspect(await read(path.join(entry.cwd, '.nodeterm', 'project.json')))
      else if (entry.dataFile === true && typeof entry.id === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(entry.id))
        inspect(await read(path.join(path.dirname(indexPath), 'inline-projects', `${entry.id}.json`)))
      else if (object(entry.project)) inspect(entry.project)
      else throw new Error('cleanup-protection-invalid-entry')
    }
  } else throw new Error('cleanup-protection-unsupported-index')
  return [...names]
}
