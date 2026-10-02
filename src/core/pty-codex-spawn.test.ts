/**
 * S6 §5 property 4 / Decision 2 — the carried PR-1 obligation, now at the PtyManager layer.
 *
 * `resolveCodexSessionScope` (pty-codex-account.test.ts) proves the MODEL fails closed. This proves
 * the PtyManager CONSUMES it: a LOCAL Codex create that explicitly selected a managed account whose
 * home is MISSING refuses (`unavailable: 'codex-account'`) and spawns NOTHING — it never falls
 * through to a system-`~/.codex` shell wearing the switch's identity. When the home exists, the
 * same create spawns and the session runs under that managed CODEX_HOME + account id. The system
 * account (no id, agentId codex) always spawns and pins NODETERM_CODEX_ACCOUNT_ID='' explicitly.
 *
 * MUTATION (recorded in the PR body): delete the `isCodexScopeRefusal` refusal block in
 * pty-manager `spawnNew` → the missing-account create falls through and SPAWNS, so
 * `expect(spawned).toHaveLength(0)` and `res.unavailable` both redden.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'fs'
import os from 'os'
import path from 'path'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform, type FakePlatform } from './platform-fake'
import { IPC } from '../shared/ipc'
import type { PtyCreateOptions, PtyCreateResult } from '../shared/types'
import { codexAccountHome } from './codex-accounts-core'

const spawned: Array<{ file: string; args: string[]; env: Record<string, string> }> = []

// This suite mocks node-pty and asserts the plain-shell spawn path. Pin off the session-host
// backend so a built `out/session-host/host.cjs` on disk cannot flip create() onto the host
// backend (where the mocked spawn is never called). See __fixtures__/no-session-host.ts.
vi.mock('./session-host-backend', async () =>
  (await import('./__fixtures__/no-session-host')).noSessionHost()
)

vi.mock('node-pty', () => ({
  spawn: (file: string, args: string[], options: { env: Record<string, string> }) => {
    spawned.push({ file, args, env: options?.env ?? {} })
    return {
      onData: () => {},
      onExit: () => {},
      write: () => {},
      resize: () => {},
      pause: () => {},
      resume: () => {},
      kill: () => {},
      pid: 4321
    }
  }
}))

// Never let the real /dev probe refuse the spawn on the developer's host (see pty-require-remote).
vi.mock('./pty-devices', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./pty-devices')>()),
  readPtyDevices: () => ({ ceiling: 511, inUse: 8 })
}))

const ALICE = 1

describe('pty create: a local Codex spawn fails closed on a missing selected account', () => {
  let fake: FakePlatform
  let userDataDir: string

  beforeEach(async () => {
    spawned.length = 0
    userDataDir = mkdtempSync(path.join(os.tmpdir(), 'nodeterm-codex-spawn-'))
    fake = fakePlatform({ userDataDir })
    initPlatform(fake)
    const { PtyManager } = await import('./pty-manager')
    new PtyManager({cleanupBootId:'private-fixture-boot'}).registerIpc()
  })
  afterEach(() => {
    resetPlatformForTests()
    rmSync(userDataDir, { recursive: true, force: true })
  })

  const create = (options: Partial<PtyCreateOptions>) =>
    fake.handlers[IPC.ptyCreate](ALICE, {
      cols: 80,
      rows: 24,
      persistKey: 'node-1',
      cwd: '/srv/app',
      ...options
    }) as Promise<PtyCreateResult>

  it('refuses (spawning nothing) when the explicitly selected managed home is missing', async () => {
    // The account home is deliberately NOT created.
    const res = await create({ agentId: 'codex', accountId: 'acct-missing' })

    expect(spawned).toHaveLength(0) // the whole point: no system-~/.codex shell wearing the switch id
    expect(res.unavailable).toBe('codex-account')
    expect(res.sessionId).toBe('')
    expect(res.fresh).toBe(false)
  })

  it('spawns under the managed CODEX_HOME + account id once the home exists', async () => {
    const home = codexAccountHome(userDataDir, 'acct-real')
    mkdirSync(home, { recursive: true })

    const res = await create({ agentId: 'codex', accountId: 'acct-real', persistKey: 'node-2' })

    expect(res.unavailable).toBeUndefined()
    expect(res.sessionId).not.toBe('')
    expect(spawned).toHaveLength(1)
    expect(spawned[0].env.CODEX_HOME).toBe(home)
    expect(spawned[0].env.NODETERM_CODEX_ACCOUNT_ID).toBe('acct-real')
    expect(spawned[0].env.NODETERM_CLEANUP_BOOT).toBe('private-fixture-boot')
  })

  it('a system Codex node (no account id) always spawns and clears any managed scope explicitly', async () => {
    const res = await create({ agentId: 'codex', persistKey: 'node-3' })

    expect(res.unavailable).toBeUndefined()
    expect(spawned).toHaveLength(1)
    // Explicitly empty — a parent tmux server's leaked managed scope must be overwritten, not
    // inherited (§2.1).
    expect(spawned[0].env.NODETERM_CODEX_ACCOUNT_ID).toBe('')
    expect(path.isAbsolute(spawned[0].env.CODEX_HOME)).toBe(true)
  })
})
