import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { TMUX_SOCKET } from './tmux-naming'

/** Shared by Desktop and Server on the same host/socket, independent of their data directories.
 * Never steal a lease on age: an interrupted owner requires explicit reviewed recovery. */
export class FileCleanupReservations {
  constructor(private readonly root = path.join(os.tmpdir(), `nodeterm-cleanup-leases-${process.getuid?.() ?? 'user'}`)) {}
  async reserve(names: string[], socket = TMUX_SOCKET): Promise<(() => Promise<void>) | null> {
    await fs.mkdir(this.root, { recursive: true, mode: 0o700 })
    const stat = await fs.lstat(this.root)
    if (!stat.isDirectory() || stat.isSymbolicLink() || process.getuid &&
      (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0)) throw new Error('unsafe-cleanup-lease-directory')
    const owned: { file: string; token: string }[] = []
    const release = async () => {
      for (const { file, token } of owned.splice(0)) {
        // Never remove a replacement or another owner's lease.
        if (await fs.readFile(file, 'utf8') !== token) throw new Error('cleanup-lease-owner-changed')
        await fs.unlink(file)
      }
    }
    try {
      for (const name of [...new Set(names)].sort()) {
        const file = path.join(this.root, createHash('sha256').update(`${socket}\0${name}`).digest('hex') + '.lock')
        const token = JSON.stringify({ version: 1, id: randomUUID(), pid: process.pid, socket, name })
        const handle = await fs.open(file, 'wx', 0o600)
        // Track even an uncertain write: no caller may infer absence from an I/O failure.
        try { await handle.writeFile(token); await handle.sync() } finally { await handle.close() }
        owned.push({ file, token })
      }
      return release
    } catch (error) {
      await release()
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null
      throw error
    }
  }
}
