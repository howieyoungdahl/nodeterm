import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

export interface RecoveryRetentionPolicy { days: number; minVersions: number; batchSize: number }
const number = (value: string | undefined, fallback: number, min: number, max: number) => {
  const parsed = Number(value)
  return value !== undefined && value.trim() !== '' && Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.floor(parsed))) : fallback
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
const expiry = '{"version":1}\n'
interface Candidate { file: string; mtime: number; operation: boolean; expired?: boolean }

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
      if (!stat?.isDirectory()) continue
      const marker = path.join(file, 'expired.json')
      let expired = false
      try { expired = (await fs.lstat(marker)).isFile() && await fs.readFile(marker, 'utf8') === expiry }
      catch (error) { if (!missing(error)) continue }
      // A crash after expiry enrollment resumes payload cleanup regardless of the new mtime.
      if (expired && (await fs.readdir(file)).every(name => name === 'expired.json')) continue
      if (expired || stat.mtimeMs < oldest) result.push({ file, mtime: stat.mtimeMs, operation: true, expired })
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
        if (!stat.isDirectory() || process.platform === 'win32') continue
        if (!candidate.expired) {
          try {
            const receiptFile = path.join(candidate.file, 'receipt.json')
            if (!(await fs.lstat(receiptFile)).isFile()) continue
            const receipt = JSON.parse(await fs.readFile(receiptFile, 'utf8')) as { kind?: string }
            if (!['committed', 'already-applied'].includes(receipt.kind ?? '')) continue
          } catch { continue }
        }
        const entries = await fs.readdir(candidate.file, { withFileTypes: true })
        if (entries.length > 16 || entries.some(entry => !entry.isFile())) continue
        {
          // Permanently retire the key BEFORE removing request.json. Writers check this both
          // before read-back and under writer.lock. A crash cannot turn a partial prune into
          // permission to replay, and concurrent pruners only unlink immutable expired payloads.
          const marker = path.join(candidate.file, 'expired.json')
          let handle
          try { handle = await fs.open(marker, 'wx', 0o600) }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
          if (handle) {
            try { await handle.writeFile(expiry); await handle.sync() } finally { await handle.close() }
          }
          if (!(await fs.lstat(marker)).isFile() || await fs.readFile(marker, 'utf8') !== expiry) continue
          // A resumed or concurrent pass must flush the existing marker too. Its bytes may
          // have been observed before the process that created it finished syncing.
          const retained = await fs.open(marker, 'r')
          try { await retained.sync() } finally { await retained.close() }
          // POSIX directory durability is required before deleting payloads. Unsupported
          // platforms defer cleanup; do not acknowledge a marker that could disappear alone.
          const directory = await fs.open(candidate.file, 'r')
          try { await directory.sync() } finally { await directory.close() }
        }
        for (const entry of entries.filter(entry => !['receipt.json', 'expired.json'].includes(entry.name))) {
          try { await fs.unlink(path.join(candidate.file, entry.name)) }
          catch (error) { if (!missing(error)) throw error }
        }
        try { await fs.unlink(path.join(candidate.file, 'receipt.json')) }
        catch (error) { if (!missing(error)) throw error }
        // Keep only the small expiry marker. Removing it would reopen the operation-ID race.
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
