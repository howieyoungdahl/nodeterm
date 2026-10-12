import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'
import { resolveCodexHomeRouting, observedCodexHome, isBoundCodexTranscript, SECOND_CODEX_HOME_SCOPE } from './codex-home-routing'
import { writeCodexThreadIdentity, readCodexThreadIdentity, setCodexThreadIdentityAuthSecret, resetCodexThreadIdentityAuthSecret } from './codex-identity-proxy'
import { codexHomeFor } from './codex-config-dir'
import { resolveCodexSessionScope } from './codex-accounts-core'
import { isSafeAccountId } from '../shared/codex-account'
import { reduceEntry, buildFile, recordAgentEvent, recordCodexContext, mirrorEntry, _resetForTest, sweepStaleWorking } from './agent-status-mirror'

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-home-routing-'))
  initPlatform(fakePlatform({ userDataDir: dir }))
  setCodexThreadIdentityAuthSecret(Buffer.alloc(32, 23))
  _resetForTest()
})
afterEach(() => { vi.restoreAllMocks(); _resetForTest(); resetCodexThreadIdentityAuthSecret(); resetPlatformForTests(); fs.rmSync(dir, { recursive: true, force: true }) })

describe('Codex exact home routing and mirror telemetry', () => {
  it('routes both login homes and replaces stale inherited scope without accepting arbitrary paths', () => {
    const primary = path.join(os.homedir(), '.codex')
    const secondary = path.join(os.homedir(), '.codex-2')
    expect(resolveCodexHomeRouting(primary, SECOND_CODEX_HOME_SCOPE)).toMatchObject({ home: primary, accountId: undefined })
    expect(resolveCodexHomeRouting(secondary)).toMatchObject({ home: secondary, accountId: SECOND_CODEX_HOME_SCOPE })
    expect(resolveCodexHomeRouting(secondary).socket).toBe(path.join(secondary, 'app-server-control', 'app-server-control.sock'))
    expect(() => resolveCodexHomeRouting(path.join(os.homedir(), '.ssh'))).toThrow('Unsupported')
    expect(() => resolveCodexHomeRouting(secondary + '-evil')).toThrow('Unsupported')
  })

  it('preserves a pre-existing managed local-home-2 account beside the second local login namespace', () => {
    const managedId = 'local-home-2'
    const managedHome = codexHomeFor(managedId)
    const secondary = path.join(os.homedir(), '.codex-2')
    expect(isSafeAccountId(managedId)).toBe(true)
    expect(isSafeAccountId(SECOND_CODEX_HOME_SCOPE)).toBe(false)
    expect(resolveCodexSessionScope(dir, managedId, () => true)).toMatchObject({ CODEX_HOME: managedHome, NODETERM_CODEX_ACCOUNT_ID: managedId })
    expect(resolveCodexHomeRouting(managedHome, managedId)).toMatchObject({ home: managedHome, accountId: managedId })
    expect(resolveCodexHomeRouting(secondary, managedId)).toMatchObject({ home: secondary, accountId: SECOND_CODEX_HOME_SCOPE })
    writeCodexThreadIdentity('managed-thread', 'managed-node', '/endpoint', undefined, managedId)
    writeCodexThreadIdentity('local-thread', 'local-node', '/endpoint', undefined, SECOND_CODEX_HOME_SCOPE)
    const forged = fs.readFileSync(path.join(dir, 'codex-thread-nodes', managedId, 'managed-thread'), 'utf8').replace('accountId=local-home-2', 'accountId=@local-home-2')
    fs.writeFileSync(path.join(dir, 'codex-thread-nodes', SECOND_CODEX_HOME_SCOPE, 'managed-thread'), forged)
    expect(readCodexThreadIdentity('managed-thread', undefined, SECOND_CODEX_HOME_SCOPE)).toBeUndefined()
    expect(observedCodexHome('managed-node', 'managed-thread')).toMatchObject({ home: managedHome, accountId: managedId })
    expect(observedCodexHome('local-node', 'local-thread')).toMatchObject({ home: secondary, accountId: SECOND_CODEX_HOME_SCOPE })
    const managedTranscript = path.join(managedHome, 'sessions', 'rollout-managed-thread.jsonl')
    const localTranscript = path.join(secondary, 'sessions', 'rollout-local-thread.jsonl')
    expect(isBoundCodexTranscript('managed-node', 'managed-thread', managedTranscript)).toBe(true)
    expect(isBoundCodexTranscript('local-node', 'local-thread', localTranscript)).toBe(true)
    expect(isBoundCodexTranscript('managed-node', 'managed-thread', path.join(secondary, 'sessions', 'rollout-managed-thread.jsonl'))).toBe(false)
    expect(isBoundCodexTranscript('local-node', 'local-thread', path.join(managedHome, 'sessions', 'rollout-local-thread.jsonl'))).toBe(false)
  })

  it.each([undefined, SECOND_CODEX_HOME_SCOPE])('jails the exact signed thread in scope %s and rejects missing/foreign/ambiguous owners', (scope) => {
    writeCodexThreadIdentity('thread-one', 'node-one', '/endpoint', undefined, scope)
    const owner = observedCodexHome('node-one', 'thread-one')!
    const tp = path.join(owner.home, 'sessions', '2026', 'rollout-thread-one.jsonl')
    expect(isBoundCodexTranscript('node-one', 'thread-one', tp)).toBe(true)
    expect(isBoundCodexTranscript('node-two', 'thread-one', tp)).toBe(false)
    expect(isBoundCodexTranscript('node-one', 'missing', tp)).toBe(false)
    expect(isBoundCodexTranscript('node-one', 'thread-one', path.join(owner.home, 'auth.json'))).toBe(false)
    expect(isBoundCodexTranscript('node-one', 'thread-one', tp.replace('thread-one', 'thread-other'))).toBe(false)
    writeCodexThreadIdentity('thread-one', 'node-two', '/endpoint', undefined, scope ? undefined : SECOND_CODEX_HOME_SCOPE)
    expect(observedCodexHome('node-one', 'thread-one')).toBeUndefined()
  })

  it('drops old context when an exact thread is observed under a different home', () => {
    const ev = { nodeId: 'n', agentId: 'codex' as const, sessionId: 'same-thread', kind: 'state' as const, state: 'working' as const, verified: true }
    const old = reduceEntry(undefined, { ...ev, codexHome: '/primary' }, 1000)
    old.context = { usedTokens: 99999, windowTokens: 100000, updatedAt: 1000 }
    const moved = reduceEntry(old, { ...ev, codexHome: '/secondary' }, 2000)
    expect(moved.context).toBeUndefined()
    expect(moved.lastActivityAt).toBe(2000)
    expect(moved.codexHome).toBe('/secondary')
  })

  it.each([undefined, SECOND_CODEX_HOME_SCOPE])('preserves busy/ask/idle provenance and context without warming from context in scope %s', (scope) => {
    const home = resolveCodexHomeRouting(undefined, scope).home
    const ev = { nodeId: 'n', agentId: 'codex' as const, sessionId: 's', kind: 'state' as const, verified: true, codexHome: home, codexAccountId: scope ?? null }
    const working = reduceEntry(undefined, { ...ev, state: 'working', newTurn: true }, 1000)
    const waiting = reduceEntry(working, { ...ev, state: 'waiting', awaitingInput: true }, 1100)
    const held = reduceEntry(waiting, { ...ev, state: 'done' }, 1200)
    expect(held.state).toBe('waiting')
    const done = reduceEntry(held, { ...ev, state: 'working', newTurn: true }, 1300)
    const ended = reduceEntry(done, { ...ev, state: 'done' }, 1400)
    expect(buildFile({ n: ended }, 1400).nodes.n).toMatchObject({ codexHome: home, state: 'done', stateVerified: true, stateSource: 'hook', lastActivityAt: 1400 })
    vi.spyOn(Date, 'now').mockReturnValue(2000)
    recordAgentEvent({ ...ev, state: 'working', newTurn: true })
    recordCodexContext('n', { sessionId: 'wrong', usedTokens: 99999, windowTokens: 100000 }, 2500)
    expect(mirrorEntry('n')?.context).toBeUndefined()
    recordCodexContext('n', { sessionId: 's', usedTokens: 1234, windowTokens: 100000, model: 'test' }, 3000)
    expect(mirrorEntry('n')).toMatchObject({ lastActivityAt: 2000, context: { usedTokens: 1234, updatedAt: 3000 } })
    sweepStaleWorking(2000 + 21 * 60_000)
    expect(mirrorEntry('n')).toMatchObject({ state: 'done', stateSource: 'stale', stateVerified: false, updatedAt: 2000 })
  })
})
