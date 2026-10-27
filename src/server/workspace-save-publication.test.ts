import { afterEach, expect, it } from 'vitest'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { ServerPlatform } from './platform-server'
import { initPlatform, resetPlatformForTests } from '../core/platform'
import { WorkspaceStore } from '../core/workspace-store'
import { WorkspaceMutationQueue } from './workspace-mutation-queue'
import { IPC } from '../shared/ipc'
import type { Workspace } from '../shared/types'

let dir: string | undefined
afterEach(async () => { resetPlatformForTests(); if (dir) await fs.rm(dir, { recursive: true, force: true }) })
it('delivers a normal save complete stamp to both Server peers before ACK, rejects stale writers without publishing', async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-priority-publication-'))
  const shell = new ServerPlatform({ userDataDir: dir, appVersion: 'test' })
  initPlatform(shell)
  const frames: unknown[][] = [[], []]
  const clients = frames.map(frame => shell.attach({ sendText: raw => frame.push(JSON.parse(raw)), sendBinary: () => {} }))
  const store = new WorkspaceStore(), queue = new WorkspaceMutationQueue()
  const snapshots: Array<{ senderId: number; accepted: boolean }> = []
  store.onClientSaveSnapshot = (_workspace, source) => { snapshots.push(source) }
  store.clientMutationRunner = work => queue.run(work)
  const workspace: Workspace = { version: 2, activeProjectId: 'p', projects: [{ id: 'p', name: 'Synthetic', color: '#fff', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], kanban: { columns: [], assignments: [] } }] }
  await store.save(workspace)
  const first = await store.load(), stale = structuredClone(first)
  first.projects[0].kanban!.meta = [{ nodeId: 'synthetic', priority: 'urgent', priorityManual: true }]
  store.registerIpc()
  const response = await shell.dispatch(clients[0], { t: 'req', id: 1, method: IPC.workspaceSave, args: [first] })
  expect(response.ok).toBe(true)
  for (const peer of frames) {
    expect(peer).toHaveLength(1)
    expect(peer[0]).toMatchObject({ channel: IPC.workspaceServerChange, args: [{ workspaceChange: {
      before: stale.revision, changes: [{ after: { kanban: first.projects[0].kanban } }]
    } }] })
  }
  const rejected = await shell.dispatch(clients[1], { t: 'req', id: 2, method: IPC.workspaceSave, args: [stale] })
  expect(rejected).toMatchObject({ ok: false, error: { message: expect.stringContaining('workspace_conflict') } })
  expect(frames.map(peer => peer.length)).toEqual([1, 1])
  expect(snapshots).toEqual([
    { senderId: clients[0], accepted: false }, { senderId: clients[0], accepted: true },
    { senderId: clients[1], accepted: false }
  ])
})
