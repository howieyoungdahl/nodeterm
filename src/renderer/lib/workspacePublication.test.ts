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

it('keeps null distinct from an omitted field when checking edit-versus-delete overlap', () => {
  const base = project(['A']), local = project(['A'])
  Reflect.deleteProperty(local.nodes[0], 'group')
  expect(merge(base, local, project([]))).toEqual({ kind: 'conflict', reason: 'overlapping-content' })
})

it('refuses incoming layoutRules deletion when a plain JSON own __proto__ field was locally added', () => {
  const base = project(['A']), local = project(['A']), incoming = project(['A'])
  base.layoutRules = JSON.parse('{"unknown":{}}') as Project['layoutRules']
  local.layoutRules = JSON.parse('{"unknown":{"__proto__":{}}}') as Project['layoutRules']
  expect(Object.hasOwn((local.layoutRules as unknown as { unknown: object }).unknown, '__proto__')).toBe(true)
  expect(merge(base, local, incoming)).toEqual({ kind: 'conflict', reason: 'overlapping-content' })
})
it.each(['__proto__', 'toString'])('treats an undefined own %s field like omission during incoming layoutRules deletion', key => {
  const base = project(['A']), local = project(['A']), incoming = project(['A'])
  base.layoutRules = JSON.parse('{"unknown":{}}') as Project['layoutRules']
  local.layoutRules = { unknown: { [key]: undefined } } as unknown as Project['layoutRules']
  const result = merge(base, local, incoming)
  expect(result.kind).toBe('adopt'); if (result.kind !== 'adopt') throw new Error('fixture')
  expect(result.projects[0].layoutRules).toBeUndefined()
})

// Flow materializes these defaults even when a saved card has never been edited.
it('adopts deletion of a sparse unchanged card after renderer defaults materialize', () => {
  const base = project(['A']), local = project(['A'])
  local.nodes[0].collapsed = false
  local.nodes[0].titleAuto = true
  expect(merge(base, local, project([])).kind).toBe('adopt')
})
it.each([{ collapsed: true }, { titleAuto: false }, { text: 'unsent draft' }, { manualPlacement: true }])(
  'retains meaningful local edit versus deletion: %j', edit => {
    const base = project(['A']), local = project(['A'])
    Object.assign(local.nodes[0], { collapsed: false, titleAuto: true }, edit)
    expect(merge(base, local, project([]))).toEqual({ kind: 'conflict', reason: 'overlapping-content' })
  })

it('does not normalize defaults on opaque nested metadata', () => {
  const base = project(['A']), local = project(['A']), incoming = project(['A'])
  base.layoutRules = { unknown: {} } as unknown as Project['layoutRules']
  local.layoutRules = { unknown: { collapsed: false, titleAuto: true } } as unknown as Project['layoutRules']
  expect(merge(base, local, incoming)).toEqual({ kind: 'conflict', reason: 'overlapping-content' })
})

it('adopts priority metadata beside disjoint unsaved node text, but refuses competing priority edits', () => {
  const base = project(['A']), local = project(['A']), incoming = project(['A'])
  for (const p of [base, local, incoming]) p.kanban = { columns: [], assignments: [] }
  local.nodes[0].text = 'Synthetic unsaved draft'
  incoming.kanban!.meta = [{ nodeId: 'A', priority: 'urgent', priorityManual: true }]
  const result = merge(base, local, incoming)
  expect(result.kind).toBe('adopt'); if (result.kind !== 'adopt') throw new Error('fixture')
  expect(result.projects[0].nodes[0].text).toBe('Synthetic unsaved draft')
  expect(result.projects[0].kanban?.meta).toEqual(incoming.kanban!.meta)
  local.kanban!.meta = [{ nodeId: 'A', priority: 'low', priorityManual: true }]
  expect(merge(base, local, incoming)).toEqual({ kind: 'conflict', reason: 'overlapping-content' })
})

it('merges different-card priority rows and retains row order, but refuses different choices on the same card', () => {
  const base = project(['A', 'B']), local = project(['A', 'B']), incoming = project(['A', 'B'])
  for (const p of [base, local, incoming]) p.kanban = { columns: [], assignments: [], meta: [
    { nodeId: 'A', priority: 'low' }, { nodeId: 'B', priority: 'low' }] }
  local.kanban!.meta![1].priority = 'high'
  incoming.kanban!.meta![0].priority = 'urgent'
  incoming.kanban!.meta!.reverse()
  const result = merge(base, local, incoming)
  expect(result.kind).toBe('adopt'); if (result.kind !== 'adopt') throw new Error('fixture')
  expect(result.projects[0].kanban!.meta).toEqual([{ nodeId: 'B', priority: 'high' }, { nodeId: 'A', priority: 'urgent' }])
  expect(result.localEditsRemain).toBe(true)
  local.kanban!.meta![0].priority = 'medium'
  expect(merge(base, local, incoming)).toEqual({ kind: 'conflict', reason: 'overlapping-content' })
})
it('merges concurrent first choices on distinct cards without interpreting opaque meta or labels as entities', () => {
  const base = project(['A', 'B']), local = project(['A', 'B']), incoming = project(['A', 'B'])
  for (const p of [base, local, incoming]) p.kanban = { columns: [], assignments: [] }
  local.kanban!.meta = [{ nodeId: 'B', priority: 'high' }]
  incoming.kanban!.meta = [{ nodeId: 'A', priority: 'urgent' }]
  const result = merge(base, local, incoming)
  expect(result.kind).toBe('adopt'); if (result.kind !== 'adopt') throw new Error('fixture')
  expect(result.projects[0].kanban!.meta).toHaveLength(2)
  expect(result.projects[0].kanban!.meta).toEqual(expect.arrayContaining([...local.kanban!.meta, ...incoming.kanban!.meta]))
  for (const p of [base, local, incoming]) p.layoutRules = JSON.parse('{"opaque":{"meta":[{"nodeId":"A","value":1},{"nodeId":"B","value":1}]}}')
  ;(local.layoutRules as unknown as { opaque: { meta: Array<{ value: number }> } }).opaque.meta[1].value = 2
  ;(incoming.layoutRules as unknown as { opaque: { meta: Array<{ value: number }> } }).opaque.meta[0].value = 3
  expect(merge(base, local, incoming)).toEqual({ kind: 'conflict', reason: 'overlapping-content' })
  for (const p of [base, local, incoming]) delete p.layoutRules
  base.kanban!.meta = [{ nodeId: 'A', labels: ['base'] }]
  local.kanban!.meta = [{ nodeId: 'A', labels: ['local'] }]
  incoming.kanban!.meta = [{ nodeId: 'A', labels: ['incoming'] }]
  expect(merge(base, local, incoming)).toEqual({ kind: 'conflict', reason: 'overlapping-content' })
})

it('card assignee arrays retain atomic choice semantics', () => {
  const base = project(['A']), local = project(['A']), incoming = project(['A'])
  for (const [p, name] of [[base, 'Synthetic base'], [local, 'Synthetic local'], [incoming, 'Synthetic incoming']] as const)
    p.kanban = { columns: [], assignments: [], meta: [{ nodeId: 'A', assignees: [{ name, color: '#fff' }] }] }
  expect(merge(base, local, incoming)).toEqual({ kind: 'conflict', reason: 'overlapping-content' })
})
