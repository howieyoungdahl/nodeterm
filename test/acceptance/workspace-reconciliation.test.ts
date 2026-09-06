import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { WorkspaceStore } from '../../src/core/workspace-store'
import { fakePlatform } from '../../src/core/platform-fake'
import { initPlatform, resetPlatformForTests } from '../../src/core/platform'
import { ProjectCommitStore } from '../../src/core/project-commit-store'
import { WorkspaceReconciliationClient } from '../../src/renderer/state/workspaceReconciliation'
import { buildRealApi, type RpcClient } from '../../src/renderer/bridge/ws-bridge'
import { useProjects } from '../../src/renderer/state/projects'
import { flowToNodeStates, nodeStatesToFlow } from '../../src/renderer/state/workspace'
import { IPC } from '../../src/shared/ipc'
import { projectNodeViewKeys } from '../../src/shared/project-view'
import type { Project, Workspace, WorkspaceApi } from '../../src/shared/types'
import type { WorkspaceRevisionOutcome, WorkspaceRevisionRequest, WorkspaceRevisionView } from '../../src/shared/workspace-reconciliation'

let dir: string, file: string, store: WorkspaceStore, fake: ReturnType<typeof fakePlatform>, api: WorkspaceApi
const project = (id: string, cwd: string): Project => ({ id, cwd, name: id, color: '#fff', viewport: { x: 7, y: 8, zoom: 1 },
  nodes: [{ id: `term-${id}`, kind: 'terminal', title: 'Base', position: { x: 0, y: 0 }, size: { width: 500, height: 300 },
    color: '#fff', group: null, shell: '/bin/bash' }] })
const current = (): Workspace => useProjects.getState().toWorkspace()
const request = (view: WorkspaceRevisionView, workspace: Workspace, operationId = 'op'): WorkspaceRevisionRequest => ({
  clientId: view.clientId, operationId, indexRevision: view.indexRevision,
  expected: Object.fromEntries(Object.entries(view.projects).map(([id, value]) => [id, value.revision])), workspace
})
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-workspace-reconciliation-'))
  const userData = path.join(dir, 'user'); await fs.mkdir(userData)
  fake = fakePlatform({ userDataDir: userData }); initPlatform(fake)
  store = new WorkspaceStore()
  await store.save({ version: 2, activeProjectId: 'p1', projects: [project('p1', path.join(dir, 'one')), project('p2', path.join(dir, 'two'))] })
  file = path.join(dir, 'one', '.nodeterm', 'project.json')
  const raw = JSON.parse(await fs.readFile(file, 'utf8'))
  raw.futureRoot = { survive: true }; raw.nodes[0].futureNode = { survive: true }
  await fs.writeFile(file, JSON.stringify(raw))
  store.registerIpc()
  // Same registered handlers used by Electron and Server request adapters, with no service boot.
  api = buildRealApi({ request: async (channel: string, ...args: unknown[]) => {
    // Exercise the actual browser bridge methods and wire JSON, not direct typed references.
    const result = await fake.handlers[channel](...JSON.parse(JSON.stringify(args)))
    return JSON.parse(JSON.stringify(result))
  } } as RpcClient).workspace
})
afterEach(async () => {
  resetPlatformForTests()
  const evidence = process.env.NODETERM_RECONCILIATION_EVIDENCE_DIR
  if (evidence) {
    await fs.mkdir(evidence, { recursive: true })
    await fs.cp(dir, path.join(evidence, path.basename(dir)), { recursive: true, force: false, errorOnExist: true })
  }
  await fs.rm(dir, { recursive: true, force: true })
})

describe('actual store → IPC → renderer state → Flow serialization → store', () => {
  it('preserves unknown fields and machine-local exec through actual Flow and disk reopening', async () => {
    const client = new WorkspaceReconciliationClient(api)
    useProjects.getState().hydrate(await client.load())
    const p = current().projects[0], flow = nodeStatesToFlow(p.nodes)
    expect(Object.keys(flowToNodeStates(flow)[0]).sort()).toEqual([...projectNodeViewKeys].sort())
    flow[0].position.x = 120
    useProjects.getState().commitCanvas('p1', flowToNodeStates(flow), p.viewport)
    const outcome = await client.save(current(), current)
    expect(outcome.saved).toBe(true)
    const raw = JSON.parse(await fs.readFile(file, 'utf8'))
    expect(raw).toMatchObject({ futureRoot: { survive: true }, nodes: [{ futureNode: { survive: true }, position: { x: 120 } }] })
    expect(raw.nodes[0].shell).toBeUndefined()
    expect(outcome.workspace.projects[0].nodes[0].shell).toBe('/bin/bash')
    expect((await new WorkspaceStore().loadReconciled()).workspace.projects[0].nodes[0].position.x).toBe(120)
  })

  it('binds different clients to their own loaded bases; guessing the latest revision is not enrollment', async () => {
    const a = await store.loadReconciled()
    const local = structuredClone(a.workspace); local.projects[0].name = 'A edit'
    expect((await store.saveReconciled(request(a, local, 'a'))).projects.p1.kind).toBe('committed')
    const b = await store.loadReconciled()
    expect(b.projects.p1.revision).not.toBe(a.projects.p1.revision)
    // A did receive its own ack, so use a genuinely stale third client for the guessed-base case.
    const stale = await store.loadReconciled()
    const next = structuredClone(b.workspace); next.projects[0].color = '#123456'
    const changed = await store.saveReconciled(request(b, next, 'b'))
    const forged = request(stale, stale.workspace, 'guess')
    forged.expected.p1 = changed.projects.p1.current!.revision
    expect((await store.saveReconciled(forged)).projects.p1.kind).toBe('stale-base')
    const oldEdit = structuredClone(a.workspace); oldEdit.projects[0].nodes[0].position.x = 80
    expect((await store.saveReconciled(request(a, oldEdit, 'stale-independent'))).projects.p1.kind).toBe('committed')
    expect(JSON.parse(await fs.readFile(file, 'utf8'))).toMatchObject({ name: 'A edit', color: '#123456', nodes: [{ position: { x: 80 } }] })
  })

  it('replays the same pending operation after a lost ack and a host-store restart', async () => {
    let lose = true
    const wrapped = { ...api, saveReconciled: async (req: WorkspaceRevisionRequest) => {
      const result = await api.saveReconciled!(req)
      if (lose) { lose = false; throw new Error('socket lost after commit') }
      return result
    } } as WorkspaceApi
    const client = new WorkspaceReconciliationClient(wrapped)
    useProjects.getState().hydrate(await client.load())
    useProjects.getState().renameNode('p1', 'term-p1', 'Saved once')
    await expect(client.save(current(), current)).rejects.toThrow('socket lost')
    // No event reaches the disconnected client. Its old receipt is not the current file head.
    expect(await store.appendRemoteNode('p1', { id: 'term-offline-444' })).toBe(true)
    const committed = await fs.readFile(file, 'utf8')
    store = new WorkspaceStore(); store.registerIpc()
    const replay = await client.save(current(), current)
    expect(replay.saved).toBe(true)
    expect(replay.workspace.projects[0].nodes.map((node) => node.id)).toContain('term-offline-444')
    expect(await fs.readFile(file, 'utf8')).toBe(committed)
  })

  it('adopts a real host append while a local save ack is pending, then reconciles the fresh head', async () => {
    let release!: (value: WorkspaceRevisionOutcome) => void
    let landed!: () => void
    const published = new Promise<void>((resolve) => { landed = resolve })
    const held = { ...api, saveReconciled: async (req: WorkspaceRevisionRequest) => {
      const result = await api.saveReconciled!(req)
      return new Promise<WorkspaceRevisionOutcome>((resolve) => { release = () => resolve(result); landed() })
    } } as WorkspaceApi
    const client = new WorkspaceReconciliationClient(held)
    useProjects.getState().hydrate(await client.load())
    useProjects.getState().renameNode('p1', 'term-p1', 'Local')
    const saving = client.save(current(), current)
    await published
    expect(await store.appendRemoteNode('p1', { id: 'term-phone-222', title: 'Remote' })).toBe(true)
    useProjects.getState().hydrate(await client.refresh(current))
    expect(current().projects[0].nodes.map((node) => node.id)).toContain('term-phone-222')
    release(undefined as never)
    const result = await saving
    expect(result.workspace.projects[0].nodes.map((node) => node.id)).toEqual(['term-p1', 'term-phone-222'])
    expect(result.workspace.projects[0].nodes[0].title).toBe('Local')
    expect(client.conflicts.size).toBe(0)
  })

  it('keeps field conflicts through tab switches and another project save, adopts additions, resolves and reopens', async () => {
    const client = new WorkspaceReconciliationClient(api)
    useProjects.getState().hydrate(await client.load())
    useProjects.getState().renameNode('p1', 'term-p1', 'Local title')
    const other = await store.loadReconciled(), external = structuredClone(other.workspace)
    external.projects[0].nodes[0].title = 'Incoming title'
    expect((await store.saveReconciled(request(other, external, 'other'))).projects.p1.kind).toBe('committed')
    expect(await store.appendRemoteNode('p1', { id: 'term-phone-333' })).toBe(true)
    useProjects.getState().hydrate(await client.refresh(current))
    expect(client.conflicts.get('p1')).toMatchObject([{ path: ['nodes', 'term-p1', 'title'] }])
    useProjects.getState().setActive('p2'); useProjects.getState().renameProject('p2', 'Background edit')
    const partial = await client.save(current(), current)
    expect(partial.saved).toBe(false); useProjects.getState().hydrate(partial.workspace)
    expect(JSON.parse(await fs.readFile(path.join(dir, 'two', '.nodeterm', 'project.json'), 'utf8')).name).toBe('Background edit')
    useProjects.getState().setActive('p1')
    expect(client.conflicts.has('p1')).toBe(true)
    useProjects.getState().hydrate(client.resolve(current(), 'p1', client.conflicts.get('p1')![0], 'local'))
    const saved = await client.save(current(), current)
    expect(saved.saved).toBe(true)
    const reopened = (await new WorkspaceStore().loadReconciled()).workspace.projects[0]
    expect(reopened.nodes[0].title).toBe('Local title')
    expect(reopened.nodes.map((node) => node.id)).toContain('term-phone-333')
  })

  it('refuses legacy IPC and unenrolled clients, keeping proposals and all existing bytes', async () => {
    const view = await store.loadReconciled(), before = await fs.readFile(file, 'utf8')
    await expect(fake.handlers[IPC.workspaceSave](view.workspace)).rejects.toThrow('E_EXPECTED_REVISION_REQUIRED')
    await expect(new WorkspaceStore().save(view.workspace)).rejects.toThrow('E_EXPECTED_REVISION_REQUIRED')
    const result = await store.saveReconciled({ ...request(view, view.workspace), clientId: '00000000-0000-0000-0000-000000000000' })
    expect(result.projects.p1.kind).toBe('stale-base')
    expect(await fs.readFile(result.projects.p1.recovery, 'utf8')).toContain('term-p1')
    expect(await fs.readFile(file, 'utf8')).toBe(before)
  })

  it('retains deletion across stale reconnect and prevents a raw replay from creating live cards', async () => {
    const stale = await store.loadReconciled()
    expect(await store.removeRemoteNode('term-p1')).toBe(true)
    const result = await store.saveReconciled(request(stale, stale.workspace, 'stale-delete'))
    expect(result.projects.p1.kind).toBe('conflict')
    const coordinator = new ProjectCommitStore(file)
    await fs.writeFile(file, (await coordinator.known(stale.projects.p1.revision))!)
    const reopened = await new WorkspaceStore().loadReconciled()
    expect(reopened.unsupported).toContain('p1')
    expect(reopened.workspace.projects[0].nodes).toEqual([])
  })

  it('offers only deletion resolution for a tombstoned identity even when the stale renderer edited it', async () => {
    const client = new WorkspaceReconciliationClient(api)
    useProjects.getState().hydrate(await client.load())
    useProjects.getState().renameNode('p1', 'term-p1', 'Unsaved stale edit')
    expect(await store.removeRemoteNode('term-p1')).toBe(true)
    const result = await client.save(current(), current)
    expect(result.saved).toBe(false); useProjects.getState().hydrate(result.workspace)
    const deletion = client.conflicts.get('p1')!.find((field) => field.kind === 'deleted-node')!
    expect(deletion).toBeDefined()
    useProjects.getState().hydrate(client.resolve(current(), 'p1', deletion, 'local'))
    expect((await client.save(current(), current)).saved).toBe(true)
    expect(JSON.parse(await fs.readFile(file, 'utf8')).nodes).toEqual([])
  })

  it('does not roll an acknowledged base backward when an earlier load response arrives late', async () => {
    let release!: () => void, observed!: () => void, hold = false
    const reading = new Promise<void>((resolve) => { observed = resolve })
    const wrapped = { ...api, loadReconciled: async (id?: string) => {
      const result = await api.loadReconciled!(id)
      if (hold) { hold = false; await new Promise<void>((resolve) => { release = resolve; observed() }) }
      return result
    } } as WorkspaceApi
    const client = new WorkspaceReconciliationClient(wrapped)
    useProjects.getState().hydrate(await client.load())
    hold = true
    const refresh = client.refresh(current)
    await reading
    useProjects.getState().renameNode('p1', 'term-p1', 'Acknowledged newer edit')
    const saved = await client.save(current(), current)
    expect(saved.saved).toBe(true); useProjects.getState().hydrate(saved.workspace)
    release()
    const late = await refresh
    expect(late.projects[0].nodes[0].title).toBe('Acknowledged newer edit')
    expect(client.conflicts.size).toBe(0)
  })
})
