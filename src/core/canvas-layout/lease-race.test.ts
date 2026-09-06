import { expect, it } from 'vitest'
import { LayoutLeaseStore } from './lease'

it('grants only one of two overlapping acquisitions against the same persisted file', async () => {
  let file: string | null = null
  const read = (): string | null => file
  const write = async (text: string): Promise<void> => {
    // Both callers reached the old read/check/write boundary before either write completed.
    await Promise.resolve()
    file = text
  }
  const a = new LayoutLeaseStore({ read, write, now: () => 1_000 })
  const b = new LayoutLeaseStore({ read, write, now: () => 1_000 })
  const results = await Promise.all([a.acquire('p1', 'ui-a'), b.acquire('p1', 'ui-b')])
  expect(results.filter((result) => result.ok)).toHaveLength(1)
  expect(a.holder('p1')?.holder).toBe('ui-a')
})
