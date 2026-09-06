// A layout grant is valid only after publication, and only for its exact token. Acquisitions,
// releases and guarded effects share a queue and a file lock. A corrupt/unreadable store or a
// leftover lock refuses automation; it must never turn uncertain ownership into a free lease.
import { randomUUID } from 'node:crypto'
import { closeSync, openSync, readFileSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { writeFileAtomic } from '../fs-atomic'
import { platform } from '../platform'

export const LAYOUT_LEASE_TTL_MS = 60_000

export interface LayoutLease {
  holder: string
  at: number
  /** Missing only on a legacy record, which may block admission but never authorize an effect. */
  token?: string
}

export type LeaseRefusal = {
  ok: false
  reason: 'lease-held' | 'lease-stale' | 'source-unavailable'
  holder?: string
}

export interface LayoutLeaseStoreDeps {
  /** null means proven ENOENT; throw for unreadable storage. */
  read?: () => string | null
  write?: (text: string) => Promise<void>
  now?: () => number
  ttlMs?: number
  /** Disposable files in tests; production uses the shell's private data directory. */
  filePath?: string
}

// Distinct store instances over the same file must serialize too. Memory adapters share their
// read function as the key and are process-local fixtures, not cross-process storage adapters.
const queues = new Map<unknown, Promise<void>>()

export class LayoutLeaseStore {
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly readFile: () => string | null
  private readonly writeFile: (text: string) => Promise<void>
  private readonly filePath: string | undefined
  private readonly queueKey: unknown

  constructor(deps: LayoutLeaseStoreDeps = {}) {
    this.now = deps.now ?? Date.now
    this.ttlMs = deps.ttlMs ?? LAYOUT_LEASE_TTL_MS
    this.filePath = deps.filePath
      ? path.resolve(deps.filePath)
      : deps.read ? undefined : path.join(platform().userDataDir, 'canvas-layout-leases.json')
    this.queueKey = this.filePath ?? deps.read
    this.readFile = deps.read ?? (() => {
      try {
        return readFileSync(this.filePath!, 'utf8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      }
    })
    this.writeFile = deps.write ?? ((text) =>
      writeFileAtomic(this.filePath!, text, { mode: 0o600 }))
  }

  private async exclusive<T>(run: () => Promise<T> | T): Promise<T> {
    const previous = queues.get(this.queueKey) ?? Promise.resolve()
    let release!: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    queues.set(this.queueKey, pending)
    await previous
    let lock: number | undefined
    try {
      // No timed lock stealing: a delayed writer must never finish after a successor entered.
      // A crashed writer leaves an explicit unavailable state for operator recovery.
      if (this.filePath) lock = openSync(`${this.filePath}.lock`, 'wx', 0o600)
      return await run()
    } finally {
      try {
        if (lock !== undefined) {
          closeSync(lock)
          unlinkSync(`${this.filePath}.lock`)
        }
      } finally {
        release()
        if (queues.get(this.queueKey) === pending) queues.delete(this.queueKey)
      }
    }
  }

  private load(): Record<string, LayoutLease> {
    const raw = this.readFile()
    if (raw === null) return Object.create(null) as Record<string, LayoutLease>
    const parsed: unknown = JSON.parse(raw)
    const leases = (parsed as { leases?: unknown } | null)?.leases
    if (!leases || typeof leases !== 'object' || Array.isArray(leases)) {
      throw new Error('Unverifiable layout lease store')
    }
    const out = Object.create(null) as Record<string, LayoutLease>
    for (const [id, value] of Object.entries(leases)) {
      const lease = value as LayoutLease | null
      if (!lease || typeof lease.holder !== 'string' || !lease.holder.trim() ||
          typeof lease.at !== 'number' || !Number.isFinite(lease.at) || lease.at < 0 ||
          (lease.token !== undefined && (typeof lease.token !== 'string' || !lease.token))) {
        throw new Error('Unverifiable layout lease record')
      }
      out[id] = { ...lease }
    }
    return out
  }

  private live(lease: LayoutLease | undefined): LayoutLease | null {
    const now = this.now()
    if (!Number.isFinite(now) || !Number.isFinite(this.ttlMs) || this.ttlMs <= 0 ||
        (lease && lease.at > now)) throw new Error('Unverifiable layout lease clock')
    return lease && now - lease.at < this.ttlMs ? lease : null
  }

  /** Read errors propagate. Unreadable is not an empty lease. */
  holder(projectId: string): LayoutLease | null {
    return this.live(this.load()[projectId])
  }

  async acquire(projectId: string, holder: string): Promise<
    { ok: true; lease: LayoutLease & { token: string } } | LeaseRefusal
  > {
    try {
      return await this.exclusive(async () => {
        if (!projectId?.trim() || !holder?.trim()) {
          return { ok: false, reason: 'source-unavailable' } as const
        }
        const leases = this.load()
        const current = this.live(leases[projectId])
        if (current && current.holder !== holder) {
          return { ok: false, reason: 'lease-held', holder: current.holder } as const
        }
        const lease = { holder, at: this.now(), token: randomUUID() }
        leases[projectId] = lease
        await this.writeFile(`${JSON.stringify({ leases }, null, 2)}\n`)
        // Delayed publication may consume the whole TTL. Never grant an already expired token.
        if (!this.live(lease)) return { ok: false, reason: 'lease-stale' } as const
        const published = this.load()[projectId]
        if (published?.token !== lease.token || published.holder !== holder || published.at !== lease.at) {
          return { ok: false, reason: 'source-unavailable' } as const
        }
        return { ok: true, lease } as const
      })
    } catch {
      return { ok: false, reason: 'source-unavailable' }
    }
  }

  /**
   * The callback is a synchronous effect boundary, called under the same lock as acquisition.
   * The project coordinator must already hold its transaction and re-read revision/epoch inside
   * this callback. Async publication belongs to that coordinator's conditional commit protocol.
   */
  async withCurrent<T extends { kind: string }>(
    projectId: string,
    holder: string,
    token: string,
    apply: (check: () => LeaseRefusal | null) => T
  ): Promise<
    { ok: true; value: T } | LeaseRefusal
  > {
    let entered = false
    try {
      return await this.exclusive(() => {
        const check = (): LeaseRefusal | null => {
          const current = this.holder(projectId)
          return !token || !current || current.holder !== holder || current.token !== token
            ? { ok: false, reason: 'lease-stale', ...(current ? { holder: current.holder } : {}) }
            : null
        }
        const refusal = check()
        if (refusal) return refusal
        entered = true
        return { ok: true, value: apply(check) } as const
      })
    } catch (error) {
      // An effect or post-effect unlock failure may have changed state. Never report it as an
      // innocent refusal that invites replay; let the coordinator settle its operation receipt.
      if (entered) throw error
      return { ok: false, reason: 'source-unavailable' }
    }
  }

  /** A token prevents a delayed release from cancelling a newer grant to the same holder.
   * Legacy holder-only release is cancellation only; it never authorizes an effect. */
  async release(projectId: string, holder: string, token?: string): Promise<void> {
    await this.exclusive(async () => {
      const leases = this.load()
      const current = leases[projectId]
      if (!current || current.holder !== holder || (token !== undefined && current.token !== token)) return
      delete leases[projectId]
      await this.writeFile(`${JSON.stringify({ leases }, null, 2)}\n`)
    })
  }
}
