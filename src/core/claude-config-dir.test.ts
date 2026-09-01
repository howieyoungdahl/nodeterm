import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'
import {
  claudeConfigDirFor,
  claudeAccountsSnapshot,
  linkedClaudeConfigDirFor,
  linkedClaudeConfigDirs,
  registerClaudeAccountsSource,
  resetClaudeAccountsSourceForTests
} from './claude-config-dir'
import type { ClaudeAccount } from '../shared/types'

const acct = (over: Partial<ClaudeAccount> & { id: string }): ClaudeAccount => ({
  label: over.id,
  createdAt: 0,
  ...over
})

beforeEach(() => initPlatform(fakePlatform({ userDataDir: '/tmp/ud' })))
afterEach(() => {
  resetPlatformForTests()
  resetClaudeAccountsSourceForTests()
})

describe('claudeConfigDirFor', () => {
  // NOTE: the actual current signature in claude-accounts.ts is
  // `claudeConfigDirFor(accountId: string): string` — accountId is REQUIRED and the
  // return is always a string. Every caller guards (`accountId ? claudeConfigDirFor(id) : …`)
  // so undefined never reaches it. This test documents that ACTUAL behavior; the refactor
  // must not change it.
  it('an account id resolves under userData/claude-accounts', () => {
    expect(claudeConfigDirFor('abc')).toContain('/tmp/ud')
    expect(claudeConfigDirFor('abc')).toContain('abc')
    expect(claudeConfigDirFor('abc')).toBe('/tmp/ud/claude-accounts/abc')
  })

  it('reads userDataDir lazily from the platform seam', () => {
    resetPlatformForTests()
    initPlatform(fakePlatform({ userDataDir: '/other/ud' }))
    expect(claudeConfigDirFor('xyz')).toBe('/other/ud/claude-accounts/xyz')
  })

  it('rejects a traversal-shaped account id (id validation preserved)', () => {
    expect(() => claudeConfigDirFor('../escape')).toThrow(/invalid account id/)
  })

  // Passing undefined is a type error at call sites; at runtime it throws (path.join on
  // undefined) rather than returning undefined — documenting that callers must guard.
  it('throws when accountId is missing (callers must guard)', () => {
    expect(() => claudeConfigDirFor(undefined as unknown as string)).toThrow()
  })
})

// ---- Linked accounts (design D4) ------------------------------------------------------------
//
// `claudeConfigDirFor` is THE resolver: env injection at spawn, the usage reader, the transcript
// roots and the mirror's account list all call it and nothing else. So the linked branch is added
// here rather than at seven call sites — and these cases are what keep the managed branch, and its
// id validation, exactly as it was.

describe('registerClaudeAccountsSource + claudeConfigDirFor', () => {
  it('with no source registered, every id resolves managed (bit-for-bit legacy)', () => {
    expect(claudeAccountsSnapshot()).toEqual([])
    expect(claudeConfigDirFor('abc')).toBe('/tmp/ud/claude-accounts/abc')
    expect(linkedClaudeConfigDirs()).toEqual([])
  })

  it('resolves a linked account to its own dir, and its neighbours to the managed root', () => {
    registerClaudeAccountsSource(() => [
      acct({ id: 'linked', configDir: '/home/u/.claude-2' }),
      acct({ id: 'managed' })
    ])
    expect(claudeConfigDirFor('linked')).toBe('/home/u/.claude-2')
    expect(claudeConfigDirFor('managed')).toBe('/tmp/ud/claude-accounts/managed')
    expect(linkedClaudeConfigDirFor('linked')).toBe('/home/u/.claude-2')
    expect(linkedClaudeConfigDirFor('managed')).toBeNull()
  })

  it('normalizes the stored value (trailing slash, `.`, an absorbable `..`)', () => {
    registerClaudeAccountsSource(() => [acct({ id: 'l', configDir: '/home/u/x/.././.claude-2/' })])
    expect(claudeConfigDirFor('l')).toBe('/home/u/.claude-2')
  })

  it('IGNORES a relative or `..`-bearing configDir → managed fallback, never something wider', () => {
    // settings.json is hand-edited; a relative value must not resolve against the process cwd,
    // and the safe default is the managed dir (which then hits the existing missing-dir warn +
    // system fallback at spawn).
    for (const bad of ['.claude-2', '../.claude-2', '', '   ', 42 as unknown as string]) {
      resetClaudeAccountsSourceForTests()
      registerClaudeAccountsSource(() => [acct({ id: 'l', configDir: bad })])
      expect(claudeConfigDirFor('l')).toBe('/tmp/ud/claude-accounts/l')
      expect(linkedClaudeConfigDirFor('l')).toBeNull()
      expect(linkedClaudeConfigDirs()).toEqual([])
    }
  })

  it('ignores a host-scoped or pending row (a linked dir is LOCAL and settled by definition)', () => {
    registerClaudeAccountsSource(() => [
      acct({ id: 'r', configDir: '/home/u/.claude-2', host: 'u@example' }),
      acct({ id: 'p', configDir: '/home/u/.claude-3', pending: true })
    ])
    expect(claudeConfigDirFor('r')).toBe('/tmp/ud/claude-accounts/r')
    expect(claudeConfigDirFor('p')).toBe('/tmp/ud/claude-accounts/p')
    expect(linkedClaudeConfigDirs()).toEqual([])
  })

  it('keeps the id validation even for a linked row (the one gate, not seven)', () => {
    registerClaudeAccountsSource(() => [acct({ id: '../escape', configDir: '/home/u/.claude-2' })])
    expect(() => claudeConfigDirFor('../escape')).toThrow(/invalid account id/)
  })

  it('a throwing settings source costs the linked answer, never the call', () => {
    // This runs on the hook-event hot path and from both jails: a settings store mid-write must
    // not take a 204 down with it, and "no linked accounts" is the safe direction.
    registerClaudeAccountsSource(() => {
      throw new Error('settings unreadable')
    })
    expect(claudeAccountsSnapshot()).toEqual([])
    expect(claudeConfigDirFor('abc')).toBe('/tmp/ud/claude-accounts/abc')
    expect(linkedClaudeConfigDirs()).toEqual([])
  })

  it('linkedClaudeConfigDirs dedupes two rows naming one dir', () => {
    registerClaudeAccountsSource(() => [
      acct({ id: 'a', configDir: '/home/u/.claude-2' }),
      acct({ id: 'b', configDir: '/home/u/.claude-2/' }),
      acct({ id: 'c', configDir: '/home/u/.claude-3' })
    ])
    expect(linkedClaudeConfigDirs()).toEqual(['/home/u/.claude-2', '/home/u/.claude-3'])
  })
})
