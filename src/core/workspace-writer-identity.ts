import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'

/** Linux process birth evidence, not a PID/age-based stale-lock heuristic. */
export interface WorkspaceWriterIdentity {
  host: string
  boot: string
  namespace: string
  start: string
  uid: number
}
export interface WorkspaceWriterOwner {
  pid: number
  operation: string
  identity?: WorkspaceWriterIdentity
}

const startTime = (stat: string): string => {
  const value = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/)[19]
  if (!/^\d+$/.test(value ?? '')) throw new Error('Invalid process birth evidence')
  return value
}
let identity: Promise<WorkspaceWriterIdentity | undefined> | undefined
export function workspaceWriterIdentity(): Promise<WorkspaceWriterIdentity | undefined> {
  return identity ??= (async () => {
    if (process.platform !== 'linux') return undefined
    try {
      const [machine, boot, namespace, stat] = await Promise.all([
        fs.readFile('/etc/machine-id', 'utf8'), fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8'),
        fs.readlink('/proc/self/ns/pid'), fs.readFile('/proc/self/stat', 'utf8')
      ])
      if (!/^[a-f0-9]{32}$/.test(machine.trim()) || !/^[a-f0-9-]{36}$/.test(boot.trim())) return undefined
      return { host: createHash('sha256').update(`${machine.trim()}\0${os.hostname()}`).digest('hex'),
        boot: boot.trim(), namespace, start: startTime(stat), uid: process.getuid!() }
    } catch { return undefined }
  })()
}

export async function workspaceWriterOwner(operation: string): Promise<WorkspaceWriterOwner> {
  return { pid: process.pid, operation, identity: await workspaceWriterIdentity() }
}

/** A foreign host/namespace, legacy owner, failed probe or live exact process refuses. */
export async function workspaceWriterHasExited(owner: WorkspaceWriterOwner): Promise<boolean> {
  const current = await workspaceWriterIdentity(), held = owner.identity
  if (!current || !held || held.host !== current.host || held.uid !== current.uid ||
    !/^[a-f0-9-]{36}$/.test(held.boot) || !/^pid:\[\d+\]$/.test(held.namespace) ||
    !/^\d+$/.test(held.start) || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) return false
  if (held.boot !== current.boot) return true
  if (held.namespace !== current.namespace) return false
  try { return startTime(await fs.readFile(`/proc/${owner.pid}/stat`, 'utf8')) !== held.start }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' }
}
