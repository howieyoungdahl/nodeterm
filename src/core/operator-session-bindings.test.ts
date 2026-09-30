import { describe, expect, it } from 'vitest'
import { OperatorSessionBindings, OperatorTargetError } from './operator-session-bindings'

const event = (overrides = {}) => ({ nodeId: 'node1', agentId: 'claude' as const, kind: 'session' as const,
  sessionId: 'session1', sessionPhase: 'start' as const, verified: true, ...overrides })
const projects = [{ id: 'p1', nodes: [{ id: 'node1', kind: 'terminal' }] }]

describe('OperatorSessionBindings', () => {
  it('only publishes a unique terminal backed by a current verified session', () => {
    const b = new OperatorSessionBindings()
    b.observe(event({ verified: false }))
    expect(b.targets(projects)).toEqual([])
    b.observe(event())
    const target = b.targets(projects)[0]
    expect(target).toMatchObject({ projectId: 'p1', nodeId: 'node1', sessionId: 'session1' })
    expect(b.resolve(projects, target).agentId).toBe('claude')
    expect(b.targets([...projects, { id: 'p2', nodes: [{ id: 'node1', kind: 'terminal' }] }])).toEqual([])
    expect(() => b.resolve([...projects, { id: 'p2', nodes: [{ id: 'node1', kind: 'terminal' }] }], target))
      .toThrowError(expect.objectContaining({ code: 'ambiguous_target' }))
  })

  it('invalidates on end, replacement, same-session resume, and a new process instance', () => {
    const b = new OperatorSessionBindings()
    b.observe(event())
    const first = b.targets(projects)[0]
    b.observe(event({ sessionPhase: 'end' }))
    expect(() => b.resolve(projects, first)).toThrow(OperatorTargetError)
    b.observe(event())
    const resumed = b.targets(projects)[0]
    expect(resumed.generation).not.toBe(first.generation)
    b.observe(event({ sessionId: 'session2' }))
    expect(() => b.resolve(projects, resumed)).toThrowError(expect.objectContaining({ code: 'stale_target' }))
    const restarted = new OperatorSessionBindings()
    restarted.observe(event({ sessionId: 'session2' }))
    expect(() => restarted.resolve(projects, b.targets(projects)[0])).toThrowError(expect.objectContaining({ code: 'stale_target' }))
  })

  it('invalidates authority on unverified lifecycle signals, then rotates verified restart and agent changes', () => {
    const b = new OperatorSessionBindings()
    b.observe(event())
    const original = b.targets(projects)[0]
    b.observe(event({ verified: false, sessionId: 'spoofed-session', sessionPhase: 'end' }))
    expect(() => b.resolve(projects, original)).toThrowError(expect.objectContaining({ code: 'stale_target' }))
    b.observe(event())
    const rebound = b.targets(projects)[0]
    b.observe(event({ verified: false, sessionId: 'spoofed-session' }))
    expect(() => b.resolve(projects, rebound)).toThrowError(expect.objectContaining({ code: 'stale_target' }))

    b.observe(event({ sessionPhase: 'start' }))
    const restarted = b.targets(projects)[0]
    expect(restarted.generation).not.toBe(rebound.generation)
    expect(() => b.resolve(projects, rebound)).toThrowError(expect.objectContaining({ code: 'stale_target' }))
    b.observe(event({ agentId: 'codex', sessionPhase: 'state' as never }))
    expect(() => b.resolve(projects, restarted)).toThrowError(expect.objectContaining({ code: 'stale_target' }))
  })

  it('does not let transcript metadata establish or cross-bind a session', () => {
    const b = new OperatorSessionBindings()
    b.transcript('node1', 'session1', 'claude', '/synthetic/private.jsonl')
    expect(b.targets(projects)).toEqual([])
    b.observe(event())
    const target = b.targets(projects)[0]
    b.transcript('node1', 'other', 'claude', '/synthetic/wrong.jsonl')
    expect(b.resolve(projects, target)).not.toHaveProperty('transcriptPath')
    b.transcript('node1', 'session1', 'claude', '/synthetic/private.jsonl')
    expect(b.resolve(projects, target).transcriptPath).toBe('/synthetic/private.jsonl')
  })

  it('discovers Claude identity from an authenticated native hook without a UI transition', () => {
    const b = new OperatorSessionBindings()
    const payload = { hook_event_name: 'Notification', notification_type: 'auth_success', session_id: 'session1' }
    b.observeHook('claude', 'node1', payload, false, '/synthetic/private.jsonl')
    expect(b.targets(projects)).toEqual([])
    b.observeHook('claude', 'node1', payload, true, '/synthetic/private.jsonl')
    const target = b.targets(projects)[0]
    expect(b.resolve(projects, target).transcriptPath).toBe('/synthetic/private.jsonl')
    b.observeHook('claude', 'node1', { hook_event_name: 'SessionStart', session_id: 'session1' }, true)
    const resumed = b.targets(projects)[0]
    expect(resumed.generation).not.toBe(target.generation)
    expect(b.resolve(projects, resumed).transcriptPath).toBeUndefined()
    expect(() => b.resolve(projects, target)).toThrowError(expect.objectContaining({ code: 'stale_target' }))
  })

  it('ignores unknown hooks and malformed child markers, and revokes on authenticated native end', () => {
    const b = new OperatorSessionBindings()
    b.observeHook('codex', 'node1', { hook_event_name: 'unknown', session_id: 'session1' }, true)
    b.observeHook('codex', 'node1', { hook_event_name: 'Stop', session_id: 'session1', agent_id: null }, true)
    expect(b.targets(projects)).toEqual([])
    b.observeHook('codex', 'node1', { hookEventName: 'SessionStart', session_id: 'session1' }, true, '/synthetic/public.jsonl')
    const target = b.targets(projects)[0]
    expect(b.resolve(projects, target).transcriptPath).toBe('/synthetic/public.jsonl')
    b.observeHook('codex', 'node1', { hook_event_name: 'SessionEnd', session_id: 'session1' }, true, '/synthetic/public.jsonl')
    expect(b.targets(projects)).toEqual([])
    expect(() => b.resolve(projects, target)).toThrowError(expect.objectContaining({ code: 'stale_target' }))
  })
})
