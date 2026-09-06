/**
 * DURABLE creator ownership for Server Edition canvas control.
 *
 * The in-memory twin (`createHeadlessNodeOwnership`) is deliberately process-local, and the
 * reasoning behind that is still correct as far as it goes: `.nodeterm/project.json` is git-shared
 * and hand-editable, a tmux session name survives anything, and a node title is whatever somebody
 * last typed. NONE of those may ever be read back as creator proof, because an attacker (or a
 * merge) writes them. That rule is unchanged.
 *
 * This file is a different trust class, and the distinction is the whole point. The ledger here is
 * SERVER-AUTHORED, lives in the Server's own `dataDir`, and is written 0600 — the same class as
 * `node-tokens/` and `node-auth-key.bin`, which already carry node IDENTITY across restarts. If an
 * attacker can rewrite this file they can rewrite the node token store next to it and mint identity
 * directly, so persisting ownership here grants them nothing they did not already have. Nothing in
 * it is ever reconstructed FROM canvas state; it only ever records what this server itself observed
 * a verified agent do.
 *
 * What it buys: a director loop that spawned twenty child nodes before an upgrade can still
 * message, resize and close them afterwards. Before this, a Server restart silently revoked every
 * grant, and the agent's only recovery was to abandon the nodes it had made.
 *
 * Two properties are load-bearing and must survive any edit here:
 *
 *  - **Unknown ownership still fails closed.** A missing, unreadable, or wrong-shaped file yields
 *    an EMPTY ledger, never a throw and never a permissive default. Losing the file costs an agent
 *    its grants; misreading one would hand grants to the wrong caller.
 *  - **Every entry is re-validated on the way in.** Ids must satisfy `isSafeNodeId` — the same
 *    predicate the token derivation and the hook server gate on, not a local regex — because these
 *    strings become map keys, get compared against caller-supplied ids, and are serialized back
 *    out. An id the rest of the system refuses can never become an ownership answer here.
 */

import { promises as fs, readFileSync } from 'node:fs'
import path from 'node:path'

import { writeFileAtomic } from '../core/fs-atomic'
import { isSafeNodeId } from '../shared/safe-id'
import type { HeadlessNodeOwner, HeadlessNodeOwnership } from './headless-node-factory'

/**
 * Coalesce a spawn burst into ONE disk write. A single `team` verb opens several nodes back to
 * back and each one records a grant; without the debounce that is one atomic publish per node.
 * Matches the agent-status mirror's `WRITE_DEBOUNCE_MS` for the same reason.
 */
export const OWNERSHIP_WRITE_DEBOUNCE_MS = 300

/** The persisted form of one grant. `recordedAt` is diagnostics only — nothing gates on it. */
interface OwnerRecord extends HeadlessNodeOwner {
  recordedAt: number
}

interface OwnershipFileV1 {
  v: 1
  owners: Record<string, OwnerRecord>
}

export interface PersistentHeadlessNodeOwnership extends HeadlessNodeOwnership {
  /**
   * Publish any debounced mutation NOW. For shutdown and for tests; the debounce publishes on its
   * own otherwise. Rejects with the underlying write error so a caller that cares can say the
   * ledger did not land (the scheduled path can only warn).
   */
  flush(): Promise<void>
}

export interface PersistentOwnershipOptions {
  /**
   * The node ids that still exist in the persisted workspace. Entries outside the set are dropped
   * and the file is rewritten: a grant for a node nobody can name is consent for nothing, and the
   * ledger would otherwise grow for the life of the install.
   *
   * `undefined` means "not known yet", NOT "nothing is live" — the boot workspace is read after
   * this store is constructed, so an eager prune at construction would delete the entire ledger.
   * The prune therefore runs lazily, at the top of the first `ownerOf`/`record`/`forget`, which is
   * necessarily after boot has read the workspace. Gating it on `ownerOf` in particular is what
   * makes it safe: no ownership ANSWER can be produced from an un-pruned ledger.
   */
  prune?: () => ReadonlySet<string> | undefined
  /** Test seam for `recordedAt`; production uses the wall clock. */
  now?: () => number
}

/** `__proto__` & co pass `isSafeNodeId`'s charset but would set the prototype of the plain object
 *  `toFile()` serializes, so they are refused at every entry point into the map rather than
 *  handled at the exit. Same guard, same reason, as `core/trigger-arm-store.ts`. */
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

/** Both alphabets: node ids are tmux names, project ids are machine-minted (uuid / `project-1`).
 *  `isSafeNodeId` covers and bounds both — see `trigger-arm-store.ts`, which keys the same way. */
function validId(value: unknown): value is string {
  return typeof value === 'string' && isSafeNodeId(value) && !DANGEROUS_KEYS.has(value)
}

/** Strict per-entry shape check. A single bad entry is dropped; it never poisons the whole load. */
function validRecord(value: unknown): OwnerRecord | null {
  if (!value || typeof value !== 'object') return null
  const r = value as Partial<OwnerRecord>
  if (!validId(r.sourceNodeId) || !validId(r.projectId)) return null
  const recordedAt = r.recordedAt
  if (typeof recordedAt !== 'number' || !Number.isSafeInteger(recordedAt) || recordedAt <= 0)
    return null
  return { sourceNodeId: r.sourceNodeId, projectId: r.projectId, recordedAt }
}

/**
 * A `HeadlessNodeOwnership` backed by a 0600 JSON file, so creator grants survive a Server restart.
 *
 * Loads synchronously at construction (boot-time, one small file — the same shape as the mirror's
 * `loadPersisted` and `loadOrCreateOpsToken`); mutations are synchronous in memory and land on disk
 * behind one debounced atomic write.
 */
export function createPersistentHeadlessNodeOwnership(
  filePath: string,
  opts: PersistentOwnershipOptions = {}
): PersistentHeadlessNodeOwnership {
  const now = opts.now ?? Date.now
  const owners = load(filePath)
  // Cleared once applied (or once `clear()` makes it moot) — the latch IS the pending flag.
  let pendingPrune = opts.prune

  let timer: ReturnType<typeof setTimeout> | null = null
  let dirty = false
  // Serialize publishes: two overlapping renames onto one destination is the exact Windows EPERM
  // race `fs-atomic.ts` documents, and the later snapshot must win regardless.
  let queue: Promise<void> = Promise.resolve()

  function persist(): Promise<void> {
    // Snapshot and clear the flag together, synchronously: a mutation that lands during the await
    // must re-dirty the store rather than be swallowed by this write's completion.
    const snapshot = JSON.stringify(toFile(owners))
    dirty = false
    const run = queue.then(async () => {
      await fs.mkdir(path.dirname(filePath), { recursive: true })
      // 0600: this file decides who may message, mutate and KILL another agent's nodes. Another
      // local account must not be able to read it, and `writeFileAtomic` publishes by rename, so
      // the mode rides the temp inode and survives every later rewrite.
      await writeFileAtomic(filePath, snapshot, { mode: 0o600 })
    })
    // A failed write must not wedge the queue for every later write (trigger-arm-store's rule).
    queue = run.catch(() => {})
    return run
  }

  function scheduleWrite(): void {
    dirty = true
    if (timer) return
    timer = setTimeout(() => {
      timer = null
      void persist().catch((error) => {
        // Loud, because the failure is silent otherwise and only shows up as a revoked grant after
        // the NEXT restart — by which time nothing connects it to this write.
        console.warn('[node-ownership] could not persist the creator ledger', error)
      })
    }, OWNERSHIP_WRITE_DEBOUNCE_MS)
    // Never hold the process open for a debounce; `close()` flushes explicitly.
    timer.unref?.()
  }

  /** See `PersistentOwnershipOptions.prune` — runs once, on the first access after boot. */
  function applyPendingPrune(): void {
    if (!pendingPrune) return
    const live = pendingPrune()
    if (!live) return // workspace not readable yet: stay pending rather than drop every grant
    pendingPrune = undefined
    let changed = false
    for (const nodeId of [...owners.keys()]) {
      if (live.has(nodeId)) continue
      owners.delete(nodeId)
      changed = true
    }
    if (changed) scheduleWrite()
  }

  return {
    ownerOf: (nodeId) => {
      applyPendingPrune()
      return owners.get(nodeId)
    },
    record: (nodeId, owner) => {
      applyPendingPrune()
      // Refuse what the loader would refuse, so an id can never round-trip in and then vanish on
      // the next boot — an in-memory grant the restart silently drops is the bug this file fixes.
      if (!validId(nodeId) || !validId(owner?.sourceNodeId) || !validId(owner?.projectId)) return
      owners.set(nodeId, {
        sourceNodeId: owner.sourceNodeId,
        projectId: owner.projectId,
        recordedAt: now()
      })
      scheduleWrite()
    },
    forget: (nodeId) => {
      applyPendingPrune()
      if (!owners.delete(nodeId)) return
      scheduleWrite()
    },
    clear: () => {
      // Nothing survives, so a pending prune has nothing left to remove.
      pendingPrune = undefined
      if (!owners.size) return
      owners.clear()
      scheduleWrite()
    },
    flush: async () => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      if (!dirty) return
      await persist()
    }
  }
}

/** Tolerant load: a missing, corrupt or foreign-shaped file is an EMPTY ledger, never a throw.
 *  Empty is the fail-CLOSED direction for ownership — every grant is refused until re-earned. */
function load(filePath: string): Map<string, OwnerRecord> {
  const owners = new Map<string, OwnerRecord>()
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf-8'))
  } catch {
    return owners
  }
  if (!parsed || typeof parsed !== 'object') return owners
  const file = parsed as OwnershipFileV1
  if (file.v !== 1 || !file.owners || typeof file.owners !== 'object') return owners
  for (const [nodeId, value] of Object.entries(file.owners)) {
    if (!validId(nodeId)) continue
    const record = validRecord(value)
    if (record) owners.set(nodeId, record)
  }
  return owners
}

/** Every key in the map already passed `validId`, so `fromEntries` cannot define a prototype key
 *  here — the guard is at the entry points, which is where a Map key stops protecting us. */
function toFile(owners: ReadonlyMap<string, OwnerRecord>): OwnershipFileV1 {
  return { v: 1, owners: Object.fromEntries(owners) }
}
