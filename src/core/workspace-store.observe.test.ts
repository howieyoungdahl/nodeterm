import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'
import { IPC } from '../shared/ipc'
import { WorkspaceStore } from './workspace-store'
import type { Project, Workspace } from '../shared/types'

let userData: string, projRoot: string
let fake: ReturnType<typeof fakePlatform>
const project = (ids: string[]): Project => ({ id: 'p1', name: 'foo', color: '#7aa2f7', viewport: { x: 0, y: 0, zoom: 1 }, cwd: projRoot,
  nodes: ids.map(id => ({ id, kind: 'terminal' as const, position: { x: 0, y: 0 }, size: { width: 1, height: 1 }, title: id, color: '#fff', group: null })) })
const ws = (projects: Project[]): Workspace => ({ version: 2, activeProjectId: projects[0].id, projects })

beforeEach(async () => {
  userData = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-ws-'))
  projRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-proj-'))
  fake = fakePlatform({ userDataDir: userData })
  initPlatform(fake)
})
afterEach(async () => {
  resetPlatformForTests()
  await fs.rm(userData, { recursive: true, force: true })
  await fs.rm(projRoot, { recursive: true, force: true })
})

// Field 2026-11-17: a tab behind the conflict bar sends no saves at all, so the Server never
// learned of a card opened meanwhile. The observe channel reports it without writing anything.
it('hands a suspended tab report to presentation evidence as unaccepted and never writes it', async () => {
  const store = new WorkspaceStore()
  await store.save(ws([project(['term-1'])]))
  const before = await store.load()
  const seen: Array<{ workspace: Workspace; source: { senderId: number; accepted: boolean } }> = []
  store.onClientSaveSnapshot = (workspace, source) => seen.push({ workspace, source })
  store.registerIpc()
  const info = vi.spyOn(console, 'info').mockImplementation(() => {})
  const held = { ...before, projects: [project(['term-1', 'term-new'])] }
  await fake.handlers[IPC.workspaceObserve](7, held, 'conflict bar open (overlapping-content)')
  expect(seen).toEqual([{ workspace: held, source: { senderId: 7, accepted: false } }])
  expect(info).toHaveBeenCalledWith('[workspace] ui:7 saves suspended: conflict bar open (overlapping-content)')
  const after = await new WorkspaceStore().load()
  expect(after.revision).toBe(before.revision)
  expect(after.projects[0].nodes.map(n => n.id)).toEqual(['term-1'])
})
