// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import type { CanvasNodeState, Project, WorkspacePublication } from '@shared/types'
import { nodeStatesToFlow, flowToNodeStates, type CanvasNode } from '../state/workspace'
import { mergeWithKeepAlive, type KeepAliveEntry } from './webviewKeepAlive'
import { planWorkspaceFlowPublication, applyWorkspaceFlowPublication } from './workspaceFlowPublication'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const revision = 'a'.repeat(64), after = 'b'.repeat(64)
const node = (id: string, kind: CanvasNodeState['kind'] = 'terminal'): CanvasNodeState => ({ id, kind, title: id, color: '#fff', group: null,
  position: { x: 1, y: 2 }, size: { width: 500, height: 400 }, titleAuto: true, collapsed: false, tags: [] })
const project = (nodes: CanvasNodeState[]): Project => ({ id: 'p', name: 'P', color: '#fff', viewport: { x: 0, y: 0, zoom: 1 }, nodes,
  kanban: { columns: [{ id: 'manual', title: 'Manual', color: '#fff' }], assignments: [] } })
function fixture() {
  const base = project([node('same'), node('local')]), incoming = structuredClone(base)
  const live = nodeStatesToFlow(base.nodes)
  const change: WorkspacePublication = { before: revision, after, changes: [{ before: base, after: incoming }] }
  const plan = (rev: string = revision, publication: WorkspacePublication | undefined = change) => planWorkspaceFlowPublication({ revision: rev,
    projects: [base], activeProjectId: 'p', nodes: live, change: publication })
  return { base, incoming, live, change, plan }
}
it('installs disjoint local/incoming insertion order at the Flow seam before advancing evidence and deferring created-node layout', () => {
  const base = project([node('A'), node('B')]), incoming = project([node('A'), node('R'), node('B')])
  const live = nodeStatesToFlow([node('L'), ...base.nodes]), callback = vi.fn()
  live[0].data.onNavigate = callback
  const change: WorkspacePublication = { before: revision, after, changes: [{ before: base, after: incoming }] }
  const plan = planWorkspaceFlowPublication({ revision, projects: [base], activeProjectId: 'p', nodes: live, change })
  expect(plan.kind).toBe('adopt'); if (plan.kind !== 'adopt') throw new Error('fixture')
  expect(flowToNodeStates(plan.nodes).map(n => n.id)).toEqual(['L', 'A', 'R', 'B'])
  expect(plan.nodes[0].data.onNavigate).toBe(callback)
  const events: string[] = [], deferred: Array<() => void> = []
  applyWorkspaceFlowPublication(plan, {
    content: p => { expect(p.nodes.map(n => n.id)).toEqual(['L', 'A', 'R', 'B']); events.push('content') },
    acknowledge: (p, r) => { expect(p[0].nodes.map(n => n.id)).toEqual(['L', 'A', 'R', 'B']); expect(r).toBe(after); events.push('ack') },
    defer: work => { deferred.push(work) }, created: ids => { expect(ids).toEqual(['R']); events.push('layout') }
  })
  expect(events).toEqual(['content', 'ack']); deferred[0](); expect(events).toEqual(['content', 'ack', 'layout'])
  const conflicting = planWorkspaceFlowPublication({ revision, projects: [base], activeProjectId: 'p',
    nodes: nodeStatesToFlow([node('B'), node('A')]), change })
  expect(conflicting.kind).toBe('conflict')
})
it('adopts a same-node edit and clears removed saved metadata and parent geometry while preserving runtime callbacks', () => {
  const f = fixture(), callback = vi.fn()
  Object.assign(f.base.nodes[0], { text: 'remove', taskSummary: 'remove', parentId: 'frame', pinned: true, manualPlacement: true,
    organization: { version: 1, mode: 'manual', metadata: { owner: 'X', projectId: 'p', workstream: 'test', functionalRole: 'ops' }, columnId: null, sequence: 1 },
    assistantCreation: { version: 1, taskId: 'task-001', creationId: 'create-001', declaredOwner: 'X' } })
  f.live.splice(0, f.live.length, ...nodeStatesToFlow(f.base.nodes))
  f.live[0].selected = true
  Object.assign(f.live[0].data, { onNavigate: callback, respawnNonce: 17, initialCommand: 'local pending command', viewerState: { scroll: 8 } })
  f.incoming.nodes[0].title = 'server rename'
  const plan = f.plan()
  expect(plan.kind).toBe('adopt'); if (plan.kind !== 'adopt') throw new Error('fixture')
  const next = plan.nodes[0], saved = flowToNodeStates([next])[0]
  expect(next.data.title).toBe('server rename'); expect(next.selected).toBe(true)
  expect(next.parentId).toBeUndefined(); expect(next.extent).toBeUndefined()
  for (const key of ['text', 'taskSummary', 'organization', 'assistantCreation', 'pinned', 'manualPlacement'] as const) expect(saved[key]).toBeUndefined()
  expect(next.data.onNavigate).toBe(callback); expect(next.data.respawnNonce).toBe(17)
  expect(next.data.initialCommand).toBe('local pending command'); expect(next.data.viewerState).toEqual({ scroll: 8 })
})
it('keeps disjoint unsaved fields, pins, placement, local node order and manual board choices at the Flow seam', () => {
  const f = fixture()
  f.live[1].data.pinned = true; f.live[1].data.manualPlacement = true; f.live[1].position = { x: 999, y: 333 }
  f.live.reverse()
  f.base.kanban!.manualAssignments = { local: true }; f.base.kanban!.assignments = [{ nodeId: 'local', columnId: 'manual' }]
  f.incoming.kanban = structuredClone(f.base.kanban)
  f.incoming.nodes[0].title = 'server'
  const plan = f.plan(); expect(plan.kind).toBe('adopt'); if (plan.kind !== 'adopt') throw new Error('fixture')
  expect(plan.nodes.map(n => n.id)).toEqual(['local', 'same'])
  expect(plan.nodes[0].data.pinned).toBe(true); expect(plan.nodes[0].data.manualPlacement).toBe(true)
  expect(plan.nodes[0].position).toEqual({ x: 999, y: 333 }); expect(plan.projects[0].kanban).toEqual(f.base.kanban)
})
it('refuses true overlap, missed/out-of-order/foreign publications and missing old-host acknowledgment without touching Flow or revision', () => {
  const f = fixture(), content = vi.fn(), acknowledge = vi.fn()
  f.live[0].data.title = 'local'; f.incoming.nodes[0].title = 'server'
  const rejected = [f.plan(), f.plan('c'.repeat(64)), f.plan(revision, undefined), f.plan(revision, { ...f.change, changes: [] }),
    f.plan(revision, { ...f.change, changes: [{ before: { ...f.base, id: 'foreign' }, after: { ...f.incoming, id: 'foreign' } }] })]
  for (const plan of rejected) { expect(plan.kind).toBe('conflict'); applyWorkspaceFlowPublication(plan, { content, acknowledge, created: vi.fn(), defer: vi.fn() }) }
  expect(content).not.toHaveBeenCalled(); expect(acknowledge).not.toHaveBeenCalled(); expect(f.live[0].data.title).toBe('local')
})
it.each([false, true])('adopts a saved operator close of an unchanged JSON node, archived=%s', archived => {
  const f = fixture()
  if (archived) f.base.nodes[0].cleanupArchiveId = 'receipt'
  // Real RPC/disk snapshots omit undefined keys. Flow serialization materializes them.
  delete f.base.nodes[0].titleAuto
  delete f.base.nodes[0].collapsed
  f.base = JSON.parse(JSON.stringify(f.base)) as Project
  f.incoming = JSON.parse(JSON.stringify(f.base)) as Project
  f.incoming.nodes = f.incoming.nodes.filter(n => n.id !== 'same')
  f.incoming.deletedEntities = { nodes: ['same'], bridges: ['incident'], ropes: [] }
  f.base.bridges = [{ id: 'incident', source: 'same', target: 'local' }]
  f.incoming.bridges = []
  f.base.kanban!.assignments = [{ nodeId: 'same', columnId: 'manual' }]
  f.incoming.kanban!.assignments = []
  const live = nodeStatesToFlow(f.base.nodes)
  live[1].data.text = 'unsaved surviving draft'
  const plan = planWorkspaceFlowPublication({ revision, projects: [f.base], activeProjectId: 'p', nodes: live,
    change: { before: revision, after, changes: [{ before: f.base, after: f.incoming }] } })
  expect(plan.kind).toBe('adopt'); if (plan.kind !== 'adopt') throw new Error('fixture')
  expect(plan.nodes.map(n => n.id)).toEqual(['local'])
  expect(plan.nodes[0].data.text).toBe('unsaved surviving draft')
  expect(plan.removed).toEqual(['same'])
  expect(plan.projects[0].bridges).toEqual([])
  expect(plan.projects[0].kanban!.assignments).toEqual([])
  expect(plan.projects[0].deletedEntities).toEqual(f.incoming.deletedEntities)
  expect(plan.revision).toBe(after)
})
it('refuses saved deletion of a card carrying a real unsaved draft despite retained deletion evidence', () => {
  const f = fixture()
  f.incoming.nodes = f.incoming.nodes.filter(n => n.id !== 'same')
  f.incoming.deletedEntities = { nodes: ['same'], bridges: [], ropes: [] }
  f.live[0].data.text = 'unsent text must stay visible'
  expect(f.plan()).toEqual({ kind: 'conflict', reason: 'overlapping-content' })
  expect(f.live[0].data.text).toBe('unsent text must stay visible')
})
it('installs all content before acknowledging and defers the original node-created trigger', () => {
  const f = fixture(), order: string[] = [], deferred: Array<() => void> = []
  f.incoming.nodes.push(node('created'))
  const plan = f.plan()
  applyWorkspaceFlowPublication(plan, { content: p => { expect(p.nodes.some(n => n.id === 'created')).toBe(true); order.push('content') },
    acknowledge: (_p, rev) => { expect(rev).toBe(after); order.push('ack') }, created: ids => order.push(`created:${ids.join(',')}`), defer: work => deferred.push(work) })
  expect(order).toEqual(['content', 'ack']); deferred[0]()
  expect(order).toEqual(['content', 'ack', 'created:created'])
  const ack = vi.fn()
  expect(() => applyWorkspaceFlowPublication(plan, { content: () => { throw new Error('adoption failed') }, acknowledge: ack, created: vi.fn(), defer: vi.fn() })).toThrow('adoption failed')
  expect(ack).not.toHaveBeenCalled()
})
it('archive and marker-only undo preserve Flow callbacks, identity and saved manual fields', () => {
  const f = fixture(), callback = vi.fn()
  f.live[0].data.onAction = callback; f.live[0].data.pinned = true; f.live[0].data.manualPlacement = true
  f.incoming.nodes[0].cleanupArchiveId = 'receipt'
  const archive = f.plan(); expect(archive.kind).toBe('adopt'); if (archive.kind !== 'adopt') throw new Error('fixture')
  expect(archive.nodes[0].hidden).toBe(true); expect(archive.nodes[0].data.onAction).toBe(callback)
  const restored = structuredClone(f.incoming); delete restored.nodes[0].cleanupArchiveId
  const undo = planWorkspaceFlowPublication({ revision: after, projects: archive.projects, activeProjectId: 'p', nodes: archive.nodes,
    change: { before: after, after: 'c'.repeat(64), changes: [{ before: f.incoming, after: restored }] } })
  expect(undo.kind).toBe('adopt'); if (undo.kind !== 'adopt') throw new Error('fixture')
  expect(undo.nodes[0].hidden).toBe(false); expect(undo.nodes[0].data.onAction).toBe(callback)
  expect(undo.nodes[0].data.pinned).toBe(true); expect(undo.nodes[0].data.manualPlacement).toBe(true)
})
it.each([false, true])('keeps webview DOM keys/order and mounted background ghosts, pooled=%s', pooled => {
  const f = fixture(); f.base.nodes = [node('browser-a', 'browser'), node('web-b', 'web'), node('same')]
  f.incoming.nodes = structuredClone(f.base.nodes); f.incoming.nodes.reverse(); f.incoming.nodes[2].title = 'new title'
  f.live.splice(0, f.live.length, ...nodeStatesToFlow(f.base.nodes))
  const entries: KeepAliveEntry[] = [{ nodeId: 'background', projectId: 'other', retiredAt: 1,
    node: { type: 'browser', data: { title: 'background', color: '#fff', group: null, url: 'https://fixture.test/' } } }]
  if (pooled) for (const n of f.live.filter(n => n.type === 'browser' || n.type === 'web')) entries.push({ nodeId: n.id, projectId: 'p', retiredAt: 0,
    node: { type: n.type as 'browser', data: n.data } })
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host)
  const render = (nodes: CanvasNode[]) => act(() => root.render(<div>{mergeWithKeepAlive(nodes, [], entries, 'p').map(n => <div key={n.id} data-id={n.id} data-ghost={String(!!n.data.ghost)}>{n.data.title}</div>)}</div>))
  render(f.live)
  const kept = new Map(['browser-a', 'web-b', 'background'].map(id => [id, host.querySelector(`[data-id="${id}"]`)!]))
  const moves: string[] = [], originals = new Map<string, Function>()
  for (const name of ['insertBefore', 'appendChild', 'removeChild'] as const) {
    const original = Node.prototype[name]; originals.set(name, original)
    Object.defineProperty(Node.prototype, name, { configurable: true, writable: true, value: function (this: Node, ...args: any[]) {
      if ([...kept.values()].includes(args[0])) moves.push(name)
      return (original as Function).apply(this, args)
    } })
  }
  try {
    const plan = f.plan(); expect(plan.kind).toBe('adopt'); if (plan.kind !== 'adopt') throw new Error('fixture')
    render(plan.nodes)
    expect(moves).toEqual([])
    for (const [id, el] of kept) expect(host.querySelector(`[data-id="${id}"]`)).toBe(el)
    expect(kept.get('background')!.getAttribute('data-ghost')).toBe('true')
    expect(kept.get('browser-a')!.textContent).toBe('new title')
  } finally {
    for (const [name, original] of originals) Object.defineProperty(Node.prototype, name, { value: original, writable: true, configurable: true })
    act(() => root.unmount()); host.remove()
  }
})
afterEach(() => vi.restoreAllMocks())

it('clean adoption advances content/evidence without requesting another save, disjoint retained edits request saving', () => {
  const base = project([node('A')]), incoming = structuredClone(base)
  incoming.nodes[0].title = 'Durable incoming title'
  const change: WorkspacePublication = { before: revision, after, changes: [{ before: base, after: incoming }] }
  const persist = vi.fn(), acknowledge = vi.fn()
  const sinks = { content: vi.fn(), acknowledge, created: vi.fn(), defer: (work: () => void) => work(), persistLocalEdits: persist }
  const clean = planWorkspaceFlowPublication({ revision, projects: [base], activeProjectId: 'p', nodes: nodeStatesToFlow(base.nodes), change })
  expect(clean.kind).toBe('adopt'); if (clean.kind !== 'adopt') throw new Error('fixture')
  expect(clean.localEditsRemain).toBe(false)
  applyWorkspaceFlowPublication(clean, sinks)
  expect(acknowledge).toHaveBeenCalledOnce()
  expect(persist).not.toHaveBeenCalled()
  const local = nodeStatesToFlow(base.nodes)
  local[0].data.text = 'Synthetic unsaved disjoint draft'
  const merged = planWorkspaceFlowPublication({ revision, projects: [base], activeProjectId: 'p', nodes: local, change })
  expect(merged.kind).toBe('adopt'); if (merged.kind !== 'adopt') throw new Error('fixture')
  expect(merged.localEditsRemain).toBe(true)
  applyWorkspaceFlowPublication(merged, sinks)
  expect(persist).toHaveBeenCalledOnce()
  expect(merged.projects[0].nodes[0].text).toBe('Synthetic unsaved disjoint draft')
  expect(merged.projects[0].nodes[0].title).toBe('Durable incoming title')
})
it('an index-only publication while viewing a different project does not request saving or change active Flow', () => {
  const base = project([node('A')]), background = { ...project([]), id: 'different-active' }
  const change: WorkspacePublication = { before: revision, after, changes: [{ before: base, after: { ...base, revision: 'c'.repeat(64) } }] }
  const nodes = nodeStatesToFlow(background.nodes), persist = vi.fn()
  const plan = planWorkspaceFlowPublication({ revision, projects: [base, background], activeProjectId: background.id, nodes, change })
  expect(plan.kind).toBe('adopt'); if (plan.kind !== 'adopt') throw new Error('fixture')
  expect(plan.nodes).toBe(nodes)
  expect(plan.localEditsRemain).toBe(false)
  applyWorkspaceFlowPublication(plan, { content: vi.fn(), acknowledge: vi.fn(), created: vi.fn(), defer: work => work(), persistLocalEdits: persist })
  expect(persist).not.toHaveBeenCalled()
})

it('missed publication resyncs without conflict', () => {
  const f = fixture()
  f.live[0].data.text = 'local draft'
  f.incoming.nodes[0].title = 'remote rename'
  const plan = planWorkspaceFlowPublication({ revision, projects: [f.base], activeProjectId: 'p', nodes: f.live,
    change: undefined, resync: { base: [f.base], incoming: [f.incoming], revision: after } } as Parameters<typeof planWorkspaceFlowPublication>[0])
  expect(plan.kind).toBe('adopt')
  if (plan.kind !== 'adopt') throw new Error('resync failed')
  expect(plan.nodes[0].data.text).toBe('local draft')
  expect(plan.nodes[0].data.title).toBe('remote rename')
})
it('agent-created card in a project appears in an open tab without reload', () => {
  const f = fixture()
  f.incoming.nodes.push(node('agent-created'))
  const plan = planWorkspaceFlowPublication({ revision, projects: [f.base], activeProjectId: 'p', nodes: f.live,
    change: undefined, resync: { base: [f.base], incoming: [f.incoming], revision: after } } as Parameters<typeof planWorkspaceFlowPublication>[0])
  expect(plan.kind).toBe('adopt')
  if (plan.kind !== 'adopt') throw new Error('card did not land')
  expect(plan.nodes.map(n => n.id)).toContain('agent-created')
})
it('full resync preserves independent board metadata edits and new projects', () => {
  const f = fixture()
  f.base.kanban!.meta = [{ nodeId: 'same', labels: ['base'] }, { nodeId: 'local', labels: ['base'] }]
  f.incoming.kanban = structuredClone(f.base.kanban)
  f.incoming.kanban!.meta![0].labels = ['remote']
  const local = structuredClone(f.base)
  local.kanban!.meta![1].labels = ['local']
  const added = { ...project([]), id: 'new-project' }
  const plan = planWorkspaceFlowPublication({ revision, projects: [local], activeProjectId: 'p', nodes: f.live,
    change: undefined, resync: { base: [f.base], incoming: [f.incoming, added], revision: after } })
  expect(plan.kind).toBe('adopt')
  if (plan.kind !== 'adopt') throw new Error('resync failed')
  expect(plan.projects.map(p => p.id)).toEqual(['p', 'new-project'])
  expect(plan.projects[0].kanban!.meta!.map(m => m.labels)).toEqual([['remote'], ['local']])
})
it('full resync refuses a real field overlap and preserves the live draft', () => {
  const f = fixture()
  f.live[0].data.text = 'local draft'
  f.incoming.nodes[0].text = 'remote draft'
  expect(planWorkspaceFlowPublication({ revision, projects: [f.base], activeProjectId: 'p', nodes: f.live,
    change: undefined, resync: { base: [f.base], incoming: [f.incoming], revision: after } })).toEqual({ kind: 'conflict', reason: 'overlapping-content' })
  expect(f.live[0].data.text).toBe('local draft')
})
it('current save-ACK duplicate installs rescued host content and retains post-save edits', () => {
  const f = fixture()
  const saved = structuredClone(f.base)
  saved.nodes[0].title = 'saved title'
  f.incoming.nodes[0].title = 'normalized title'
  f.incoming.nodes.push(node('rescued'))
  const live = nodeStatesToFlow(saved.nodes)
  live[0].data.text = 'typed after save'
  const plan = planWorkspaceFlowPublication({ revision: after, projects: [saved], adoptedProjects: [saved], activeProjectId: 'p', nodes: live, change: f.change })
  expect(plan.kind).toBe('adopt')
  if (plan.kind !== 'adopt') throw new Error('ACK content did not land')
  expect(plan.duplicateEvidence).toBe(true)
  expect(plan.nodes[0].data.title).toBe('normalized title')
  expect(plan.nodes[0].data.text).toBe('typed after save')
  expect(plan.nodes.map(n => n.id)).toContain('rescued')
  expect(plan.adoptedProjects).toEqual([f.incoming])
  const older = planWorkspaceFlowPublication({ revision: 'c'.repeat(64), projects: plan.projects,
    adoptedProjects: plan.adoptedProjects, activeProjectId: 'p', nodes: plan.nodes, change: f.change })
  expect(older).toEqual({ kind: 'conflict', reason: 'revision-chain-broken' })
})
