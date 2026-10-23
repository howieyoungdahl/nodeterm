import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'
import { applyNodeChanges } from '@xyflow/react'
import { expect, it } from 'vitest'
import { startServer } from '../../src/server/index'
import { WorkspaceStore } from '../../src/core/workspace-store'
import { initPlatform, resetPlatformForTests } from '../../src/core/platform'
import { fakePlatform } from '../../src/core/platform-fake'
import { planWorkspaceFlowPublication } from '../../src/renderer/lib/workspaceFlowPublication'
import { flowToNodeStates, nodeStatesToFlow, type CanvasNode } from '../../src/renderer/state/workspace'
import { IPC } from '../../src/shared/ipc'
import type { CanvasNodeState, Project, Workspace } from '../../src/shared/types'

it('adopts authenticated operator closes after DOM measurement, saves surviving edits and preserves true conflicts', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-auto-refresh-'))
  let stop: (() => Promise<void>) | undefined, socket: WebSocket | undefined
  const node = (id: string): CanvasNodeState => ({ id, kind: 'sticky', title: id,
    color: '#0a84ff', group: null, text: 'Synthetic note', position: { x: 10.5, y: 20.25 },
    size: { width: 320.25, height: 200.25 } })
  try {
    initPlatform(fakePlatform({ userDataDir: root }))
    const store = new WorkspaceStore()
    await store.save({ version: 2, activeProjectId: 'fixture', projects: [{
      id: 'fixture', name: 'Synthetic canvas', color: '#0a84ff',
      viewport: { x: 150, y: 200, zoom: 0.75 }, nodes: [node('closed'), node('survivor'), node('conflict')]
    }] })
    resetPlatformForTests()
    const server = await startServer({ port: 0, host: '127.0.0.1', dataDir: root,
      rendererDir: path.join(root, 'no-renderer'), insecureHttp: false,
      passwordSeed: 'synthetic-refresh-password', installHooks: false, headless: false, deadCardReapMinutes: 0 })
    stop = server.close
    const base = `http://127.0.0.1:${server.port}`
    const token = (await fs.readFile(path.join(root, 'ops-token'), 'utf8')).trim()
    const login = await fetch(`${base}/auth/login`, { method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'password=synthetic-refresh-password' })
    socket = new WebSocket(`${base.replace('http:', 'ws:')}/ws`, {
      headers: { cookie: login.headers.get('set-cookie')!.split(';')[0] }
    })
    await new Promise<void>((resolve, reject) => { socket!.once('open', resolve); socket!.once('error', reject) })
    let id = 0
    const request = (method: string, ...args: unknown[]): Promise<any> => new Promise((resolve, reject) => {
      const requestId = ++id
      const timer = setTimeout(() => { socket!.off('message', receive); reject(new Error('RPC timeout')) }, 5000)
      const receive = (raw: WebSocket.RawData, binary: boolean) => {
        if (binary) return
        const message = JSON.parse(raw.toString())
        if (message.t !== 'res' || message.id !== requestId) return
        clearTimeout(timer); socket!.off('message', receive)
        if (message.ok) resolve(message.result)
        else reject(new Error(message.error.message))
      }
      socket!.on('message', receive)
      socket!.send(JSON.stringify({ t: 'req', id: requestId, method, args }))
    })
    const closeCard = async (cardId: string): Promise<Project> => {
      const publication = new Promise<Project>((resolve, reject) => {
        const timer = setTimeout(() => { socket!.off('message', receive); reject(new Error('Publication timeout')) }, 5000)
        const receive = (raw: WebSocket.RawData, binary: boolean) => {
          if (binary) return
          const message = JSON.parse(raw.toString())
          if (message.channel !== IPC.workspaceServerChange) return
          clearTimeout(timer); socket!.off('message', receive); resolve(message.args[0])
        }
        socket!.on('message', receive)
      })
      const response = await fetch(`${base}/opsapi/nodes/${cardId}?force=1`, {
        method: 'DELETE', headers: { authorization: `Bearer ${token}` }
      })
      expect(response.status).toBe(200)
      return publication
    }
    const local: Workspace = await request(IPC.workspaceLoad)
    const live = applyNodeChanges<CanvasNode>(local.projects[0].nodes.map(n => ({
      type: 'dimensions', id: n.id, dimensions: { width: 320, height: 200 }
    })), nodeStatesToFlow(local.projects[0].nodes))
    live[1].selected = true
    live[1].data.text = 'Synthetic unsaved surviving draft'
    const incoming = await closeCard('closed')
    const plan = planWorkspaceFlowPublication({ revision: local.revision, projects: local.projects,
      activeProjectId: 'fixture', nodes: live, change: incoming.workspaceChange })
    expect(plan.kind).toBe('adopt'); if (plan.kind !== 'adopt') throw new Error('Expected adoption')
    expect(plan.nodes.map(n => n.id)).toEqual(['survivor', 'conflict'])
    expect(plan.nodes[0].selected).toBe(true)
    expect(plan.nodes[0].data.text).toBe('Synthetic unsaved surviving draft')
    expect(plan.projects[0].viewport).toEqual(local.projects[0].viewport)
    await request(IPC.workspaceSave, { ...local, revision: plan.revision,
      projects: [{ ...plan.projects[0], nodes: flowToNodeStates(plan.nodes) }] })
    const reloaded: Workspace = await request(IPC.workspaceLoad)
    expect(reloaded.projects[0].nodes.map(n => n.id)).toEqual(['survivor', 'conflict'])
    expect(reloaded.projects[0].nodes[0].text).toBe('Synthetic unsaved surviving draft')
    expect(reloaded.projects[0].nodes[0].size).toEqual({ width: 320.25, height: 200.25 })
    const edited = nodeStatesToFlow(reloaded.projects[0].nodes)
    edited[1].data.text = 'Synthetic unsaved conflicting draft'
    const conflict = await closeCard('conflict')
    expect(planWorkspaceFlowPublication({ revision: reloaded.revision, projects: reloaded.projects,
      activeProjectId: 'fixture', nodes: edited, change: conflict.workspaceChange }))
      .toEqual({ kind: 'conflict', reason: 'overlapping-content' })
    expect(edited[1].data.text).toBe('Synthetic unsaved conflicting draft')
  } finally {
    socket?.terminate()
    await stop?.()
    resetPlatformForTests()
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 30_000)
