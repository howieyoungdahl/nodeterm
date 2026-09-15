import { describe, it, expect } from 'vitest'
import { limitSummary, usageSectionKey } from './usageFormat'
import type { UsageLimit } from '@shared/types'

const limit = (over: Partial<UsageLimit> = {}): UsageLimit => ({
  kind: 'session',
  group: 'session',
  usedPercent: 42,
  severity: null,
  resetsAt: null,
  windowMinutes: 300,
  scopeLabel: null,
  isActive: false,
  ...over
})

describe('usageSectionKey', () => {
  it('namespaces claude, remote and provider sections so they can never collide', () => {
    // A Claude account id and a provider id are both plain strings; a key that collapsed the
    // WRONG row is a bug whose cause the user cannot see.
    const claude = usageSectionKey({ kind: 'claude', accountId: 'abc' })
    const provider = usageSectionKey({ kind: 'provider', provider: 'codex', accountId: 'abc' })
    expect(claude).not.toBe(provider)
    expect(claude).toBe('claude:abc')
    expect(provider).toBe('provider:codex:abc')
  })

  it('reads an absent account as the machine system row', () => {
    expect(usageSectionKey({ kind: 'claude' })).toBe('claude:system')
    expect(usageSectionKey({ kind: 'claude', accountId: null })).toBe('claude:system')
    expect(usageSectionKey({ kind: 'provider', provider: 'gemini' })).toBe('provider:gemini:system')
  })

  it('separates the same subscription signed in on two hosts', () => {
    const a = usageSectionKey({ kind: 'remote', hostKey: 'a@one', accountId: null })
    const b = usageSectionKey({ kind: 'remote', hostKey: 'b@two', accountId: null })
    expect(a).not.toBe(b)
    expect(a).toBe('remote:a@one#system')
  })

  it('separates two accounts of one provider', () => {
    // Both Codex accounts emit `provider: 'codex'`; only the accountId tells them apart.
    const one = usageSectionKey({ kind: 'provider', provider: 'codex', accountId: 'ext:codex:/h/a' })
    const two = usageSectionKey({ kind: 'provider', provider: 'codex', accountId: 'ext:codex:/h/b' })
    expect(one).not.toBe(two)
  })
})

describe('limitSummary', () => {
  it('shows the same reading the open section would have led with', () => {
    // A collapsed section must not hide an exhausted window behind a chevron.
    expect(limitSummary(limit({ usedPercent: 93 }), 'remaining')).toBe('7% 5h')
    expect(limitSummary(limit({ usedPercent: 93 }), 'used')).toBe('93% 5h')
  })

  it('names a scoped limit by its model', () => {
    expect(limitSummary(limit({ kind: 'weekly_scoped', scopeLabel: 'Fable' }), 'used')).toBe(
      '42% Fable'
    )
  })

  it('prints a balance verbatim — there is no percentage to round', () => {
    expect(limitSummary(limit({ amountText: '$12.40', usedPercent: 0 }), 'used')).toBe('$12.40')
  })

  it('is empty for nothing', () => {
    expect(limitSummary(null, 'used')).toBe('')
  })
})
