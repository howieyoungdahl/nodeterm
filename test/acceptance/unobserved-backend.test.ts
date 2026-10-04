import { describe, expect, it, vi } from 'vitest'
import { probePaneEvidence } from '../../src/core/node-status-service'
import { probeUnobservedBackends, unobservedBackendPresentation } from '../../src/renderer/lib/unobservedBackend'
import { buildSessionList, buildStatusList } from '../../src/renderer/lib/sessionList'
import type { AgentNodeStatus } from '../../src/renderer/state/agentStatus'
import type { PaneEvidence } from '../../src/shared/node-status'

describe('backend facts do not become task state', () => {
  it.each([
    ['dead', 'dead', 'backend stopped'],
    ['dead', 'alive', 'backend present'],
    ['dead', 'unknown', 'backend unverified'],
    ['unknown', 'dead', 'backend unverified']
  ] as const)('core answers %s/%s display %s without changing the hook buckets', async (first, second, word) => {
    const statuses: Record<string, AgentNodeStatus> = {
      working: { state: 'working', unread: false }, waiting: { state: 'waiting', unread: false },
      blocked: { state: 'blocked', unread: false }, done: { state: 'done', unread: false }
    }
    const before = structuredClone(statuses)
    const projects = [{ id: 'p', name: 'P', color: '#123', nodes: ['unknown', ...Object.keys(statuses)].map((id) =>
      ({ id, kind: 'terminal' as const, title: id, color: '#123', cwd: 'C:\\Users\\example\\project' })) }]
    const targets = projects[0].nodes.map((node) => ({ id: node.id, projectId: 'p',
      eligible: statuses[node.id]?.state === undefined, statusToken: statuses[node.id] }))
    const answers: PaneEvidence[] = [first, second]
    const presence = vi.fn(async () => answers.shift() ?? 'unknown')
    const observations = await probeUnobservedBackends({ targets: () => targets, observations: {}, now: () => 2,
      probe: (ids) => probePaneEvidence(ids, { panePresence: presence }) })
    expect(unobservedBackendPresentation(targets[0], observations.unknown, 2).word).toBe(word)
    expect(presence).toHaveBeenCalledTimes(first === 'dead' ? 2 : 1)
    expect(statuses).toEqual(before)
    const rows = buildSessionList(projects, null, 'p', statuses, '')[0].ungrouped
    expect(rows.map((row) => [row.id, row.statusKind, row.stateLabel])).toEqual([
      ['unknown', 'unknown', 'Task unobserved'], ['working', 'working', 'Running'],
      ['waiting', 'attention', 'Waiting for your response'], ['blocked', 'attention', 'Waiting for your response'],
      ['done', 'done', 'Done']
    ])
    const sections = buildStatusList(projects, null, 'p', statuses, '')
    expect(sections.find((s) => s.kind === 'unknown')?.rows.map((r) => r.id)).toEqual(['unknown'])
    expect(sections.find((s) => s.kind === 'idle')?.rows.map((r) => r.id)).toEqual(['done'])
  })
})
