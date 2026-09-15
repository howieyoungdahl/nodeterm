import { describe, it, expect } from 'vitest'
import {
  checkProfileDir,
  externalCodexUsageAccounts,
  resolveExternalProfiles
} from './external-profile-dir'
import type { ExternalUsageProfile } from '../../shared/external-profile'

const HOME = '/home/tester'
const dir = (provider: 'claude' | 'codex', d: string, label = ''): ExternalUsageProfile => ({
  provider,
  dir: d,
  label
})

describe('checkProfileDir', () => {
  it('accepts an absolute directory inside home', () => {
    expect(checkProfileDir(`${HOME}/.claude-2`, HOME)).toEqual({
      ok: true,
      dir: `${HOME}/.claude-2`
    })
  })

  it('tolerates a trailing separator', () => {
    // Shell tab-completion adds one; refusing it would be a papercut with no safety value.
    expect(checkProfileDir(`${HOME}/.codex-2/`, HOME)).toEqual({
      ok: true,
      dir: `${HOME}/.codex-2`
    })
  })

  it('refuses a relative path', () => {
    // A relative path resolves against a cwd that differs between the desktop app and the
    // Server Edition — the same setting would name two different directories.
    expect(checkProfileDir('.claude-2', HOME).ok).toBe(false)
    expect(checkProfileDir('~/.claude-2', HOME).ok).toBe(false)
  })

  it('refuses a traversal segment', () => {
    // Validated at read time precisely so a hand-edited settings file cannot walk out of home.
    const verdict = checkProfileDir(`${HOME}/../etc`, HOME)
    expect(verdict.ok).toBe(false)
  })

  it('refuses home itself', () => {
    expect(checkProfileDir(HOME, HOME).ok).toBe(false)
  })

  it('refuses a directory outside home', () => {
    expect(checkProfileDir('/etc', HOME).ok).toBe(false)
    expect(checkProfileDir('/home/someone-else/.claude', HOME).ok).toBe(false)
    // A sibling whose name merely STARTS with the home path is not inside it.
    expect(checkProfileDir('/home/tester-other/.claude', HOME).ok).toBe(false)
  })

  it('refuses a non-string', () => {
    expect(checkProfileDir(null, HOME).ok).toBe(false)
    expect(checkProfileDir(undefined, HOME).ok).toBe(false)
    expect(checkProfileDir(42, HOME).ok).toBe(false)
  })
})

describe('resolveExternalProfiles', () => {
  it('keeps only the requested provider', () => {
    const rows = resolveExternalProfiles(
      [dir('claude', `${HOME}/.claude-2`), dir('codex', `${HOME}/.codex-2`)],
      'claude',
      HOME
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].dir).toBe(`${HOME}/.claude-2`)
  })

  it('labels a row from its directory when no label is given', () => {
    const rows = resolveExternalProfiles([dir('claude', `${HOME}/.claude-2`)], 'claude', HOME)
    expect(rows[0].label).toBe('.claude-2')
  })

  it('prefers an explicit label', () => {
    const rows = resolveExternalProfiles(
      [dir('claude', `${HOME}/.claude-2`, 'Second profile')],
      'claude',
      HOME
    )
    expect(rows[0].label).toBe('Second profile')
  })

  it('drops entries that fail validation rather than throwing', () => {
    // A malformed settings list must not take the whole usage sweep down with it.
    const rows = resolveExternalProfiles(
      [dir('claude', '/etc'), dir('claude', 'relative'), dir('claude', `${HOME}/ok`)],
      'claude',
      HOME
    )
    expect(rows.map((r) => r.dir)).toEqual([`${HOME}/ok`])
  })

  it('collapses two entries naming the same directory', () => {
    // They would carry the same id; rendering the same numbers twice under two labels would
    // misstate how many accounts there are.
    const rows = resolveExternalProfiles(
      [dir('claude', `${HOME}/.claude-2`, 'A'), dir('claude', `${HOME}/.claude-2`, 'B')],
      'claude',
      HOME
    )
    expect(rows).toHaveLength(1)
  })

  it('survives a missing or malformed list', () => {
    expect(resolveExternalProfiles(undefined, 'claude', HOME)).toEqual([])
    expect(resolveExternalProfiles([null as any], 'claude', HOME)).toEqual([])
  })

  it('gives each row an id that cannot collide with a managed account id', () => {
    // Managed account ids are UUIDs; `:` is outside ACCOUNT_ID_RE's alphabet, so a path builder
    // that validates its input can never mistake one of these for an account.
    const rows = resolveExternalProfiles([dir('claude', `${HOME}/.claude-2`)], 'claude', HOME)
    expect(rows[0].id.startsWith('ext:claude:')).toBe(true)
  })
})

describe('externalCodexUsageAccounts', () => {
  it('shapes a profile exactly like a managed account row', () => {
    // Byte-identical to codexUsageAccounts' output, so the usage service treats both the same
    // way and only the origin of the home differs.
    const rows = externalCodexUsageAccounts([dir('codex', `${HOME}/.codex-2`, 'Second')], HOME)
    expect(rows).toEqual([
      { id: `ext:codex:${HOME}/.codex-2`, home: `${HOME}/.codex-2`, label: 'Second', email: null }
    ])
  })

  it('ignores Claude profiles', () => {
    expect(externalCodexUsageAccounts([dir('claude', `${HOME}/.claude-2`)], HOME)).toEqual([])
  })
})
