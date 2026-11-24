import { promises as fs } from 'node:fs'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import WebSocket, { WebSocketServer } from 'ws'
import { expect, it, vi } from 'vitest'
import { hookServer } from '../../src/core/agents/hook-server'
import { nodeAuthToken } from '../../src/core/agents/node-auth-token'
import { privateTmuxSocketReason } from '../../src/core/tmux-test-socket'
import { resetPlatformForTests } from '../../src/core/platform'
import { buildRealApi, RpcClient } from '../../src/renderer/bridge/ws-bridge'
import { canAutoSyncSessionTitle, syncSessionTitle } from '../../src/renderer/lib/sessionTitleSync'
import { mergeWorkspacePublication } from '../../src/renderer/lib/workspacePublication'
import { useProjects } from '../../src/renderer/state/projects'
import type { ServerControlReply } from '../../src/server/headless-node-factory'
import { startServer } from '../../src/server/index'
import type { CanvasNodeState, Project, Workspace } from '../../src/shared/types'

// The disposable Codex fixture speaks over a Unix socket and launches on private tmux.
it.skipIf(process.platform === 'win32' || !!privateTmuxSocketReason())('adopts a Codex thread name and preserves a canvas rename across an overlapping tab save', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-title-'))
  const codex = createServer()
  const codexWs = new WebSocketServer({ server: codex })
  const appServerDir = path.join(root, 'app-server-control')
  const threadId = 'disposable-codex-thread'
  const threadName = 'Review the test workspace'
  const manualTitle = 'My hand title'
  let close: (() => Promise<void>) | undefined
  let browser: WebSocket | undefined
  let removeCard: (() => Promise<unknown>) | undefined
  try {
    await fs.mkdir(appServerDir)
    vi.stubEnv('CODEX_HOME', root)
    await new Promise<void>((resolve, reject) => {
      codex.once('error', reject)
      codex.listen(path.join(appServerDir, 'app-server-control.sock'), resolve)
    })
    codexWs.on('connection', socket => {
      socket.on('message', raw => {
        const request = JSON.parse(raw.toString())
        if (request.method === 'initialize') socket.send(JSON.stringify({ id: request.id, result: {} }))
        if (request.method === 'thread/read' && request.params.threadId === threadId) {
          socket.send(JSON.stringify({ id: request.id, result: { thread: { id: threadId, name: threadName } } }))
        }
      })
    })
    const node: CanvasNodeState = {
      id: 'source', kind: 'terminal', title: 'Fixture launcher', agentId: 'claude',
      color: '#888888', group: null, tags: [], position: { x: 0, y: 0 }, size: { width: 640, height: 440 }
    }
    const project: Project = {
      id: 'fixture', name: 'Fixture', cwd: root, color: '#888888',
      viewport: { x: 0, y: 0, zoom: 1 }, nodes: [node]
    }
    const workspace: Workspace = { version: 2, activeProjectId: project.id, projects: [project] }
    await fs.writeFile(path.join(root, 'workspace.json'), JSON.stringify(workspace))
    await fs.writeFile(path.join(root, 'settings.json'), JSON.stringify({
      agentLaunchCommands: { codex: 'printf disposable-codex' }
    }))
    const server = await startServer({
      port: 0, host: '127.0.0.1', dataDir: root, rendererDir: path.join(root, 'no-renderer'),
      insecureHttp: false, passwordSeed: 'disposable-title-password', canvasControl: true,
      installHooks: false, deadCardReapMinutes: 0, headless: false
    })
    close = server.close
    const secret = hookServer.nodeAuthSecretOrNull()!
    const control = async (verb: string, args: Record<string, string>): Promise<ServerControlReply> => {
      const body = new URLSearchParams({ nodeId: node.id })
      for (const [key, value] of Object.entries(args)) body.set(`arg.${key}`, value)
      const response = await fetch(`http://127.0.0.1:${hookServer.getPort()}/control/${verb}`, {
        method: 'POST',
        headers: {
          'X-Nodeterm-Hook-Token': hookServer.getToken(),
          'X-Nodeterm-Node-Token': nodeAuthToken(secret, node.id),
          accept: 'application/json'
        },
        body,
        signal: AbortSignal.timeout(10_000)
      })
      return response.json()
    }
    const opened = await control('open-agent', {
      agent: 'codex', prompt: 'probe', 'task-id': 'test-title',
      'creation-id': 'test-title-card', owner: 'Test', workstream: 'test',
      'functional-role': 'review', 'organization-project': project.id
    })
    expect(opened.result, JSON.stringify(opened)).toMatchObject({ id: expect.stringMatching(/^term-/) })
    const cardId = (opened.result as { id: string }).id
    removeCard = () => control('close', { node: cardId })
    const login = await fetch(`http://127.0.0.1:${server.port}/auth/login`, {
      method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'password=disposable-title-password'
    })
    expect(login.status).toBe(303)
    const socket = browser = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, {
      headers: { cookie: login.headers.get('set-cookie')!.split(';')[0] }
    })
    const connected = new Promise<void>((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    const client = new RpcClient({
      send: json => socket.send(json), ready: () => connected,
      onMessage: cb => { socket.on('message', (raw, binary) => cb(binary ? new Uint8Array(raw as Buffer) : raw.toString())) },
      onClose: cb => { socket.on('close', cb) }
    })
    await client.ready()
    const api = buildRealApi(client)
    const tab = await api.workspace.load()
    useProjects.getState().hydrate(tab)
    const tabNode = tab.projects[0].nodes.find(candidate => candidate.id === cardId)!
    expect(tabNode).toMatchObject({ titleAuto: true, agentId: 'codex' })
    // The open tab has an automatic title and a local move queued for its next save.
    await syncSessionTitle(
      () => canAutoSyncSessionTitle(project.id, cardId, tabNode.titleAuto === true),
      () => api.pty.readSessionName(threadId, undefined, 'codex'),
      title => { tabNode.title = title }
    )
    expect(tabNode.title).toBe(threadName)
    tabNode.position.x = 125

    const publication = new Promise<Project>(resolve => api.workspace.onServerChange(resolve))
    const renamed = await control('rename', { node: cardId, title: manualTitle })
    expect(renamed.ok, JSON.stringify(renamed)).toBe(true)
    const incoming = await publication

    await expect(api.workspace.save(tab)).rejects.toThrow('workspace_conflict')
    const merged = mergeWorkspacePublication(tab.revision, tab.projects, incoming.workspaceChange)
    expect(merged, JSON.stringify(merged)).toMatchObject({ kind: 'adopt', localEditsRemain: true })
    if (merged.kind !== 'adopt') throw new Error('Could not adopt the canvas rename')
    await api.workspace.save({ ...tab, projects: merged.projects, revision: merged.revision })
    const saved = (await api.workspace.load()).projects[0].nodes.find(candidate => candidate.id === cardId)
    expect(saved).toMatchObject({ title: manualTitle, titleAuto: false, position: { x: 125 } })
  } finally {
    browser?.terminate()
    try { await removeCard?.() } finally { await close?.() }
    resetPlatformForTests()
    vi.unstubAllEnvs()
    for (const socket of codexWs.clients) socket.terminate()
    await new Promise<void>(resolve => codexWs.close(() => resolve()))
    await new Promise<void>(resolve => codex.close(() => resolve()))
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 30_000)
