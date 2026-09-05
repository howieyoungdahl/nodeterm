// Single layout authority per project.
//
// Two directors both organising one canvas is the operator's own stated failure — "conflicting
// layout decisions from multiple directors". The fix is not a merge strategy; it is that only one
// instance is the layout authority for a project at a time, and the one that is not says so.
//
// **A refusal names the holder.** That is the whole point: a second director reading "another
// instance holds this project's layout lease (server-1f2e…, 4m ago)" knows to stand down and can
// say why. A refusal with no holder is indistinguishable from a bug, and an instance that goes
// quiet instead of refusing is worse than one that fights.
//
// The lease is a 0600 file in the shell's own data dir — the same trust class as `node-tokens/`
// and `node-ownership.json` beside it. It is not in `project.json`: a lease is a statement about
// which PROCESS is currently in charge, so it must not travel with the repo, and a lease that
// git-merged would be nonsense. Written through `writeFileAtomic` like every other store here.
//
// It EXPIRES rather than being released-or-stuck. An instance that crashes mid-organize must not
// lock a canvas forever, so the holder re-stamps while it works and any lease past its TTL is
// free. The TTL is the failure mode chosen deliberately: too short and two instances overlap for
// a few seconds; too long and a crash costs the operator a wait. A layout plan is applied in one
// tick, so a minute is generous for the work and short for the wait.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { writeFileAtomic } from '../fs-atomic'
import { platform } from '../platform'

/** How long a lease stands without being re-stamped. */
export const LAYOUT_LEASE_TTL_MS = 60_000

export interface LayoutLease {
  /** The instance holding it — what a refusal names. */
  holder: string
  /** ms epoch of the last stamp. */
  at: number
}

export interface LayoutLeaseStoreDeps {
  /** Whole-file read; `null` for "not there". Injected so the store is testable with no disk. */
  read?: () => string | null
  write?: (text: string) => Promise<void>
  now?: () => number
  ttlMs?: number
}

interface LeaseFile {
  leases?: Record<string, LayoutLease>
}

function defaultPath(): string {
  return path.join(platform().userDataDir, 'canvas-layout-leases.json')
}

/**
 * Leases for every project this shell knows about, in one file.
 *
 * Every read is fail-open in the direction that keeps the app working: an unreadable or
 * malformed file means "nobody holds anything". That is deliberate and it is the SAFE direction
 * here, unlike creator ownership — the cost of a wrongly-granted lease is two instances briefly
 * planning the same canvas (and both plans are previewed and both refuse the operator's active
 * node), while the cost of a wrongly-denied one is a canvas nothing can ever organise again.
 */
export class LayoutLeaseStore {
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly readFile: () => string | null
  private readonly writeFile: (text: string) => Promise<void>

  constructor(deps: LayoutLeaseStoreDeps = {}) {
    this.now = deps.now ?? (() => Date.now())
    this.ttlMs = deps.ttlMs ?? LAYOUT_LEASE_TTL_MS
    this.readFile =
      deps.read ??
      ((): string | null => {
        try {
          return readFileSync(defaultPath(), 'utf8')
        } catch {
          return null
        }
      })
    this.writeFile =
      deps.write ??
      ((text: string): Promise<void> => writeFileAtomic(defaultPath(), text, { mode: 0o600 }))
  }

  private load(): Record<string, LayoutLease> {
    const raw = this.readFile()
    if (!raw) return {}
    try {
      const parsed = JSON.parse(raw) as LeaseFile
      const leases = parsed?.leases
      if (!leases || typeof leases !== 'object' || Array.isArray(leases)) return {}
      const out: Record<string, LayoutLease> = {}
      for (const [projectId, lease] of Object.entries(leases)) {
        if (
          lease &&
          typeof (lease as LayoutLease).holder === 'string' &&
          typeof (lease as LayoutLease).at === 'number' &&
          Number.isFinite((lease as LayoutLease).at)
        ) {
          out[projectId] = { holder: (lease as LayoutLease).holder, at: (lease as LayoutLease).at }
        }
      }
      return out
    } catch {
      return {}
    }
  }

  private async save(leases: Record<string, LayoutLease>): Promise<void> {
    try {
      await this.writeFile(`${JSON.stringify({ leases }, null, 2)}\n`)
    } catch {
      // A lease we could not persist is a lease we do not hold across processes. The caller has
      // already been told it may proceed, which is the fail-open direction stated above; losing
      // the write costs single-authority, never correctness of the plan itself.
    }
  }

  /** The live holder of a project's lease, or `null` when it is free or expired. */
  holder(projectId: string): LayoutLease | null {
    const lease = this.load()[projectId]
    if (!lease) return null
    return this.now() - lease.at < this.ttlMs ? lease : null
  }

  /**
   * Take (or re-stamp) the lease. `ok: false` carries the CURRENT holder so the caller can name
   * it. Re-acquiring a lease you already hold always succeeds and refreshes the stamp — that is
   * how a long organize keeps the lease alive without a timer.
   */
  async acquire(
    projectId: string,
    holder: string
  ): Promise<{ ok: true } | { ok: false; holder: string }> {
    const current = this.holder(projectId)
    if (current && current.holder !== holder) return { ok: false, holder: current.holder }
    const leases = this.load()
    leases[projectId] = { holder, at: this.now() }
    await this.save(leases)
    return { ok: true }
  }

  /** Give it back. Releasing someone else's lease is a no-op, never a steal. */
  async release(projectId: string, holder: string): Promise<void> {
    const leases = this.load()
    if (leases[projectId]?.holder !== holder) return
    delete leases[projectId]
    await this.save(leases)
  }
}
