import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { WorkspaceStore } from '../../src/core/workspace-store'
import { fakePlatform } from '../../src/core/platform-fake'
import { initPlatform, resetPlatformForTests } from '../../src/core/platform'
import { ProjectCommitStore } from '../../src/core/project-commit-store'
import { WorkspaceReconciliationClient } from '../../src/renderer/state/workspaceReconciliation'
import { buildRealApi, type RpcClient } from '../../src/renderer/bridge/ws-bridge'
import type { Project, WorkspaceApi } from '../../src/shared/types'
import type { WorkspaceRevisionRequest, WorkspaceRevisionView } from '../../src/shared/workspace-reconciliation'

let dir: string, index: string, store: WorkspaceStore, api: WorkspaceApi
const inline = (id = 'first-project'): Project => ({ id, name: id, color: '#fff',
  viewport: { x: 0, y: 0, zoom: 1 }, nodes: [] })
const input = (view: WorkspaceRevisionView, id = 'first-project'): WorkspaceRevisionRequest => ({
  clientId: view.clientId, operationId: 'first-save', indexRevision: '', expected: {},
  bootstrap: view.bootstrap, createInline: [id], workspace: { version: 2, activeProjectId: id, projects: [inline(id)] }
})
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-workspace-bootstrap-')); index = path.join(dir, 'workspace.json')
  const fake = fakePlatform({ userDataDir: dir }); initPlatform(fake)
  store = new WorkspaceStore(); store.registerIpc()
  api = buildRealApi({ request: async (channel: string, ...args: unknown[]) =>
    JSON.parse(JSON.stringify(await fake.handlers[channel](...JSON.parse(JSON.stringify(args))))) } as RpcClient).workspace
})
afterEach(async () => {
  vi.restoreAllMocks(); resetPlatformForTests()
  const evidence = process.env.NODETERM_RECONCILIATION_EVIDENCE_DIR
  if (evidence) { await fs.mkdir(evidence, { recursive: true }); await fs.cp(dir, path.join(evidence, path.basename(dir)), { recursive: true, errorOnExist: true, force: false }) }
  await fs.rm(dir, { recursive: true, force: true })
})

it('initial registered read publishes nothing; ordinary client creates the first inline project explicitly', async () => {
  await fs.writeFile(path.join(dir, 'settings.json'), '{}')
  await fs.writeFile(path.join(dir, 'auth.json'), '{}')
  const client = new WorkspaceReconciliationClient(api), workspace = await client.load()
  await expect(fs.lstat(index)).rejects.toMatchObject({ code: 'ENOENT' })
  workspace.projects.push(inline()); workspace.activeProjectId = 'first-project'
  const result = await client.save(workspace, () => workspace)
  expect(result.saved).toBe(true)
  expect(JSON.parse(await fs.readFile(index, 'utf8')).entries).toEqual([expect.objectContaining({ id: 'first-project', dataFile: true })])
  expect(JSON.parse(await fs.readFile(path.join(dir, 'inline-projects', 'first-project.json'), 'utf8')).id).toBe('first-project')
  const reopened = await new WorkspaceReconciliationClient(api).load()
  expect(reopened.projects.map((p) => p.id)).toEqual(['first-project'])
})

it('does not turn an ordinary missing index base into creation authority', async () => {
  const view = await api.loadReconciled!(), request = input(view)
  delete request.bootstrap
  expect((await api.saveReconciled!(request)).index.kind).toBe('publication-refused')
  await expect(fs.lstat(index)).rejects.toMatchObject({ code: 'ENOENT' })
  expect((await new WorkspaceStore().loadReconciled()).bootstrap).toBeUndefined()
})

it.each(['workspace.v2.bak', 'workspace.json.corrupt-1', 'workspace.json.tmp', 'inline-projects', 'reconciliation-refusals', '.recovery'])
('does not enroll prior workspace evidence: %s', async (name) => {
  await fs.mkdir(path.join(dir, name))
  expect((await api.loadReconciled!()).bootstrap).toBeUndefined()
  await expect(fs.lstat(index)).rejects.toMatchObject({ code: 'ENOENT' })
  expect((await fs.lstat(path.join(dir, name))).isDirectory()).toBe(true)
})

it('does not enroll a managed missing index or unresolved old client', async () => {
  await fs.mkdir(path.join(new ProjectCommitStore(index).recovery, 'writer.lock'), { recursive: true })
  await expect(api.loadReconciled!()).rejects.toMatchObject({ code: 'E_PUBLICATION_BUSY' })
})

it('rechecks disk eligibility, not the mutable load cache, immediately before publication', async () => {
  const request = input(await api.loadReconciled!())
  const bootstrap = ProjectCommitStore.prototype.bootstrapIndex
  vi.spyOn(ProjectCommitStore.prototype, 'bootstrapIndex').mockImplementation(function (value, scope) {
    const target = new ProjectCommitStore(this.file, async (phase) => {
      if (phase === 'before-publish') await fs.writeFile(path.join(dir, 'workspace.v2.bak'), 'retained evidence')
    }, new Set(['entries']))
    return bootstrap.call(target, value, scope)
  })
  const result = await api.saveReconciled!(request)
  expect(result.bootstrap?.kind).toBe('publication-refused'); expect(result.index.kind).toBe('stale-base')
  expect(result.projects).toEqual({})
  await expect(fs.lstat(index)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await fs.readFile(path.join(dir, 'workspace.v2.bak'), 'utf8')).toBe('retained evidence')
  expect((await api.saveReconciled!(request)).bootstrap?.kind).toBe('publication-refused')
})

it('two separately enrolled stores share no bootstrap grant and cannot replace the winner', async () => {
  const a = input(await api.loadReconciled!(), 'winner'), other = new WorkspaceStore()
  const b = input(await other.loadReconciled(), 'loser')
  expect(a.bootstrap).toBeDefined(); expect(b.bootstrap).toBeDefined(); expect(a.bootstrap).not.toEqual(b.bootstrap)
  const first = await api.saveReconciled!(a), winning = await fs.readFile(index, 'utf8')
  expect(first.bootstrap?.kind).toBe('committed'); expect(first.index.kind).toBe('committed')
  expect((await other.saveReconciled(b)).bootstrap?.kind).toBe('publication-refused')
  expect(await fs.readFile(index, 'utf8')).toBe(winning)
  await expect(fs.lstat(path.join(dir, 'inline-projects', 'loser.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it.each(['token', 'folder', 'batch', 'empty', 'revision'])('refuses unsupported bootstrap input %s without publishing', async (kind) => {
  const request = input(await api.loadReconciled!())
  if (kind === 'token') request.bootstrap!.token = '0'.repeat(64)
  if (kind === 'folder') request.workspace.projects[0].cwd = dir
  if (kind === 'batch') { request.workspace.projects.push(inline('second')); request.createInline!.push('second') }
  if (kind === 'empty') { request.workspace.projects = []; request.createInline = [] }
  if (kind === 'revision') request.indexRevision = '0'.repeat(64)
  expect((await api.saveReconciled!(request)).index.kind).toBe('publication-refused')
  await expect(fs.lstat(index)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('binds the whole bootstrap intent through store reopen and refuses changed project ID or payload', async () => {
  const view = await api.loadReconciled!(), request = input(view)
  expect((await api.saveReconciled!(request)).index.kind).toBe('committed')
  const reopened = new WorkspaceStore(), winning = await fs.readFile(index, 'utf8')
  const changed = input(view, 'changed-id')
  expect((await reopened.saveReconciled(changed)).bootstrap?.kind).toBe('stale-base')
  changed.workspace = structuredClone(request.workspace); changed.createInline = request.createInline
  changed.workspace.projects[0].name = 'changed payload'
  expect((await reopened.saveReconciled(changed)).bootstrap?.kind).toBe('stale-base')
  expect((await reopened.saveReconciled(request)).index.kind).toBe('already-applied')
  expect(await fs.readFile(index, 'utf8')).toBe(winning)
  await expect(fs.lstat(path.join(dir, 'inline-projects', 'changed-id.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('retains separate bootstrap and child outcomes without claiming saved when an interposed child wins', async () => {
  const request = input(await api.loadReconciled!()), create = ProjectCommitStore.prototype.create
  const file = path.join(dir, 'inline-projects', 'first-project.json')
  vi.spyOn(ProjectCommitStore.prototype, 'create').mockImplementation(async function (value, scope) {
    await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, 'external retained bytes')
    return create.call(this, value, scope)
  })
  const result = await api.saveReconciled!(request)
  expect(result.bootstrap?.kind).toBe('committed'); expect(result.projects['first-project'].kind).toBe('publication-refused')
  expect(result.index.kind).toBe('stale-base'); expect(JSON.parse(await fs.readFile(index, 'utf8')).entries).toEqual([])
  expect(await fs.readFile(file, 'utf8')).toBe('external retained bytes')
  expect((await new WorkspaceStore().saveReconciled(request)).bootstrap?.kind).toBe('already-applied')
})

it('retains exact pending bootstrap through partial index, late edits, refresh/tab change, and store reopen', async () => {
  const client = new WorkspaceReconciliationClient(api)
  let workspace = await client.load(); workspace.projects.push(inline()); workspace.activeProjectId = 'first-project'
  const lock = path.join(new ProjectCommitStore(index).recovery, 'writer.lock'), create = ProjectCommitStore.prototype.create
  let inserted = false
  vi.spyOn(ProjectCommitStore.prototype, 'create').mockImplementation(async function (value, scope) {
    const result = await create.call(this, value, scope)
    if (!inserted && result.kind === 'committed') { inserted = true; await fs.mkdir(lock); workspace.projects[0].name = 'Late rename' }
    return result
  })
  const seen: WorkspaceRevisionRequest[] = [], save = api.saveReconciled!.bind(api)
  api.saveReconciled = async (request) => { seen.push(structuredClone(request)); return save(request) }
  const partial = await client.save(workspace, () => workspace)
  expect(partial.saved).toBe(false); workspace = partial.workspace
  expect(workspace.projects[0].name).toBe('Late rename')
  expect(JSON.parse(await fs.readFile(index, 'utf8')).entries).toEqual([])
  const childBytes = await fs.readFile(path.join(dir, 'inline-projects', 'first-project.json'), 'utf8')
  await expect(client.load()).rejects.toThrow('pending save')
  await fs.rmdir(lock) // exact empty lock owned by this fixture
  const freshStore = new WorkspaceStore(); freshStore.registerIpc()
  workspace.activeProjectId = '' // tab/navigation state cannot replace the pending intent
  workspace = await client.refresh(() => workspace)
  const retry = await client.save(workspace, () => workspace)
  expect(retry.saved).toBe(true); expect(seen[1]).toEqual(seen[0])
  expect(retry.workspace.projects[0].name).toBe('Late rename'); expect(retry.workspace.activeProjectId).toBe('')
  expect(await fs.readFile(path.join(dir, 'inline-projects', 'first-project.json'), 'utf8')).toBe(childBytes)
  workspace = retry.workspace; workspace.activeProjectId = 'first-project'
  expect((await client.save(workspace, () => workspace)).saved).toBe(true)
  expect(seen[2].bootstrap).toBeUndefined()
  expect(JSON.parse(await fs.readFile(path.join(dir, 'inline-projects', 'first-project.json'), 'utf8')).name).toBe('Late rename')
})

it('lost transport ACK retries the exact three-phase request after host reopen', async () => {
  const client = new WorkspaceReconciliationClient(api), workspace = await client.load()
  workspace.projects.push(inline()); workspace.activeProjectId = 'first-project'
  const seen: WorkspaceRevisionRequest[] = [], save = api.saveReconciled!.bind(api)
  api.saveReconciled = async (request) => {
    seen.push(structuredClone(request)); const result = await save(request)
    if (seen.length === 1) throw new Error('lost ACK')
    return result
  }
  await expect(client.save(workspace, () => workspace)).rejects.toThrow('lost ACK')
  const bytes = await fs.readFile(index, 'utf8'); new WorkspaceStore().registerIpc()
  expect((await client.save(workspace, () => workspace)).saved).toBe(true)
  expect(seen[1]).toEqual(seen[0]); expect(await fs.readFile(index, 'utf8')).toBe(bytes)
})

it.each(['removed', 'corrupt', 'redirected', 'oversized', 'old-intent'])('rechecks retained caller enrollment at mutation: %s', async (kind) => {
  const request = input(await api.loadReconciled!()), clientDir = path.join(dir, 'reconciliation-clients', request.clientId)
  const record = path.join(clientDir, (await fs.readdir(clientDir))[0])
  if (kind === 'removed') await fs.unlink(record) // fixture-owned enrollment, simulating loss
  if (kind === 'corrupt') await fs.writeFile(record, '{broken')
  if (kind === 'redirected') { await fs.rename(record, path.join(dir, 'retained-record')); await fs.symlink(path.join(dir, 'retained-record'), record) }
  if (kind === 'oversized') { const fd = await fs.open(record, 'r+'); try { await fd.truncate(32 * 1024 * 1024 + 1) } finally { await fd.close() } }
  if (kind === 'old-intent') await fs.writeFile(path.join(clientDir, 'old.json'), '{"kind":"creation-intent"}')
  const result = await api.saveReconciled!(request)
  expect(result.bootstrap?.kind).toBe('publication-refused'); expect(result.projects).toEqual({})
  await expect(fs.lstat(index)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('retains bounded proof refusal without truncating caller history', async () => {
  const request = input(await api.loadReconciled!()), clientDir = path.join(dir, 'reconciliation-clients', request.clientId)
  const raw = await fs.readFile(path.join(clientDir, (await fs.readdir(clientDir))[0]), 'utf8')
  for (let offset = 0; offset < 4096; offset += 64)
    await Promise.all(Array.from({ length: 64 }, (_, n) => fs.writeFile(path.join(clientDir, `retained-${offset + n}.json`), raw)))
  expect((await api.saveReconciled!(request)).bootstrap?.kind).toBe('publication-refused')
  expect(await fs.readdir(clientDir)).toHaveLength(4097)
  await expect(fs.lstat(index)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('caps actual descriptor bytes when enrollment grows after the size check', async () => {
  const request = input(await api.loadReconciled!()), clientDir = path.join(dir, 'reconciliation-clients', request.clientId)
  const record = path.join(clientDir, (await fs.readdir(clientDir))[0]), open = fs.open.bind(fs)
  let grew = false, actualRead = 0
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    const handle = await open(...args)
    if (args[0] === record) {
      const read = handle.read.bind(handle)
      vi.spyOn(handle, 'read').mockImplementation(async (...readArgs: any[]) => {
        if (!grew) { grew = true; await fs.truncate(record, 32 * 1024 * 1024 + 1) }
        const result = await (read as any)(...readArgs); actualRead += result.bytesRead; return result
      })
    }
    return handle
  })
  const result = await api.saveReconciled!(request)
  expect(grew).toBe(true); expect(actualRead).toBeGreaterThan(0)
  expect(actualRead).toBeLessThanOrEqual(32 * 1024 * 1024 + 1)
  expect(result.bootstrap?.kind).toBe('publication-refused'); expect(result.bootstrap?.message).toContain('exceeds 32 MiB during read')
  expect((await fs.stat(record)).size).toBe(32 * 1024 * 1024 + 1)
  await expect(fs.lstat(index)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('an unknown bootstrap receipt retains pending identity and never launches child publication', async () => {
  const client = new WorkspaceReconciliationClient(api)
  let workspace = await client.load(); workspace.projects.push(inline()); workspace.activeProjectId = 'first-project'
  const bootstrap = ProjectCommitStore.prototype.bootstrapIndex
  vi.spyOn(ProjectCommitStore.prototype, 'bootstrapIndex').mockImplementation(function (value, scope) {
    return bootstrap.call(new ProjectCommitStore(this.file, async (phase) => {
      if (phase === 'published') throw new Error('lost bootstrap receipt')
    }, new Set(['entries'])), value, scope)
  })
  const seen: WorkspaceRevisionRequest[] = [], save = api.saveReconciled!.bind(api)
  api.saveReconciled = async (request) => { seen.push(structuredClone(request)); return save(request) }
  const partial = await client.save(workspace, () => workspace)
  expect(partial.saved).toBe(false); workspace = partial.workspace
  const bytes = await fs.readFile(index, 'utf8')
  workspace.projects[0].name = 'edit after unknown'; new WorkspaceStore().registerIpc()
  expect((await client.save(workspace, () => workspace)).saved).toBe(false)
  expect(seen[1]).toEqual(seen[0]); expect(await fs.readFile(index, 'utf8')).toBe(bytes)
  await expect(fs.lstat(path.join(dir, 'inline-projects'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('a read started before save cannot replace the current receipt or late edits', async () => {
  const client = new WorkspaceReconciliationClient(api)
  let workspace = await client.load(); workspace.projects.push(inline()); workspace.activeProjectId = 'first-project'
  const load = api.loadReconciled!.bind(api)
  let reached!: () => void, release!: () => void
  const paused = new Promise<void>((resolve) => { reached = resolve }), held = new Promise<void>((resolve) => { release = resolve })
  let once = true
  api.loadReconciled = async (id) => {
    const result = await load(id)
    if (once) { once = false; reached(); await held }
    return result
  }
  const reading = client.refresh(() => workspace)
  await paused
  try {
    const saved = await client.save(workspace, () => workspace)
    expect(saved.saved).toBe(true); workspace = saved.workspace; workspace.projects[0].name = 'late local edit'
  } finally { release() }
  workspace = await reading
  expect(workspace.projects[0].name).toBe('late local edit')
  expect((await client.save(workspace, () => workspace)).saved).toBe(true)
  expect(JSON.parse(await fs.readFile(path.join(dir, 'inline-projects', 'first-project.json'), 'utf8')).name).toBe('late local edit')
})
