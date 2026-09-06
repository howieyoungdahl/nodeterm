import { describe, expect, it } from 'vitest'
import captured from './producer-eight.json'
import { buildNavigator, classifyRegistryPayload, registryStaleness } from './model'
import type { TaskRegistry } from './fixture'

const nowMs = captured.generated_at_epoch * 1000
function fixture(): TaskRegistry { return structuredClone(captured) as unknown as TaskRegistry }
const nav = (registry = fixture(), clock = nowMs) => buildNavigator({ registry, nowMs: clock })

describe('actual schema-2 producer compatibility', () => {
  it('retains all eight mechanical owners, session IDs, seven next actions and read-only hints', () => {
    const result = nav()
    expect(result.tasks).toHaveLength(8)
    expect(result.tasks.filter((t) => t.owner.present)).toHaveLength(8)
    expect(result.tasks.filter((t) => t.open.command?.includes('attach -r -t =nt-term-owner-'))).toHaveLength(8)
    expect(result.tasks.filter((t) => t.nextAction.text)).toHaveLength(7)
    result.tasks.forEach((t, i) => {
      expect(t.owner.session).toBe(`session-${i}`)
      expect(t.open.typingAllowed).toBe(false)
      expect(t.binding.controlGranted).toBe(false)
      expect(t.owner.freshness.lastObserved).toBe(captured.nodes['term-owner-0'].last_observed)
    })
    expect(result.sourceGeneration).toBe(433)
  })

  it('ages absolute observations across rereads without renewing the recorded clock', () => {
    const r = fixture()
    const before = JSON.stringify(r)
    expect(nav(r).tasks[0].owner.freshness.observationAgeS).toBe(12)
    const old = nav(r, nowMs + 600000).tasks[0]
    expect(old.owner.freshness.observationAgeS).toBe(612)
    expect(old.owner.freshness.reportedObservationAgeS).toBe(12)
    expect(old.open.command).toBeNull()
    expect(JSON.stringify(r)).toBe(before)
    r.generated_at_epoch += 600
    expect(nav(r, nowMs + 600000).tasks[0].owner.freshness.observationAgeS).toBe(612)
  })

  it.each(['GONE', 'DEAD', 'UNKNOWN', '?', 'future-class'])('does not infer presence or completion from %s', (state) => {
    const r = fixture()
    r.nodes['term-owner-0'].class = state as never
    const task = nav(r).tasks[0]
    expect(task.owner.live).toBe(false)
    expect(task.open.command).toBeNull()
    expect(task.closed).toBe(false)
    expect(task.stage).toBe('building')
  })

  it('keeps assignment actor and supervisor distinct from creator and conflicting mechanical binding', () => {
    const r = fixture()
    r.tasks[0].assignment = { actor: { node: 'term-owner-1', session_id: 'session-1', provider: 'codex' },
      assignment_epoch: 2, supervisor_task_id: 'task-supervisor', state: 'active', role: 'director' }
    r.nodes['term-owner-1'].owner_node = 'term-creator'
    const t = nav(r).tasks[0]
    expect(t.owner.node).toBe('term-owner-1')
    expect(t.binding.supervisorTaskId).toBe('task-supervisor')
    expect(t.binding.creatorNode).toBe('term-creator')
    expect(t.binding.assignment?.assignment_epoch).toBe(2)
    expect(t.binding.conflicts).toContain('owner binding disagreement')
    expect(t.open.command).toBeNull()
  })

  it('uses boot identity over display epoch and suppresses a prior-boot hint', () => {
    const r = fixture()
    r.host_boot_epoch = r.generated_at_epoch + 999
    expect(registryStaleness(r, nowMs, 'boot-fixture').generatedBeforeHostBoot).toBe(false)
    expect(registryStaleness(r, nowMs).bootIdentityState).toBe('unknown')
    const result = buildNavigator({ registry: r, nowMs, currentHostBootId: 'new-boot' })
    expect(result.staleness.bootIdentityState).toBe('mismatch')
    expect(result.tasks.every((t) => t.open.command === null)).toBe(true)
  })

  it.each(['sid', 'account', 'provider', 'project_id'])('refuses a changed observed %s binding', (field) => {
    const r = fixture()
    if (field === 'project_id') r.nodes['term-owner-0'].project_id = 'project-original'
    r.tasks[0][field] = 'another'
    expect(nav(r).tasks[0].open.command).toBeNull()
  })

  it('does not treat inherited dictionary keys as nodes or worker rosters', () => {
    const r = fixture()
    r.tasks[0].task_id = 'constructor'
    r.tasks[0].node = 'constructor'
    expect(nav(r).tasks[0].owner.present).toBe(false)
  })

  it.each([null, { task_id: 'bad', blockers: [null] }, { task_id: 'bad', workers: 'oops' }])('rejects corrupt task rows', (row) => {
    const r = { ...fixture(), tasks: [row] }
    expect(classifyRegistryPayload({ kind: 'text', path: '/fixture/registry.json', text: JSON.stringify(r) }, nowMs).ok).toBe(false)
  })
})
