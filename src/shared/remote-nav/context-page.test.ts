import { describe, expect, it } from 'vitest'
import { adaptContextPage, validateOpenTarget } from './context-page'
import type { ContextRequest, RemoteOpenTarget } from './context-page'

// Declared context API v1 fixture. Compact records omit free text; detail queries may
// carry fields/deferred_fields. This is not represented as an observed node registry.
const request: ContextRequest = { operation: 'overview', scope: { project_id: 'project-a' }, nowMs: 1000000 }
function page() {
  return { schema: 1, ok: true, code: 'ok', operation: 'overview', scope: { project_id: 'project-a' },
    queried_at: 1000, sources: [{ file: '/fixture/ledger.json', generation: 42, published_at: 999 }],
    records: [{ task_id: 'task-a', project_id: 'project-a', node: 'term-a', observed_at: 980,
      assignment_epoch: 2, supervisor_task_id: 'task-supervisor', observation_class: 'BUSY',
      freshness: { observed_at: 980, queried_at: 1000, may_be_stale: false, reasons: [] as string[] } }],
    uncertainty: ['view_filter_is_not_authentication; control_not_granted'],
    truncated: false, continuation: null as Record<string, unknown> | null }
}

describe('bounded context page consumer', () => {
  it('preserves provenance, assignment and absolute clocks with no control grant', () => {
    const p = page()
    const result = adaptContextPage(p, request)
    expect(result).toMatchObject({ ok: true, sources: p.sources, queriedAt: 1000, controlGranted: false,
      records: [{ assignment_epoch: 2, supervisor_task_id: 'task-supervisor', observation: { ageS: 20, stale: false } }] })
    expect(adaptContextPage(p, { ...request, nowMs: 1400000 })).toMatchObject({ records: [{ observation: { ageS: 420, stale: true } }] })
    expect(p.records[0].freshness.reasons).toEqual([])
  })

  it('keeps empty filtered pages with continuations distinct from end of inventory', () => {
    const p = page()
    p.records = []
    p.truncated = true
    p.continuation = { operation: 'overview', scope: p.scope, generation: 42, offset: 900 }
    expect(adaptContextPage(p, request)).toMatchObject({ ok: true, records: [], truncated: true, continuation: p.continuation })
    const previousSources = p.sources
    p.sources = [{ ...p.sources[0], generation: 43 }]
    expect(adaptContextPage(p, { ...request, previousSources })).toMatchObject({ ok: false, code: 'reset_required' })
  })

  it.each(['missing', 'corrupt', 'stale_publication', 'read_limit', 'reset_required'])('preserves explicit %s failures', (code) => {
    expect(adaptContextPage({ schema: 1, ok: false, code }, request)).toEqual({ ok: false, code, controlGranted: false })
  })

  it('rejects wrong scope, corrupt rows, dropped continuations and oversized multibyte output', () => {
    expect(adaptContextPage(page(), { ...request, scope: { project_id: 'project-b' } })).toMatchObject({ ok: false })
    expect(adaptContextPage({ ...page(), records: [null] }, request)).toMatchObject({ code: 'corrupt' })
    expect(adaptContextPage({ ...page(), truncated: true }, request)).toMatchObject({ code: 'corrupt' })
    expect(adaptContextPage({ ...page(), extra: '界'.repeat(1000) }, { ...request, maxBytes: 2048 })).toMatchObject({ code: 'output_limit' })
    expect(adaptContextPage({ ...page(), records: [...page().records, ...page().records] }, { ...request, limit: 1 })).toMatchObject({ ok: false })
  })
})

const target: RemoteOpenTarget = { taskId: 'task-a', nodeId: 'term-a', sessionId: 'session-a',
  provider: 'codex', account: 'account-2', projectId: 'project-a', hostId: 'host-a', hostBootId: 'boot-a',
  sourceGeneration: 42, assignmentEpoch: 2 }
const current = { ...target, observedAt: 980, observationClass: 'BUSY', assignmentState: 'active',
  observationState: 'observed', conflicts: [], stale: false }
describe('focus target revalidation', () => {
  it('permits exact fresh focus without granting control', () => {
    expect(validateOpenTarget(target, current, 1000000)).toEqual({ ok: true, code: 'focus_only', controlGranted: false })
  })
  it.each(['hostId', 'hostBootId', 'projectId', 'account', 'sessionId', 'nodeId', 'provider'] as const)('refuses changed %s', (key) => {
    expect(validateOpenTarget(target, { ...current, [key]: 'another' }, 1000000).ok).toBe(false)
  })
  it('refuses unknown hosts, changed assignments, stale observations and unknown presence', () => {
    expect(validateOpenTarget({ ...target, hostId: '' }, current, 1000000).ok).toBe(false)
    expect(validateOpenTarget(target, { ...current, assignmentEpoch: 3 }, 1000000).ok).toBe(false)
    expect(validateOpenTarget(target, { ...current, assignmentState: 'suspended' }, 1000000).ok).toBe(false)
    expect(validateOpenTarget(target, current, 1400000).ok).toBe(false)
    expect(validateOpenTarget(target, { ...current, observationClass: '?' }, 1000000).ok).toBe(false)
    expect(validateOpenTarget(target, { ...current, stale: true }, 1000000).ok).toBe(false)
    expect(validateOpenTarget(target, { ...current, conflicts: ['multiple claims'] }, 1000000).ok).toBe(false)
    expect(validateOpenTarget(target, { ...current, observationState: 'unavailable' }, 1000000).ok).toBe(false)
  })
})
