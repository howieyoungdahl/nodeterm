import { EXPIRE_MS, type MirrorEntry } from '../agent-status-mirror'

/** Observations only. None is a delivery authorization or a substitute for a pane/identity check. */
export type OperatorStatusObservation =
  | 'no_status' | 'restored' | 'invalid_time' | 'expired' | 'identity_mismatch'
  | 'unverified' | 'inferred_idle' | 'unknown_state' | 'busy' | 'recorded_done'

export function operatorStatusObservation(
  entry: MirrorEntry | undefined, expected: { sessionId: string; agentId: string }, now = Date.now()
): OperatorStatusObservation {
  if (!entry) return 'no_status'
  if (entry.restored) return 'restored'
  if (!Number.isFinite(entry.updatedAt) || !Number.isFinite(now) || entry.updatedAt > now) return 'invalid_time'
  if (now - entry.updatedAt > EXPIRE_MS) return 'expired'
  if (entry.sessionId !== expected.sessionId || entry.agentId !== expected.agentId) return 'identity_mismatch'
  if (entry.stateVerified !== true) return 'unverified'
  if (entry.idleInferred) return 'inferred_idle'
  if (!entry.state) return 'unknown_state'
  if (entry.state !== 'done') return 'busy'
  return 'recorded_done'
}
