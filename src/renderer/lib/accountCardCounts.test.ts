import { describe, expect, it } from 'vitest'
import type { ClaudeAccount, ObservedClaudeAccount } from '@shared/types'
import { externalProfileId } from '@shared/external-profile'
import { countCardsByAccount } from './accountCardCounts'

describe('countCardsByAccount', () => {
  const managed = { id: 'acct-1', label: 'work', createdAt: 0 } as ClaudeAccount
  const linked = { id: 'acct-2', label: 'two', createdAt: 0, configDir: '/h/.claude-2' } as ClaudeAccount
  const profile = { provider: 'claude' as const, dir: '/h/.claude-4', label: '.claude-4' }
  const obs: Record<string, ObservedClaudeAccount> = {
    sys: { configDir: '/h/.claude', accountId: null, known: true },
    m: { configDir: '/ud/claude-accounts/acct-1', accountId: 'acct-1', known: true },
    // Observed before the dir was linked: re-resolved to the linked account, as the chip is.
    l: { configDir: '/h/.claude-2', accountId: null, known: false },
    p: { configDir: '/h/.claude-4/', accountId: null, known: false },
    u1: { configDir: '/h/.claude-3', accountId: null, known: false },
    u2: { configDir: '/h/.claude-3', accountId: null, known: false }
  }

  it('puts each observed card on its account row, and lists profiles with no row', () => {
    const c = countCardsByAccount(
      [...Object.keys(obs), 'never-observed', 'sys'],
      (id) => obs[id],
      [managed, linked],
      [profile]
    )
    expect(c.system).toBe(1)
    expect(c.byId).toEqual({ 'acct-1': 1, 'acct-2': 1, [externalProfileId(profile)]: 1 })
    expect(c.unconfigured).toEqual([{ configDir: '/h/.claude-3', count: 2 }])
  })
})
