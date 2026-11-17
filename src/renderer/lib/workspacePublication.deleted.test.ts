import { expect, it } from 'vitest'
import type { CanvasNodeState, Project } from '@shared/types'
import { mergeWorkspacePublication, mergeWorkspaceSnapshot } from './workspacePublication'
const before = 'a'.repeat(64), after = 'b'.repeat(64)
const node = (id: string): CanvasNodeState => ({ id, kind: 'terminal', title: id, color: '#888', group: null,
  position: { x: 0, y: 0 }, size: { width: 640, height: 440 } })
const project = (ids: string[]): Project => ({ id: 'p', name: 'P', color: '#888', viewport: { x: 0, y: 0, zoom: 1 }, nodes: ids.map(node) })
const closed = (ids: string[], deleted: string[]): Project =>
  ({ ...project(ids), deletedEntities: { nodes: deleted, bridges: [], ropes: [] } })

// Field 2026-11-17: the server closed a card the tab had just retitled. Edit-vs-delete raised the
// conflict bar, autosave stayed suspended for 64 minutes and a card opened meanwhile was lost.
it('lets a recorded server close win over a local edit of that card (publication)', () => {
  const local = project(['A', 'B']); local.nodes[0].title = 'retitled locally'
  const result = mergeWorkspacePublication(before, [local], { before, after, changes: [{ before: project(['A', 'B']), after: closed(['B'], ['A']) }] })
  expect(result.kind).toBe('adopt'); if (result.kind !== 'adopt') throw new Error('fixture')
  expect(result.projects[0].nodes.map(n => n.id)).toEqual(['B'])
})
it('lets a recorded server close win over a local edit of that card (snapshot resync)', () => {
  const local = project(['A', 'B', 'L']); local.nodes[0].position = { x: 50, y: 50 }
  const result = mergeWorkspaceSnapshot([project(['A', 'B'])], [local], [closed(['B'], ['A'])], after)
  expect(result.kind).toBe('adopt'); if (result.kind !== 'adopt') throw new Error('fixture')
  expect(result.projects[0].nodes.map(n => n.id)).toEqual(['B', 'L'])
  expect(result.localEditsRemain).toBe(true)
})
it('still asks when a card is missing from the incoming file without a recorded deletion', () => {
  const local = project(['A']); local.nodes[0].title = 'retitled locally'
  expect(mergeWorkspaceSnapshot([project(['A'])], [local], [project([])], after)).toEqual({ kind: 'conflict', reason: 'overlapping-content' })
})
