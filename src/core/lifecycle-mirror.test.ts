import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { normalizeClaude, normalizeCodex, type NormalizedAgentEvent } from '../shared/agents/normalize'
import { _resetForTest, buildFile, flush, initAgentStatusMirror, mirrorEntry, recordAgentEvent, recordRawToolEvent, reduceEntry, recordLifecycleTranscript } from './agent-status-mirror'

const event = (provider: 'claude' | 'codex', hook: string, extra: object = {}): NormalizedAgentEvent => {
  const normalized = (provider === 'claude' ? normalizeClaude : normalizeCodex)({
    nodeId: 'n', agentId: provider, payload: { hook_event_name: hook, session_id: 'session', ...extra }
  })
  expect(normalized).toBeTruthy()
  return normalized!
}
let dir: string | undefined
afterEach(() => { _resetForTest(); vi.useRealTimers(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); dir = undefined })

describe('lifecycle mirror clocks', () => {
  it.each(['claude', 'codex'] as const)('stamps only a clean %s Stop and preserves it after tools', provider => {
    let entry = reduceEntry(undefined, event(provider, 'UserPromptSubmit'), 100)
    expect(entry.lastPromptAt).toBe(100)
    entry = reduceEntry(entry, event(provider, 'Stop'), 200)
    expect(entry).toMatchObject({ lastDoneAt: 200, lastDoneClean: true })
    entry = reduceEntry(entry, event(provider, 'PostToolUse'), 250)
    expect(entry).toMatchObject({ lastDoneAt: 200, lastEventAt: 250, state: 'done' })
    entry = reduceEntry(entry, event(provider, 'PostToolUse'), 10_000)
    expect(entry).toMatchObject({ lastDoneAt: 200, lastEventAt: 10_000, state: 'working' })
  })
  it('StopFailure, idle rescue, interrupted Stop and ordinary done never stamp clean completion', () => {
    for (const end of [event('claude', 'StopFailure'), event('codex', 'StopFailure'), event('claude', 'Notification', { notification_type: 'idle_prompt' }),
      event('claude', 'Stop', { is_interrupt: true }), { nodeId: 'n', agentId: 'claude', kind: 'state', state: 'done' } as const]) {
      const result = reduceEntry(reduceEntry(undefined, event('claude', 'UserPromptSubmit'), 100), end, 200)
      expect(result.lastDoneAt).toBeUndefined()
      expect(result.lastDoneClean).toBe(false)
    }
  })
  it('does not stamp Codex Stop while request_user_input is unanswered', () => {
    const ask = event('codex', 'PreToolUse', { tool_name: 'request_user_input', tool_input: { questions: [{ question: 'Choose?' }] } })
    const waiting = reduceEntry(undefined, ask, 100)
    const held = reduceEntry(waiting, event('codex', 'Stop'), 200)
    expect(held).toMatchObject({ state: 'waiting', blockedKind: 'question', blockedSince: 100, blockedDetail: 'Choose?' })
    expect(held.lastDoneAt).toBeUndefined()
  })
  it.each([
    ['PermissionRequest', {}, 'permission'],
    ['Notification', { notification_type: 'elicitation_dialog' }, 'elicitation'],
    ['Notification', { notification_type: 'agent_needs_input' }, 'input']
  ] as const)('retains blocked kind %s %j', (hook, payload, kind) => {
    const first = reduceEntry(undefined, event('claude', hook, payload), 100)
    const repeated = reduceEntry(first, event('claude', hook, payload), 200)
    expect(repeated).toMatchObject({ blockedKind: kind, blockedSince: 100 })
    expect(reduceEntry(repeated, event('claude', 'UserPromptSubmit'), 300).blockedKind).toBeUndefined()
  })
  it('resets old completion identity at replacement and records SessionEnd separately', () => {
    const finished = reduceEntry(undefined, event('claude', 'Stop'), 100)
    const ended = reduceEntry(finished, event('claude', 'SessionEnd'), 200)
    expect(ended.sessionEndedAt).toBe(200)
    const restarted = reduceEntry(ended, event('claude', 'SessionStart'), 300)
    expect(restarted.lastDoneAt).toBeUndefined()
    expect(restarted.sessionEndedAt).toBeUndefined()
    const replaced = reduceEntry(finished, { ...event('codex', 'UserPromptSubmit'), sessionId: 'another' }, 400)
    expect(replaced.lastDoneAt).toBeUndefined()
  })
  it('persists clean clocks and exact transcript binding across restart, without trusting old state', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_800_000_000_000)
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-lifecycle-mirror-'))
    const file = path.join(dir, 'agent-status.json')
    initAgentStatusMirror(file)
    recordAgentEvent(event('claude', 'UserPromptSubmit'))
    vi.setSystemTime(Date.now() + 100)
    recordAgentEvent(event('claude', 'Stop'))
    const completedAt = Date.now()
    recordLifecycleTranscript('n', 'session', '/fixture/session.jsonl')
    recordLifecycleTranscript('n', 'wrong-session', '/wrong.jsonl')
    vi.setSystemTime(Date.now() + 100)
    recordAgentEvent(event('claude', 'PostToolUse'))
    await flush()
    _resetForTest()
    initAgentStatusMirror(file)
    expect(mirrorEntry('n')).toMatchObject({ restored: true, stateVerified: false,
      lastPromptAt: completedAt - 100, lastDoneAt: completedAt, lastDoneClean: true,
      transcriptPath: '/fixture/session.jsonl' })
  })
  it.each([['codex', 'PermissionRequest', {}, 'permission'], ['claude', 'Notification', { notification_type: 'elicitation_dialog' }, 'elicitation']] as const)('inbox classification retains raw %s %s lifecycle kind', (provider, hook, payload, kind) => {
    recordAgentEvent(event(provider, hook, payload))
    expect(mirrorEntry('n')?.blockedKind).toBe(kind)
  })
  it('a repeated AskUserQuestion permission hook preserves the question clock', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1000)
    recordRawToolEvent('n', { hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Choose?', options: [{ label: 'Yes' }, { label: 'No' }] }] } })
    recordAgentEvent(event('claude', 'PermissionRequest'))
    vi.setSystemTime(2000)
    recordAgentEvent(event('claude', 'PermissionRequest'))
    expect(mirrorEntry('n')).toMatchObject({ blockedKind: 'question', blockedSince: 1000, blockedDetail: 'Choose?' })
  })
  it('round trips blocked evidence through the mirror file', () => {
    const entry = reduceEntry(undefined, event('claude', 'Notification', { notification_type: 'elicitation_dialog' }), 123)
    expect(buildFile({ n: entry }, 200).nodes.n).toMatchObject({ blockedKind: 'elicitation', blockedSince: 123 })
  })
})
