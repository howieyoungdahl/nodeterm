/** A context page is a bounded snapshot, not a complete registry or a control grant.
 * The transport authenticates the caller and chooses the source before calling this adapter.
 * Continuations remain opaque and are checked by the producer on the next explicit request.
 */
export type ContextOperation = 'overview' | 'task' | 'owner' | 'attention' | 'handoff' | 'changes' | 'summary' | 'observation' | 'policy'
export type ContextScope = Partial<Record<'task_id' | 'project_id' | 'node', string>>
type RecordValue = Record<string, unknown>
export interface ContextSource extends RecordValue {
  file: string
  generation: number
  published_at: number
}
export interface ContextRequest {
  operation: ContextOperation
  scope: ContextScope
  nowMs: number
  limit?: number
  maxBytes?: number
  previousSources?: ContextSource[]
}
export interface ContextRow extends RecordValue {
  task_id: string
  observation: { observedAt: number | null; ageS: number | null; stale: boolean; reasons: string[] }
}
export type ContextPage =
  | { ok: false; code: string; controlGranted: false }
  | { ok: true; code: 'ok' | 'continue' | 'read_limit'; operation: ContextOperation; scope: ContextScope;
      queriedAt: number; sources: ContextSource[]; records: ContextRow[];
      uncertainty: string[]; truncated: boolean; continuation: RecordValue | null;
      controlGranted: false }

const record = (v: unknown): v is RecordValue => !!v && typeof v === 'object' && !Array.isArray(v)
const nonempty = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const refusal = (code: string): ContextPage => ({ ok: false, code, controlGranted: false })
const sameScope = (a: RecordValue, b: RecordValue): boolean =>
  Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((k) => a[k] === b[k])

export function adaptContextPage(payload: unknown, request: ContextRequest): ContextPage {
  const limit = request.limit ?? 25
  const ceiling = request.maxBytes ?? 12288
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(ceiling) ||
      ceiling < 2048 || ceiling > 65536 || !Number.isFinite(request.nowMs) || !record(request.scope) ||
      !['overview', 'task', 'owner', 'attention', 'handoff', 'changes', 'summary', 'observation', 'policy'].includes(request.operation) ||
      Object.entries(request.scope).some(([k, v]) => !['task_id', 'project_id', 'node'].includes(k) || !nonempty(v))) {
    return refusal('invalid_query')
  }
  if ((['task', 'handoff'].includes(request.operation) && !request.scope.task_id) ||
      (request.operation === 'owner' && !request.scope.node && !request.scope.task_id)) return refusal('scope_required')
  try {
    if (new TextEncoder().encode(JSON.stringify(payload)).length > ceiling) return refusal('output_limit')
  } catch { return refusal('corrupt') }
  if (record(payload) && payload.schema !== 1) return refusal('unsupported')
  if (!record(payload) || typeof payload.ok !== 'boolean' || !nonempty(payload.code)) {
    return refusal('corrupt')
  }
  // A failed publication must never become an empty successful page.
  if (!payload.ok) return refusal(payload.code)
  if (!['ok', 'continue', 'read_limit'].includes(payload.code) || payload.operation !== request.operation || !record(payload.scope) ||
      !sameScope(payload.scope, request.scope)) return refusal('scope_mismatch')
  if (!finite(payload.queried_at) || !Array.isArray(payload.sources) || payload.sources.length !== 1 ||
      !Array.isArray(payload.records) || payload.records.length > limit ||
      !Array.isArray(payload.uncertainty) || payload.uncertainty.some((v) => typeof v !== 'string') ||
      typeof payload.truncated !== 'boolean' ||
      (payload.truncated ? !record(payload.continuation) : payload.continuation !== null)) return refusal('corrupt')
  if (payload.code !== 'ok' && !payload.truncated) return refusal('corrupt')
  const source = payload.sources[0]
  if (!record(source) || !nonempty(source.file) || !Number.isSafeInteger(source.generation) ||
      (source.generation as number) < 0 || !finite(source.published_at)) return refusal('corrupt')
  if (request.previousSources && (request.previousSources.length !== 1 ||
      ['file', 'generation', 'published_at'].some((k) => request.previousSources![0][k] !== source[k]))) {
    return refusal('reset_required')
  }
  const rows: ContextRow[] = []
  const ids = new Set<string>()
  for (const row of payload.records) {
    if (!record(row) || !nonempty(row.task_id) ||
        Object.entries(request.scope).some(([k, v]) => row[k] !== v)) return refusal('corrupt')
    const key = JSON.stringify([row.task_id, row.node, row.role, row.relationship])
    if (ids.has(key)) return refusal('corrupt')
    ids.add(key)
    const observed = finite(row.observed_at) && row.observed_at > 0 ? row.observed_at : null
    const age = observed === null ? null : request.nowMs / 1000 - observed
    const freshness = record(row.freshness) ? row.freshness : {}
    const reasons = Array.isArray(freshness.reasons) ? freshness.reasons.filter((v): v is string => typeof v === 'string') : []
    if (age === null) reasons.push('observation_unavailable')
    else if (age < 0) reasons.push('observation_in_future')
    else if (age > 300) reasons.push('observation_expired')
    if (row.may_be_stale || freshness.may_be_stale) reasons.push('source_marked_stale')
    rows.push({ ...row, task_id: row.task_id,
      observation: { observedAt: observed, ageS: age === null ? null : Math.max(0, age), stale: reasons.length > 0, reasons: [...new Set(reasons)] } })
  }
  const result: ContextPage = { ok: true, code: payload.code as 'ok' | 'continue' | 'read_limit', operation: request.operation, scope: { ...request.scope },
    queriedAt: payload.queried_at, sources: payload.sources as ContextSource[], records: rows,
    uncertainty: payload.uncertainty as string[], truncated: payload.truncated,
    continuation: payload.continuation as RecordValue | null, controlGranted: false }
  return new TextEncoder().encode(JSON.stringify(result)).length > ceiling ? refusal('output_limit') : result
}

export interface RemoteOpenTarget {
  taskId: string
  nodeId: string
  sessionId: string
  provider: string
  account: string
  projectId: string
  hostId: string
  hostBootId: string
  sourceGeneration: number
  assignmentEpoch: number | null
}

/** Compare a clicked row with newly read, authenticated target metadata. Success permits the
 * integrator to request focus only. Its existing authorization and attach-only gates still run.
 */
export function validateOpenTarget(
  target: RemoteOpenTarget,
  current: RemoteOpenTarget & { observedAt: number; observationClass: string; assignmentState: string;
    observationState: string; conflicts: unknown[]; stale: boolean },
  nowMs: number
): { ok: boolean; code: string; controlGranted: false } {
  const deny = (code: string) => ({ ok: false, code, controlGranted: false as const })
  const keys = ['taskId', 'nodeId', 'sessionId', 'provider', 'account', 'projectId', 'hostId', 'hostBootId'] as const
  if (current.observationState !== 'observed' || current.stale !== false ||
      !Array.isArray(current.conflicts) || current.conflicts.length) return deny('observation_unavailable')
  if (keys.some((k) => !nonempty(target[k]) || !nonempty(current[k]))) return deny('target_unknown')
  if (keys.some((k) => target[k] !== current[k])) return deny('target_mismatch')
  if (!Number.isSafeInteger(target.sourceGeneration) || target.sourceGeneration < 0 ||
      target.sourceGeneration !== current.sourceGeneration || target.assignmentEpoch !== current.assignmentEpoch) return deny('reset_required')
  if (current.assignmentState !== 'active' && current.assignmentState !== 'unregistered') return deny('assignment_unavailable')
  if (current.assignmentState === 'active'
    ? !Number.isSafeInteger(current.assignmentEpoch) || (current.assignmentEpoch as number) < 1
    : current.assignmentEpoch !== null) return deny('assignment_unavailable')
  if (!['BUSY', 'IDLE', 'DONE', 'LIMIT', 'PERMISSION', 'QUESTION', 'NEEDS-OPERATOR', 'STALLED'].includes(current.observationClass) ||
      !finite(current.observedAt) || !finite(nowMs) || current.observedAt <= 0 ||
      nowMs / 1000 - current.observedAt > 300 || current.observedAt > nowMs / 1000) return deny('observation_unavailable')
  return { ok: true, code: 'focus_only', controlGranted: false }
}
