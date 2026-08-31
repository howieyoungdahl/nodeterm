import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { loadOrCreateOpsToken, opsBearerMatches } from './ops-token'

describe('operator token', () => {
  let dir = ''
  let file = ''

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeterm-ops-token-'))
    file = path.join(dir, 'nested', 'ops-token')
  })

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

  it('creates one restart-stable 0600 bearer token', () => {
    const first = loadOrCreateOpsToken(file)
    const second = loadOrCreateOpsToken(file)

    expect(first).toMatch(/^[A-Za-z0-9_-]{40,}$/)
    expect(second).toBe(first)
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(fs.readFileSync(file, 'utf8')).toBe(`${first}\n`)
  })

  it('tightens an existing token and refuses an empty one instead of rotating silently', () => {
    const existing = 'a'.repeat(43)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `${existing}\n`, { mode: 0o644 })
    expect(loadOrCreateOpsToken(file)).toBe(existing)
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)

    fs.writeFileSync(file, '\n')
    expect(() => loadOrCreateOpsToken(file)).toThrow(/empty|invalid/i)
  })

  it('refuses a non-regular token path', () => {
    fs.mkdirSync(file, { recursive: true })
    expect(() => loadOrCreateOpsToken(file)).toThrow(/regular file/i)
  })

  it('accepts only the dedicated bearer header', () => {
    expect(opsBearerMatches('Bearer secret-token', 'secret-token')).toBe(true)
    expect(opsBearerMatches('bearer secret-token', 'secret-token')).toBe(true)
    expect(opsBearerMatches('Bearer wrong', 'secret-token')).toBe(false)
    expect(opsBearerMatches(undefined, 'secret-token')).toBe(false)
  })
})
