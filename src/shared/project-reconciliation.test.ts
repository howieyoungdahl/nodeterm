import { describe, expect, it } from 'vitest'
import {
  applyProjectViewEdits, reconcileProjectBytes, reconcileProjectDocuments, type ProjectDocument
} from './project-reconciliation'

const node = (id: string, extra: ProjectDocument = {}): ProjectDocument => ({
  id, title: id, position: { x: 0, y: 0 }, group: null, ...extra
})
const doc = (nodes = [node('a'), node('b')], extra: ProjectDocument = {}): ProjectDocument => ({
  name: 'Canvas', nodes, ...extra
})

describe('project common-base reconciliation', () => {
  it('merges local layout, an incoming title and one remote registration exactly once', () => {
    const base = doc()
    const local = doc([node('a', { position: { x: 50, y: 0 } }), node('b')])
    const incoming = doc([node('a'), node('b', { title: 'Remote task' }), node('phone', { taskId: 'task-7' })])
    const result = reconcileProjectDocuments(base, local, incoming)
    expect(result).toEqual({ kind: 'merged', conflicts: [], document: doc([
      node('a', { position: { x: 50, y: 0 } }), node('b', { title: 'Remote task' }), node('phone', { taskId: 'task-7' })
    ]) })
    expect(reconcileProjectDocuments(incoming, result.document, incoming)).toEqual(result)
  })

  it('merges independent fields of the same node without dropping groups, edges or preferences', () => {
    const base = doc([node('a')], { layoutRules: { border: 'blue', unknownRule: true }, bridges: [] })
    const local = doc([node('a', { position: { x: 10, y: 0 } })], {
      layoutRules: { unknownRule: true }, bridges: []
    })
    const incoming = doc([node('a', { title: 'Other title' }), node('group', { kind: 'group' })], {
      layoutRules: { border: 'blue', unknownRule: true, spacing: 40 }, bridges: [{ id: 'edge', source: 'a', target: 'group' }]
    })
    expect(reconcileProjectDocuments(base, local, incoming)).toMatchObject({ kind: 'merged', document: {
      nodes: [node('a', { title: 'Other title', position: { x: 10, y: 0 } }), node('group', { kind: 'group' })],
      layoutRules: { unknownRule: true, spacing: 40 }, bridges: incoming.bridges
    } })
  })

  it('names an actual same-field conflict while retaining unrelated edits and a new session', () => {
    const result = reconcileProjectDocuments(doc(), doc([node('a', { title: 'Local' }), node('b')]),
      doc([node('a', { title: 'Incoming' }), node('b'), node('phone')], { color: 'red' }))
    expect(result.kind).toBe('conflict')
    expect(result.conflicts).toEqual([{ path: ['nodes', 'a', 'title'], kind: 'value',
      base: { present: true, value: 'a' }, local: { present: true, value: 'Local' }, incoming: { present: true, value: 'Incoming' } }])
    expect(result.document.nodes).toHaveLength(3)
    expect(result.document.color).toBe('red')
  })

  it.each(['local', 'incoming'] as const)('keeps a %s deletion against an unchanged node', (side) => {
    const base = doc()
    expect(reconcileProjectDocuments(base, side === 'local' ? doc([node('b')]) : base,
      side === 'incoming' ? doc([node('b')]) : base)).toEqual({ kind: 'merged', conflicts: [], document: doc([node('b')]) })
  })

  it('retains both sides of delete versus edit, including missing versus null', () => {
    const result = reconcileProjectDocuments(doc(), doc([node('b')]), doc([node('a', { group: 'g' }), node('b')]))
    expect(result.conflicts).toMatchObject([{ path: ['nodes', 'a'], kind: 'delete-edit', local: { present: false },
      incoming: { present: true, value: { group: 'g' } } }])
    expect(reconcileProjectDocuments({ future: false }, {}, { future: null }).conflicts).toEqual([
      { path: ['future'], kind: 'delete-edit', base: { present: true, value: false }, local: { present: false },
        incoming: { present: true, value: null } }
    ])
  })

  it('refuses resurrection after the common base advances, even for equal replay snapshots', () => {
    const deleted = new Set(['a'])
    const replay = doc()
    for (const local of [doc([node('b')]), replay]) {
      const result = reconcileProjectDocuments(doc([node('b')]), local, replay, deleted)
      expect(result.kind).toBe('conflict')
      expect(result.conflicts[0]).toMatchObject({ path: ['nodes', 'a'], kind: 'deleted-node' })
      expect(result.document.nodes).toEqual([node('b')])
    }
  })

  it('preserves unknown fields on every side, literal prototype keys and detached recovery values', () => {
    const base = JSON.parse('{"nodes":[],"future":{"nested":1},"__proto__":{"safe":true}}')
    const local = { ...base, future: { nested: 1, local: [1, 2] } }
    const incoming = { ...base, future: { nested: 1, remote: { feature: true } } }
    const result = reconcileProjectDocuments(base, local, incoming)
    expect(result.kind).toBe('merged')
    expect(result.document.future).toEqual({ nested: 1, local: [1, 2], remote: { feature: true } })
    expect(Object.hasOwn(result.document, '__proto__')).toBe(true)
    expect(Object.getPrototypeOf(result.document)).toBe(Object.prototype)
    incoming.future.remote.feature = false
    expect(result.document.future).toMatchObject({ remote: { feature: true } })
  })

  it('retains byte-exact recovery inputs, including invalid partial external writes', () => {
    const recovery = { base: '{ "name": "before" }\n', local: '{"name":"local"}', incoming: '{\n"name":"disk"\n}' }
    expect(reconcileProjectBytes(recovery)).toMatchObject({ kind: 'conflict', recovery })
    const partial = { ...recovery, incoming: '{"name":' }
    expect(reconcileProjectBytes(partial)).toEqual({ kind: 'unavailable', invalid: ['incoming'], recovery: partial })
    const recovered = reconcileProjectBytes({ ...partial, incoming: recovery.base })
    expect(recovered).toMatchObject({ kind: 'merged', document: { name: 'local' } })
  })

  it('refuses duplicate IDs and incompatible concurrent additions instead of collapsing identities', () => {
    expect(reconcileProjectDocuments(doc(), doc(), doc([node('a'), node('a')]))).toMatchObject({
      kind: 'conflict', conflicts: [{ path: ['nodes'], kind: 'identity' }]
    })
    expect(reconcileProjectDocuments(doc([]), doc([node('new', { accountId: 'one' })]),
      doc([node('new', { accountId: 'two' })]))).toMatchObject({ kind: 'conflict',
      conflicts: [{ path: ['nodes', 'new'], kind: 'identity' }] })
  })

  it('merges disjoint insertions and preserves an inserted group before its child', () => {
    const base = doc([node('a'), node('b')])
    const local = doc([node('a'), node('local'), node('b')])
    const incoming = doc([node('group'), node('a'), node('b')])
    expect(reconcileProjectDocuments(base, local, incoming).document.nodes).toEqual([
      node('group'), node('a'), node('local'), node('b')
    ])
  })

  it('preserves a one-sided reorder and surfaces incompatible combined reorders', () => {
    const base = doc([node('a'), node('b'), node('c')])
    const local = doc([node('b'), node('a'), node('c')])
    expect(reconcileProjectDocuments(base, local, base)).toMatchObject({ kind: 'merged', document: local })
    expect(reconcileProjectDocuments(base, local, doc([node('a'), node('c'), node('b')]))).toMatchObject({
      kind: 'conflict', conflicts: [{ path: ['nodes'], kind: 'order' }]
    })
  })

  it('keeps unknown ordered arrays atomic and optional list absence distinct from empty', () => {
    expect(reconcileProjectDocuments({ future: [1] }, { future: [2] }, { future: [3] })).toMatchObject({
      kind: 'conflict', conflicts: [{ path: ['future'], kind: 'value' }]
    })
    expect(reconcileProjectDocuments({}, {}, {}).document).toEqual({})
    expect(reconcileProjectDocuments({ bridges: [] }, {}, { bridges: [] }).document).toEqual({})
  })

  it('overlays an older client view without deleting raw fields its serializer never understood', () => {
    const raw = doc([node('a', { futureNode: { owner: 'task-7' } })], {
      futureProject: ['preserve'], layoutRules: { knownBorder: 'red', futureRule: 9 }
    })
    const viewBase = doc([node('a')], { layoutRules: { knownBorder: 'red' } })
    const viewLocal = doc([node('a', { title: 'Edited' })], { layoutRules: {} })
    expect(applyProjectViewEdits(JSON.stringify(raw), viewBase, viewLocal)).toMatchObject({
      kind: 'merged', document: doc([node('a', { title: 'Edited', futureNode: { owner: 'task-7' } })], {
        futureProject: ['preserve'], layoutRules: { futureRule: 9 }
      })
    })
  })
})
