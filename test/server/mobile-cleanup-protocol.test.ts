import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'
import { expect, it, vi } from 'vitest'
import { IPC } from '../../src/shared/ipc'
import { startServer } from '../../src/server/index'
import { TMUX_SOCKET, sessionName } from '../../src/core/tmux-naming'
import { cleanupHash } from '../../src/core/session-cleanup'
import type { Workspace } from '../../src/shared/types'

// A protocol fixture has no provider transcript to name. Keep that unrelated
// background reader away from the operator's installed provider homes.
vi.mock('../../src/core/session-name-sweep', () => ({ startSessionNameSweep: () => () => {},
  displayNodeTitle: (node: { title: string }) => node.title }))

it.skipIf(process.platform !== 'linux')('round trips an archive through authenticated legacy mobile WS-RPC saves and undo', async () => {
  expect(TMUX_SOCKET).toBe(`nt-vitest-${process.pid}`)
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-mobile-cleanup-'))
  const id = `term-${randomUUID()}`, other = `term-${randomUUID()}`, name = sessionName(id)
  const call = (...args: string[]) => execFileSync('tmux', ['-L', TMUX_SOCKET, ...args], { encoding: 'utf8', timeout: 4000 })
  let close: (() => Promise<void>) | undefined, ws: WebSocket | undefined
  try {
    const script = path.join(dir, 'history.sh')
    await fs.writeFile(script, "printf 'mobile history retained\\n'\nexec sleep 600\n")
    const pane = call('new-session', '-d', '-P', '-F', '#{pane_id}', '-s', name, 'sh', script).trim()
    await expect.poll(() => call('capture-pane', '-p', '-S', '-', '-t', pane)).toContain('mobile history retained')
    const node = (nodeId: string) => ({ id: nodeId, kind: 'terminal' as const, title: nodeId, titleAuto: false,
      color: '#888', group: null, position: { x: 0, y: 0 }, size: { width: 640, height: 440 } })
    const workspace: Workspace = { version: 2, activeProjectId: 'mobile-fixture', projects: [{
      id: 'mobile-fixture', name: 'Mobile fixture', color: '#888', viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [{ ...node(id), agentId: 'codex', agentModel: 'gpt-6.1-sol', agentSessionId: 'fixture-session',
        pinned: true, manualPlacement: true }, node(other)],
      kanban: { columns: [{ id: 'manual', title: 'Manual', color: '#888' }],
        assignments: [{ nodeId: other, columnId: 'manual' }, { nodeId: id, columnId: 'manual' }],
        manualAssignments: { [id]: 'manual' }, manualAssignmentVersions: { [id]: 'operator-choice' } }
    }] }
    await fs.writeFile(path.join(dir, 'workspace.json'), JSON.stringify(workspace))
    await fs.writeFile(path.join(dir, 'node-ownership.json'), JSON.stringify({ v: 1, owners: {
      [id]: { sourceNodeId: 'ops-operator', projectId: 'mobile-fixture', recordedAt: Date.now() }
    } }), { mode: 0o600 })
    const server = await startServer({ port: 0, host: '127.0.0.1', dataDir: dir,
      rendererDir: path.join(dir, 'no-renderer'), passwordSeed: 'synthetic-mobile-only',
      installHooks: false, headless: false, deadCardReapMinutes: 0, insecureHttp: false })
    close = server.close
    const base = `http://127.0.0.1:${server.port}`
    const token = (await fs.readFile(path.join(dir, 'ops-token'), 'utf8')).trim()
    const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
    const get = async (route: string) => { const r = await fetch(base + route, { headers }); expect(r.status).toBe(200); return r.json() }
    const post = async (route: string, body: unknown) => {
      const r = await fetch(base + route, { method: 'POST', headers, body: JSON.stringify(body) })
      expect(r.status, await r.clone().text()).toBe(200); return r.json()
    }
    const login = await fetch(base + '/auth/login', { method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'password=synthetic-mobile-only' })
    expect(login.status).toBe(303)
    ws = new WebSocket(base.replace('http:', 'ws:') + '/ws', { headers: { cookie: login.headers.get('set-cookie')!.split(';')[0] } })
    await new Promise<void>((resolve, reject) => { ws!.once('open', resolve); ws!.once('error', reject) })
    const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>()
    const events: any[] = []
    ws.on('message', (data, binary) => {
      if (binary) return
      const message = JSON.parse(String(data))
      if (message.t === 'ev') events.push(message)
      else if (message.t === 'res') {
        const p = pending.get(message.id); pending.delete(message.id)
        if (message.ok) p?.resolve(message.result); else p?.reject(new Error(message.error.message))
      }
    })
    let sequence = 0
    const rpc = (method: string, ...args: unknown[]): Promise<any> => new Promise((resolve, reject) => {
      const key = ++sequence; pending.set(key, { resolve, reject })
      ws!.send(JSON.stringify({ t: 'req', id: key, method, args }))
    })
    // An ordinary mobile save migrates the legacy index before retained cleanup.
    await rpc(IPC.workspaceSave, await rpc(IPC.workspaceLoad))
    const stale: Workspace = await rpc(IPC.workspaceLoad)
    const beforePane = call('list-panes', '-s', '-t', '=' + name, '-F', '#{pane_id}:#{pane_pid}')
    const history = call('capture-pane', '-p', '-S', '-', '-t', pane)
    const preview = await get('/opsapi/cleanup/preview'), row = preview.plan.rows.find((r: any) => r.nodeId === id)
    const review = await post('/opsapi/cleanup/reviewed-preview', { projectId: 'mobile-fixture', entries: [{
      nodeId: id, disposition: 'obsolete-superseded', evidenceDigest: cleanupHash('synthetic mobile task receipt'),
      ownerDigest: row.reviewedFence.ownerDigest
    }] })
    const archived = await post('/opsapi/cleanup/archive', { planId: review.plan.id, nodeIds: [id] })
    await expect(rpc(IPC.workspaceSave, stale)).rejects.toThrow()
    const visibleIds = (w: Workspace) => w.projects[0].nodes.filter(n => !n.cleanupArchiveId).map(n => n.id)
    let current: Workspace = await rpc(IPC.workspaceLoad)
    expect(visibleIds(current)).toEqual([other])
    expect(current.projects[0].nodes[0].cleanupArchiveId).toBe(archived.receipt.id)
    const board = current.projects[0].kanban
    for (const omit of [false, true]) {
      const legacy: Workspace = structuredClone(current)
      for (const n of legacy.projects[0].nodes) delete n.cleanupArchiveId
      if (omit) legacy.projects[0].nodes = legacy.projects[0].nodes.filter(n => n.id !== id)
      legacy.projects[0].nodes.find(n => n.id === other)!.title = 'legacy phone edit ' + omit
      const ack = await rpc(IPC.workspaceSave, legacy)
      current = await rpc(IPC.workspaceLoad)
      expect(ack.revision).toBe(current.revision)
      expect(visibleIds(current)).toEqual([other])
      expect(current.projects[0].nodes.map(n => n.id)).toEqual([id, other])
      expect(current.projects[0].nodes[0]).toMatchObject({ cleanupArchiveId: archived.receipt.id,
        agentSessionId: 'fixture-session', agentModel: 'gpt-6.1-sol', pinned: true, manualPlacement: true })
      expect(current.projects[0].kanban).toEqual(board)
    }
    await post('/opsapi/cleanup/undo', { receiptId: archived.receipt.id })
    const restored: Workspace = await rpc(IPC.workspaceLoad)
    expect(visibleIds(restored)).toEqual([id, other])
    expect(restored.projects[0].nodes[1].title).toBe('legacy phone edit true')
    expect(restored.projects[0].kanban).toEqual(board)
    await expect.poll(() => events.filter(e => e.channel === IPC.workspaceServerChange).length).toBe(2)
    const publications = events.filter(e => e.channel === IPC.workspaceServerChange).map(e => e.args[0])
    expect(publications[0].nodes.find((n: any) => n.id === id).cleanupArchiveId).toBe(archived.receipt.id)
    expect(publications[0].workspaceChange.before).toBe(stale.revision)
    expect(publications[1].workspaceChange.before).toBe(current.revision)
    expect(publications[1].workspaceChange.after).toBe(restored.revision)
    expect(publications[1].workspaceChange.changes[0].after.nodes).toEqual(restored.projects[0].nodes)
    expect(call('list-panes', '-s', '-t', '=' + name, '-F', '#{pane_id}:#{pane_pid}')).toBe(beforePane)
    expect(call('capture-pane', '-p', '-S', '-', '-t', pane)).toBe(history)
  } finally {
    ws?.terminate(); await close?.()
    try { call('kill-session', '-t', '=' + name) } catch { /* fixture might have exited */ }
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 30000)
