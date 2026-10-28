import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'
import { expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { hookServer } from '../../src/core/agents/hook-server'
import { nodeAuthToken } from '../../src/core/agents/node-auth-token'
import { privateTmuxSocketReason } from '../../src/core/tmux-test-socket'
import { TMUX_SOCKET, sessionName } from '../../src/core/tmux-naming'
vi.mock('../../src/core/session-name-sweep', () => ({ startSessionNameSweep: () => () => {}, displayNodeTitle: (node: { title: string }) => node.title }))
import { startServer } from '../../src/server/index'
import { WorkspaceStore } from '../../src/core/workspace-store'
import { initPlatform, resetPlatformForTests } from '../../src/core/platform'
import { fakePlatform } from '../../src/core/platform-fake'
import { HeadlessNodeFactory } from '../../src/server/headless-node-factory'
import { IPC } from '../../src/shared/ipc'
import type { CanvasNodeState, Workspace } from '../../src/shared/types'

it.skipIf(process.platform === 'win32')('preserves Directors placement through rejected-save recovery', async () => {
  if (privateTmuxSocketReason() || !/^nt-vitest-\d+$/.test(TMUX_SOCKET)) throw new Error('unique-private-test-socket-required')
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-save-rpc-'))
  let stop: (() => Promise<void>) | undefined, socket: WebSocket | undefined
  const registration = vi.spyOn(HeadlessNodeFactory.prototype, 'onHookRegistration')
  const tmux = (...args: string[]) => execFileSync('tmux', ['-L', TMUX_SOCKET, ...args], { encoding: 'utf8', timeout: 4000, stdio: 'pipe' })
  const node = (id: string): CanvasNodeState => ({ id, kind: 'terminal', title: id, titleAuto: false,
    color: '#0a84ff', group: null, position: { x: 10, y: 20 }, size: { width: 320, height: 200 } })
  try {
    initPlatform(fakePlatform({ userDataDir: root }))
    const store = new WorkspaceStore()
    const seed: Workspace = { version: 2, activeProjectId: 'fixture', projects: [{
      id: 'fixture', name: 'Fixture', color: '#0a84ff', cwd: path.join(root, 'project'),
      viewport: { x: 0, y: 0, zoom: 1 }, nodes: [node('saved')], kanban: { columns: [{ id: 'directors', title: 'Directors', color: '#888' }], assignments: [] }
    }] }
    await store.save(seed)
    // A distinct live saved session keeps the sweep's healthy-backend guard exercised.
    execFileSync('tmux', ['-L', TMUX_SOCKET, 'new-session', '-d', '-s', sessionName('saved'), '-c', seed.projects[0].cwd!, 'sleep', '600'])
    execFileSync('tmux', ['-L', TMUX_SOCKET, 'new-session', '-d', '-s', sessionName('term-operator-boot-orphan'), '-c', seed.projects[0].cwd!, 'sleep', '600'])
    resetPlatformForTests()
    const server = await startServer({ port: 0, host: '127.0.0.1', dataDir: root,
      rendererDir: path.join(root, 'no-renderer'), insecureHttp: false,
      passwordSeed: 'synthetic-save-password', installHooks: false, headless: false, canvasControl: true, deadCardReapMinutes: 0 })
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
    const snapshot: Workspace = await request(IPC.workspaceLoad)
    expect(snapshot.projects[0].nodes.some(n => n.id === 'term-operator-boot-orphan')).toBe(false)
    execFileSync('tmux', ['-L', TMUX_SOCKET, 'has-session', '-t', sessionName('term-operator-boot-orphan')])
    const card = { ...node('term-operator-recovery'), title: 'Original operator work' }
    snapshot.projects[0].nodes.push(card)
    snapshot.projects[0].kanban!.assignments.push({ nodeId: card.id, columnId: 'directors' })
    snapshot.projects[0].kanban!.manualAssignments = { [card.id]: true }
    const created = await request(IPC.ptyCreate, { cols: 80, rows: 24, cwd: seed.projects[0].cwd,
      persistKey: card.id, ownerProjectId: 'fixture' })
    expect(created.fresh).toBe(true)
    const pane = (nodeId = card.id) => tmux('list-panes', '-t', '=' + sessionName(nodeId), '-F', '#{pane_id}:#{pane_pid}')
    const waitForPane = async (nodeId: string) => {
      await expect.poll(() => { try { return pane(nodeId) } catch { return '' } }).toMatch(/^%\d+:\d+/)
      return pane(nodeId)
    }
    const detach = async (sessionId: string, nodeId: string) => {
      socket!.send(JSON.stringify({ t: 'cast', method: IPC.ptyKill, args: [sessionId] }))
      // Observe the real client departure. A fixed sleep races native tmux startup under load.
      await expect.poll(() => tmux('list-clients', '-t', '=' + sessionName(nodeId), '-F', '#{client_pid}')).toBe('')
    }
    const paneBefore = await waitForPane(card.id)
    const opsToken = (await fs.readFile(path.join(root, 'ops-token'), 'utf8')).trim()
    const changed = await fetch(`http://127.0.0.1:${server.port}/opsapi/nodes/saved?force=1`, { method: 'PATCH',
      headers: { authorization: `Bearer ${opsToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Internal update' }) })
    expect(changed.status).toBe(200)
    await expect(request(IPC.workspaceSave, snapshot)).rejects.toThrow('workspace_conflict')
    const hook = async (nodeId = card.id) => {
      const callsBefore = registration.mock.calls.length
      const response = await fetch(`http://127.0.0.1:${hookServer.getPort()}/hook/claude`, {
        method: 'POST', headers: { 'X-Nodeterm-Hook-Token': hookServer.getToken(),
          'X-Nodeterm-Node-Token': nodeAuthToken(hookServer.nodeAuthSecretOrNull()!, nodeId),
          'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ nodeId, payload: JSON.stringify({ hook_event_name: 'Stop', session_id: 'synthetic-operator', is_interrupt: false }) }).toString()
      })
      expect(response.status).toBe(204)
      // HTTP acknowledgment does not await the queued recovery. Await the actual production
      // registration promise without replacing its behavior or relying on a quiet-time sleep.
      const callIndex = () => registration.mock.calls.findIndex((call, index) => index >= callsBefore && call[1] === nodeId)
      await expect.poll(callIndex).toBeGreaterThanOrEqual(0)
      await registration.mock.results[callIndex()].value
    }
    await hook()
    expect((await request(IPC.workspaceLoad) as Workspace).projects[0].nodes.some(n => n.id === card.id)).toBe(false)
    // Rejected saves cannot leave this card memory-only indefinitely while its tab stays open.
    await expect.poll(async () => (await request(IPC.workspaceLoad) as Workspace).projects[0].nodes.find(n => n.id === card.id),
      { timeout: 15_000 }).toMatchObject(card)
    expect(tmux('list-clients', '-t', '=' + sessionName(card.id), '-F', '#{client_pid}').trim()).not.toBe('')
    expect(pane()).toBe(paneBefore)
    await detach(created.sessionId, card.id)
    await hook()
    await expect.poll(async () => (await request(IPC.workspaceLoad) as Workspace).projects[0].nodes.find(n => n.id === card.id)).toMatchObject(card)
    const reloaded: Workspace = await request(IPC.workspaceLoad)
    const persisted = await new WorkspaceStore().load({ sideline: false })
    expect(pane()).toBe(paneBefore)
    expect(reloaded.projects[0].kanban!.assignments).toContainEqual({ nodeId: card.id, columnId: 'directors' })
    expect(persisted.projects[0].kanban!.assignments).toContainEqual({ nodeId: card.id, columnId: 'directors' })
    await expect(request(IPC.workspaceSave, snapshot)).rejects.toThrow('workspace_conflict')
    const afterStale: Workspace = await request(IPC.workspaceLoad)
    expect(afterStale.projects[0].nodes.find(n => n.id === card.id)).toMatchObject(card)
    expect(afterStale.projects[0].kanban!.assignments).toContainEqual({ nodeId: card.id, columnId: 'directors' })

    // A backend alone cannot reconstruct original operator metadata. Keep it pending and alive.
    const unknownId = 'term-operator-unobserved'
    const unknown = await request(IPC.ptyCreate, { cols: 80, rows: 24, cwd: seed.projects[0].cwd,
      persistKey: unknownId, ownerProjectId: 'fixture' })
    const unknownPaneBefore = await waitForPane(unknownId)
    await detach(unknown.sessionId, unknownId)
    await hook(unknownId)
    expect((await request(IPC.workspaceLoad) as Workspace).projects[0].nodes.some(n => n.id === unknownId)).toBe(false)
    expect(pane(unknownId)).toBe(unknownPaneBefore)
    // A real operator backend can exit without authorizing either cleanup pass to delete its card.
    tmux('kill-session', '-t', '=' + sessionName(card.id))
    for (let pass = 0; pass < 2; pass++) {
      const response = await fetch(`http://127.0.0.1:${server.port}/opsapi/sweep`, {
        method: 'POST', headers: { authorization: `Bearer ${opsToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ dryRun: false })
      })
      expect(response.status).toBe(200)
      expect((await response.json()).affectedIds).not.toContain(card.id)
    }
    const afterSweep = await new WorkspaceStore().load({ sideline: false })
    expect(afterSweep.projects[0].nodes.find(n => n.id === card.id)).toMatchObject(card)
    expect(afterSweep.projects[0].kanban!.assignments).toContainEqual({ nodeId: card.id, columnId: 'directors' })
    const exited = await request(IPC.ptyCreate, { cols: 80, rows: 24, persistKey: card.id, ownerProjectId: 'fixture' })
    expect(exited).toMatchObject({ sessionId: '', fresh: false, deadCard: true })
  } finally {
    try { execFileSync('tmux', ['-L', TMUX_SOCKET, 'kill-session', '-t', sessionName('saved')], { stdio: 'ignore' }) } catch {}
    try { execFileSync('tmux', ['-L', TMUX_SOCKET, 'kill-session', '-t', sessionName('term-operator-recovery')], { stdio: 'ignore' }) } catch {}
    try { execFileSync('tmux', ['-L', TMUX_SOCKET, 'kill-session', '-t', sessionName('term-operator-unobserved')], { stdio: 'ignore' }) } catch {}
    try { execFileSync('tmux', ['-L', TMUX_SOCKET, 'kill-session', '-t', sessionName('term-operator-boot-orphan')], { stdio: 'ignore' }) } catch {}
    socket?.terminate()
    await stop?.()
    registration.mockRestore()
    resetPlatformForTests()
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 60_000)
