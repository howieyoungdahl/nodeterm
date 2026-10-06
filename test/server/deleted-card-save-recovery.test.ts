import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'
import { expect, it } from 'vitest'
import { startServer } from '../../src/server/index'
import { WorkspaceStore } from '../../src/core/workspace-store'
import { initPlatform, resetPlatformForTests } from '../../src/core/platform'
import { fakePlatform } from '../../src/core/platform-fake'
import { resolveWorkspaceConflict } from '../../src/renderer/lib/workspacePersistence'
import { IPC } from '../../src/shared/ipc'
import type { CanvasNodeState, Workspace } from '../../src/shared/types'

it('resolves rejected deleted-card saves through real authenticated WS RPC on a disposable Server', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-save-rpc-'))
  let stop: (() => Promise<void>) | undefined, socket: WebSocket | undefined
  const node = (id: string): CanvasNodeState => ({ id, kind: 'sticky', title: id,
    color: '#0a84ff', group: null, text: 'synthetic note', position: { x: 10, y: 20 }, size: { width: 320, height: 200 } })
  try {
    initPlatform(fakePlatform({ userDataDir: root }))
    const store = new WorkspaceStore()
    const seed: Workspace = { version: 2, activeProjectId: 'fixture', projects: [{
      id: 'fixture', name: 'Fixture', color: '#0a84ff', cwd: path.join(root, 'project'),
      viewport: { x: 0, y: 0, zoom: 1 }, nodes: [node('saved'), node('deleted')]
    }] }
    await store.save(seed)
    const stale = await store.load()
    const changed = structuredClone(stale)
    changed.projects[0].nodes.pop()
    await store.save(changed)
    resetPlatformForTests()
    const server = await startServer({ port: 0, host: '127.0.0.1', dataDir: root,
      rendererDir: path.join(root, 'no-renderer'), insecureHttp: false,
      passwordSeed: 'synthetic-save-password', installHooks: false, deadCardReapMinutes: 0 })
    stop = server.close
    const login = await fetch(`http://127.0.0.1:${server.port}/auth/login`, {
      method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'password=synthetic-save-password'
    })
    expect(login.status).toBe(303)
    socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, {
      headers: { cookie: login.headers.get('set-cookie')!.split(';')[0] }
    })
    await new Promise<void>((resolve, reject) => { socket!.once('open', resolve); socket!.once('error', reject) })
    let id = 0
    const request = (method: string, ...args: unknown[]): Promise<any> => new Promise((resolve, reject) => {
      const requestId = ++id
      const timer = setTimeout(() => { socket!.off('message', receive); reject(new Error('RPC fixture timed out')) }, 5000)
      const receive = (data: WebSocket.RawData, binary: boolean) => {
        if (binary) return
        const message = JSON.parse(data.toString())
        if (message.t !== 'res' || message.id !== requestId) return
        clearTimeout(timer); socket!.off('message', receive)
        if (message.ok) resolve(message.result)
        else reject(new Error(message.error.message))
      }
      socket!.on('message', receive)
      socket!.send(JSON.stringify({ t: 'req', id: requestId, method, args }))
    })
    for (const keep of [false, true]) {
      const incoming: Workspace = await request(IPC.workspaceLoad)
      // Fresh revision but stale cards: exercise the retained conflict through aggregation and RPC.
      const local = { ...structuredClone(stale), revision: incoming.revision }
      local.projects[0].nodes.push(node(keep ? 'new-keep' : 'new-reload'))
      await expect(request(IPC.workspaceSave, local)).rejects.toThrow('workspace_conflict: retained publication conflict')
      const disk: Workspace = await request(IPC.workspaceLoad)
      expect(disk.projects[0].deletedEntities?.nodes).toContain('deleted')
      const resolved = resolveWorkspaceConflict(local, disk, keep)
      expect(resolved.projects[0].nodes.map(n => n.id)).not.toContain('deleted')
      expect(await request(IPC.workspaceSave, resolved)).toHaveProperty('revision')
      const reloaded: Workspace = await request(IPC.workspaceLoad)
      expect(reloaded.projects[0].nodes.map(n => n.id)).toContain(keep ? 'new-keep' : 'new-reload')
      await request(IPC.workspaceSave, reloaded)
    }
  } finally {
    socket?.terminate()
    await stop?.()
    resetPlatformForTests()
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 30_000)
