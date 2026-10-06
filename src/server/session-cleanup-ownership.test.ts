import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const { run } = vi.hoisted(() => ({ run: vi.fn() }))
vi.mock('node:child_process', () => ({ execFile: run }))
import { createCleanupProbe, CleanupActivity } from '../core/session-cleanup-probe'
import { SessionCleanup, CLEANUP_IDLE_MS } from '../core/session-cleanup'
import { AssistantCreationReceipts } from './assistant-creation-receipts'
import { publicationPlatform } from '../core/workspace-publication-platform'
import { TMUX_SOCKET } from '../core/tmux-naming'
import type { Project, Workspace } from '../shared/types'

let dir: string
const screen = 'Task finished\nWorked for 1m • 12:00\n\n› Ask Codex to do anything\n'
const stat = (pid: number, birth: string) => {
  const fields = Array(22).fill('0'); fields[0] = 'S'; fields[5] = '11'; fields[19] = birth
  return `${pid} (fixture) ${fields.join(' ')}`
}
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-cleanup-ownership-'))
  run.mockImplementation((_bin, args, _opts, callback) => callback(null, { stdout: args.includes('list-panes')
    ? '100\t100\t100\t%1\t10\t0\tcodex\n' : args.includes('capture-pane') ? screen : '10 1 bash\n11 10 codex\n', stderr: '' }))
})
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(dir, { recursive: true, force: true }) })

it.skipIf(process.platform !== 'linux')('requires exact private task/creator receipts at the real completed probe and preview seam; manual and forged cards remain excluded', async () => {
  const generation = `${TMUX_SOCKET}:100:%1:10:10000:11:20000`
  const activity = new CleanupActivity(async () => ({ generation, process: '11:20000' }))
  await activity.observe({ nodeId: 'child', agentId: 'codex', kind: 'session', sessionId: 'fresh-session',
    sessionPhase: 'start', freshSession: true, verified: true, cleanupProcess: '11:20000' })
  expect(activity.covered('child', 'fresh-session', generation)).toBe(true)
  const read = fs.readFile
  vi.spyOn(fs, 'readFile').mockImplementation(async (...args) => {
    if (args[0] === '/proc/10/stat') return stat(10, '10000') as never
    if (args[0] === '/proc/11/stat') return stat(11, '20000') as never
    if (args[0] === '/proc/11/environ') return `NODETERM_CLEANUP_BOOT=${activity.bootId}\0` as never
    return read(...args)
  })
  const creation = { version: 1 as const, taskId: 'explicit-task', creationId: 'explicit-creation', declaredOwner: 'Declared assistant' }
  const project: Project = { id: 'project', name: 'Fixture', color: '#888', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [{
    id: 'child', kind: 'terminal', title: 'Assistant complete', agentId: 'codex', agentModel: 'gpt-6.1-sol', agentSessionId: 'fresh-session',
    position: { x: 0, y: 0 }, size: { width: 640, height: 440 }, group: null, color: '#888', assistantCreation: creation,
    organization: { version: 1, mode: 'manual', columnId: null, sequence: 0,
      metadata: { owner: creation.declaredOwner, projectId: 'project', workstream: 'fixture', functionalRole: 'review' } }
  }] }
  const workspace: Workspace = { version: 2, activeProjectId: project.id, projects: [project] }
  let receipts = new AssistantCreationReceipts(path.join(dir, 'receipts'))
  let owner: { sourceNodeId: string; projectId: string; assistantCreationId?: string } | undefined
  const probe = createCleanupProbe({ tmuxBin: () => 'fixture-tmux', activity,
    status: () => ({ state: 'done', sessionId: 'fresh-session', updatedAt: 100000 }), lastActivity: () => 100000,
    assistantTaskEvidence: (p, n) => receipts.attestNode(p.id, n.id, owner) })
  const save = vi.fn()
  const cleanup = new SessionCleanup({ dataDir: dir, now: () => 100000 + CLEANUP_IDLE_MS, load: async () => workspace,
    save, exclusive: work => work(), probe })
  // A genuine current-boot completion, visible metadata and model/title labels are insufficient.
  for (const held of [undefined, { sourceNodeId: 'ops-operator', projectId: 'project' },
    { sourceNodeId: 'source', projectId: 'project', assistantCreationId: 'forged-receipt' }]) {
    owner = held
    const preview = await cleanup.preview(), row = preview.plan.rows[0]
    expect(row.evidence).toMatchObject({ state: 'unknown', workChildren: 0, pending: true, reason: 'assistant-task-ownership-unproven' })
    expect(row.eligible).toBe(false)
    await expect(cleanup.archive({ planId: preview.plan.id, nodeIds: ['child'] })).rejects.toThrow('node_not_in_eligible_preview')
  }
  const source = { principal: 'verified-node' as const, sourceNodeId: 'source', projectId: 'project' }
  const receipt = await receipts.record(source, creation, [{ nodeId: 'child', organization: project.nodes[0].organization!.metadata }], 'a'.repeat(64), 'private-receipt')
  for (const held of [
    { sourceNodeId: 'foreign-source', projectId: 'project', assistantCreationId: receipt.id },
    { sourceNodeId: 'source', projectId: 'foreign-project', assistantCreationId: receipt.id }
  ]) {
    owner = held; expect((await cleanup.preview()).plan.rows[0].eligible).toBe(false)
  }
  owner = { sourceNodeId: 'source', projectId: 'project', assistantCreationId: receipt.id }
  const owned = await cleanup.preview()
  expect(owned.plan.rows[0].evidence).toMatchObject({ state: 'completed', pending: false, workChildren: 0 })
  expect(owned.plan.rows[0].eligible).toBe(true)
  expect(await receipts.attestNode('project', 'other-node', owner)).toBeUndefined()
  // A copied Linux receipt has bytes/history but no acknowledgment in this cleanup runtime.
  await fs.cp(path.join(dir, 'receipts'), path.join(dir, 'copied'), { recursive: true })
  receipts = new AssistantCreationReceipts(path.join(dir, 'copied'))
  expect((await cleanup.preview()).plan.rows[0].eligible).toBe(false)
  // A flushed Windows creation acknowledgment remains valid for idempotent management, but
  // must never qualify for Linux automatic cleanup, including after a cross-host copy.
  const native = vi.spyOn(publicationPlatform, 'nativePlatform').mockReturnValue('win32')
  const windows = new AssistantCreationReceipts(path.join(dir, 'windows'))
  await windows.record(source, creation, [{ nodeId: 'child', organization: project.nodes[0].organization!.metadata }], 'a'.repeat(64), receipt.id)
  native.mockRestore()
  await fs.cp(path.join(dir, 'windows'), path.join(dir, 'windows-copy'), { recursive: true })
  for (const held of [windows, new AssistantCreationReceipts(path.join(dir, 'windows-copy'))]) {
    receipts = held
    expect(await receipts.find(source, creation.creationId)).toMatchObject({ publication: { platform: 'win32', guarantee: 'file-flush-visibility' } })
    const preview = await cleanup.preview()
    expect(preview.plan.rows[0].evidence.reason).toBe('assistant-task-ownership-unproven')
    expect(preview.plan.rows[0].eligible).toBe(false)
    await expect(cleanup.archive({ planId: preview.plan.id, nodeIds: ['child'] })).rejects.toThrow('node_not_in_eligible_preview')
  }
  receipts = new AssistantCreationReceipts(path.join(dir, 'interrupted'), async at => {
    if (at === 'published') throw new Error('fixture unknown acknowledgment')
  })
  await expect(receipts.record(source, creation, [{ nodeId: 'child', organization: project.nodes[0].organization!.metadata }], 'a'.repeat(64), receipt.id)).rejects.toThrow('fixture unknown acknowledgment')
  expect((await cleanup.preview()).plan.rows[0].eligible).toBe(false)
  expect(save).not.toHaveBeenCalled()
})
