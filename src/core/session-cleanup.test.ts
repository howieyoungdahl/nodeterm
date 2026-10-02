import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { CLEANUP_IDLE_MS, CLEANUP_PREVIEW_MS, CleanupReservations, SessionCleanup, cleanupEligible, type CleanupEvidence } from './session-cleanup'
import { WorkspaceMutationQueue } from '../server/workspace-mutation-queue'
import type { CanvasNodeState, Project, Workspace } from '../shared/types'

const now = 1_900_000_000_000
const node = (id: string): CanvasNodeState => ({ id, kind: 'terminal', title: `Review ${id}`,
  position: { x: 0, y: 0 }, size: { width: 640, height: 440 }, color: '#888', group: null,
  cwd: 'C:\\work\\project', shell: 'bash' })
const evidence = (): CleanupEvidence => ({ generation: 'boot:session:pane:pid:birth', activityAt: now - CLEANUP_IDLE_MS,
  state: 'completed', workChildren: 0, pending: false, fingerprint: 'screen-and-process-generation', reason: 'verified-completion' })
describe('safe session cleanup', () => {
  let dir: string, clock: number, workspace: Workspace, e: CleanupEvidence, cleanup: SessionCleanup
  let save: Mock<(w: Workspace) => Promise<void>>, publish: Mock<(p: Project) => void>, probe: Mock<() => Promise<CleanupEvidence>>
  let revision: number
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-cleanup-'))
    clock = now; revision = 0; e = evidence()
    workspace = { version: 2, activeProjectId: 'p1', projects: [{ id: 'p1', name: 'P1', color: '#888', nodes: [node('a'), node('b')], viewport: { x: 0, y: 0, zoom: 1 } }] }
    save = vi.fn(async w => { workspace = structuredClone(w) })
    publish = vi.fn(); probe = vi.fn(async () => structuredClone(e))
    const queue = new WorkspaceMutationQueue()
    cleanup = new SessionCleanup({ dataDir: dir, now: () => clock, load: async () => structuredClone(workspace), save,
      exclusive: work => queue.run(work), probe, publish, activityVersion: () => revision })
  })
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }) })
  async function request(nodeIds = ['a']) { return { planId: (await cleanup.preview()).plan.id, nodeIds } }

  it('previews a completed live review at exactly one hour without creating files or saving', async () => {
    const r = await cleanup.preview()
    expect(r.dryRun).toBe(true); expect(r.plan.rows[0].eligible).toBe(true)
    expect(save).not.toHaveBeenCalled(); expect(await fs.readdir(dir)).toEqual([])
  })
  it('refuses publication if its prepared inverse cannot be synced durably', async () => {
    const open=fs.open.bind(fs)
    const spy=vi.spyOn(fs,'open').mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle=await open(...args)
      if(String(args[0]).endsWith('.json') && args[1]==='r')
        vi.spyOn(handle,'sync').mockRejectedValue(new Error('fixture-fsync-failure'))
      return handle
    })
    try {
      await expect(cleanup.archive(await request())).rejects.toThrow('fixture-fsync-failure')
      expect(save).not.toHaveBeenCalled();expect(publish).not.toHaveBeenCalled()
      expect(workspace.projects[0].nodes[0].cleanupArchiveId).toBeUndefined()
    } finally { spy.mockRestore() }
  })
  it.each(['active', 'waiting', 'blocked', 'unknown', 'dead'] as const)('preserves an old %s session', async state => {
    e.state = state; e.activityAt = now - 20 * CLEANUP_IDLE_MS
    expect((await cleanup.preview()).plan.rows.every(r => !r.eligible)).toBe(true)
  })
  it('requires observed activity, no children, and no pending approval', () => {
    for (const patch of [{ activityAt: null }, { activityAt: NaN }, { activityAt: now + 1 },
      { activityAt: now - CLEANUP_IDLE_MS + 1 }, { workChildren: null }, { workChildren: 1 },
      { pending: true }, { generation: '' }, { fingerprint: '' }]) {
      expect(cleanupEligible({ ...e, ...patch }, now)).toBe(false)
    }
  })
  it('reports unreadable probes as unknown rather than empty success', async () => {
    probe.mockRejectedValue(new Error('unreadable'))
    const r = await cleanup.preview(); expect(r.plan.rows).toHaveLength(2)
    expect(r.plan.rows[0].evidence.reason).toBe('probe-unavailable'); expect(r.plan.rows[0].eligible).toBe(false)
    for (const value of [null, {}, {...e,workChildren:-1}, {...e,pending:undefined}, {...e,activityAt:NaN}]) {
      probe.mockResolvedValue(value as never)
      expect((await cleanup.preview()).plan.rows.every(row=>!row.eligible && row.evidence.state==='unknown')).toBe(true)
    }
  })
  it('refuses SSH and duplicate identities', async () => {
    workspace.projects[0].ssh = {} as never
    expect((await cleanup.preview()).plan.rows[0].eligible).toBe(false)
    delete workspace.projects[0].ssh; workspace.projects[0].nodes.push(node('a'))
    const rows = (await cleanup.preview()).plan.rows.filter(r => r.nodeId === 'a')
    expect(rows.every(r => !r.eligible && r.evidence.reason === 'ambiguous-node-id')).toBe(true)
  })
  it.each([{ids: []}, {ids: ['a', 'a']}, {ids: ['z']}])('refuses an empty/duplicate/unpreviewed allowlist $ids', async ({ids}) => {
    await expect(cleanup.archive(await request(ids))).rejects.toThrow()
    expect(save).not.toHaveBeenCalled()
  })
  it('does not accept force, wildcard or generation overrides', async () => {
    const r = await request()
    await expect(cleanup.archive({ ...r, force: true })).rejects.toThrow('exact_id_allowlist_required')
    await expect(cleanup.archive({ ...r, nodeIds: ['*'] })).rejects.toThrow('exact_id_allowlist_required')
  })
  it('archives only selected IDs and preserves every original content/identity field', async () => {
    const before = structuredClone(workspace)
    const r = await cleanup.archive(await request())
    expect(r.receipt.state).toBe('applied')
    expect(workspace.projects[0].nodes[0]).toEqual({ ...before.projects[0].nodes[0], cleanupArchiveId: r.receipt.id })
    expect(workspace.projects[0].nodes[1]).toEqual(before.projects[0].nodes[1])
    expect(publish).toHaveBeenCalledOnce()
    expect((await cleanup.preview()).plan.rows[0].archiveId).toBe(r.receipt.id)
  })
  it('rejects expired previews at the boundary and after a service restart', async () => {
    const r = await request(); clock += CLEANUP_PREVIEW_MS
    await expect(cleanup.archive(r)).rejects.toThrow('preview_expired_or_restarted')
    const fresh = new SessionCleanup({ dataDir: dir, load: async () => workspace, save, probe, exclusive: w => w() })
    await expect(fresh.archive(r)).rejects.toThrow('preview_expired_or_restarted')
  })
  it('rejects new output, input, replaced panes and changed semantic status after preview', async () => {
    const r = await request()
    for (const patch of [{ fingerprint: 'new-output' }, { generation: 'replacement' }, { state: 'active' as const }, { pending: true }]) {
      e = { ...evidence(), ...patch }
      await expect(cleanup.archive(r)).rejects.toThrow('activity_or_generation_changed')
    }
    expect(save).not.toHaveBeenCalled()
  })
  it('rejects disk changes during probing and asynchronous activity before save', async () => {
    const r = await request()
    probe.mockImplementationOnce(async () => { workspace.projects[0].nodes[1].title = 'edited'; return evidence() })
    await expect(cleanup.archive(r)).rejects.toThrow('workspace_or_preview_changed')
    const next = await request()
    probe.mockImplementationOnce(async () => { revision++; return evidence() })
    await expect(cleanup.archive(next)).rejects.toThrow('activity_during_validation')
    expect(save).not.toHaveBeenCalled()
  })
  it('restores a session whose activity races the actual save before publishing archive', async () => {
    save.mockImplementationOnce(async w => { workspace = structuredClone(w); e.state = 'active' })
    await expect(cleanup.archive(await request())).rejects.toThrow('activity_raced_archive_restored')
    expect(workspace.projects[0].nodes[0].cleanupArchiveId).toBeUndefined()
    const id = (await cleanup.receipts()).receiptIds[0]
    expect((await cleanup.receipt(id)).receipt.state).toBe('undone')
    expect(publish.mock.calls[0][0].nodes[0].cleanupArchiveId).toBeUndefined()
  })
  it('keeps a prepared recovery receipt on partial save failure, recoverable after restart', async () => {
    save.mockImplementationOnce(async w => { workspace = structuredClone(w); throw new Error('save uncertain') })
    await expect(cleanup.archive(await request())).rejects.toThrow('save uncertain')
    expect(publish).not.toHaveBeenCalled()
    const restored = new SessionCleanup({ dataDir: dir, load: async () => structuredClone(workspace), save, probe, exclusive: w => w() })
    const id = (await restored.receipts()).receiptIds[0]
    expect((await restored.receipt(id)).receipt.state).toBe('prepared')
    expect(await restored.protectedNodeIds()).toEqual(['a'])
    await restored.undo(id)
    expect(workspace.projects[0].nodes[0].cleanupArchiveId).toBeUndefined()
    expect(await restored.protectedNodeIds()).toEqual([])
  })
  it('never holds the workspace FIFO during external probes and restores a hook race at publication', async () => {
    let inTransaction = false, loads = 0
    const service = new SessionCleanup({ dataDir: dir, now:()=>clock, save, publish, activityVersion:()=>revision,
      load: async () => { if (++loads === 4) revision++; return structuredClone(workspace) },
      exclusive: async work => { inTransaction = true; try { return await work() } finally { inTransaction = false } },
      probe: async () => { expect(inTransaction).toBe(false); return evidence() } })
    const plan = await service.preview()
    await expect(service.archive({ planId: plan.plan.id, nodeIds:['a'] })).rejects.toThrow('activity_raced_archive_restored')
    expect(workspace.projects[0].nodes[0].cleanupArchiveId).toBeUndefined()
    expect(publish.mock.calls[0][0].nodes[0].cleanupArchiveId).toBeUndefined()
  })
  it('refuses a reaper lease without saving, and releases its own lease after failure', async () => {
    const leases = new CleanupReservations()
    const service = new SessionCleanup({ dataDir:dir,now:()=>clock,save,probe,load:async()=>structuredClone(workspace),exclusive:w=>w(),reserveSessions:ids=>leases.reserve(ids) })
    const plan = await service.preview()
    const release = leases.reserve(['a'])!
    await expect(service.archive({planId:plan.plan.id,nodeIds:['a']})).rejects.toThrow('session_cleanup_or_reap_in_progress')
    expect(save).not.toHaveBeenCalled()
    release(); release() // A repeated release cannot remove a later owner's lease.
    save.mockRejectedValueOnce(new Error('save failed'))
    await expect(service.archive({planId:plan.plan.id,nodeIds:['a']})).rejects.toThrow('save failed')
    expect(leases.reserve(['a'])).not.toBeNull()
  })
  it('rejects malformed, null-item and duplicate-item receipts without workspace mutation', async () => {
    const {receipt} = await cleanup.archive(await request())
    save.mockClear()
    for (const bad of [null, {...receipt,at:NaN}, {...receipt,items:[null]}, {...receipt,items:[...receipt.items,...receipt.items]}, {...receipt,items:[]}]) {
      await fs.writeFile(path.join(dir,'session-cleanup',`${receipt.id}.json`),JSON.stringify(bad))
      await expect(cleanup.undo(receipt.id)).rejects.toThrow('invalid_cleanup_receipt')
      await expect(cleanup.protectedNodeIds()).rejects.toThrow('invalid_cleanup_receipt')
    }
    expect(save).not.toHaveBeenCalled()
  })
  it('undo preserves later title/position edits and is idempotent', async () => {
    const { receipt } = await cleanup.archive(await request())
    workspace.projects[0].nodes[0].title = 'new title'; workspace.projects[0].nodes[0].position.x = 100
    await cleanup.undo(receipt.id)
    expect(workspace.projects[0].nodes[0]).toMatchObject({ title: 'new title', position: { x: 100 } })
    expect(workspace.projects[0].nodes[0].cleanupArchiveId).toBeUndefined()
    save.mockClear(); await cleanup.undo(receipt.id); expect(save).not.toHaveBeenCalled()
  })
  it('undo never resurrects a removed node or overrides a later archive', async () => {
    const { receipt } = await cleanup.archive(await request())
    workspace.projects[0].nodes[0].cleanupArchiveId = 'other'
    await expect(cleanup.undo(receipt.id)).rejects.toThrow('undo_conflict')
    workspace.projects[0].nodes.shift()
    await expect(cleanup.undo(receipt.id)).rejects.toThrow('undo_target_missing_or_ambiguous')
  })
  it('fails closed on corrupt receipts and an abandoned transaction lock', async () => {
    await fs.mkdir(path.join(dir, 'session-cleanup'))
    const id = '00000000-0000-4000-8000-000000000000'
    await fs.writeFile(path.join(dir, 'session-cleanup', `${id}.json`), '{broken')
    await expect(cleanup.undo(id)).rejects.toThrow('cleanup_receipt_unavailable')
    await fs.writeFile(path.join(dir, 'session-cleanup', 'transaction.lock'), '')
    await expect(cleanup.archive(await request())).rejects.toThrow('cleanup_locked_or_unavailable')
    expect(save).not.toHaveBeenCalled()
  })
})
