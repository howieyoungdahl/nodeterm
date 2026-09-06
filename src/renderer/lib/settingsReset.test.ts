import { describe, it, expect } from 'vitest'
import { DEFAULT_SETTINGS, type Settings } from '@shared/types'
import {
  APPEARANCE_RESET_KEYS,
  TERMINAL_RESET_KEYS,
  isPristine,
  resetPatch
} from './settingsReset'

describe('reset key lists', () => {
  /**
   * Settings whose shipped default is ABSENCE, so they are legitimately missing from
   * `DEFAULT_SETTINGS`. Resetting one means REMOVING the key, which is what `resetPatch` does by
   * reading `undefined` out of `DEFAULT_SETTINGS` — see the case below.
   *
   * Kept as an explicit list rather than relaxing the check for every optional key: the assertion
   * underneath is a typo guard, and "absent from the defaults" is exactly what a typo looks like.
   */
  const DEFAULT_IS_ABSENT: readonly string[] = ['appearance']

  it.each([
    ['terminal', TERMINAL_RESET_KEYS],
    ['appearance', APPEARANCE_RESET_KEYS]
  ])('%s keys all exist in DEFAULT_SETTINGS (or default to absence)', (_name, keys) => {
    for (const k of keys) {
      if (DEFAULT_IS_ABSENT.includes(k)) expect(DEFAULT_SETTINGS).not.toHaveProperty(k)
      else expect(DEFAULT_SETTINGS).toHaveProperty(k)
    }
  })

  // The visual preferences (@shared/appearance) are the whole block, so "Reset appearance" has to
  // clear them — and clearing means the key is GONE, not set to an empty object a later read would
  // treat as "configured".
  it('resets the visual preferences by removing the key, not by storing an empty block', () => {
    expect(APPEARANCE_RESET_KEYS).toContain('appearance')
    const patch = resetPatch(['appearance'] as const)
    expect('appearance' in patch).toBe(true)
    expect(patch.appearance).toBeUndefined()
    // And a user who set one is correctly reported as no longer pristine.
    expect(isPristine(['appearance'] as const, { appearance: { effectsOff: true } })).toBe(false)
    expect(isPristine(['appearance'] as const, {})).toBe(true)
  })

  it.each([
    ['terminal', TERMINAL_RESET_KEYS],
    ['appearance', APPEARANCE_RESET_KEYS]
  ])('%s keys have no duplicates', (_name, keys) => {
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('the two sections claim no key in common — a reset must have one owner', () => {
    const overlap = TERMINAL_RESET_KEYS.filter((k) =>
      (APPEARANCE_RESET_KEYS as readonly string[]).includes(k)
    )
    expect(overlap).toEqual([])
  })

  // Deliberate exclusion: the terminal renders with it, but it belongs to the tmux section, and
  // resetting a scrollback limit from an appearance button would be a surprise.
  it('does not claim tmuxScrollback', () => {
    expect(TERMINAL_RESET_KEYS).not.toContain('tmuxScrollback')
  })

  // A global "reset everything" would empty these; per-section lists must never reach them.
  it.each(['claudeAccounts', 'customAgents', 'seenOnboarding', 'phoneAccessEnabled'])(
    'never resets %s',
    (danger) => {
      expect([...TERMINAL_RESET_KEYS, ...APPEARANCE_RESET_KEYS]).not.toContain(danger)
    }
  )
})

describe('resetPatch', () => {
  it('returns exactly the defaults for the listed keys', () => {
    const patch = resetPatch(TERMINAL_RESET_KEYS)
    expect(Object.keys(patch).sort()).toEqual([...TERMINAL_RESET_KEYS].sort())
    for (const k of TERMINAL_RESET_KEYS) expect(patch[k]).toEqual(DEFAULT_SETTINGS[k])
  })

  it('touches nothing outside the list', () => {
    expect(resetPatch(['fontSize'] as const)).toEqual({ fontSize: DEFAULT_SETTINGS.fontSize })
  })
})

describe('isPristine', () => {
  it('is true for untouched defaults', () => {
    expect(isPristine(TERMINAL_RESET_KEYS, DEFAULT_SETTINGS)).toBe(true)
  })

  it('is false once any listed key differs', () => {
    const changed: Settings = { ...DEFAULT_SETTINGS, terminalTheme: 'dracula' }
    expect(isPristine(TERMINAL_RESET_KEYS, changed)).toBe(false)
  })

  it('ignores changes to keys it was not asked about', () => {
    const changed: Settings = { ...DEFAULT_SETTINGS, tmuxScrollback: 999 }
    expect(isPristine(TERMINAL_RESET_KEYS, changed)).toBe(true)
  })

  it('compares list-valued keys structurally, not by identity', () => {
    const sameContent: Settings = { ...DEFAULT_SETTINGS, hiddenHeaderButtons: [] }
    expect(isPristine(APPEARANCE_RESET_KEYS, sameContent)).toBe(true)
    const different: Settings = { ...DEFAULT_SETTINGS, hiddenHeaderButtons: ['branch'] }
    expect(isPristine(APPEARANCE_RESET_KEYS, different)).toBe(false)
  })
})
