import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { initPlatform, resetPlatformForTests } from '../core/platform'
import { fakePlatform } from '../core/platform-fake'
import { createCleanupPersistence } from '../core/session-cleanup-persistence'
import { WorkspaceStore } from '../core/workspace-store'
import { ServerNodeOps } from './node-ops'
import type { Workspace } from '../shared/types'

it.skipIf(process.platform === 'win32').each([false, true])('acknowledges durable operator deletion and rejects a stale card even with a fresh workspace revision (inline=%s)', async (inline) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-ops-removal-'))
  try {
    initPlatform(fakePlatform({ userDataDir: root }))
    const store = new WorkspaceStore()
    const seed: Workspace = { version: 2, activeProjectId: 'p', projects: [{ id: 'p', name: 'p', color: '#fff', ...(inline ? {} : { cwd: path.join(root, 'project') }),
      viewport: { x: 0, y: 0, zoom: 1 }, nodes: [{ id: 'term-dead', kind: 'terminal', title: 'dead', color: '#fff', group: null,
        position: { x: 0, y: 0 }, size: { width: 440, height: 320 } }] }] }
    await store.save(seed)
    const stale = await store.load()
    const ops = new ServerNodeOps({ workspaceStore: store, sessionPresence: async () => 'dead', destroySession: async () => {},
      statusOf: () => undefined, ownerOf: () => undefined })
    expect(await ops.remove('term-dead', true)).toMatchObject({ ok: true })
    const disk = await new WorkspaceStore().load()
    expect(disk.projects[0].nodes).toEqual([])
    expect(disk.projects[0].deletedEntities?.nodes).toContain('term-dead')
    await expect(store.save(stale, { requireRevision: true })).rejects.toThrow('workspace_conflict')
    stale.revision = disk.revision
    await expect(store.save(stale, { requireRevision: true })).rejects.toThrow('workspace_conflict')
    expect((await new WorkspaceStore().load()).projects[0].nodes).toEqual([])
  } finally {
    resetPlatformForTests()
    await fs.rm(root, { recursive: true, force: true })
  }
})

it.skipIf(process.platform === 'win32').each([false, true])('explicit dead archived card removal persists without unprotecting sibling archives (inline=%s)', async (inline) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-ops-archive-removal-'))
  try {
    initPlatform(fakePlatform({ userDataDir: root }))
    const store = new WorkspaceStore()
    const card = (id: string) => ({ id, kind: 'terminal' as const, title: id, color: '#fff', group: null,
      position: { x: 0, y: 0 }, size: { width: 440, height: 320 } })
    await store.save({ version: 2, activeProjectId: 'p', projects: [{ id: 'p', name: 'p', color: '#fff',
      ...(inline ? {} : { cwd: path.join(root, 'project') }), viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [card('selected'), card('sibling')], bridges: [{ id: 'bridge', source: 'selected', target: 'sibling' }],
      ropes: [{ id: 'rope', source: 'sibling', target: 'selected' }], kanban: {
        columns: [{ id: 'done', title: 'Done', color: '#fff' }],
        assignments: ['selected', 'sibling'].map(nodeId => ({ nodeId, columnId: 'done' })),
        meta: [{ nodeId: 'selected' }, { nodeId: 'sibling' }],
        manualAssignments: { selected: true, sibling: true }, manualAssignmentVersions: { selected: 'v1', sibling: 'v2' }
      } }] })
    const cleanup = createCleanupPersistence(store)
    const archived = await cleanup.load()
    for (const node of archived.projects[0].nodes) node.cleanupArchiveId = 'receipt-history'
    await cleanup.save(archived)
    const stale = await store.load()
    const markerBlind = structuredClone(stale)
    for (const node of markerBlind.projects[0].nodes) delete node.cleanupArchiveId
    await store.save(markerBlind)
    expect((await store.load()).projects[0].nodes.every(n => n.cleanupArchiveId === 'receipt-history')).toBe(true)
    const olderClient = await store.load()
    olderClient.projects[0].nodes = []
    olderClient.projects[0].bridges = []
    olderClient.projects[0].ropes = []
    olderClient.projects[0].kanban!.assignments = []
    // A JSON-shaped option cannot acquire the symbol authority, even on an internal save call.
    await store.save(olderClient, JSON.parse('{"operatorArchiveRemoval":{"p":["selected","sibling"]}}'))
    expect((await store.load()).projects[0].nodes.map(n => [n.id, n.cleanupArchiveId])).toEqual([
      ['selected', 'receipt-history'], ['sibling', 'receipt-history']
    ])
    let probes = 0
    let destroyed = false
    const ops = new ServerNodeOps({ workspaceStore: store,
      sessionPresence: async () => { probes++; return 'dead' }, destroySession: async () => { destroyed = true },
      statusOf: () => undefined, ownerOf: () => undefined })
    expect(await ops.remove('selected', false)).toMatchObject({ ok: true, forced: false })
    expect(probes).toBe(2)
    expect(destroyed).toBe(false)
    const disk = await new WorkspaceStore().load()
    const project = disk.projects[0]
    expect(project.nodes.map(n => [n.id, n.cleanupArchiveId])).toEqual([['sibling', 'receipt-history']])
    expect(project.bridges).toEqual([])
    expect(project.ropes).toEqual([])
    expect(project.kanban!.assignments).toEqual([{ nodeId: 'sibling', columnId: 'done' }])
    expect(project.kanban!.meta).toEqual([{ nodeId: 'sibling' }])
    expect(project.kanban!.manualAssignments).toEqual({ sibling: true })
    expect(project.kanban!.manualAssignmentVersions).toEqual({ sibling: 'v2' })
    expect(project.deletedEntities?.nodes).toContain('selected')
    await expect(store.save(stale, { requireRevision: true })).rejects.toThrow('workspace_conflict')
    stale.revision = disk.revision
    await expect(store.save(stale, { requireRevision: true })).rejects.toThrow('workspace_conflict')
    expect((await new WorkspaceStore().load()).projects[0].nodes.map(n => n.id)).toEqual(['sibling'])
  } finally {
    resetPlatformForTests()
    await fs.rm(root, { recursive: true, force: true })
  }
})
