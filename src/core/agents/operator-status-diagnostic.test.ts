import { describe, expect, it } from 'vitest'
import { EXPIRE_MS, _resetForTest, mirrorEntry, recordAgentEvent, sweepStaleWorking, type MirrorEntry } from '../agent-status-mirror'
import { decidePreProbe } from './agent-message-decide'
import { MANAGED_SCRIPT_REVISION } from './hooks/managed-script'
import { operatorStatusObservation } from './operator-status-diagnostic'

const now = 10 * EXPIRE_MS
const expected = { sessionId: 'session-1', agentId: 'codex' }
const done: MirrorEntry = { agentId: 'codex', sessionId: 'session-1', state: 'done',
  stateVerified: true, updatedAt: now }

describe('operator status observation', () => {
  it('distinguishes missing, restored, invalid and expired state without granting authority', () => {
    expect(operatorStatusObservation(undefined, expected, now)).toBe('no_status')
    expect(operatorStatusObservation({ ...done, restored: true }, expected, now)).toBe('restored')
    expect(operatorStatusObservation({ ...done, updatedAt: NaN }, expected, now)).toBe('invalid_time')
    expect(operatorStatusObservation({ ...done, updatedAt: now + 1 }, expected, now)).toBe('invalid_time')
    expect(operatorStatusObservation({ ...done, updatedAt: now - EXPIRE_MS - 1 }, expected, now)).toBe('expired')
    expect(operatorStatusObservation({ ...done, updatedAt: now - EXPIRE_MS }, expected, now)).toBe('recorded_done')
  })

  it('reports identity, verification, inferred and busy states separately', () => {
    expect(operatorStatusObservation({ ...done, sessionId: 'another' }, expected, now)).toBe('identity_mismatch')
    expect(operatorStatusObservation({ ...done, agentId: 'claude' }, expected, now)).toBe('identity_mismatch')
    expect(operatorStatusObservation({ ...done, sessionId: undefined }, expected, now)).toBe('identity_mismatch')
    expect(operatorStatusObservation({ ...done, stateVerified: false }, expected, now)).toBe('unverified')
    expect(operatorStatusObservation({ ...done, idleInferred: true }, expected, now)).toBe('inferred_idle')
    expect(operatorStatusObservation({ ...done, state: undefined }, expected, now)).toBe('unknown_state')
    expect(operatorStatusObservation({ ...done, state: 'waiting' }, expected, now)).toBe('busy')
    expect(operatorStatusObservation(done, expected, now)).toBe('recorded_done')
  })

  it.each(['claude', 'codex', 'gemini'] as const)('never treats a real %s timeout sweep as verified completion', agentId => {
    _resetForTest()
    try {
      const at = Date.now()
      recordAgentEvent({ nodeId: 'synthetic', sessionId: 'session-1', agentId, kind: 'state',
        state: 'working', newTurn: true, verified: true, clientRevision: MANAGED_SCRIPT_REVISION })
      const previous = mirrorEntry('synthetic')!.updatedAt
      expect(sweepStaleWorking(at + 21 * 60_000, 20 * 60_000)).toContain('synthetic')
      const entry = mirrorEntry('synthetic')
      expect(entry).toMatchObject({ state: 'done', stateVerified: false, updatedAt: previous })
      expect(operatorStatusObservation(entry, { sessionId: 'session-1', agentId }, at + 21 * 60_000)).toBe('unverified')
      expect(decidePreProbe({ targetNodeId: 'synthetic', targetLive: true, tokenFilePresent: true, target: entry }))
        .toMatchObject({ kind: 'targetStatusStale' })
      recordAgentEvent({ nodeId: 'synthetic', sessionId: 'session-1', agentId, kind: 'state',
        state: 'done', verified: true, clientRevision: MANAGED_SCRIPT_REVISION })
      expect(mirrorEntry('synthetic')).toMatchObject({ state: 'done', stateVerified: true })
      expect(decidePreProbe({ targetNodeId: 'synthetic', targetLive: true, tokenFilePresent: true, target: mirrorEntry('synthetic') })).toBeNull()
    } finally { _resetForTest() }
  })

  it.each(['waiting', 'blocked'] as const)('does not sweep a verified %s state', state => {
    _resetForTest()
    try {
      const at = Date.now()
      recordAgentEvent({ nodeId: 'synthetic', sessionId: 'session-1', agentId: 'claude', kind: 'state',
        state, verified: true, clientRevision: MANAGED_SCRIPT_REVISION })
      expect(sweepStaleWorking(at + 21 * 60_000, 20 * 60_000)).not.toContain('synthetic')
      expect(mirrorEntry('synthetic')).toMatchObject({ state, stateVerified: true })
    } finally { _resetForTest() }
  })
})
