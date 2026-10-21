import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'
import { expect, it } from 'vitest'
import { startServer } from '../../src/server/index'
import { WorkspaceStore } from '../../src/core/workspace-store'
import { initPlatform, resetPlatformForTests } from '../../src/core/platform'
import { fakePlatform } from '../../src/core/platform-fake'
import { RpcClient } from '../../src/renderer/bridge/ws-bridge'
import { saveWorkspace, subscribeWorkspacePublications } from '../../src/renderer/lib/workspacePersistence'
import { mergeWorkspacePublication } from '../../src/renderer/lib/workspacePublication'
import { useProjects } from '../../src/renderer/state/projects'
import { IPC } from '../../src/shared/ipc'
import type { CanvasNodeState, Project, Workspace, WorkspaceApi, WorkspaceSaveAck } from '../../src/shared/types'

it('persists a browser-created card after two internal save collisions on a disposable Server', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-card-churn-'))
  let stop: (() => Promise<void>) | undefined, socket: WebSocket | undefined, unsubscribe: (() => void) | undefined
  const card = (id: string): CanvasNodeState => ({ id, kind: 'terminal', title: id, titleAuto: false,
    color: '#0a84ff', group: null, tags: [], position: { x: 123, y: 456 }, size: { width: 640, height: 440 } })
  try {
    initPlatform(fakePlatform({ userDataDir: root }))
    await new WorkspaceStore().save({ version: 2, activeProjectId: 'fixture', projects: [{
      id: 'fixture', name: 'Fixture', color: '#0a84ff', cwd: path.join(root, 'project'),
      viewport: { x: 0, y: 0, zoom: 1 }, nodes: [card('saved')]
    }] })
    resetPlatformForTests()
    const server = await startServer({ port: 0, host: '127.0.0.1', dataDir: root,
      rendererDir: path.join(root, 'no-renderer'), insecureHttp: false,
      passwordSeed: 'synthetic-save-password', installHooks: false, deadCardReapMinutes: 0 })
    stop = server.close
    const base = `http://127.0.0.1:${server.port}`
    const login = await fetch(`${base}/auth/login`, { method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'password=synthetic-save-password' })
    expect(login.status).toBe(303)
    socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, {
      headers: { cookie: login.headers.get('set-cookie')!.split(';')[0] }
    })
    const connected = new Promise<void>((resolve, reject) => { socket!.once('open', resolve); socket!.once('error', reject) })
    const client = new RpcClient({
      send: json => socket!.send(json), ready: () => connected,
      onMessage: cb => { socket!.on('message', (raw, binary) => cb(binary ? new Uint8Array(raw as Buffer) : raw.toString())) },
      onClose: cb => { socket!.on('close', cb) }
    })
    await client.ready()
    useProjects.getState().hydrate(await client.request(IPC.workspaceLoad) as Workspace)
    const created = { ...card('new-browser-card'), title: 'My carefully named session' }
    useProjects.setState(state => ({ projects: state.projects.map(p => ({ ...p, nodes: [...p.nodes, created] })) }))
    const token = (await fs.readFile(path.join(root, 'ops-token'), 'utf8')).trim()
    let saves = 0
    const api = {
      save: async (snapshot: Workspace) => {
        if (++saves <= 2) {
          // Real internal transactions overtake both the browser snapshot and its immediate retry.
          const changed = await fetch(`${base}/opsapi/nodes/saved?force=1`, { method: 'PATCH',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
            body: JSON.stringify({ title: `Internal change ${saves}` }) })
          expect(changed.status).toBe(200)
          await client.request(IPC.workspaceLoad) // WS ordering barrier for publication delivery.
        }
        return await client.request(IPC.workspaceSave, snapshot) as WorkspaceSaveAck
      },
      onServerChange: (cb: (p: Project) => void) => client.subscribe(IPC.workspaceServerChange, cb as (...args: unknown[]) => void)
    } as WorkspaceApi
    const conflicts: string[] = []
    unsubscribe = subscribeWorkspacePublications(api, incoming => {
      const state = useProjects.getState()
      const merged = mergeWorkspacePublication(state.revision, state.projects, incoming.workspaceChange)
      if (merged.kind === 'conflict') { conflicts.push(merged.reason); return { kind: 'conflict' } }
      if (merged.kind === 'duplicate') return { kind: 'duplicate', revision: state.revision! }
      useProjects.setState({ projects: merged.projects, revision: merged.revision })
      return { kind: 'adopt', before: incoming.workspaceChange!.before, after: merged.revision }
    })
    let failure: unknown
    try { await saveWorkspace(api) } catch (error) { failure = error }
    expect(failure).toMatchObject({ name: 'WorkspaceSaveSupersededError' })
    expect(conflicts).toEqual([])
    expect((await client.request(IPC.workspaceLoad) as Workspace).projects[0].nodes).toHaveLength(1)
    await saveWorkspace(api) // The bounded delivery schedule resumes without another user edit.
    expect(saves).toBe(3)
    const reloaded = await client.request(IPC.workspaceLoad) as Workspace
    expect(reloaded.projects[0].nodes.find(n => n.id === created.id)).toMatchObject(created)
    expect(reloaded.projects[0].nodes.find(n => n.id === 'saved')?.title).toBe('Internal change 2')
    expect((await new WorkspaceStore().load({ sideline: false })).projects[0].nodes.find(n => n.id === created.id)).toMatchObject(created)
  } finally {
    unsubscribe?.(); socket?.terminate(); await stop?.(); resetPlatformForTests()
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 30_000)
