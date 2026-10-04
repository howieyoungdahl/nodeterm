import { expect, it } from 'vitest'
import type { CanvasNodeState, Project } from '@shared/types'
import { mergeWorkspacePublication } from './workspacePublication'
const before = 'a'.repeat(64), after = 'b'.repeat(64)
const node = (id: string): CanvasNodeState => ({ id, kind: 'terminal', title: id, color: '#888', group: null,
  position: { x: 0, y: 0 }, size: { width: 640, height: 440 } })
const project = (ids: string[]): Project => ({ id: 'p', name: 'P', color: '#888', viewport: { x: 0, y: 0, zoom: 1 }, nodes: ids.map(node) })
const merge = (base: Project, local: Project, incoming: Project) => mergeWorkspacePublication(before, [local],
  { before, after, changes: [{ before: base, after: incoming }] })

it('preserves disjoint local-before-A and incoming-between-A/B insertions before acknowledging content', () => {
  const result = merge(project(['A', 'B']), project(['L', 'A', 'B']), project(['A', 'R', 'B']))
  expect(result.kind).toBe('adopt'); if (result.kind !== 'adopt') throw new Error('fixture')
  expect(result.projects[0].nodes.map(n => n.id)).toEqual(['L', 'A', 'R', 'B'])
  expect(result.revision).toBe(after)
})
it('preserves independent manual assignment and column insertion relations', () => {
  const base = project(['A', 'B']), local = project(['L', 'A', 'B']), incoming = project(['A', 'R', 'B'])
  for (const p of [base, local, incoming]) p.kanban = { columns: p.nodes.map(n => ({ id: n.id, title: n.id, color: '#888' })),
    assignments: p.nodes.map(n => ({ nodeId: n.id, columnId: n.id })) }
  const result = merge(base, local, incoming)
  expect(result.kind).toBe('adopt'); if (result.kind !== 'adopt') throw new Error('fixture')
  expect(result.projects[0].kanban!.columns.map(c => c.id)).toEqual(['L', 'A', 'R', 'B'])
  expect(result.projects[0].kanban!.assignments.map(a => a.nodeId)).toEqual(['L', 'A', 'R', 'B'])
})
it('refuses a cycle between manual reordering and incoming insertion instead of silently acknowledging either lost relation', () => {
  expect(merge(project(['A', 'B']), project(['B', 'A']), project(['A', 'R', 'B']))).toEqual({ kind: 'conflict', reason: 'overlapping-order' })
})
it('merges insertion anchors around a removed unchanged entity without resurrecting it', () => {
  const result = merge(project(['A', 'B', 'C']), project(['L', 'A', 'B', 'C']), project(['A', 'R', 'C']))
  expect(result.kind).toBe('adopt'); if (result.kind !== 'adopt') throw new Error('fixture')
  expect(result.projects[0].nodes.map(n => n.id)).toEqual(['L', 'A', 'R', 'C'])
})
