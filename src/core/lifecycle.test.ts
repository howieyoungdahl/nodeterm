import { describe, expect, it } from 'vitest'
import { deriveLifecycle, DEFAULT_LIFECYCLE_CONFIG, lifecycleConfigFromEnv, type LifecycleInput } from './lifecycle'
const now = 10_000_000
const base: LifecycleInput = { paneState: 'alive', isAgent: true, provider: 'codex', sessionId: 's', createdAt: now - 1000 }
const done = { ...base, state: 'done' as const, lastDoneAt: now - 1000, lastDoneClean: true }

describe('deriveLifecycle', () => {
  it.each([
    ['starting', {}, now],
    ['unknown', {}, now + DEFAULT_LIFECYCLE_CONFIG.startingGraceMs - 1000],
    ['working', { state: 'working', updatedAt: now - 60_000 }, now],
    ['unknown', { state: 'working', updatedAt: now - 20 * 60_000 - 1 }, now],
    ['unknown', { state: undefined, sessionStartedAt: now - 1000 }, now],
    ['idle-warm', { ...done }, now],
    ['idle-warm', { ...done, lastDoneAt: now - 300_000 + 1 }, now],
    ['idle-cold', { ...done, lastDoneAt: now - 300_000 }, now],
    ['idle-cold', { ...done, lastDoneAt: now - 300_001 }, now],
    ['idle-warm', { ...done, provider: 'claude', lastDoneAt: now - 45 * 60_000 + 1 }, now],
    ['idle-cold', { ...done, provider: 'claude', lastDoneAt: now - 45 * 60_000 }, now],
    ['idle-cold', { ...done, provider: 'other', lastDoneAt: now - 300_000 }, now],
    ['exited', { ...done, shell: true }, now],
    ['exited', { sessionEndedAt: now - 100 }, now],
    ['dead', { ...done, paneState: 'dead' }, now],
    ['dead', { paneState: 'none' }, now],
    ['unknown', { ...done, paneState: 'unknown' }, now],
    ['unknown', { isAgent: false }, now],
    ['unknown', { ...done, lastDoneClean: false }, now],
    ['unknown', { state: 'done' }, now],
    ['idle-warm', { ...done, restored: true }, now],
    ['idle-warm', { ...done, restored: true, transcriptDone: { at: now - 100, clean: false } }, now],
    ['idle-warm', { ...done, restored: true, transcriptDone: { at: now - 300_000, clean: true } }, now],
  ] as const)('%s from %j', (expected, overrides, clock) => {
    expect(deriveLifecycle({ ...base, ...overrides }, clock).state).toBe(expected)
  })
  it.each(['permission', 'question', 'elicitation', 'input'] as const)('keeps raw blocked kind %s', kind => {
    const result = deriveLifecycle({ ...base, state: 'waiting', blockedKind: kind, blockedSince: now - 123 }, now)
    expect(result).toMatchObject({ state: 'blocked', since: now - 123, blockedOn: { kind, since: now - 123 } })
  })
  it('detected prompts override stale working and retain their own clock', () => {
    expect(deriveLifecycle({ ...base, state: 'working', updatedAt: now, detectedPrompt: {
      kind: 'codex-hooks-review', since: now - 50, detail: 'Hooks need review'
    } }, now)).toMatchObject({ state: 'blocked', blockedOn: { kind: 'codex-hooks-review' }, since: now - 50 })
  })
  it('uses the clean completion clock for coldAt and the transition time for since', () => {
    expect(deriveLifecycle({ ...done, lastDoneAt: now - 400_000, updatedAt: now }, now))
      .toMatchObject({ state: 'idle-cold', lastDoneAt: now - 400_000, coldAt: now - 100_000, since: now - 100_000 })
  })
  it('uses the newer clean persisted end or transcript end after restore', () => {
    expect(deriveLifecycle({ ...done, restored: true, transcriptDone: { at: now - 400_000, clean: false } }, now))
      .toMatchObject({ state: 'idle-warm', lastDoneAt: done.lastDoneAt, lastDoneClean: true })
    expect(deriveLifecycle({ ...done, restored: true, lastDoneAt: now - 400_000, transcriptDone: { at: now - 100, clean: false } }, now))
      .toMatchObject({ state: 'idle-warm', lastDoneAt: now - 100, lastDoneClean: false })
    expect(deriveLifecycle({ ...done, restored: true, lastDoneClean: false }, now).state).toBe('unknown')
  })
  it('validates optional env overrides and accepts explicit config', () => {
    const config = lifecycleConfigFromEnv({ NODETERM_LIFECYCLE_CODEX_TTL_MS: '1234', NODETERM_LIFECYCLE_CLAUDE_TTL_MS: '-1', NODETERM_LIFECYCLE_DEFAULT_TTL_MS: 'NaN' })
    expect(config.ttlMs).toEqual({ claude: 2_700_000, codex: 1234, default: 300_000 })
    expect(deriveLifecycle({ ...done, lastDoneAt: now - 1234 }, now, config).state).toBe('idle-cold')
  })
})
