import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

export interface RecoveryRetentionPolicy { days: number; minVersions: number; batchSize: number }
const number = (value: string | undefined, fallback: number, min: number, max: number) => {
  const parsed = Number(value)
  return value !== undefined && Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.floor(parsed))) : fallback
}
export function recoveryRetentionPolicy(): RecoveryRetentionPolicy {
  return {
    days: number(process.env.NODETERM_RECOVERY_RETENTION_DAYS, 7, 1, 3650),
    minVersions: number(process.env.NODETERM_RECOVERY_MIN_VERSIONS, 200, 1, 100000),
    batchSize: number(process.env.NODETERM_RECOVERY_PRUNE_BATCH, 64, 1, 256)
  }
}
const hash = (raw: string) => createHash('sha256').update(raw).digest('hex')
const leaf = /^[a-f0-9]{64}$/
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
async function realDirectory(dir: string): Promise<boolean> {
  try { return (await fs.lstat(dir)).isDirectory() } catch (error) { if (missing(error)) return false; throw error }
}
interface Candidate { file: string; mtime: number; operation: boolean }

/** Immutable history only. No publication destination, tombstone, lock or unknown operation
 * is removed. Planning and deletion are asynchronous and never awaited by a publication.
 * A crash merely leaves more expired history for the next pass; no prune lock can strand saves. */
export class RecoveryRetention {
  private candidates?: Candidate[]
  constructor(readonly file: string, private policy: RecoveryRetentionPolicy = recoveryRetentionPolicy(),
    private now: () => number = Date.now) {}
  private get recovery() { return path.join(path.dirname(this.file), '.recovery', path.basename(this.file)) }
  private async idle(): Promise<boolean> {
    for (const entry of [path.dirname(this.file), path.dirname(this.recovery), this.recovery])
      if (!await realDirectory(entry)) return false
    if (!(await fs.lstat(this.file)).isFile()) return false
    try { await fs.lstat(path.join(this.recovery, 'writer.lock')); return false }
    catch (error) { if (!missing(error)) throw error }
    return true
  }
  private async plan(): Promise<Candidate[]> {
    const versions = path.join(this.recovery, 'versions'), operations = path.join(this.recovery, 'operations')
    if (!await realDirectory(versions)) return []
    const rows: Candidate[] = []
    for (const name of await fs.readdir(versions)) {
      if (!name.endsWith('.json') || !leaf.test(name.slice(0, -5))) continue
      const file = path.join(versions, name), stat = await fs.lstat(file).catch(() => undefined)
      if (stat?.isFile()) rows.push({ file, mtime: stat.mtimeMs, operation: false })
    }
    rows.sort((a, b) => b.mtime - a.mtime || a.file.localeCompare(b.file))
    const cutoff = this.now() - this.policy.days * 86400000
    const current = hash(await fs.readFile(this.file, 'utf8'))
    const kept = rows.filter((row, i) => i < this.policy.minVersions || row.mtime >= cutoff || path.basename(row.file) === `${current}.json`)
    const keep = new Set(kept.map(row => row.file))
    const oldest = Math.min(cutoff, ...kept.map(row => row.mtime))
    const result = rows.filter(row => !keep.has(row.file))
    if (await realDirectory(operations)) for (const name of await fs.readdir(operations)) {
      if (!leaf.test(name)) continue
      const file = path.join(operations, name), stat = await fs.lstat(file).catch(() => undefined)
      if (stat?.isDirectory() && stat.mtimeMs < oldest) result.push({ file, mtime: stat.mtimeMs, operation: true })
    }
    return result.sort((a, b) => a.mtime - b.mtime)
  }
  async pass(): Promise<{ removed: number; remaining: number }> {
    if (!await this.idle()) return { removed: 0, remaining: this.candidates?.length ?? 0 }
    this.candidates ??= await this.plan()
    let removed = 0
    // Bound attempts too: a backlog of interrupted operations cannot turn a pass into a sweep.
    for (let attempts = 0; attempts < this.policy.batchSize && this.candidates.length; attempts++) {
      if (!await this.idle()) break
      const candidate = this.candidates.shift()!
      // A cached plan never authorizes following a replaced versions/operations directory.
      if (!await realDirectory(path.dirname(candidate.file))) continue
      const stat = await fs.lstat(candidate.file).catch(() => undefined)
      if (!stat || stat.mtimeMs !== candidate.mtime || stat.isSymbolicLink()) continue
      if (candidate.operation) {
        if (!stat.isDirectory()) continue
        let receipt: { kind?: string }
        try {
          const receiptFile = path.join(candidate.file, 'receipt.json')
          if (!(await fs.lstat(receiptFile)).isFile()) continue
          receipt = JSON.parse(await fs.readFile(receiptFile, 'utf8'))
        } catch { continue }
        if (!['committed', 'already-applied'].includes(receipt.kind ?? '')) continue
        // Delete the receipt last. An interrupted partial prune stays recognizable on restart.
        const entries = await fs.readdir(candidate.file, { withFileTypes: true })
        if (entries.length > 16 || entries.some(entry => !entry.isFile())) continue
        for (const entry of entries.filter(entry => entry.name !== 'receipt.json'))
          await fs.unlink(path.join(candidate.file, entry.name))
        await fs.unlink(path.join(candidate.file, 'receipt.json'))
        await fs.rmdir(candidate.file)
      } else {
        if (!stat.isFile()) continue
        // Recheck at the deletion boundary, not merely when a potentially old plan was built.
        if (path.basename(candidate.file) === `${hash(await fs.readFile(this.file, 'utf8'))}.json`) continue
        if (!await this.idle()) { this.candidates.unshift(candidate); break }
        await fs.unlink(candidate.file)
      }
      removed++
    }
    const remaining = this.candidates.length
    if (!remaining) this.candidates = undefined
    return { removed, remaining }
  }
}

const pending = new Map<string, { retention: RecoveryRetention; next: number }>()
let timer: ReturnType<typeof setTimeout> | undefined
/** Registration only. One process-wide worker handles one file per tick, after boot settles. */
export function scheduleRecoveryRetention(file: string): void {
  if (process.env.NODETERM_RECOVERY_RETENTION === '0' || pending.has(file) || pending.size >= 128) return
  pending.set(file, { retention: new RecoveryRetention(file), next: Date.now() + 60000 })
  if (timer) return
  const run = async () => {
    const entry = [...pending].find(([, value]) => value.next <= Date.now())
    if (entry) {
      const [key, value] = entry
      pending.delete(key)
      let delay = 3600000
      try { if ((await value.retention.pass()).remaining) delay = 5000 } catch (error) {
        delay = 60000
        if (!missing(error)) console.warn('[recovery] Retention pass deferred:', String(error))
      }
      pending.set(key, { ...value, next: Date.now() + delay })
    }
    timer = setTimeout(() => void run(), number(process.env.NODETERM_RECOVERY_PRUNE_INTERVAL_MS, 5000, 1000, 3600000))
    timer.unref()
  }
  timer = setTimeout(() => void run(), 60000)
  timer.unref()
}
