import { describe, it, expect } from 'vitest'
import { defaultProfileLabel, externalProfileId, isPlausibleProfileDir } from './external-profile'

describe('isPlausibleProfileDir', () => {
  it('accepts POSIX and Windows absolute paths', () => {
    expect(isPlausibleProfileDir('/home/tester/.claude-2')).toBe(true)
    expect(isPlausibleProfileDir('C:\\Users\\tester\\.codex-2')).toBe(true)
    expect(isPlausibleProfileDir('\\\\server\\share\\profile')).toBe(true)
  })

  it('rejects anything a process cwd would resolve differently', () => {
    expect(isPlausibleProfileDir('~/.claude-2')).toBe(false)
    expect(isPlausibleProfileDir('./profile')).toBe(false)
    expect(isPlausibleProfileDir('profile')).toBe(false)
    expect(isPlausibleProfileDir('')).toBe(false)
    expect(isPlausibleProfileDir('   ')).toBe(false)
  })

  it('rejects a non-string', () => {
    // A hand-edited settings.json is the input this guards, so the type is not guaranteed.
    expect(isPlausibleProfileDir(null)).toBe(false)
    expect(isPlausibleProfileDir(42)).toBe(false)
    expect(isPlausibleProfileDir({})).toBe(false)
  })
})

describe('defaultProfileLabel', () => {
  it('names a profile after its directory', () => {
    expect(defaultProfileLabel('/home/tester/.claude-2')).toBe('.claude-2')
    expect(defaultProfileLabel('C:\\Users\\tester\\.codex-2')).toBe('.codex-2')
  })

  it('ignores a trailing separator', () => {
    expect(defaultProfileLabel('/home/tester/.codex-2/')).toBe('.codex-2')
  })

  it('falls back to the raw path when there is no final segment', () => {
    expect(defaultProfileLabel('/')).toBe('/')
  })
})

describe('externalProfileId', () => {
  it('namespaces by provider so two providers can share a directory path', () => {
    expect(externalProfileId({ provider: 'claude', dir: '/h/.p' })).toBe('ext:claude:/h/.p')
    expect(externalProfileId({ provider: 'codex', dir: '/h/.p' })).toBe('ext:codex:/h/.p')
  })

  it('cannot collide with a managed account id', () => {
    // Managed ids match /^[A-Za-z0-9][A-Za-z0-9._-]*$/ — `:` is outside that alphabet, which is
    // what lets a path builder that validates its input refuse one of these outright.
    expect(/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(externalProfileId({ provider: 'claude', dir: '/x' })))
      .toBe(false)
  })

  it('is stable for the same profile', () => {
    const a = externalProfileId({ provider: 'codex', dir: '/h/.codex-2' })
    const b = externalProfileId({ provider: 'codex', dir: '/h/.codex-2' })
    expect(a).toBe(b)
  })
})
