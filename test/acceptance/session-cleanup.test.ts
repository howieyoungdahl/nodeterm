import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SessionCleanup, CLEANUP_IDLE_MS } from '../../src/core/session-cleanup'
import { createOpsApiHandler } from '../../src/server/ops-api'
import { SpawnHandlerState } from '../../src/server/spawn-handler-state'
import { WorkspaceMutationQueue } from '../../src/server/workspace-mutation-queue'
import { nodeStatesToFlow, flowToNodeStates } from '../../src/renderer/state/workspace'
import { buildSessionList, buildStatusList } from '../../src/renderer/lib/sessionList'
import { toKanbanSession } from '../../src/renderer/canvas/toKanbanSession'
import { applyCleanupChanges, planServerChange } from '../../src/renderer/lib/serverChange'
import type { Workspace } from '../../src/shared/types'
const exec = promisify(execFile)
const token = 'synthetic-cleanup-management-bearer-0000000000000000000'
describe('cleanup operator -> persistence -> canvas/sidebar/board -> undo', () => {
  let server: http.Server, dir: string, base: string, workspace: Workspace, service: SessionCleanup
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-cleanup-api-'))
    const disk = path.join(dir, 'workspace.json')
    workspace = { version: 2, activeProjectId: 'p', projects: [{ id: 'p', name: 'P', color: '#888', viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [{ id: 'n', kind: 'terminal', title: 'completed review', color: '#888', group: null, size: { width: 640, height: 440 }, position: { x: 0, y: 0 }, cwd: 'C:\\work\\project' }] }] }
    await fs.writeFile(disk, JSON.stringify(workspace))
    await fs.writeFile(path.join(dir, 'ops-token'), token, { mode: 0o600 })
    const queue = new WorkspaceMutationQueue()
    const activityAt = Date.now() - CLEANUP_IDLE_MS - 60_000
    service = new SessionCleanup({ dataDir: dir, load: async () => JSON.parse(await fs.readFile(disk, 'utf8')),
      save: async w => { workspace = w; await fs.writeFile(disk, JSON.stringify(w)) }, exclusive: w => queue.run(w),
      probe: async () => ({ generation: 'boot:original-session', activityAt,
        state: 'completed', workChildren: 0, pending: false, fingerprint: 'unchanged', reason: 'fixture-completed' }) })
    const handler = createOpsApiHandler({ token, cleanup: service, nodes: async () => [], sweep: async dryRun => ({ dryRun, affectedIds: [], scanned: 0 }),
      remove: async () => { throw new Error('destructive route must never be used') }, adoptOrphans: async () => ({ adopted: [], skipped: [], live: false }),
      createNode: async () => { throw new Error('spawn forbidden') }, updateNode: async () => { throw new Error('legacy mutation forbidden') },
      health: () => ({ startedAt: 0, uptimeMs: 0, wsClientCount: 0, canvasControlEnabled: false, spawnHandler: new SpawnHandlerState().snapshot(), deliveryQueueDepths: {}, projects: [] }) })
    server = http.createServer((req, res) => void handler(req, res))
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as {port:number}).port}`
  })
  afterEach(async () => { await new Promise<void>(r => server.close(() => r())); await fs.rm(dir, {recursive:true,force:true}) })
  async function call(route: string, body?: unknown, auth = true) {
    return fetch(base + '/opsapi/cleanup/' + route, { method: body ? 'POST' : 'GET',
      headers: { ...(auth ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  }
  it('archives and restores the same identity across all three projections and JSON serialization', async () => {
    const before = structuredClone(workspace)
    let live = nodeStatesToFlow(structuredClone(before.projects[0].nodes))
    live[0].position.x = 200 // A browser edit still inside its autosave debounce.
    const preview = await (await call('preview')).json()
    const archive = await call('archive', { planId: preview.plan.id, nodeIds: ['n'] })
    expect(archive.status).toBe(200)
    const receipt = (await archive.json()).receipt
    const project = workspace.projects[0]
    const merge = (baseline: Workspace['projects'][number], incoming: Workspace['projects'][number]) =>
      applyCleanupChanges(live, planServerChange({ base: baseline, incoming, liveNodeIds: live.map(n=>n.id), liveRopes:[], liveBridges:[] }).cleanupChanges)
    live = merge(before.projects[0], project)
    expect(live[0].hidden).toBe(true)
    expect(live[0].position.x).toBe(200)
    expect(flowToNodeStates(live)[0].cleanupArchiveId).toBe(receipt.id)
    const flow = nodeStatesToFlow(project.nodes)
    expect(flow[0].hidden).toBe(true); expect(toKanbanSession(flow[0])).toBeNull()
    expect(flowToNodeStates(flow)[0].cleanupArchiveId).toBe(receipt.id)
    expect(buildSessionList([project], null, 'p', {}, '').flatMap(g => g.ungrouped)).toEqual([])
    expect(buildStatusList([project], null, 'p', {}, '').flatMap(g => g.rows)).toEqual([])
    expect((await call('undo', { receiptId: receipt.id })).status).toBe(200)
    expect(workspace).toEqual(before)
    live = merge(project, workspace.projects[0])
    expect(live[0].hidden).toBe(false)
    expect(live[0].position.x).toBe(200)
    const restored = nodeStatesToFlow(workspace.projects[0].nodes)
    expect(restored[0].hidden).toBe(false); expect(toKanbanSession(restored[0])?.id).toBe('n')
  })
  it('requires management auth and rejects bulk force and empty allowlists', async () => {
    expect((await call('preview', undefined, false)).status).toBe(401)
    const preview = await (await call('preview')).json()
    expect((await call('archive', { planId: preview.plan.id, nodeIds: [], force: true })).status).toBe(400)
    expect(workspace.projects[0].nodes[0].cleanupArchiveId).toBeUndefined()
    expect((await call('receipts')).status).toBe(200)
  })
  it('the real CLI previews, applies an exact request file and undoes, with credentials off argv', async () => {
    const common = [path.resolve('scripts/nodeterm-cleanup.mjs'), '--url', base, '--credential-file', path.join(dir, 'ops-token')]
    const run = async (command: string, extra: string[] = []) => JSON.parse((await exec(process.execPath, [common[0], command, ...common.slice(1), ...extra])).stdout)
    const preview = await run('preview')
    const request = path.join(dir, 'request.json')
    await fs.writeFile(request, JSON.stringify({ planId: preview.plan.id, nodeIds: ['n'] }))
    const applied = await run('archive', ['--request-file', request])
    expect(applied.receipt.state).toBe('applied')
    expect((await run('receipts')).receiptIds).toContain(applied.receipt.id)
    expect((await run('undo', ['--receipt-id', applied.receipt.id])).receipt.state).toBe('undone')
  })
  it('CLI refuses existing output packets and invalid options before any mutation', async () => {
    const script = path.resolve('scripts/nodeterm-cleanup.mjs')
    const preview = await (await call('preview')).json()
    const request = path.join(dir,'request.json'), output = path.join(dir,'review-packet.json')
    await fs.writeFile(request,JSON.stringify({planId:preview.plan.id,nodeIds:['n']}))
    await fs.writeFile(output,'existing evidence')
    const args = [script,'archive','--url',base,'--credential-file',path.join(dir,'ops-token'),'--request-file',request]
    await expect(exec(process.execPath,[...args,'--output',output])).rejects.toMatchObject({stderr:expect.stringContaining('EEXIST')})
    expect(workspace.projects[0].nodes[0].cleanupArchiveId).toBeUndefined()
    expect(await fs.readFile(output,'utf8')).toBe('existing evidence')
    await expect(exec(process.execPath,[...args,'--force','true'])).rejects.toMatchObject({stderr:expect.stringContaining('invalid_arguments')})
    await expect(exec(process.execPath,[script,'preview','--url','http://example.com','--credential-file',path.join(dir,'ops-token')])).rejects.toMatchObject({stderr:expect.stringContaining('loopback_url_required')})
  })
  it.skipIf(process.platform === 'win32')('rejects a Windows or mixed host path instead of prefixing it with a Linux cwd', async () => {
    await expect(exec(process.execPath, [path.resolve('scripts/nodeterm-cleanup.mjs'), 'preview', '--credential-file', 'C:\\Users\\example\\ops-token'])).rejects.toMatchObject({ stderr: expect.stringContaining('absolute_local_path_required') })
    await expect(exec(process.execPath, [path.resolve('scripts/nodeterm-cleanup.mjs'), 'preview', '--credential-file', '/tmp/workspace/C:\\Users\\example\\ops-token'])).rejects.toMatchObject({ stderr: expect.stringContaining('absolute_local_path_required') })
  })
})
