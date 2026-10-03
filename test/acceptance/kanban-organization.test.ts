import http from 'node:http'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import * as atomic from '../../src/core/fs-atomic'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { initPlatform, resetPlatformForTests } from '../../src/core/platform'
import { fakePlatform } from '../../src/core/platform-fake'
import { WorkspaceStore } from '../../src/core/workspace-store'
import { BoardLogStore } from '../../src/core/board-log'
import { nodePlacement } from '../../src/core/kanban-organization'
import { ServerNodeOps } from '../../src/server/node-ops'
import { createOpsApiHandler } from '../../src/server/ops-api'
import { createPersistentHeadlessNodeOwnership } from '../../src/server/node-ownership-store'
import { OrganizationJournal, ORGANIZATION_AUDIT_LIMIT } from '../../src/server/organization-journal'
import { WorkspaceMutationQueue } from '../../src/server/workspace-mutation-queue'
import { IPC } from '../../src/shared/ipc'
import type { CanvasNodeState, Project, Workspace, WorkspaceSaveAck } from '../../src/shared/types'
import { parseOrganizationMetadata, parseOrganizationPolicy } from '../../src/shared/kanban-organization'
import { assignNode, renameColumn, deleteColumn } from '../../src/renderer/lib/kanban'
import { duplicateNode, flowToNodeStates, nodeStatesToFlow } from '../../src/renderer/state/workspace'
import { useProjects } from '../../src/renderer/state/projects'
import { resolveWorkspaceConflict, saveWorkspace } from '../../src/renderer/lib/workspacePersistence'
import { mergeOrganizationProject } from '../../src/renderer/lib/workspacePersistence'
import { toKanbanSession } from '../../src/renderer/canvas/toKanbanSession'

const metadata = (functionalRole = 'ops') => ({ owner: 'Test assistant', projectId: 'p1', workstream: 'ics', functionalRole })
const human: CanvasNodeState = { id: 'human', kind: 'terminal', title: 'Manual card', role: 'primary',
  color: '#fff', group: null, position: { x: 30, y: 70 }, size: { width: 640, height: 440 } }
let root: string, data: string, cwd: string, base: string
let server: http.Server, store: WorkspaceStore, ops: ServerNodeOps
let fake: ReturnType<typeof fakePlatform>
let ownership: ReturnType<typeof createPersistentHeadlessNodeOwnership>
let journal: OrganizationJournal
let createSession: ReturnType<typeof vi.fn>, sendText: ReturnType<typeof vi.fn>, destroy: ReturnType<typeof vi.fn>
let queue: WorkspaceMutationQueue
let published: Project[]
let pendingRequests: Set<Promise<void>>
const token = 'disposable-test-token-000000000000'
const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }

function service() {
  store = new WorkspaceStore()
  store.clientMutationRunner = (work) => queue.run(work)
  store.registerIpc()
  ownership = createPersistentHeadlessNodeOwnership(path.join(data, 'node-ownership.json'))
  journal = new OrganizationJournal(path.join(data, 'kanban-organization.json'))
  const log = new BoardLogStore({})
  ops = new ServerNodeOps({ workspaceStore: store, mutationQueue: queue,
    ownerOf: (id) => ownership.ownerOf(id), recordOwnership: (id, owner) => ownership.record(id, owner),
    flushOwnership: () => ownership.flush(), organizationJournal: journal,
    appendBoardLog: (_id, entry) => log.appendOnce(cwd, entry),
    publishProject: (project) => published.push(structuredClone(project)),
    createSession, sendText, destroySession: destroy, sessionPresence: async () => 'unknown', statusOf: () => undefined })
}
const rpcSave = (ws: Workspace, client = 1): Promise<WorkspaceSaveAck> =>
  fake.handlers[IPC.workspaceSave](client, ws) as Promise<WorkspaceSaveAck>
const request = async (route: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') => {
  const response = await fetch(base + route, { method, headers: auth, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: response.status, body: await response.json() as any }
}
const create = async (over: Record<string, unknown> = {}) => request('/opsapi/nodes', {
  projectId: 'p1', organization: metadata(), idempotencyKey: 'create-test-0001', ...over
})
const patch = async (id: string, role = 'security', over: Record<string, unknown> = {}) => {
  const project = (await store.load()).projects[0]
  return request(`/opsapi/nodes/${id}`, { organization: metadata(role), expectedRevision: project.revision, ...over }, 'PATCH')
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-organization-'))
  data = path.join(root, 'data'); cwd = path.join(root, 'project')
  await fs.mkdir(data); await fs.mkdir(cwd)
  fake = fakePlatform({ userDataDir: data }); initPlatform(fake)
  createSession = vi.fn(async () => ({ sessionId: 'private-fixture', fresh: true }))
  sendText = vi.fn(async () => true); destroy = vi.fn(async () => {})
  queue = new WorkspaceMutationQueue(); service()
  published = []
  const project: Project = { id: 'p1', name: 'Test project', cwd, color: '#fff', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [human],
    kanban: { columns: [{ id: 'col-a', title: 'Ops', color: '#fff' }, { id: 'col-b', title: 'Security', color: '#000' }], assignments: [] },
    kanbanOrganization: { version: 1, projectId: 'p1', roles: { ops: 'col-a', security: 'col-b' },
      overrides: [{ workstream: 'seo', functionalRole: 'ops', columnId: 'col-b' }] } }
  await store.save({ version: 2, activeProjectId: 'p1', projects: [project, { ...project, id: 'p2', cwd: undefined, name: 'Background', nodes: [] }] })
  const handler = createOpsApiHandler({ token, nodes: () => ops.list(), boards: () => ops.boards(),
    createNode: (input) => ops.create(input), updateNode: (id, input, force) => ops.update(id, input, force),
    previewOrganization: (id, entries) => ops.preview(id, entries), organizationAudit: (id) => ops.audit(id),
    creationReceipt: (key) => ops.creationReceipt(key),
    undoOrganization: (id, receipt, rev) => ops.undoOrganization(id, receipt, rev), retryOrganizationEvents: () => ops.retryOrganizationEvents(),
    remove: (id, force) => ops.remove(id, force), sweep: (dry, force) => ops.sweep(dry, force), adoptOrphans: () => ops.adoptOrphans(),
    health: () => ({ startedAt: 0, uptimeMs: 0, wsClientCount: 0, canvasControlEnabled: false,
      spawnHandler: { state: 'idle', activeCount: 0, queue: [] } as any, deliveryQueueDepths: {}, projects: [] }) })
  pendingRequests = new Set()
  server = http.createServer((q, r) => {
    const pending = handler(q, r)
    pendingRequests.add(pending)
    void pending.finally(() => pendingRequests.delete(pending))
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  // Responses can finish before durable outbox publication; drain the fixture's own handlers
  // before deleting their private files. http.close alone only waits for connections.
  await Promise.allSettled([...pendingRequests])
  await ownership.flush()
  resetPlatformForTests(); await fs.rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 })
})

describe('native organization through HTTP, store and renderer', () => {
  it('preserves exact placement and untouched receipts for same-column metadata updates', async () => {
    const a = await create(), b = await create({ idempotencyKey: 'same-column-card-b' })
    const before = (await store.load()).projects[0]
    const siblingReceipts = (await journal.read()).receipts[b.body.id]
    const result = await patch(a.body.id, 'ops', { organization: { ...metadata(), owner: 'Renamed owner', workstream: 'other' } })
    expect(result.status).toBe(200)
    const after = (await store.load()).projects[0]
    expect(after.kanban!.assignments).toEqual(before.kanban!.assignments)
    expect(after.nodes.find((n) => n.id === a.body.id)?.organization?.metadata.owner).toBe('Renamed owner')
    expect((await journal.read()).receipts[b.body.id]).toEqual(siblingReceipts)
    expect(createSession).toHaveBeenCalledTimes(2); expect(sendText).not.toHaveBeenCalled(); expect(destroy).not.toHaveBeenCalled()
  })

  it('allows untouched automatic siblings after legitimate moves and undo without rewriting their receipts', async () => {
    const a = await create(), b = await create({ idempotencyKey: 'sibling-card-b' })
    const siblingReceipts = (await journal.read()).receipts[b.body.id]
    const moved = await patch(a.body.id)
    expect(moved.status).toBe(200)
    expect((await journal.read()).receipts[b.body.id]).toEqual(siblingReceipts)
    const updated = await patch(b.body.id, 'ops', { organization: { ...metadata(), owner: 'Updated sibling' } })
    expect(updated.status).toBe(200)
    const undone = await request(`/opsapi/nodes/${a.body.id}/organization-undo`, {
      receiptId: moved.body.receiptId, expectedRevision: (await store.load()).projects[0].revision })
    expect(undone.status).toBe(200)
    expect((await patch(b.body.id)).status).toBe(200)
    const ws = await store.load()
    expect(ws.projects[0].kanban?.manualAssignments?.[b.body.id]).not.toBe(true)
    expect(createSession).toHaveBeenCalledTimes(2); expect(destroy).not.toHaveBeenCalled()
    service() // Expected positions survive restart as well as receipt history.
    expect((await patch(b.body.id, 'ops')).status).toBe(200)
  })

  it.each(['manual', 'unmarked', 'duplicate'])('blocks a %s reorder after automatic sibling shifts', async (kind) => {
    const a = await create(), b = await create({ idempotencyKey: 'reorder-card-b' })
    expect((await patch(a.body.id)).status).toBe(200)
    const ws = await store.load(), p = ws.projects[0]
    if (kind === 'manual') p.kanban = assignNode(p.kanban!, b.body.id, 'col-a', null) // Intentional no-op is manual too.
    else if (kind === 'unmarked') p.kanban!.assignments.reverse()
    else p.kanban!.assignments.push({ nodeId: b.body.id, columnId: 'col-a' })
    await rpcSave(ws)
    const before = (await store.load()).projects[0]
    expect((await patch(b.body.id)).status).toBe(409)
    expect((await store.load()).projects[0].kanban).toEqual(before.kanban)
  })

  it('does not launch before actual ownership publication and retries its original reserved ID', async () => {
    const rename = fs.rename.bind(fs)
    const fail = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (to === path.join(data, 'node-ownership.json')) throw Object.assign(new Error('fixture_ledger_full'), { code: 'ENOSPC' })
      await rename(from, to)
    })
    const failed = await create({ cmd: 'fixture command' })
    expect(failed.status).toBe(503); expect(failed.body.id).toBeDefined()
    expect(createSession).not.toHaveBeenCalled(); expect(sendText).not.toHaveBeenCalled(); expect(published).toHaveLength(0)
    await expect(fs.stat(path.join(data, 'node-ownership.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await store.load()).projects[0].nodes).toHaveLength(1)
    fail.mockRestore()
    const retry = await create({ cmd: 'fixture command' })
    expect(retry.status).toBe(201); expect(retry.body.id).toBe(failed.body.id)
    expect(createSession).toHaveBeenCalledTimes(1); expect(sendText).toHaveBeenCalledTimes(1)
    expect(createPersistentHeadlessNodeOwnership(path.join(data, 'node-ownership.json')).ownerOf(retry.body.id)?.assistantCreationId).toBeDefined()
  })

  it('does not reconstruct missing private placement evidence from a historical receipt', async () => {
    const created = await create()
    const state = await journal.read(); delete state.placements; await journal.write(state)
    expect((await patch(created.body.id)).status).toBe(409)
    expect(nodePlacement((await store.load()).projects[0].kanban, created.body.id).columnId).toBe('col-a')
  })

  it('rechecks durable ownership before launching an already persisted partial creation', async () => {
    const write = atomic.writeFileAtomic
    const failure = vi.spyOn(atomic, 'writeFileAtomic').mockImplementation(async (file, ...args) => {
      if (file === path.join(data, 'workspace.json')) throw new Error('fixture_index_full')
      return write(file, ...args)
    })
    const partial = await create()
    expect(partial.status).toBe(503); expect(createSession).not.toHaveBeenCalled()
    failure.mockRestore()
    expect((await store.load()).projects[0].nodes.some((n) => n.id === partial.body.id)).toBe(true)
    vi.spyOn(ownership, 'flush').mockRejectedValueOnce(new Error('fixture_retry_ledger_full'))
    const failed = await create()
    expect(failed.status).toBe(503); expect(failed.body.id).toBe(partial.body.id)
    expect(createSession).not.toHaveBeenCalled(); expect(sendText).not.toHaveBeenCalled()
    expect((await create()).body.id).toBe(partial.body.id)
    expect(createSession).toHaveBeenCalledTimes(1)
  })

  it('blocks new automatic creation during an unacknowledged undo and preserves sibling evidence on recovery', async () => {
    const a = await create(), b = await create({ idempotencyKey: 'pending-undo-card-b' })
    const original = journal.write.bind(journal)
    const failedWrite = vi.spyOn(journal, 'write').mockImplementation(async (state) => {
      if (state.receipts[a.body.id]?.at(-1)?.kind === 'undo' && state.receipts[a.body.id].at(-1)?.committed) throw new Error('fixture_undo_ack_failed')
      await original(state)
    })
    // Use a fresh revision on both the initial request and its recovery.
    const applyUndo = async () => request(`/opsapi/nodes/${a.body.id}/organization-undo`, {
      receiptId: a.body.organization.receiptId, expectedRevision: (await store.load()).projects[0].revision })
    expect((await applyUndo()).status).toBe(503)
    const input = { idempotencyKey: 'pending-undo-card-c' }
    expect(await create(input)).toMatchObject({ status: 503, body: { error: 'organization_write_pending_inspect_audit' } })
    expect(createSession).toHaveBeenCalledTimes(2)
    failedWrite.mockRestore()
    expect((await applyUndo()).status).toBe(200)
    expect((await create(input)).status).toBe(201)
    expect((await patch(b.body.id, 'ops', { organization: { ...metadata(), owner: 'Recovered sibling' } })).status).toBe(200)
    expect(createSession).toHaveBeenCalledTimes(3); expect(destroy).not.toHaveBeenCalled()
  })

  it('refuses cross-project duplicate identity in both preview and update', async () => {
    const created = await create(), ws = await store.load()
    ws.projects[1].nodes.push(structuredClone(ws.projects[0].nodes.find((n) => n.id === created.body.id)!))
    await rpcSave(ws)
    expect((await patch(created.body.id)).status).toBe(409)
    const preview = await request('/opsapi/organization/preview', { projectId: 'p1', entries: [{ nodeId: created.body.id, metadata: metadata('security') }] })
    expect(preview.body.plans[0]).toMatchObject({ action: 'skip', reason: 'missing_or_unknown_origin' })
  })

  it.each(['deleted', 'duplicate'])('preserves an existing assignment with a %s column ID', async (kind) => {
    const created = await create(), ws = await store.load()
    const board = ws.projects[0].kanban!
    if (kind === 'deleted') board.columns = board.columns.filter((c) => c.id !== 'col-a')
    else board.columns.push({ ...board.columns[0], title: 'Ambiguous duplicate' })
    await rpcSave(ws)
    const before = (await store.load()).projects[0].kanban
    expect((await patch(created.body.id)).status).toBe(409)
    expect((await store.load()).projects[0].kanban).toEqual(before)
  })

  it('creates node, exact assignment, provenance and bounded receipt before any external work', async () => {
    createSession.mockImplementationOnce(async ({ persistKey }: { persistKey: string }) => {
      const project = (await new WorkspaceStore().load()).projects[0]
      expect(project.nodes.find((n) => n.id === persistKey)?.organization?.mode).toBe('auto')
      expect(project.kanban?.assignments).toContainEqual({ nodeId: persistKey, columnId: 'col-a' })
      expect((await journal.read()).creations['create-test-0001'].stage).toBe('launch_claimed')
      expect(createPersistentHeadlessNodeOwnership(path.join(data, 'node-ownership.json')).ownerOf(persistKey)?.assistantCreationId).toBeDefined()
      return { sessionId: 'private-fixture', fresh: true }
    })
    const result = await create({ cmd: 'private command stays out of audit' })
    expect(result.status).toBe(201)
    expect(result.body.organization.metadata).toEqual(metadata())
    const project = (await store.load()).projects[0]
    expect(project.nodes[0]).toEqual(human)
    expect(destroy).not.toHaveBeenCalled()
    const raw = await fs.readFile(path.join(data, 'kanban-organization.json'), 'utf8')
    expect(raw).not.toContain('private command')
    expect(raw).not.toContain('position')
    expect((await fs.stat(path.join(data, 'kanban-organization.json'))).mode & 0o777).toBe(process.platform === 'win32' ? 0o666 : 0o600)
  })

  it('deduplicates concurrent requests, restart retries and commands durably', async () => {
    const [a, b] = await Promise.all([create({ cmd: 'echo once' }), create({ cmd: 'echo once' })])
    expect(a.body.id).toBe(b.body.id)
    expect(createSession).toHaveBeenCalledTimes(1); expect(sendText).toHaveBeenCalledTimes(1)
    service()
    const replay = await create({ cmd: 'echo once' })
    expect(replay.status).toBe(201); expect(replay.body.replayed).toBe(true)
    expect(replay.body.id).toBe(a.body.id); expect(createSession).toHaveBeenCalledTimes(1)
    expect((await store.load()).projects[0].nodes).toHaveLength(2)
    expect((await create({ cmd: 'different' })).status).toBe(409)
  })

  it('retains the reserved ID after a complete save failure, then recovers once', async () => {
    const original = store.save.bind(store)
    vi.spyOn(store, 'save').mockRejectedValueOnce(new Error('fixture_disk_full'))
    const failed = await create()
    expect(failed.status).toBe(503); expect(failed.body.id).toBeDefined()
    expect(createSession).not.toHaveBeenCalled()
    vi.mocked(store.save).mockImplementation(original)
    service()
    const recovered = await create()
    expect(recovered.status).toBe(201); expect(recovered.body.id).toBe(failed.body.id)
    expect(createSession).toHaveBeenCalledTimes(1)
  })

  it('does not let a reserved policy retry replace a newer manual configuration', async () => {
    const original = (await store.load()).projects[0]
    const input = { expectedRevision: original.revision, organizationPolicy: { version: 1, projectId: 'p1', roles: { ops: 'col-b' } } }
    vi.spyOn(store, 'save').mockRejectedValueOnce(new Error('fixture_disk_full'))
    const failed = await create(input)
    expect(failed.status).toBe(503)
    const manual = await store.load(); manual.projects[0].kanbanOrganization = { version: 1, projectId: 'p1', roles: { ops: 'col-a', security: 'col-a' } }
    await rpcSave(manual)
    const retry = await create(input)
    expect(retry).toMatchObject({ status: 409, body: { id: failed.body.id, error: 'revision_conflict' } })
    expect((await store.load()).projects[0].kanbanOrganization).toEqual(manual.projects[0].kanbanOrganization)
    expect(createSession).not.toHaveBeenCalled()
  })

  it('canonicalizes JSON object key order while rejecting genuinely changed creation fields', async () => {
    const revision = (await store.load()).projects[0].revision
    const first = await create({ expectedRevision: revision, organizationPolicy: { version: 1, projectId: 'p1', roles: { ops: 'col-a', security: 'col-b' } } })
    const second = await create({ expectedRevision: revision, organizationPolicy: { roles: { security: 'col-b', ops: 'col-a' }, projectId: 'p1', version: 1 } })
    expect(second.status).toBe(201); expect(second.body.id).toBe(first.body.id)
    expect(createSession).toHaveBeenCalledTimes(1)
  })

  it('recovers a project write followed by an index failure without another card', async () => {
    const original = atomic.writeFileAtomic
    const write = vi.spyOn(atomic, 'writeFileAtomic').mockImplementation(async (file, content, options) => {
      if (file === path.join(data, 'workspace.json')) throw new Error('fixture_index_disk_full')
      return original(file, content, options)
    })
    const failed = await create()
    expect(failed.status).toBe(503); expect(createSession).not.toHaveBeenCalled()
    expect(JSON.parse(await fs.readFile(path.join(cwd, '.nodeterm/project.json'), 'utf8')).nodes).toHaveLength(2)
    write.mockRestore()
    service()
    const recovered = await create()
    expect(recovered.body.id).toBe(failed.body.id); expect(recovered.status).toBe(201)
    expect((await store.load()).projects[0].nodes).toHaveLength(2)
    expect(createSession).toHaveBeenCalledTimes(1)
  })

  it.each(['spawn_failed', 'command_failed'])('never replays a %s launch after restart', async (failure) => {
    if (failure === 'spawn_failed') createSession.mockRejectedValueOnce(new Error('fixture'))
    else sendText.mockResolvedValueOnce(false)
    const failed = await create({ cmd: 'echo once' })
    expect(failed.status).toBe(502)
    service()
    const replay = await create({ cmd: 'echo once' })
    expect(replay.body.id).toBe(failed.body.id); expect(replay.status).toBe(502)
    expect(createSession).toHaveBeenCalledTimes(1)
    expect(sendText).toHaveBeenCalledTimes(failure === 'command_failed' ? 1 : 0)
  })

  it('returns uncertain after a crash-window launch claim, without launching again', async () => {
    const created = await create()
    const state = await journal.read(); state.creations['create-test-0001'].stage = 'launch_claimed'
    await journal.write(state); service()
    const replay = await create()
    expect(replay.status).toBe(409); expect(replay.body.id).toBe(created.body.id)
    expect(replay.body.error).toContain('uncertain'); expect(createSession).toHaveBeenCalledTimes(1)
  })

  it('releases the workspace queue while a launch hangs, and never sends a command after timeout', async () => {
    let finish!: (v: { sessionId: string; fresh: boolean }) => void
    createSession.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve }))
    const task = ops.create({ projectId: 'p1', organization: metadata(), idempotencyKey: 'create-timeout-0001', cmd: 'once' })
    await vi.waitFor(() => expect(createSession).toHaveBeenCalledTimes(1))
    const workspace = await store.load(); workspace.projects[1].name = 'queue stays available'
    await rpcSave(workspace)
    const result = await task
    expect(result).toMatchObject({ ok: false, status: 502, error: 'launch_outcome_uncertain_do_not_repeat' })
    finish({ sessionId: 'late-disposable-fixture', fresh: true })
    await Promise.resolve(); await Promise.resolve()
    expect(sendText).not.toHaveBeenCalled()
    service()
    expect(await ops.create({ projectId: 'p1', organization: metadata(), idempotencyKey: 'create-timeout-0001', cmd: 'once' }))
      .toMatchObject({ ok: false, status: 502, replayed: true })
    expect(createSession).toHaveBeenCalledTimes(1)
  }, 35_000)

  it('fails before publishing or launching when durable ownership cannot be flushed', async () => {
    vi.spyOn(ownership, 'flush').mockRejectedValueOnce(new Error('fixture_ownership_disk_full'))
    const failed = await create()
    expect(failed.status).toBe(503); expect(failed.body.id).toBeDefined()
    expect(createSession).not.toHaveBeenCalled(); expect(published).toHaveLength(0)
    expect((await store.load()).projects[0].nodes).toHaveLength(1)
  })

  it.each(['corrupt', 'deleted'])('fails closed on a %s journal after restart', async (mode) => {
    await create()
    const file = path.join(data, 'kanban-organization.json')
    if (mode === 'corrupt') await fs.writeFile(file, '{wrong')
    else await fs.rm(file)
    service()
    expect((await create()).status).toBe(503); expect(createSession).toHaveBeenCalledTimes(1)
  })

  it('fences a stale browser save before any active or background write', async () => {
    const browser = await store.load()
    browser.projects[0].name = 'unsaved active'
    browser.projects[1].name = 'unsaved background'
    await create()
    await expect(rpcSave(browser)).rejects.toThrow('workspace_conflict')
    const actual = await store.load()
    expect(actual.projects[0].name).toBe('Test project'); expect(actual.projects[1].name).toBe('Background')
    expect(actual.projects[0].nodes).toHaveLength(2)
  })

  it('fences two browsers and retains both manual choices after explicit conflict resolution', async () => {
    const created = await create()
    const a = await store.load(), b = await store.load()
    a.projects[0].kanban = assignNode(a.projects[0].kanban!, created.body.id, null, null)
    b.projects[0].kanban = assignNode(b.projects[0].kanban!, human.id, 'col-b', null)
    await rpcSave(a)
    await expect(rpcSave(b, 2)).rejects.toThrow('workspace_conflict')
    const incoming = await store.load()
    const merged = resolveWorkspaceConflict(b, incoming, true)
    await rpcSave(merged, 2)
    const saved = (await store.load()).projects[0]
    expect(nodePlacement(saved.kanban, created.body.id).columnId).toBeNull()
    expect(nodePlacement(saved.kanban, human.id).columnId).toBe('col-b')
    expect(saved.nodes.find((n) => n.id === created.body.id)?.organization?.mode).toBe('manual')
  })

  it('preserves two independent browser moves of cards that have no organization metadata', async () => {
    const ws = await store.load(); ws.projects[0].nodes.push({ ...human, id: 'human-two' }); await rpcSave(ws)
    const a = await store.load(), b = await store.load()
    // The renderer remembers its loaded board while the user edits it.
    useProjects.getState().hydrate(b)
    useProjects.getState().setProjectKanban('p1', assignNode(b.projects[0].kanban!, 'human-two', 'col-b', null))
    a.projects[0].kanban = assignNode(a.projects[0].kanban!, human.id, 'col-a', null)
    await rpcSave(a)
    await expect(saveWorkspace({ save: (snapshot: Workspace) => rpcSave(snapshot, 2) } as any)).rejects.toThrow('workspace_conflict')
    const resolved = resolveWorkspaceConflict(useProjects.getState().toWorkspace(), await store.load(), true)
    await rpcSave(resolved, 2)
    const saved = (await store.load()).projects[0]
    expect(nodePlacement(saved.kanban, human.id).columnId).toBe('col-a')
    expect(nodePlacement(saved.kanban, 'human-two').columnId).toBe('col-b')
  })

  it('preserves a repeated intentional Ungrouped choice against another browser assignment', async () => {
    const ws = await store.load(); ws.projects[0].kanban = assignNode(ws.projects[0].kanban!, human.id, null, null); await rpcSave(ws)
    const a = await store.load(), b = await store.load()
    useProjects.getState().hydrate(b)
    useProjects.getState().setProjectKanban('p1', assignNode(b.projects[0].kanban!, human.id, null, null))
    a.projects[0].kanban = assignNode(a.projects[0].kanban!, human.id, 'col-a', null); await rpcSave(a)
    const merged = resolveWorkspaceConflict(useProjects.getState().toWorkspace(), await store.load(), true)
    await rpcSave(merged, 2)
    expect(nodePlacement((await store.load()).projects[0].kanban, human.id).columnId).toBeNull()
  })

  it('carries acknowledgment revisions through actual UI store saves, including racing edits', async () => {
    useProjects.getState().hydrate(await store.load())
    const api = { save: (ws: Workspace) => rpcSave(ws) } as any
    useProjects.getState().renameProject('p1', 'first')
    const a = saveWorkspace(api)
    useProjects.getState().renameProject('p2', 'second')
    const b = saveWorkspace(api)
    await Promise.all([a, b])
    const actual = await store.load()
    expect(actual.projects.map((p) => p.name)).toEqual(['first', 'second'])
    expect(useProjects.getState().toWorkspace().revision).toBe(actual.revision)
  })

  it('refuses a missing acknowledgment from an older host without advancing renderer evidence', async () => {
    useProjects.getState().hydrate(await store.load())
    const before = useProjects.getState().revision
    await expect(saveWorkspace({ save: async () => undefined } as any)).rejects.toThrow('workspace_conflict: revision acknowledgment missing')
    expect(useProjects.getState().revision).toBe(before)
  })

  it('merges an ordered organization publication while preserving browser manual and background edits', async () => {
    useProjects.getState().hydrate(await store.load())
    const local = useProjects.getState().getProject('p1')!
    useProjects.getState().setProjectKanban('p1', assignNode(local.kanban!, human.id, 'col-b', null))
    useProjects.getState().renameProject('p2', 'unsaved background edit')
    const created = await create()
    const incoming = published.at(-1)!
    expect(incoming.organizationChange?.before).toBe(useProjects.getState().revision)
    useProjects.getState().replaceProject(mergeOrganizationProject(useProjects.getState().getProject('p1')!, incoming))
    useProjects.getState().acknowledgeOrganizationChange(incoming)
    await saveWorkspace({ save: (ws: Workspace) => rpcSave(ws) } as any)
    const actual = await store.load()
    expect(nodePlacement(actual.projects[0].kanban, created.body.id).columnId).toBe('col-a')
    expect(nodePlacement(actual.projects[0].kanban, human.id).columnId).toBe('col-b')
    expect(actual.projects[1].name).toBe('unsaved background edit')
    expect(await fs.readFile(path.join(data, 'workspace.json'), 'utf8')).not.toContain('organizationChange')
  })

  it.each(['created', 'cross-column'])('merges only %s placement deltas while retaining a local manual front drag', async (change) => {
    const x = await create(), y = await create({ idempotencyKey: 'merge-card-y' })
    const setup = await store.load()
    setup.projects[0].kanban = assignNode(setup.projects[0].kanban!, human.id, 'col-a', null)
    await rpcSave(setup)
    useProjects.getState().hydrate(await store.load())
    const local = useProjects.getState().getProject('p1')!
    expect(local.kanban!.assignments.map((a) => a.nodeId)).toEqual([x.body.id, y.body.id, human.id])
    useProjects.getState().setProjectKanban('p1', assignNode(local.kanban!, human.id, 'col-a', x.body.id))
    if (change === 'cross-column') expect((await patch(x.body.id)).status).toBe(200)
    const z = await create({ idempotencyKey: 'merge-card-z' })
    const incoming = structuredClone(published.at(-1)!)
    incoming.nodes.reverse() // Node iteration must not determine board order.
    useProjects.getState().replaceProject(mergeOrganizationProject(useProjects.getState().getProject('p1')!, incoming))
    if (change === 'created') useProjects.getState().acknowledgeOrganizationChange(incoming)
    else {
      // Missed publications use the existing explicit conflict resolution and fresh evidence.
      const resolved = resolveWorkspaceConflict(useProjects.getState().toWorkspace(), await store.load(), true)
      useProjects.getState().hydrate(resolved)
    }
    await saveWorkspace({ save: (ws: Workspace) => rpcSave(ws) } as any)
    const actual = (await store.load()).projects[0]
    expect(actual.kanban!.assignments.map((a) => a.nodeId)).toEqual(change === 'created'
      ? [human.id, x.body.id, y.body.id, z.body.id] : [human.id, y.body.id, x.body.id, z.body.id])
    expect(nodePlacement(actual.kanban, x.body.id).columnId).toBe(change === 'created' ? 'col-a' : 'col-b')
    expect(actual.kanban!.manualAssignments?.[human.id]).toBe(true)
    expect(actual.nodes.find((n) => n.id === y.body.id)?.organization?.mode).toBe('auto')
  })

  it('does not acknowledge an out-of-order or missed organization publication', async () => {
    useProjects.getState().hydrate(await store.load())
    const before = useProjects.getState().revision
    await create(); await create({ idempotencyKey: 'create-next-0002' })
    const latest = published.at(-1)!
    useProjects.getState().replaceProject(mergeOrganizationProject(useProjects.getState().getProject('p1')!, latest))
    useProjects.getState().acknowledgeOrganizationChange(latest)
    expect(useProjects.getState().revision).toBe(before)
    await expect(saveWorkspace({ save: (ws: Workspace) => rpcSave(ws) } as any)).rejects.toThrow('workspace_conflict')
  })

  it('allows unrelated appended cards and uses a read-only creation receipt after launch', async () => {
    const first = await create(); await create({ idempotencyKey: 'create-next-0002' })
    expect((await patch(first.body.id)).status).toBe(200)
    const receipt = await request('/opsapi/creation-receipts/create-test-0001')
    expect(receipt.body).toMatchObject({ id: first.body.id, stage: 'finished', outcome: 'success' })
    expect(createSession).toHaveBeenCalledTimes(2)
  })

  it('detects same-rev external edits and stale/missing browser evidence', async () => {
    const stale = await store.load()
    const file = path.join(cwd, '.nodeterm', 'project.json')
    const raw = JSON.parse(await fs.readFile(file, 'utf8')); raw.name = 'edited without bumping rev'
    await fs.writeFile(file, JSON.stringify(raw))
    await expect(rpcSave(stale)).rejects.toThrow('workspace_conflict')
    const { revision: _rev, ...missing } = await store.load()
    await expect(rpcSave(missing)).rejects.toThrow('loaded revision required')
    expect((await store.load()).projects[0].name).toBe(raw.name)
  })

  it('never acknowledges newer storage with content read before an external edit during load', async () => {
    const file = path.join(cwd, '.nodeterm/project.json')
    const original = fs.readFile.bind(fs)
    let reads = 0
    const spy = vi.spyOn(fs, 'readFile').mockImplementation((async (...args: Parameters<typeof fs.readFile>) => {
      const value = await original(...args)
      // First read is the pre-load digest, second is the actual project codec's read.
      if (args[0] === file && ++reads === 2) {
        const changed = JSON.parse(String(value)); changed.name = 'external change during load'
        await fs.writeFile(file, JSON.stringify(changed))
      }
      return value
    }) as typeof fs.readFile)
    const snapshot = await store.load({ sideline: false })
    spy.mockRestore()
    expect(snapshot.projects[0].name).toBe('external change during load')
    snapshot.projects[1].name = 'independent edit'
    await rpcSave(snapshot)
    expect((await store.load()).projects[0].name).toBe('external change during load')
  })

  it('does not acknowledge an external edit that races a successful file publication', async () => {
    const snapshot = await store.load(); snapshot.projects[0].name = 'browser edit'
    const original = atomic.writeFileAtomic
    const spy = vi.spyOn(atomic, 'writeFileAtomic').mockImplementation(async (file, content, options) => {
      await original(file, content, options)
      if (file === path.join(data, 'workspace.json')) {
        const projectFile = path.join(cwd, '.nodeterm/project.json')
        const changed = JSON.parse(await fs.readFile(projectFile, 'utf8')); changed.name = 'external after publication'
        await fs.writeFile(projectFile, JSON.stringify(changed))
      }
    })
    await expect(rpcSave(snapshot)).rejects.toThrow('workspace_conflict: project changed during save')
    spy.mockRestore()
    expect((await store.load()).projects[0].name).toBe('external after publication')
  })

  it('preserves geometry, group, CLI and session identity in CAS metadata updates', async () => {
    const created = await create()
    const ws = await store.load(), node = ws.projects[0].nodes[1]
    Object.assign(node, { shell: 'C:\\Windows\\System32\\cmd.exe', cwd: 'C:\\Work\\Project',
      agentSessionId: 'session-test', parentId: undefined, position: { x: 44, y: 91 }, controlSize: 'normal' })
    await rpcSave(ws)
    const before = (await store.load()).projects[0].nodes[1]
    const changed = await patch(created.body.id)
    expect(changed.status).toBe(200)
    const after = (await store.load()).projects[0].nodes[1]
    const { organization: _a, ...beforeFields } = before
    const { organization: _b, ...afterFields } = after
    expect(afterFields).toEqual(beforeFields)
    expect(after.organization?.columnId).toBe('col-b')
    expect(createSession).toHaveBeenCalledTimes(1); expect(destroy).not.toHaveBeenCalled()
    expect((await patch(created.body.id, 'ops', { expectedRevision: ws.projects[0].revision })).status).toBe(409)
  })

  it.each(['pinned', 'manualPlacement', 'primary', 'unknown_owner', 'forged_metadata'])('refuses automatic updates for %s', async (gate) => {
    const created = await create()
    const ws = await store.load(), node = ws.projects[0].nodes[1]
    if (gate === 'primary') node.role = 'primary'
    else if (gate === 'unknown_owner') { ownership.forget(node.id); await ownership.flush() }
    else if (gate === 'forged_metadata') node.organization!.metadata.owner = 'another claimant'
    else (node as any)[gate] = true
    await rpcSave(ws)
    expect((await patch(created.body.id)).status).toBe(409)
    expect(nodePlacement((await store.load()).projects[0].kanban, node.id).columnId).toBe('col-a')
  })

  it.each(['ungrouped', 'order', 'assignment', 'dangling'])('preserves manual %s and assignment drift', async (choice) => {
    const created = await create(), ws = await store.load(), p = ws.projects[0]
    if (choice === 'ungrouped') p.kanban = assignNode(p.kanban!, created.body.id, null, null)
    if (choice === 'order') {
      p.kanban!.assignments.push({ nodeId: human.id, columnId: 'col-a' })
      p.kanban = assignNode(p.kanban!, created.body.id, 'col-a', human.id)
    }
    if (choice === 'assignment') p.kanban!.assignments[0].columnId = 'col-b'
    if (choice === 'dangling') p.kanban!.assignments[0].columnId = 'missing-column'
    await rpcSave(ws)
    const before = (await store.load()).projects[0]
    expect((await patch(created.body.id)).status).toBe(409)
    expect((await store.load()).projects[0].kanban).toEqual(before.kanban)
  })

  it('routes by stable ID after rename, handles exact overrides and missing policy/columns/boards', async () => {
    const ws = await store.load(), p = ws.projects[0]
    p.kanban = renameColumn(p.kanban!, 'col-a', 'New name')
    await rpcSave(ws)
    expect((await create()).body.organization.columnId).toBe('col-a')
    expect((await create({ idempotencyKey: 'create-seo-0002', organization: { ...metadata(), workstream: 'seo' } })).body.organization.columnId).toBe('col-b')
    const missing = await store.load(); missing.projects[0].kanban = deleteColumn(missing.projects[0].kanban!, 'col-a')
    await rpcSave(missing)
    expect((await create({ idempotencyKey: 'create-missing-0003' })).body.organization.columnId).toBeNull()
    const noPolicy = await store.load(); delete noPolicy.projects[0].kanbanOrganization
    await rpcSave(noPolicy)
    expect((await create({ idempotencyKey: 'create-nopolicy-0004' })).body.organization.columnId).toBeNull()
    const noBoard = await store.load(); delete noBoard.projects[0].kanban
    await rpcSave(noBoard)
    expect((await create({ idempotencyKey: 'create-noboard-0005' })).body.organization.columnId).toBeNull()
    expect((await store.load()).projects[0].kanban).toBeUndefined()
  })

  it('round trips metadata through both renderer codecs and strips it from duplicates', async () => {
    const created = await create(), node = (await store.load()).projects[0].nodes[1]
    const flow = nodeStatesToFlow([node])
    expect(flowToNodeStates(flow)[0].organization).toEqual(node.organization)
    expect(toKanbanSession(flow[0])?.organization).toEqual(node.organization)
    expect(duplicateNode(flow[0]).data.organization).toBeUndefined()
    useProjects.getState().hydrate(await store.load())
    useProjects.getState().duplicateNode('p1', created.body.id)
    expect(useProjects.getState().getProject('p1')!.nodes.at(-1)?.organization).toBeUndefined()
  })

  it('imports content without copying organization authority, policy or receipts', async () => {
    await create()
    const imported = await store.probeFolder(cwd)
    expect(imported?.kanbanOrganization).toBeUndefined()
    expect(imported?.nodes.every((n) => !n.organization)).toBe(true)
    expect(imported?.id).not.toBe('p1')
    expect(createSession).toHaveBeenCalledTimes(1)
  })

  it('previews exact allowlists read-only and excludes old operator/claimed owner cards', async () => {
    ownership.record(human.id, { sourceNodeId: 'ops-operator', projectId: 'p1' }); await ownership.flush()
    const created = await create()
    const before = await fs.readFile(path.join(cwd, '.nodeterm/project.json'), 'utf8')
    const preview = await request('/opsapi/organization/preview', { projectId: 'p1', entries: [
      { nodeId: created.body.id, metadata: metadata('security') }, { nodeId: human.id, metadata: metadata() }
    ] })
    expect(preview.body.plans[0].action).toBe('apply'); expect(preview.body.plans[1].action).toBe('skip')
    expect(await fs.readFile(path.join(cwd, '.nodeterm/project.json'), 'utf8')).toBe(before)
    expect((await request('/opsapi/organization/preview', { projectId: 'p1', entries: [], apply: true })).status).toBe(400)
    expect(createSession).toHaveBeenCalledTimes(1); expect(destroy).not.toHaveBeenCalled()
    const boards = await request('/opsapi/boards')
    expect(boards.body.boards[0].columns.map((c: any) => c.id)).toEqual(['col-a', 'col-b'])
  })

  it('undo restores only the affected assignment, preserves unrelated edits and becomes manual', async () => {
    const created = await create(), update = await patch(created.body.id)
    expect(update.status).toBe(200)
    const ws = await store.load(); ws.projects[0].name = 'unrelated edit'; ws.projects[0].nodes[0].title = 'keep title'
    await rpcSave(ws)
    const p = (await store.load()).projects[0]
    const undo = await request(`/opsapi/nodes/${created.body.id}/organization-undo`, { receiptId: update.body.receiptId, expectedRevision: p.revision })
    expect(undo.status).toBe(200)
    const saved = (await store.load()).projects[0]
    expect(saved.name).toBe('unrelated edit'); expect(saved.nodes[0].title).toBe('keep title')
    expect(nodePlacement(saved.kanban, created.body.id).columnId).toBe('col-a')
    expect(saved.nodes[1].organization?.mode).toBe('manual')
    expect((await patch(created.body.id)).status).toBe(409)
    expect((await request(`/opsapi/nodes/${created.body.id}/organization-undo`, { receiptId: update.body.receiptId, expectedRevision: saved.revision })).status).toBe(409)
    expect(createSession).toHaveBeenCalledTimes(1); expect(destroy).not.toHaveBeenCalled()
  })

  it('rejects stale undo and undone placements changed by a user', async () => {
    const created = await create(), before = (await store.load()).projects[0]
    const update = await patch(created.body.id)
    expect((await request(`/opsapi/nodes/${created.body.id}/organization-undo`, { receiptId: update.body.receiptId, expectedRevision: before.revision })).status).toBe(409)
    const ws = await store.load(); ws.projects[0].kanban = assignNode(ws.projects[0].kanban!, created.body.id, null, null); await rpcSave(ws)
    expect((await request(`/opsapi/nodes/${created.body.id}/organization-undo`, { receiptId: update.body.receiptId, expectedRevision: (await store.load()).projects[0].revision })).status).toBe(409)
  })

  it('bounds audit receipts and retries stable board-log events without duplicates', async () => {
    const created = await create()
    for (let i = 0; i < ORGANIZATION_AUDIT_LIMIT + 3; i++) {
      const result = await patch(created.body.id, i % 2 === 0 ? 'security' : 'ops')
      expect(result.status).toBe(200)
    }
    const audit = await request(`/opsapi/nodes/${created.body.id}/organization-audit`)
    expect(audit.body.receipts).toHaveLength(ORGANIZATION_AUDIT_LIMIT)
    const state = await journal.read(); state.receipts[created.body.id].at(-1)!.published = false; await journal.write(state)
    await request('/opsapi/organization/retry-events', {}, 'POST')
    const entries = await new BoardLogStore({}).read(cwd, { all: true })
    expect(new Set(entries.map((e) => e.id)).size).toBe(entries.length)
    expect(entries).toHaveLength(ORGANIZATION_AUDIT_LIMIT + 4)
  })

  it('reports events as still pending when durable board-log publication refuses', async () => {
    const created = await create()
    const state = await journal.read(); state.receipts[created.body.id][0].published = false; await journal.write(state)
    vi.spyOn(BoardLogStore.prototype, 'appendOnce').mockResolvedValue(false)
    const retried = await request('/opsapi/organization/retry-events', {}, 'POST')
    expect(retried.status).toBe(200); expect(retried.body.pending).toBe(1)
    expect((await journal.read()).receipts[created.body.id][0].published).toBe(false)
  })

  it.each(['update', 'undo'])('recovers a persisted %s after receipt acknowledgment failure without another move', async (kind) => {
    const created = await create(), changed = kind === 'undo' ? await patch(created.body.id) : undefined
    const original = journal.write.bind(journal)
    const spy = vi.spyOn(journal, 'write').mockImplementation(async (state) => {
      if (state.receipts[created.body.id]?.at(-1)?.kind === kind && state.receipts[created.body.id].at(-1)?.committed) {
        throw new Error('fixture_receipt_ack_failed')
      }
      await original(state)
    })
    const rev = (await store.load()).projects[0].revision
    const failed = kind === 'update' ? await patch(created.body.id) : await request(`/opsapi/nodes/${created.body.id}/organization-undo`, { receiptId: changed!.body.receiptId, expectedRevision: rev })
    expect(failed.status).toBe(503); expect(failed.body.id).toBe(created.body.id)
    const persisted = (await store.load()).projects[0]
    const raw = await fs.readFile(path.join(cwd, '.nodeterm/project.json'), 'utf8')
    spy.mockRestore(); service()
    const retry = kind === 'update' ? await patch(created.body.id) : await request(`/opsapi/nodes/${created.body.id}/organization-undo`, { receiptId: changed!.body.receiptId, expectedRevision: persisted.revision })
    expect(retry.status).toBe(200)
    expect(await fs.readFile(path.join(cwd, '.nodeterm/project.json'), 'utf8')).toBe(raw)
    expect((await journal.read()).receipts[created.body.id].at(-1)?.committed).toBe(true)
    expect(createSession).toHaveBeenCalledTimes(1); expect(destroy).not.toHaveBeenCalled()
  })

  it('rejects unexpected audit fields instead of exposing arbitrary private content', async () => {
    const created = await create()
    const file = path.join(data, 'kanban-organization.json')
    const state = JSON.parse(await fs.readFile(file, 'utf8'))
    state.receipts[created.body.id][0].transcript = 'private material'
    await fs.writeFile(file, JSON.stringify(state))
    await expect(new OrganizationJournal(file).read()).rejects.toThrow('organization_journal_invalid')
  })

  it('runs the repository client against the disposable HTTP API without automatic retries', async () => {
    const credential = path.join(root, 'credential'), body = path.join(root, 'request.json')
    await fs.writeFile(credential, token, { mode: 0o600 })
    await fs.writeFile(body, JSON.stringify({ projectId: 'p1', organization: metadata(), idempotencyKey: 'helper-create-0001' }))
    const run = (command: string) => promisify(execFile)(process.execPath, [path.resolve('scripts/nodeterm-organization.mjs'), command,
      '--url', base, '--credential-file', credential, ...(command === 'create' ? ['--body-file', body] : [])], { timeout: 10_000 })
    const created = JSON.parse((await run('create')).stdout)
    const replay = JSON.parse((await run('create')).stdout)
    expect(replay.id).toBe(created.id); expect(replay.replayed).toBe(true)
    expect((await run('boards')).stdout).not.toContain(token)
    expect(createSession).toHaveBeenCalledTimes(1)
  })

  it.each([
    { organization: { ...metadata(), authority: true } }, { organization: { ...metadata(), projectId: 'p2' } },
    { organizationPolicy: { version: 1, projectId: 'p1', roles: { ops: 'col-a' }, unknown: true } },
    { idempotencyKey: 'bad' }, { organization: metadata(), role: 'primary' }
  ])('rejects strict schema violations before persistence or launch: %j', async (input) => {
    expect((await create(input)).status).toBe(400)
    expect(createSession).not.toHaveBeenCalled(); expect((await store.load()).projects[0].nodes).toHaveLength(1)
  })

  it('validates hostile policy, prototype keys and exact case without title inference', () => {
    expect(parseOrganizationMetadata({ ...metadata(), owner: 'bad\nowner' })).toBeUndefined()
    expect(parseOrganizationPolicy(JSON.parse('{"version":1,"projectId":"p1","roles":{"__proto__":"col-a"}}'))).toBeUndefined()
    expect(parseOrganizationPolicy({ version: 1, projectId: 'p1', roles: { OPS: 'col-b' } })?.roles).toEqual({ OPS: 'col-b' })
  })
})
