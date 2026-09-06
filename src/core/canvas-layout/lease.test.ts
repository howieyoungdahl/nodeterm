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
    expect(await store.acquire('p1', 'ui-a')).toMatchObject({ ok: true, lease: { token: expect.any(String) } })
  })

  it('refuses a held lease AND names the holder', async () => {
    const store = memoryStore(() => 1_000)
    await store.acquire('p1', 'ui-a')
    expect(await store.acquire('p1', 'ui-b')).toEqual({ ok: false, reason: 'lease-held', holder: 'ui-a' })
  })

  it('re-acquiring your OWN lease succeeds and re-stamps it', async () => {
    let now = 1_000
    const store = memoryStore(() => now)
    await store.acquire('p1', 'ui-a')
    now = 50_000
    expect(await store.acquire('p1', 'ui-a')).toMatchObject({ ok: true })
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
    expect(await store.acquire('p1', 'ui-b')).toMatchObject({ ok: true })
  })

  it('leases are per PROJECT — one canvas being organized does not lock another', async () => {
    const store = memoryStore(() => 1_000)
    await store.acquire('p1', 'ui-a')
    expect(await store.acquire('p2', 'ui-b')).toMatchObject({ ok: true })
  })

  it('release frees it', async () => {
    const store = memoryStore(() => 1_000)
    await store.acquire('p1', 'ui-a')
    await store.release('p1', 'ui-a')
    expect(await store.acquire('p1', 'ui-b')).toMatchObject({ ok: true })
  })

  it('releasing someone ELSE’s lease is a no-op, never a steal', async () => {
    const store = memoryStore(() => 1_000)
    await store.acquire('p1', 'ui-a')
    await store.release('p1', 'ui-b')
    expect(store.holder('p1')?.holder).toBe('ui-a')
  })

  it('malformed storage refuses admission instead of pretending the lease is free', async () => {
    for (const contents of ['', 'not json', '{}', '{"leases":"nope"}', '{"leases":{"p1":{}}}']) {
      const store = new LayoutLeaseStore({
        read: () => contents,
        write: async () => {},
        now: () => 1_000
      })
      expect(() => store.holder('p1')).toThrow()
      expect(await store.acquire('p1', 'ui-a')).toEqual({ ok: false, reason: 'source-unavailable' })
    }
  })

  it('a failed write cannot grant authority', async () => {
    const store = new LayoutLeaseStore({
      read: () => null,
      write: async () => {
        throw new Error('EACCES')
      },
      now: () => 1_000
    })
    await expect(store.acquire('p1', 'ui-a')).resolves.toEqual({ ok: false, reason: 'source-unavailable' })
  })

  it('a swallowed write cannot grant authority', async () => {
    const store = new LayoutLeaseStore({ read: () => null, write: async () => {} })
    expect(await store.acquire('p1', 'ui-a')).toEqual({ ok: false, reason: 'source-unavailable' })
  })

  it('read failure, unlike ENOENT, refuses admission', async () => {
    const store = new LayoutLeaseStore({ read: () => { throw new Error('EACCES') } })
    expect(await store.acquire('p1', 'ui-a')).toEqual({ ok: false, reason: 'source-unavailable' })
  })

  it('retains independent project grants during overlapping writes', async () => {
    const store = memoryStore(() => 1_000)
    const results = await Promise.all([store.acquire('p1', 'ui-a'), store.acquire('p2', 'ui-b')])
    expect(results.every((result) => result.ok)).toBe(true)
    expect(store.holder('p1')?.holder).toBe('ui-a')
    expect(store.holder('p2')?.holder).toBe('ui-b')
  })

  it('a delayed old release cannot cancel a newer token for the same holder', async () => {
    const store = memoryStore(() => 1_000)
    const first = await store.acquire('p1', 'ui-a')
    const second = await store.acquire('p1', 'ui-a')
    if (!first.ok || !second.ok) throw new Error('fixture failed to acquire')
    expect(first.lease.token).not.toBe(second.lease.token)
    await store.release('p1', 'ui-a', first.lease.token)
    expect(store.holder('p1')?.token).toBe(second.lease.token)
  })

  it('does not grant a lease whose publication consumed its TTL', async () => {
    let now = 1_000
    let file: string | null = null
    const store = new LayoutLeaseStore({
      read: () => file,
      write: async (text) => { file = text; now += 60_000 },
      now: () => now
    })
    expect(await store.acquire('p1', 'ui-a')).toEqual({ ok: false, reason: 'lease-stale' })
  })

  it('a backwards clock cannot extend an existing grant', async () => {
    let now = 1_000
    const store = memoryStore(() => now)
    await store.acquire('p1', 'ui-a')
    now = 500
    expect(await store.acquire('p1', 'ui-a')).toEqual({ ok: false, reason: 'source-unavailable' })
  })
})
