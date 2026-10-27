import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetCodexThreadIdentityAuthSecret, setCodexThreadIdentityAuthSecret, writeCodexThreadIdentity } from '../core/codex-identity-proxy'
import { ServerLifecycleReader } from './lifecycle'

let home: string
let dataDir: string
const sid = '00000000-1111-2222-3333-444444444444'
const now = 1_800_000_000_000
const doneAt = now - 10 * 60_000
const owner = (binary = 'codex') => ({ panePid: 10, tty: '/dev/pts/1', command: 'node', argv: [`node /fixture/${binary} --remote unix:///fixture.sock`] })
const input = { paneState: 'alive' as const, isAgent: false, provider: null, createdAt: now - 20 * 60_000 }
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-life-hookless-'))
  dataDir = path.join(home, 'data')
  vi.stubEnv('HOME', home)
  vi.stubEnv('USERPROFILE', home)
  vi.stubEnv('CODEX_HOME', path.join(home, '.codex'))
  setCodexThreadIdentityAuthSecret(Buffer.alloc(32, 7))
})
afterEach(() => {
  resetCodexThreadIdentityAuthSecret()
  vi.unstubAllEnvs()
  fs.rmSync(home, { recursive: true, force: true })
})
function bind(accountId?: string) {
  writeCodexThreadIdentity(sid, 'n', '/fixture/hook-endpoint.env', path.join(dataDir, 'codex-thread-nodes'), accountId)
}
function rollout(root = '.codex') {
  const file = path.join(home, root, 'sessions', '2026', '10', '14', `rollout-fixture-${sid}.jsonl`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ type: 'event_msg', timestamp: new Date(doneAt).toISOString(), payload: { type: 'task_complete' } }) + '\n')
  return file
}
function reader(capture = '', binary = 'codex') {
  return new ServerLifecycleReader({ entry: () => undefined, paneOwner: async () => owner(binary),
    paneCommand: async () => 'node', capture: async () => capture, now: () => now, userDataDir: dataDir })
}
describe('lifecycle without a mirror entry', () => {
  it('uses the kernel provider and signed exact thread to recover a cold rollout', async () => {
    bind(); rollout()
    expect(await reader().read('n', input)).toMatchObject({ provider: 'codex', sessionId: sid, state: 'idle-cold', lastDoneAt: doneAt })
  })
  it('detects hooks-review even when the bound rollout ended cold', async () => {
    bind(); rollout()
    expect(await reader('Hooks need review\n1. Trust these hooks\n2. Continue without hooks').read('n', input))
      .toMatchObject({ provider: 'codex', sessionId: sid, state: 'blocked', blockedOn: { kind: 'codex-hooks-review' } })
  })
  it('does not guess a thread from a neighboring rollout or saved Codex session', async () => {
    rollout()
    expect(await reader().read('n', { ...input, sessionId: sid })).toMatchObject({ state: 'unknown', provider: 'codex', sessionId: null, lastDoneAt: null })
  })
  it('preserves startup grace for a newly created agent before any session is bound', async () => {
    expect(await reader().read('n', { ...input, createdAt: now - 100 }))
      .toMatchObject({ state: 'starting', provider: 'codex', sessionId: null })
  })
  it('refuses a tampered signed binding', async () => {
    bind(); rollout()
    const file = path.join(dataDir, 'codex-thread-nodes', sid)
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('signature=', 'signature=bad'))
    expect(await reader().read('n', input)).toMatchObject({ state: 'unknown', sessionId: null })
  })
  it('refuses two signed sessions for one node', async () => {
    bind(); rollout()
    writeCodexThreadIdentity('different-thread', 'n', '/fixture/hook-endpoint.env', path.join(dataDir, 'codex-thread-nodes'))
    expect(await reader().read('n', input)).toMatchObject({ state: 'unknown', sessionId: null })
  })
  it('refuses the same thread signed in two account scopes', async () => {
    bind(); rollout()
    writeCodexThreadIdentity(sid, 'other-node', '/fixture/hook-endpoint.env', path.join(dataDir, 'codex-thread-nodes'), '@local-home-2')
    expect(await reader().read('n', input)).toMatchObject({ state: 'unknown', sessionId: null })
  })
  it('uses the signed second-home scope rather than a same-ID primary rollout', async () => {
    bind('@local-home-2'); rollout()
    const file = rollout('.codex-2')
    fs.writeFileSync(file, JSON.stringify({ type: 'event_msg', timestamp: new Date(now - 10).toISOString(), payload: { type: 'task_complete' } }) + '\n')
    expect(await reader().read('n', input)).toMatchObject({ state: 'idle-warm', lastDoneAt: now - 10 })
  })
  it.skipIf(process.platform === 'win32')('does not read a bound rollout symlink outside its home jail', async () => {
    bind()
    const file = rollout()
    const outside = path.join(home, 'outside.jsonl')
    fs.copyFileSync(file, outside)
    fs.unlinkSync(file)
    fs.symlinkSync(outside, file)
    expect((await reader().read('n', input)).state).toBe('unknown')
  })
  it('uses the saved Claude session only when Claude owns the pane', async () => {
    const file = path.join(home, '.claude', 'projects', '-fixture', `${sid}.jsonl`)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ type: 'assistant', timestamp: new Date(doneAt).toISOString(), message: { content: [{ type: 'text', text: 'Done' }] } }) + '\n')
    expect(await reader('', 'claude').read('n', { ...input, sessionId: sid }))
      .toMatchObject({ provider: 'claude', sessionId: sid, state: 'idle-warm', lastDoneAt: doneAt })
    expect(await reader('', 'editor').read('n', { ...input, provider: 'claude', isAgent: true, sessionId: sid }))
      .toMatchObject({ provider: null, sessionId: null, state: 'unknown' })
  })
})
