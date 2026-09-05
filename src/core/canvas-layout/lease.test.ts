// The lease is what makes "conflicting layout decisions from multiple directors" impossible, and
// the property that matters most is not exclusion — it is that a refusal NAMES the holder. A
// second instance that only learns "no" cannot tell a lease from a bug.
import { describe, it, expect } from 'vitest'
import { LayoutLeaseStore } from './lease'

function memoryStore(now: () => number, ttlMs = 60_000): LayoutLeaseStore {
  let file: string | null = null
  return new LayoutLeaseStore({
    read: () => file,
    write: async (text) => {
      file = text
    },
    now,
    ttlMs
  })
}

describe('LayoutLeaseStore', () => {
  it('grants a free lease', async () => {
    const store = memoryStore(() => 1_000)
    expect(await store.acquire('p1', 'ui-a')).toEqual({ ok: true })
  })

  it('refuses a held lease AND names the holder', async () => {
    const store = memoryStore(() => 1_000)
    await store.acquire('p1', 'ui-a')
    expect(await store.acquire('p1', 'ui-b')).toEqual({ ok: false, holder: 'ui-a' })
  })

  it('re-acquiring your OWN lease succeeds and re-stamps it', async () => {
    let now = 1_000
    const store = memoryStore(() => now)
    await store.acquire('p1', 'ui-a')
    now = 50_000
    expect(await store.acquire('p1', 'ui-a')).toEqual({ ok: true })
    // Re-stamped: past the ORIGINAL expiry, the lease is still live.
    now = 80_000
    expect(store.holder('p1')?.holder).toBe('ui-a')
  })

  it('EXPIRES, so a crashed instance cannot lock a canvas forever', async () => {
    let now = 1_000
    const store = memoryStore(() => now)
    await store.acquire('p1', 'ui-a')
    now = 1_000 + 60_001
    expect(store.holder('p1')).toBeNull()
    expect(await store.acquire('p1', 'ui-b')).toEqual({ ok: true })
  })

  it('leases are per PROJECT — one canvas being organized does not lock another', async () => {
    const store = memoryStore(() => 1_000)
    await store.acquire('p1', 'ui-a')
    expect(await store.acquire('p2', 'ui-b')).toEqual({ ok: true })
  })

  it('release frees it', async () => {
    const store = memoryStore(() => 1_000)
    await store.acquire('p1', 'ui-a')
    await store.release('p1', 'ui-a')
    expect(await store.acquire('p1', 'ui-b')).toEqual({ ok: true })
  })

  it('releasing someone ELSE’s lease is a no-op, never a steal', async () => {
    const store = memoryStore(() => 1_000)
    await store.acquire('p1', 'ui-a')
    await store.release('p1', 'ui-b')
    expect(store.holder('p1')?.holder).toBe('ui-a')
  })

  it('an unreadable or malformed file means NOBODY holds anything', async () => {
    for (const contents of [null, '', 'not json', '{}', '{"leases":"nope"}', '{"leases":{"p1":{}}}']) {
      const store = new LayoutLeaseStore({
        read: () => contents,
        write: async () => {},
        now: () => 1_000
      })
      expect(store.holder('p1')).toBeNull()
      expect(await store.acquire('p1', 'ui-a')).toEqual({ ok: true })
    }
  })

  it('a write that throws still grants — the caller was already told it may proceed', async () => {
    const store = new LayoutLeaseStore({
      read: () => null,
      write: async () => {
        throw new Error('EACCES')
      },
      now: () => 1_000
    })
    await expect(store.acquire('p1', 'ui-a')).resolves.toEqual({ ok: true })
  })
})
