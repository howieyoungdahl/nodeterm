import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import { initPlatform, resetPlatformForTests } from '../core/platform'
import { fakePlatform } from '../core/platform-fake'
import { WorkspaceStore } from '../core/workspace-store'
import { ServerNodeOps } from './node-ops'
import type { Workspace } from '../shared/types'

it.skipIf(process.platform === 'win32').each([false, true])('acknowledges durable operator deletion and rejects a stale card even with a fresh workspace revision (inline=%s)', async (inline) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-ops-removal-'))
  try {
    initPlatform(fakePlatform({ userDataDir: root }))
    const store = new WorkspaceStore()
    const seed: Workspace = { version: 2, activeProjectId: 'p', projects: [{ id: 'p', name: 'p', color: '#fff', ...(inline ? {} : { cwd: path.join(root, 'project') }),
      viewport: { x: 0, y: 0, zoom: 1 }, nodes: [{ id: 'term-dead', kind: 'terminal', title: 'dead', color: '#fff', group: null,
        position: { x: 0, y: 0 }, size: { width: 440, height: 320 } }] }] }
    await store.save(seed)
    const stale = await store.load()
    const ops = new ServerNodeOps({ workspaceStore: store, sessionPresence: async () => 'dead', destroySession: async () => {},
      statusOf: () => undefined, ownerOf: () => undefined })
    expect(await ops.remove('term-dead', true)).toMatchObject({ ok: true })
    const disk = await new WorkspaceStore().load()
    expect(disk.projects[0].nodes).toEqual([])
    expect(disk.projects[0].deletedEntities?.nodes).toContain('term-dead')
    await expect(store.save(stale, { requireRevision: true })).rejects.toThrow('workspace_conflict')
    stale.revision = disk.revision
    await expect(store.save(stale, { requireRevision: true })).rejects.toThrow('workspace_conflict')
    expect((await new WorkspaceStore().load()).projects[0].nodes).toEqual([])
  } finally {
    resetPlatformForTests()
    await fs.rm(root, { recursive: true, force: true })
  }
})
