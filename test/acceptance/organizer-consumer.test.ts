import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { WorkspaceStore } from '../../src/core/workspace-store'
import { ProjectCommitStore } from '../../src/core/project-commit-store'
import { fakePlatform } from '../../src/core/platform-fake'
import { initPlatform, resetPlatformForTests } from '../../src/core/platform'
import { registerCanvasLayoutIpc } from '../../src/core/canvas-layout/service'
import { LayoutLeaseStore } from '../../src/core/canvas-layout/lease'
import type { OrganizerEvidence, OrganizerRuntime } from '../../src/core/canvas-layout/coordinator'
import { buildAgentApi, buildRealApi, type RpcClient } from '../../src/renderer/bridge/ws-bridge'
import { WorkspaceReconciliationClient } from '../../src/renderer/state/workspaceReconciliation'
import { applyLayoutPlan, layoutPlanRequest } from '../../src/renderer/lib/layoutPlanApply'
import { flowToNodeStates, nodeStatesToFlow } from '../../src/renderer/state/workspace'
import { IPC } from '../../src/shared/ipc'
import type { LayoutCommitRequest, LayoutPlan } from '../../src/shared/canvas-layout'
import type { NodeTerminalApi, Project, Workspace } from '../../src/shared/types'

let dir: string, file: string, store: WorkspaceStore, fake: ReturnType<typeof fakePlatform>
let api: NodeTerminalApi['canvasLayout'], client: WorkspaceReconciliationClient, workspace: Workspace
let now: number, enabled: boolean, sender: number, dropAck: boolean, evidence: OrganizerEvidence, lease: LayoutLeaseStore
let runtime: OrganizerRuntime
const raw = async () => JSON.parse(await fs.readFile(file, 'utf8'))
async function editDisk(edit: (value: any) => void) { const value = await raw(); edit(value); await fs.writeFile(file, JSON.stringify(value)) }
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-organizer-consumer-'))
  const user = path.join(dir, 'user'); await fs.mkdir(user)
  fake = fakePlatform({ userDataDir: user }); initPlatform(fake)
  store = new WorkspaceStore(); now = 1000; enabled = true; sender = 41; dropAck = false
  const project: Project = { id: 'p1', cwd: path.join(dir, 'project'), name: 'Fixture', color: '#fff',
    viewport: { x: 0, y: 0, zoom: 1 }, nodes: [{ id: 'worker', kind: 'terminal', title: 'Original', role: 'worker',
      position: { x: 100, y: 100 }, size: { width: 600, height: 400 }, color: '#fff', group: null }] }
  await store.save({ version: 2, activeProjectId: 'p1', projects: [project] })
  file = path.join(project.cwd!, '.nodeterm', 'project.json')
  await editDisk((v) => { v.futureRoot = { retained: true }; v.nodes[0].futureWorker = 7 })
  store.registerIpc()
  // Explicit disposable host evidence. This does NOT claim the production shells have a complete
  // cross-client activity/assignment adapter. No browser request supplies any of these facts.
  evidence = { source: 'current', inputRevision: 'host-edit-1', ownershipEpoch: 'assignment-fixture-1',
    activityComplete: true, actives: [], loopFrames: [], owns: (id) => id === 'worker' }
  runtime = {
    withEvidence: async (_sender, _project, run) => run(() => evidence),
    // Exercise the canonical current renderer transform, not a test-only position patch.
    present: (p, plan) => ({ ...p, nodes: flowToNodeStates(applyLayoutPlan(nodeStatesToFlow(p.nodes), plan)) })
  }
  lease = new LayoutLeaseStore({ filePath: path.join(user, 'leases.json'), now: () => now })
  registerCanvasLayoutIpc({ store: store.organizerCoordinator(), lease, runtime, settings: () => ({ enabled }), now: () => now })
  const rpc = { request: async (channel: string, ...args: unknown[]) => {
    const jsonArgs = JSON.parse(JSON.stringify(args))
    const withSender = [IPC.canvasLayoutPlan, IPC.canvasLayoutApply, IPC.canvasLayoutInverse].includes(channel as never)
    const result = await fake.handlers[channel](...(withSender ? [sender, ...jsonArgs] : jsonArgs))
    if (dropAck && channel === IPC.canvasLayoutApply) { dropAck = false; throw new Error('fixture lost acknowledgment') }
    return JSON.parse(JSON.stringify(result))
  } } as RpcClient
  api = buildAgentApi(rpc).canvasLayout
  client = new WorkspaceReconciliationClient(buildRealApi(rpc).workspace)
  workspace = await client.load()
})
afterEach(async () => { resetPlatformForTests(); await fs.rm(dir, { recursive: true, force: true }) })

async function prepare(): Promise<{ plan: LayoutPlan; request: LayoutCommitRequest }> {
  const binding = client.organizerBinding('p1', 'local-edit-1')!
  const plan = await api.plan({ ...layoutPlanRequest({ projectId: 'p1', trigger: 'node-created',
    nodes: nodeStatesToFlow(workspace.projects[0].nodes), createdIds: ['worker'], holder: 'caller-label',
    sizes: { compact: { width: 440, height: 320 }, normal: { width: 600, height: 400 } } }), binding })
  expect(plan.stoodDown).toBeUndefined(); expect(plan.operationId).toBeTruthy()
  return { plan, request: { ...binding, projectId: 'p1', operationId: plan.operationId!, leaseToken: plan.leaseToken! } }
}

describe('renderer producer → actual registered organizer boundary → canonical project publication', () => {
  it('retains the approved plan and acknowledges only the durable commit, then deduplicates replay', async () => {
    const { plan, request } = await prepare()
    plan.ops = [{ op: 'label', nodeId: 'worker', title: 'caller-edited preview' }]
    const before = workspace.projects[0]
    expect(client.beginOrganizer()).toBe(true)
    await expect(client.save(workspace, () => workspace)).rejects.toThrow('in flight')
    const result = await api.apply(request)
    workspace = client.acceptOrganizer('p1', before, workspace, result); client.endOrganizer()
    expect(result.kind).toBe('committed')
    expect((await raw()).nodes[0]).toMatchObject({ title: 'Original', size: { width: 440, height: 320 }, futureWorker: 7 })
    expect((await raw()).futureRoot).toEqual({ retained: true })
    expect(workspace.projects[0].nodes[0].size.width).toBe(440)
    const bytes = await fs.readFile(file, 'utf8')
    expect((await api.apply(request)).kind).toBe('already-applied')
    expect(await fs.readFile(file, 'utf8')).toBe(bytes)
  })

  it.each([
    ['caller input edit then undo', () => {}, 'local-edit-3', 'stale-input'],
    ['host input edit then undo', () => { evidence.inputRevision = 'host-edit-3' }, 'local-edit-1', 'stale-inputRevision'],
    ['opt-in changed', () => { enabled = false }, 'local-edit-1', 'disabled'],
    ['unknown activity', () => { evidence.activityComplete = false }, 'local-edit-1', 'activity-unknown'],
    ['stale source', () => { evidence.source = 'stale' }, 'local-edit-1', 'source-stale'],
    ['ownership mismatch', () => { evidence.owns = () => false }, 'local-edit-1', 'ineligible'],
    ['assignment epoch changed', () => { evidence.ownershipEpoch = 'next-assignment' }, 'local-edit-1', 'stale-ownershipEpoch'],
    ['lease expired', () => { now += 61_000 }, 'local-edit-1', 'lease-stale'],
    ['different browser principal', () => { sender = 42 }, 'local-edit-1', 'caller-project-mismatch']
  ] as const)('refuses %s without changing bytes', async (_name, change, inputRevision, reason) => {
    const { request } = await prepare(); const before = await fs.readFile(file, 'utf8'); change()
    expect(await api.apply({ ...request, inputRevision })).toMatchObject({ kind: 'refused', reason })
    expect(await fs.readFile(file, 'utf8')).toBe(before)
  })

  it('refuses a changed committed revision rather than merging a stale organizer plan', async () => {
    const { request } = await prepare()
    await editDisk((v) => { v.nodes[0].title = 'Intervening writer' })
    const before = await fs.readFile(file, 'utf8')
    expect(await api.apply(request)).toMatchObject({ kind: 'refused', reason: 'stale-revision' })
    expect(await fs.readFile(file, 'utf8')).toBe(before)
  })

  it('settles a lost ack read-only after opt-in, lease and input changed; keeps later renderer edits', async () => {
    const { request } = await prepare(); const before = structuredClone(workspace.projects[0])
    dropAck = true; await expect(api.apply(request)).rejects.toThrow('lost acknowledgment')
    const bytes = await fs.readFile(file, 'utf8')
    enabled = false; now += 61_000; evidence.inputRevision = 'changed'
    workspace.projects[0].nodes[0].title = 'Later local edit'
    const result = await api.apply({ ...request, settleOnly: true })
    expect(result.kind).toBe('already-applied')
    workspace = client.acceptOrganizer('p1', before, workspace, result)
    expect(workspace.projects[0].nodes[0]).toMatchObject({ title: 'Later local edit', size: { width: 440 } })
    expect(await fs.readFile(file, 'utf8')).toBe(bytes)
  })

  it('a settlement request for an unapplied preview never initiates publication', async () => {
    const { request } = await prepare(); const bytes = await fs.readFile(file, 'utf8')
    expect(await api.apply({ ...request, settleOnly: true })).toMatchObject({ kind: 'unknown' })
    expect(await fs.readFile(file, 'utf8')).toBe(bytes)
  })

  it('conditional inverse preserves unrelated committed edits and unknown fields', async () => {
    const { request } = await prepare(); const result = await api.apply(request)
    workspace = client.acceptOrganizer('p1', workspace.projects[0], workspace, result)
    await editDisk((v) => { v.nodes[0].title = 'Independent title'; v.futureRoot.extra = 9 })
    workspace = await client.refresh(() => workspace); evidence.inputRevision = 'host-edit-2'
    const inverse = { ...request, ...client.organizerBinding('p1', 'local-edit-2')! }
    const undone = await api.inverse(inverse)
    expect(undone.kind).toBe('committed')
    expect((await raw()).nodes[0]).toMatchObject({ title: 'Independent title', size: { width: 600, height: 400 }, futureWorker: 7 })
    expect((await raw()).futureRoot).toEqual({ retained: true, extra: 9 })
    const bytes = await fs.readFile(file, 'utf8')
    expect((await api.inverse(inverse)).kind).toBe('already-applied')
    expect(await fs.readFile(file, 'utf8')).toBe(bytes)
  })

  it('inverse refuses an intervening edit to an organizer-touched field', async () => {
    const { request } = await prepare(); const result = await api.apply(request)
    workspace = client.acceptOrganizer('p1', workspace.projects[0], workspace, result)
    await editDisk((v) => { v.nodes[0].size.width = 999 })
    workspace = await client.refresh(() => workspace)
    const bytes = await fs.readFile(file, 'utf8')
    expect(await api.inverse({ ...request, ...client.organizerBinding('p1', 'local-edit-2')! }))
      .toMatchObject({ kind: 'refused', reason: 'inverse-conflict' })
    expect(await fs.readFile(file, 'utf8')).toBe(bytes)
  })

  it('actual shell registration without a trusted runtime visibly refuses automatic planning', async () => {
    registerCanvasLayoutIpc({ store: store.organizerCoordinator(), settings: () => ({ enabled: true }) })
    const result = await api.plan({ projectId: 'p1', trigger: 'node-created', nodes: [], holder: 'operator-browser',
      sizes: { compact: { width: 440, height: 320 }, normal: { width: 600, height: 400 } } })
    expect(result).toMatchObject({ ops: [], refusal: 'activity-and-assignment-adapter-unavailable' })
    expect(result.operationId).toBeUndefined()
  })

  it('the canonical publication guard rechecks a late opt-in change and preserves a refusal receipt', async () => {
    const before = await fs.readFile(file, 'utf8')
    const bound = await new ProjectCommitStore(file).observe()
    const proposed = JSON.parse(before); proposed.nodes[0].title = 'Guarded write'
    const writer = new ProjectCommitStore(file, async (phase) => { if (phase === 'before-displace') enabled = false })
    const result = await writer.commit({ clientId: 'fixture', operationId: 'guard', expectedRevision: bound.revision,
      proposed: JSON.stringify(proposed) }, { check: () => enabled ? undefined : 'disabled' })
    expect(result).toMatchObject({ kind: 'publication-refused', message: 'E_CONDITIONAL_REFUSAL: disabled' })
    expect(await fs.readFile(file, 'utf8')).toBe(before)
    expect((await writer.receipt('fixture', 'guard'))?.kind).toBe('publication-refused')
  })

  it('a failed post-publication guard is unknown, never a successful asynchronous apply', async () => {
    const bound = await new ProjectCommitStore(file).observe()
    const proposed = JSON.parse(bound.raw); proposed.nodes[0].title = 'Publication fixture'
    const writer = new ProjectCommitStore(file, async (phase) => { if (phase === 'published') enabled = false })
    const result = await writer.commit({ clientId: 'fixture', operationId: 'late-guard', expectedRevision: bound.revision,
      proposed: JSON.stringify(proposed) }, { check: () => enabled ? undefined : 'disabled' })
    expect(result.kind).toBe('publication-unknown')
    expect((await writer.receipt('fixture', 'late-guard'))?.kind).toBe('publication-unknown')
    expect(await fs.readFile(path.join(result.recovery, 'displaced.json'), 'utf8')).toBe(bound.raw)
  })
})
