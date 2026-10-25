import { promises as fs } from 'node:fs'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { expect, it } from 'vitest'
import WebSocket from 'ws'
import { startServer } from '../../src/server/index'
import { IPC } from '../../src/shared/ipc'
import type { Workspace } from '../../src/shared/types'

// Explicit opt-in: this fixture only writes a private COPY of a project and its history.
const root = process.env.NODETERM_RECOVERY_BENCH_ROOT
it.skipIf(!root)('measures copied history through a disposable authenticated Server', async () => {
  if (!root || await fs.readFile(path.join(root, '.nodeterm-benchmark-copy'), 'utf8') !== 'private-copy\n')
    throw new Error('Benchmark requires an explicitly marked private project COPY')
  const dataDir = path.join(root, 'data'), cwd = path.join(root, 'project')
  await fs.mkdir(dataDir, { recursive: true })
  await fs.writeFile(path.join(dataDir, 'workspace.json'), JSON.stringify({ version: 3,
    activeProjectId: 'fixture', entries: [{ id: 'fixture', name: 'Fixture', color: '#888888', cwd,
      viewport: { x: 0, y: 0, zoom: 1 } }] }))
  const started = performance.now()
  const server = await startServer({ port: 0, host: '127.0.0.1', dataDir,
    rendererDir: path.join(root, 'no-renderer'), insecureHttp: false,
    passwordSeed: 'private-benchmark-password', installHooks: false, deadCardReapMinutes: 0 })
  let socket: WebSocket | undefined
  try {
    const bootMs = performance.now() - started, base = `http://127.0.0.1:${server.port}`
    const login = await fetch(`${base}/auth/login`, { method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'password=private-benchmark-password' })
    expect(login.status).toBe(303)
    socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, {
      headers: { cookie: login.headers.get('set-cookie')!.split(';')[0] } })
    await new Promise<void>((resolve, reject) => { socket!.once('open', resolve); socket!.once('error', reject) })
    let id = 0
    const request = (method: string, ...args: unknown[]): Promise<any> => new Promise((resolve, reject) => {
      const requestId = ++id
      const timer = setTimeout(() => { socket!.off('message', receive); reject(new Error('Benchmark RPC timed out')) }, 120_000)
      const receive = (data: WebSocket.RawData, binary: boolean) => {
        if (binary) return
        const message = JSON.parse(data.toString())
        if (message.t !== 'res' || message.id !== requestId) return
        clearTimeout(timer); socket!.off('message', receive)
        if (message.ok) resolve(message.result); else reject(new Error(message.error.message))
      }
      socket!.on('message', receive)
      socket!.send(JSON.stringify({ t: 'req', id: requestId, method, args }))
    })
    const loadStart = performance.now()
    const workspace: Workspace = await request(IPC.workspaceLoad)
    const loadMs = performance.now() - loadStart
    const project = workspace.projects[0]
    expect(project.unavailable).not.toBe(true)
    project.nodes.push({ id: `benchmark-${Date.now()}`, kind: 'sticky', title: 'Benchmark',
      color: '#888888', group: null, text: 'Synthetic benchmark', position: { x: 0, y: 0 }, size: { width: 200, height: 100 } })
    const saveStart = performance.now()
    await request(IPC.workspaceSave, workspace)
    const saveMs = performance.now() - saveStart
    const token = (await fs.readFile(path.join(dataDir, 'ops-token'), 'utf8')).trim()
    const removalStart = performance.now()
    const removal = await fetch(`${base}/opsapi/nodes/${project.nodes.at(-1)!.id}?force=1`, {
      method: 'DELETE', headers: { authorization: `Bearer ${token}` } })
    expect(removal.status).toBe(200)
    const removeMs = performance.now() - removalStart
    const reloaded: Workspace = await request(IPC.workspaceLoad)
    expect(reloaded.projects[0].nodes.some(n => n.id === project.nodes.at(-1)!.id)).toBe(false)
    await fs.writeFile(path.join(root, 'metrics.json'), JSON.stringify({ bootMs, loadMs, saveMs, removeMs }, null, 2))
  } finally { socket?.terminate(); await server.close() }
}, 240_000)
