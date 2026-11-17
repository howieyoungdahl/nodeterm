import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'
import { expect, it, vi } from 'vitest'
import { execFileSync } from 'node:child_process'
import { privateTmuxSocketReason } from '../../src/core/tmux-test-socket'
import { TMUX_SOCKET, sessionName } from '../../src/core/tmux-naming'
vi.mock('../../src/core/session-name-sweep', () => ({ startSessionNameSweep: () => () => {}, displayNodeTitle: (node: { title: string }) => node.title }))
import { startServer } from '../../src/server/index'
import { WorkspaceStore } from '../../src/core/workspace-store'
import { initPlatform, resetPlatformForTests } from '../../src/core/platform'
import { fakePlatform } from '../../src/core/platform-fake'
import { IPC } from '../../src/shared/ipc'
import type { CanvasNodeState, Workspace } from '../../src/shared/types'

/**
 * Field 2026-11-17 on a disposable Server: a browser tab sat behind the Reload/Keep-mine bar for
 * 64 minutes, so it sent NO saves. A card it opened (a live tmux pane) never reached the file and
 * a page refresh lost it. Before the fix nothing a suspended tab could send reached the Server;
 * now its presentation-only report lets the Server persist the card while the tab stays attached.
 */
it.skipIf(process.platform === 'win32')('persists a card opened behind a suspended tab from its report, without any save', async () => {
  if (privateTmuxSocketReason() || !/^nt-vitest-\d+$/.test(TMUX_SOCKET)) throw new Error('unique-private-test-socket-required')
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-suspended-tab-'))
  let stop: (() => Promise<void>) | undefined, socket: WebSocket | undefined
  const node = (id: string): CanvasNodeState => ({ id, kind: 'terminal', title: id, titleAuto: false,
    color: '#0a84ff', group: null, position: { x: 10, y: 20 }, size: { width: 320, height: 200 } })
  const card = { ...node('term-opened-behind-bar'), title: 'CI/CD takeover from test session' }
  try {
    initPlatform(fakePlatform({ userDataDir: root }))
    const seed: Workspace = { version: 2, activeProjectId: 'fixture', projects: [{
      id: 'fixture', name: 'Fixture', color: '#0a84ff', cwd: path.join(root, 'project'),
      viewport: { x: 0, y: 0, zoom: 1 }, nodes: [node('saved')] }] }
    await new WorkspaceStore().save(seed)
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
    socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, { headers: { cookie: login.headers.get('set-cookie')!.split(';')[0] } })
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
    const onDisk = async () => (await new WorkspaceStore().load({ sideline: false })).projects[0].nodes.find(n => n.id === card.id)

    // The tab holds the card and its live pane but, behind the bar, never saves.
    const snapshot: Workspace = await request(IPC.workspaceLoad)
    snapshot.projects[0].nodes.push(card)
    const created = await request(IPC.ptyCreate, { cols: 80, rows: 24, cwd: seed.projects[0].cwd, persistKey: card.id, ownerProjectId: 'fixture' })
    expect(created.fresh).toBe(true)
    await expect.poll(() => { try { return execFileSync('tmux', ['-L', TMUX_SOCKET, 'has-session', '-t', '=' + sessionName(card.id)]) && true } catch { return false } }).toBe(true)

    // Before the fix this is the whole story: well past the Server's 10 s grace, still not saved,
    // so a refresh (a fresh load of the file) shows no card while its pane keeps running.
    await new Promise(resolve => setTimeout(resolve, 11_000))
    expect(await onDisk()).toBeUndefined()

    // The suspended tab's report: presentation only, never a save.
    await request(IPC.workspaceObserve, snapshot, 'conflict bar open (overlapping-content)')
    await expect.poll(onDisk, { timeout: 15_000, interval: 250 }).toMatchObject(card)
    const reloaded: Workspace = await request(IPC.workspaceLoad)
    expect(reloaded.projects[0].nodes.map(n => n.id)).toEqual(['saved', card.id])
    // The report wrote nothing of its own: the stale snapshot's revision is still refused.
    await expect(request(IPC.workspaceSave, { ...snapshot, projects: [{ ...snapshot.projects[0], nodes: [node('saved')] }] }))
      .rejects.toThrow('workspace_conflict')
    execFileSync('tmux', ['-L', TMUX_SOCKET, 'has-session', '-t', '=' + sessionName(card.id)])
  } finally {
    try { execFileSync('tmux', ['-L', TMUX_SOCKET, 'kill-session', '-t', '=' + sessionName(card.id)], { stdio: 'ignore' }) } catch { /* gone */ }
    socket?.terminate(); await stop?.(); resetPlatformForTests()
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 60_000)
