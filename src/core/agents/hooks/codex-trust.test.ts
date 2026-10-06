import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { writeConfigAtomically } from './codex-trust'

const staging = vi.hoisted(() => ({ modes: [] as number[], unreadablePath: null as string | null }))

// Observe the real file immediately after its content is written, before a
// later chmod/rename could hide an initially over-readable temporary file.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    existsSync: (path: Parameters<typeof actual.existsSync>[0]) =>
      path === staging.unreadablePath ? false : actual.existsSync(path),
    statSync: (...args: Parameters<typeof actual.statSync>) => {
      if (args[0] === staging.unreadablePath) {
        throw Object.assign(new Error('fixture stat denied'), { code: 'EACCES' })
      }
      return actual.statSync(...args)
    },
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      actual.writeFileSync(...args)
      if (typeof args[0] === 'string' && args[0].endsWith('.tmp')) {
        staging.modes.push(actual.statSync(args[0]).mode & 0o777)
      } else if (typeof args[0] === 'number') {
        staging.modes.push(actual.fstatSync(args[0]).mode & 0o777)
      }
    }
  }
})

describe('writeConfigAtomically permissions', () => {
  let root: string
  let originalUmask: number

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'nt-codex-config-mode-'))
    originalUmask = process.umask(0o002)
    staging.modes = []
    staging.unreadablePath = null
  })

  afterEach(() => {
    process.umask(originalUmask)
    staging.unreadablePath = null
    rmSync(root, { recursive: true, force: true })
  })

  // Windows chmod exposes read/write flags, not POSIX confidentiality or ACLs.
  it.skipIf(process.platform === 'win32')('keeps an existing 0600 file and its staging bytes private under umask 0002', () => {
    const config = join(root, 'config.toml')
    writeFileSync(config, 'model = "before"\n', { mode: 0o600 })

    writeConfigAtomically(config, 'model = "after"\n')

    expect(staging.modes).toEqual([0o600])
    expect(statSync(config).mode & 0o777).toBe(0o600)
    expect(statSync(`${config}.bak`).mode & 0o777).toBe(0o600)
    expect(readFileSync(`${config}.bak`, 'utf8')).toBe('model = "before"\n')
    expect(readFileSync(config, 'utf8')).toBe('model = "after"\n')
  })

  it.skipIf(process.platform === 'win32')('preserves an existing mode independently of a more restrictive umask', () => {
    const config = join(root, 'config.toml')
    writeFileSync(config, 'before\n', { mode: 0o640 })
    process.umask(0o077)

    writeConfigAtomically(config, 'after\n')

    expect(staging.modes).toEqual([0o600])
    expect(statSync(config).mode & 0o777).toBe(0o640)
  })

  it.skipIf(process.platform === 'win32')('creates a missing config privately under umask 0002', () => {
    const config = join(root, 'new', 'config.toml')

    writeConfigAtomically(config, 'model = "new"\n')

    expect(staging.modes).toEqual([0o600])
    expect(statSync(config).mode & 0o777).toBe(0o600)
    expect(existsSync(`${config}.bak`)).toBe(false)
  })

  it('refuses an unknown existing mode even when existsSync reports false on a failed read', () => {
    const config = join(root, 'config.toml')
    writeFileSync(config, 'retained\n', { mode: 0o600 })
    staging.unreadablePath = config

    expect(() => writeConfigAtomically(config, 'must not publish\n')).toThrow('fixture stat denied')

    expect(staging.modes).toEqual([])
    expect(readFileSync(config, 'utf8')).toBe('retained\n')
    expect(existsSync(`${config}.bak`)).toBe(false)
  })

  it('publishes exact supplied bytes while retaining the prior backup and separate hook definitions', () => {
    const command = 'if [ -x "$HOME/.nodeterm/agent-hooks/codex.sh" ]; then /bin/sh "$HOME/.nodeterm/agent-hooks/codex.sh"; fi'
    const hooksPath = join(root, 'hooks.json')
    const hookBytes = JSON.stringify({ hooks: Array.from({ length: 8 }, () => ({ command })) })
    writeFileSync(hooksPath, hookBytes)
    const config = join(root, 'config.toml')
    const approved = Array.from({ length: 8 }, (_, i) =>
      `[hooks.state."fixture:approved:${i}"]\nenabled = true\ntrusted_hash = "approved-${i}"\n`
    ).join('\n')
    const unmanaged = Array.from({ length: 63 }, (_, i) =>
      `[hooks.state."fixture:unmanaged:${i}"]\nenabled = ${i % 2 === 0}\ntrusted_hash = "unchanged-${i}"\n`
    ).join('\n')
    const before = '# retained comment\nmodel = "fixture"\n\n' + approved + '\n' + unmanaged
    writeFileSync(config, before, { mode: 0o600 })
    const after = before + '\n# supplied update\n'

    writeConfigAtomically(config, after)

    expect(readFileSync(config, 'utf8')).toBe(after)
    expect(readFileSync(`${config}.bak`, 'utf8')).toBe(before)
    expect(readFileSync(hooksPath, 'utf8')).toBe(hookBytes)
  })
})
