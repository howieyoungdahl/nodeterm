import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, promises as fsp, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  createPersistentHeadlessNodeOwnership,
  OWNERSHIP_WRITE_DEBOUNCE_MS
} from './node-ownership-store'

let dir: string
let file: string

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'node-ownership-'))
  file = path.join(dir, 'node-ownership.json')
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

const owner = { sourceNodeId: 'director-1', projectId: 'project-1' }

/** The on-disk document, parsed. Fails loudly if the store never published. */
function onDisk(): { v: number; owners: Record<string, Record<string, unknown>> } {
  return JSON.parse(readFileSync(file, 'utf-8'))
}

/** Seed a hand-written file so the loader's validation is exercised against real bytes. */
function seed(doc: unknown): void {
  writeFileSync(file, typeof doc === 'string' ? doc : JSON.stringify(doc), 'utf-8')
}

describe('persistent headless node ownership — the restart contract', () => {
  it('a grant recorded before a restart is still answered by a store built on the same file', async () => {
    const before = createPersistentHeadlessNodeOwnership(file)
    before.record('n-child', owner)
    await before.flush()

    // A second store IS the restart: fresh process state, same bytes.
    const after = createPersistentHeadlessNodeOwnership(file)
    expect(after.ownerOf('n-child')).toMatchObject(owner)
  })

  it('forget and clear are persisted, not just forgotten in memory', async () => {
    const first = createPersistentHeadlessNodeOwnership(file)
    first.record('n-a', owner)
    first.record('n-b', owner)
    await first.flush()

    first.forget('n-a')
    await first.flush()
    expect(Object.keys(onDisk().owners)).toEqual(['n-b'])

    first.clear()
    await first.flush()
    expect(onDisk().owners).toEqual({})

    expect(createPersistentHeadlessNodeOwnership(file).ownerOf('n-b')).toBeUndefined()
  })

  // The mutation to try here: delete the `record` line's `validId` guard. An id the loader refuses
  // would then be granted for this run and silently revoked by the next restart — the exact
  // asymmetry this store exists to remove.
  it('refuses to record an id the loader would refuse, rather than granting it for one run', async () => {
    const store = createPersistentHeadlessNodeOwnership(file)
    store.record('../escape', owner)
    store.record('n-ok', { sourceNodeId: 'has/slash', projectId: 'project-1' })
    store.record('n-fine', owner)
    await store.flush()

    expect(store.ownerOf('../escape')).toBeUndefined()
    expect(store.ownerOf('n-ok')).toBeUndefined()
    expect(Object.keys(onDisk().owners)).toEqual(['n-fine'])
  })
})

describe('persistent headless node ownership — loading a file we did not just write', () => {
  it('a missing file is an empty ledger, not a throw', () => {
    const store = createPersistentHeadlessNodeOwnership(file)
    expect(store.ownerOf('n-child')).toBeUndefined()
  })

  it('unparseable bytes are an empty ledger (fail closed)', () => {
    seed('{not json at all')
    expect(createPersistentHeadlessNodeOwnership(file).ownerOf('n-child')).toBeUndefined()
  })

  it('a foreign or future version is an empty ledger', () => {
    seed({ v: 2, owners: { 'n-child': { ...owner, recordedAt: 1 } } })
    expect(createPersistentHeadlessNodeOwnership(file).ownerOf('n-child')).toBeUndefined()
  })

  it('a top-level array or scalar is an empty ledger', () => {
    seed([{ ...owner }])
    expect(createPersistentHeadlessNodeOwnership(file).ownerOf('n-child')).toBeUndefined()
    seed('"nope"')
    expect(createPersistentHeadlessNodeOwnership(file).ownerOf('n-child')).toBeUndefined()
  })

  // One bad entry must not cost the good ones their grants (a partial file is the realistic
  // corruption), and every named shape must actually be dropped.
  it('drops wrong-shaped and unsafe-id entries one by one, keeping the valid ones', () => {
    seed({
      v: 1,
      owners: {
        'n-good': { ...owner, recordedAt: 111 },
        // Unsafe KEY: path traversal, separators, and the prototype-polluting name.
        '../escape': { ...owner, recordedAt: 111 },
        'has/slash': { ...owner, recordedAt: 111 },
        '.': { ...owner, recordedAt: 111 },
        __proto__: { ...owner, recordedAt: 111 },
        constructor: { ...owner, recordedAt: 111 },
        // Unsafe VALUES: an id that could not have come from us.
        'n-bad-source': { sourceNodeId: '../evil', projectId: 'project-1', recordedAt: 111 },
        'n-bad-project': { sourceNodeId: 'director-1', projectId: '', recordedAt: 111 },
        // Wrong shapes.
        'n-missing-source': { projectId: 'project-1', recordedAt: 111 },
        'n-nonstring': { sourceNodeId: 7, projectId: 'project-1', recordedAt: 111 },
        'n-no-time': { ...owner },
        'n-string-time': { ...owner, recordedAt: '111' },
        'n-zero-time': { ...owner, recordedAt: 0 },
        'n-float-time': { ...owner, recordedAt: 1.5 },
        'n-null': null,
        'n-scalar': 42
      }
    })
    const store = createPersistentHeadlessNodeOwnership(file)
    expect(store.ownerOf('n-good')).toMatchObject(owner)
    for (const id of [
      '../escape',
      'has/slash',
      '.',
      '__proto__',
      'constructor',
      'n-bad-source',
      'n-bad-project',
      'n-missing-source',
      'n-nonstring',
      'n-no-time',
      'n-string-time',
      'n-zero-time',
      'n-float-time',
      'n-null',
      'n-scalar'
    ]) {
      expect(store.ownerOf(id), id).toBeUndefined()
    }
    // And the prototype was not touched on the way through.
    expect(({} as Record<string, unknown>).sourceNodeId).toBeUndefined()
  })
})

describe('persistent headless node ownership — prune against the boot workspace', () => {
  it('drops grants for ids the persisted workspace no longer has, and keeps the rest', async () => {
    const first = createPersistentHeadlessNodeOwnership(file)
    first.record('n-live', owner)
    first.record('n-gone', owner)
    await first.flush()

    const second = createPersistentHeadlessNodeOwnership(file, {
      prune: () => new Set(['n-live'])
    })
    expect(second.ownerOf('n-live')).toMatchObject(owner)
    expect(second.ownerOf('n-gone')).toBeUndefined()

    // The prune REWRITES: a third store, with no prune of its own, must not see it come back.
    await second.flush()
    expect(Object.keys(onDisk().owners)).toEqual(['n-live'])
    expect(createPersistentHeadlessNodeOwnership(file).ownerOf('n-gone')).toBeUndefined()
  })

  // The dangerous mutation: make `undefined` mean "nothing is live". The boot workspace is loaded
  // AFTER this store is constructed, so that reading would empty the ledger on every boot — and a
  // workspace read that genuinely FAILED would do the same. A failed read is not evidence of absence.
  it('an unknown (undefined) live set prunes NOTHING, and prunes later once it is known', async () => {
    const first = createPersistentHeadlessNodeOwnership(file)
    first.record('n-live', owner)
    first.record('n-gone', owner)
    await first.flush()

    let live: ReadonlySet<string> | undefined
    const second = createPersistentHeadlessNodeOwnership(file, { prune: () => live })
    expect(second.ownerOf('n-live')).toMatchObject(owner)
    expect(second.ownerOf('n-gone')).toMatchObject(owner)

    live = new Set(['n-live'])
    expect(second.ownerOf('n-gone')).toBeUndefined()
    expect(second.ownerOf('n-live')).toMatchObject(owner)
  })

  it('a node recorded this run survives the prune that runs just before it', async () => {
    const first = createPersistentHeadlessNodeOwnership(file)
    first.record('n-gone', owner)
    await first.flush()

    // `n-fresh` is brand new, so it is NOT in the boot workspace — the prune must run before the
    // insert, never after it.
    const second = createPersistentHeadlessNodeOwnership(file, { prune: () => new Set(['n-keep']) })
    second.record('n-fresh', owner)
    expect(second.ownerOf('n-fresh')).toMatchObject(owner)
    expect(second.ownerOf('n-gone')).toBeUndefined()
    await second.flush()
    expect(Object.keys(onDisk().owners)).toEqual(['n-fresh'])
  })

  it('the prune runs only once, so a later workspace edit cannot revoke a live grant', () => {
    const first = createPersistentHeadlessNodeOwnership(file)
    first.record('n-live', owner)

    let live: ReadonlySet<string> = new Set(['n-live'])
    const second = createPersistentHeadlessNodeOwnership(file, { prune: () => live })
    expect(second.ownerOf('n-live')).toBeUndefined() // not flushed yet — different store, empty file

    second.record('n-live', owner)
    live = new Set()
    expect(second.ownerOf('n-live')).toMatchObject(owner)
  })
})

describe('persistent headless node ownership — how it reaches disk', () => {
  it.skipIf(process.platform === 'win32')(
    'publishes 0600 — another local account may not read who owns what',
    async () => {
      const store = createPersistentHeadlessNodeOwnership(file)
      store.record('n-child', owner)
      await store.flush()
      expect(statSync(file).mode & 0o777).toBe(0o600)

      // And the mode survives a REWRITE (writeFileAtomic publishes by rename, so the mode rides
      // the temp inode — a rewrite that lost it would be silent).
      store.record('n-second', owner)
      await store.flush()
      expect(statSync(file).mode & 0o777).toBe(0o600)
    }
  )

  it('a burst of mutations schedules exactly ONE debounced write', async () => {
    vi.useFakeTimers()
    const store = createPersistentHeadlessNodeOwnership(file)
    store.record('n-1', owner)
    store.record('n-2', owner)
    store.record('n-3', owner)
    store.forget('n-2')
    // Four mutations, one pending publish. Delete the `if (timer) return` in `scheduleWrite` and
    // this is 4 — one atomic publish per node in a `team` spawn.
    expect(vi.getTimerCount()).toBe(1)
    // Nothing is on disk DURING the burst: the debounce is a real delay, not a coalescing no-op.
    expect(existsSync(file)).toBe(false)

    vi.useRealTimers()
    await store.flush()
    expect(Object.keys(onDisk().owners).sort()).toEqual(['n-1', 'n-3'])
  })

  it('the debounce publishes on its own, without anyone calling flush', async () => {
    const store = createPersistentHeadlessNodeOwnership(file)
    store.record('n-child', owner)
    expect(existsSync(file)).toBe(false)
    await vi.waitFor(() => expect(existsSync(file)).toBe(true), {
      timeout: OWNERSHIP_WRITE_DEBOUNCE_MS * 10
    })
    expect(onDisk().owners['n-child']).toMatchObject(owner)
  })

  it('flush on an unmutated store writes nothing at all', async () => {
    const store = createPersistentHeadlessNodeOwnership(file)
    await store.flush()
    expect(existsSync(file)).toBe(false)
  })

  it('overlapping publishes serialize, and the last snapshot wins', async () => {
    const store = createPersistentHeadlessNodeOwnership(file)
    store.record('n-1', owner)
    const first = store.flush()
    store.record('n-2', owner)
    const second = store.flush()
    await Promise.all([first, second])
    expect(Object.keys(onDisk().owners).sort()).toEqual(['n-1', 'n-2'])
  })

  it('a write failure surfaces to flush instead of being swallowed', async () => {
    const store = createPersistentHeadlessNodeOwnership(file)
    vi.spyOn(fsp, 'rename').mockRejectedValue(
      Object.assign(new Error('nope'), { code: 'ENOSPC' })
    )
    store.record('n-child', owner)
    await expect(store.flush()).rejects.toThrow(/nope/)
    // The queue is not wedged: a later successful write still lands.
    vi.restoreAllMocks()
    store.record('n-second', owner)
    await store.flush()
    expect(Object.keys(onDisk().owners).sort()).toEqual(['n-child', 'n-second'])
  })

  it('stamps recordedAt from the injected clock', async () => {
    const store = createPersistentHeadlessNodeOwnership(file, { now: () => 1_700_000_000_000 })
    store.record('n-child', owner)
    await store.flush()
    expect(onDisk().owners['n-child'].recordedAt).toBe(1_700_000_000_000)
  })
})
