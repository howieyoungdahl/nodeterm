import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initPlatform, resetPlatformForTests } from '../../src/core/platform'
import { fakePlatform } from '../../src/core/platform-fake'
import { WorkspaceStore } from '../../src/core/workspace-store'
import { resolveWorkspaceConflict } from '../../src/renderer/lib/workspacePersistence'
import type { CanvasNodeState, Project, Workspace } from '../../src/shared/types'

const node = (id: string, extra: Partial<CanvasNodeState> = {}): CanvasNodeState => ({
  id, kind: 'terminal', title: id, color: '#0a84ff', group: null,
  position: { x: 10, y: 20 }, size: { width: 640, height: 440 }, ...extra
})
let root: string, store: WorkspaceStore, stale: Workspace
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-deleted-save-'))
  initPlatform(fakePlatform({ userDataDir: root }))
  store = new WorkspaceStore()
  const project: Project = {
    id: 'project-fixture', name: 'fixture', color: '#0a84ff', cwd: path.join(root, 'project'),
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [node('saved'), node('deleted'), node('deleted-group', { kind: 'group', position: { x: 100, y: 200 } })],
    bridges: [{ id: 'deleted-bridge', source: 'saved', target: 'deleted' }],
    ropes: [{ id: 'deleted-rope', source: 'saved', target: 'deleted' }],
    kanban: { columns: [{ id: 'column-one', title: 'Work' }],
      assignments: [{ nodeId: 'saved', columnId: 'column-one' }, { nodeId: 'deleted', columnId: 'column-one' }] }
  }
  await store.save({ version: 2, activeProjectId: project.id, projects: [project] })
  stale = await store.load()
  const deleted = structuredClone(stale)
  deleted.projects[0].nodes = [deleted.projects[0].nodes[0]]
  deleted.projects[0].bridges = []
  deleted.projects[0].ropes = []
  deleted.projects[0].kanban!.assignments = [deleted.projects[0].kanban!.assignments[0]]
  await store.save(deleted)
  stale.projects[0].nodes.push(node('new-unsaved', { parentId: 'deleted-group' }))
  stale.projects[0].loadedKanban = structuredClone(stale.projects[0].kanban!)
  stale.projects[0].kanban!.manualAssignments = { saved: true }
  stale.projects[0].kanban!.manualAssignmentVersions = { saved: 'manual-version' }
  // An explicit Ungrouped choice made while autosave is paused.
  stale.projects[0].kanban!.assignments = [{ nodeId: 'deleted', columnId: 'column-one' }]
  stale.projects[0].bridges!.push({ id: 'new-bridge', source: 'saved', target: 'new-unsaved' })
})
afterEach(async () => {
  resetPlatformForTests()
  await fs.rm(root, { recursive: true, force: true })
})

describe('deleted cards cannot trap conflict resolution in another failed save', () => {
  for (const keep of [false, true]) it(`${keep ? 'Keep local edits' : 'Reload'} saves new cards without restoring explicit deletions`, async () => {
    await expect(store.save(stale, { requireRevision: true })).rejects.toThrow('workspace_conflict:')
    const incoming = await store.load()
    const resolved = resolveWorkspaceConflict(stale, incoming, keep)
    expect(resolved.projects[0].nodes.map(n => n.id)).toEqual(['saved', 'new-unsaved'])
    expect(resolved.projects[0].nodes[1]).toMatchObject({ position: { x: 110, y: 220 } })
    expect(resolved.projects[0].nodes[1].parentId).toBeUndefined()
    expect(resolved.projects[0].bridges).toEqual([{ id: 'new-bridge', source: 'saved', target: 'new-unsaved' }])
    expect(resolved.projects[0].ropes).toEqual([])
    if (keep) {
      expect(resolved.projects[0].kanban!.manualAssignments).toEqual({ saved: true })
      expect(resolved.projects[0].kanban!.assignments).toEqual([])
    }
    await store.save(resolved, { requireRevision: true })
    const reloaded = await new WorkspaceStore().load()
    expect(reloaded.projects[0].nodes.map(n => n.id)).toEqual(['saved', 'new-unsaved'])
    await store.save(reloaded, { requireRevision: true })
    const raw = JSON.parse(await fs.readFile(path.join(root, 'project/.nodeterm/project.json'), 'utf8'))
    expect(raw._reconciliation.deleted.nodes.sort()).toEqual(['deleted', 'deleted-group'])
    expect(raw.deletedEntities).toBeUndefined()
  })

  it('reports a retained deletion conflict through the workspace save boundary without a generic retry error', async () => {
    const incoming = await store.load()
    const withFreshRevision = { ...stale, revision: incoming.revision }
    await expect(store.save(withFreshRevision, { requireRevision: true })).rejects.toThrow('workspace_conflict:')
  })
})
