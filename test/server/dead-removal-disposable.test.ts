import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { sessionName, TMUX_SOCKET } from '../../src/core/tmux-naming'
import { privateTmuxSocketReason } from '../../src/core/tmux-test-socket'
import type { Workspace } from '../../src/shared/types'

const optedIn = process.env.NODETERM_DEAD_REMOVAL_E2E === '1'
const isolationRoot = process.env.NODETERM_DEAD_REMOVAL_TEST_ROOT
const expectedHome = isolationRoot ? path.join(isolationRoot, 'home') : ''
const expectedXdg = (name: string) => isolationRoot ? path.join(isolationRoot, name) : ''
const expectedSocketDir = expectedXdg('tmux')
const expectedSocketPath = path.join(expectedSocketDir, `tmux-${process.getuid?.() ?? 'unknown'}`, TMUX_SOCKET)
const expectedRootChildren = ['home', 'tmux', 'xdg-cache', 'xdg-config', 'xdg-data']
const rootIsDisposable = !!isolationRoot &&
  path.basename(isolationRoot).startsWith('nodeterm-dead-removal-e2e.') &&
  fs.existsSync(isolationRoot) && fs.statSync(isolationRoot).isDirectory() &&
  (fs.statSync(isolationRoot).mode & 0o077) === 0 &&
  path.relative(os.tmpdir(), isolationRoot) !== '..' &&
  !path.relative(os.tmpdir(), isolationRoot).startsWith(`..${path.sep}`) &&
  JSON.stringify(fs.readdirSync(isolationRoot).sort()) === JSON.stringify(expectedRootChildren) &&
  path.resolve(isolationRoot) === fs.realpathSync(isolationRoot)
const isolated = rootIsDisposable &&
  path.resolve(process.env.HOME || '') === path.resolve(expectedHome) &&
  path.resolve(os.homedir()) === path.resolve(expectedHome) &&
  path.resolve(process.env.XDG_CONFIG_HOME || '') === path.resolve(expectedXdg('xdg-config')) &&
  path.resolve(process.env.XDG_DATA_HOME || '') === path.resolve(expectedXdg('xdg-data')) &&
  path.resolve(process.env.XDG_CACHE_HOME || '') === path.resolve(expectedXdg('xdg-cache')) &&
  path.resolve(process.env.TMUX_TMPDIR || '') === path.resolve(expectedSocketDir) &&
  TMUX_SOCKET === process.env.NODETERM_TMUX_SOCKET &&
  /^nt-dead-e2e-[A-Za-z0-9-]+$/.test(TMUX_SOCKET) &&
  !privateTmuxSocketReason() &&
  !fs.existsSync(expectedSocketPath)
if (!optedIn) console.warn('[skip] disposable dead-removal HTTP test requires NODETERM_DEAD_REMOVAL_E2E=1 and isolated paths')

describe.skipIf(!optedIn)('disposable strict dead removal HTTP route', () => {
  const runId = randomUUID().slice(0, 12)
  const deadId = `dead-${runId}`
  const liveId = `live-${runId}`
  const unrelatedId = `other-${runId}`
  const createdSessions: string[] = []
  let dataDir = ''
  let projectDir = ''
  let base = ''
  let token = ''
  let close: (() => Promise<void>) | undefined

  const tmux = (...args: string[]) => execFileSync('tmux', ['-L', TMUX_SOCKET, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 5_000
  })
  const hasSession = (id: string) => {
    try { tmux('has-session', '-t', `=${sessionName(id)}`); return true }
    catch { return false }
  }

  beforeAll(async () => {
    if (!isolated) throw new Error('explicit disposable dead-removal run requires a fresh isolated HOME/XDG/TMUX_TMPDIR and private socket')
    const { startServer } = await import('../../src/server/index')
    dataDir = fs.mkdtempSync(path.join(isolationRoot!, 'data-'))
    projectDir = fs.mkdtempSync(path.join(isolationRoot!, 'project-'))
    const card = (id: string) => ({
      id, kind: 'terminal' as const, position: { x: 0, y: 0 }, size: { width: 640, height: 440 },
      title: id, color: '#d97757', group: null
    })
    const projectId = `dead-route-${runId}`
    const workspace: Workspace = {
      version: 2, activeProjectId: projectId, projects: [{
        id: projectId, name: 'Disposable dead route', color: '#0a84ff', cwd: projectDir,
        viewport: { x: 0, y: 0, zoom: 1 }, nodes: [card(deadId), card(liveId), card(unrelatedId)],
        bridges: [], ropes: []
      }]
    }
    fs.writeFileSync(path.join(dataDir, 'workspace.json'), JSON.stringify(workspace))
    fs.writeFileSync(path.join(dataDir, 'node-ownership.json'), JSON.stringify({ v: 1, owners: {
      [liveId]: { sourceNodeId: 'ops-operator', projectId, recordedAt: Date.now() }
    }}))

    for (const id of [liveId, unrelatedId]) {
      tmux('new-session', '-d', '-s', sessionName(id))
      createdSessions.push(id)
    }
    const server = await startServer({ port: 0, host: '127.0.0.1', dataDir,
      rendererDir: path.join(dataDir, 'no-renderer'), insecureHttp: false,
      passwordSeed: 'disposable-dead-route-password', installHooks: false, headless: false,
      deadCardReapMinutes: 0 })
    close = server.close
    base = `http://127.0.0.1:${server.port}`
    token = fs.readFileSync(path.join(dataDir, 'ops-token'), 'utf8').trim()
  }, 30_000)

  afterAll(async () => {
    try {
      await close?.()
    } finally {
      for (const id of createdSessions) {
        try { tmux('kill-session', '-t', `=${sessionName(id)}`) } catch { /* already absent */ }
      }
      if (createdSessions.length) {
        try { fs.rmSync(expectedSocketPath, { force: true }) } catch { /* exact owned socket path in scratch tmux dir */ }
      }
      if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true })
      if (projectDir) fs.rmSync(projectDir, { recursive: true, force: true })
    }
  })

  it('rejects a live operator-owned target and removes only the confirmed dead card over HTTP', async () => {
    expect(hasSession(liveId)).toBe(true)
    expect(hasSession(unrelatedId)).toBe(true)
    const headers = { authorization: `Bearer ${token}` }
    const liveResponse = await fetch(`${base}/opsapi/dead-nodes/${liveId}`, { method: 'DELETE', headers })
    expect(liveResponse.status).toBe(409)
    expect(await liveResponse.json()).toMatchObject({ error: 'pane_alive', paneState: 'alive' })
    expect(hasSession(liveId)).toBe(true)

    const deadResponse = await fetch(`${base}/opsapi/dead-nodes/${deadId}`, { method: 'DELETE', headers })
    expect(deadResponse.status).toBe(200)
    expect(await deadResponse.json()).toEqual({ ok: true, removedIds: [deadId], forced: false })
    expect(hasSession(unrelatedId)).toBe(true)
    const index = JSON.parse(fs.readFileSync(path.join(dataDir, 'workspace.json'), 'utf8'))
    expect(index.version).toBe(3)
    const { WorkspaceStore } = await import('../../src/core/workspace-store')
    const reloaded = await new WorkspaceStore().load({ sideline: false })
    const persistedProject = reloaded.projects.find((project) => project.id === index.activeProjectId)
    expect(persistedProject?.nodes.map((node) => node.id).sort())
      .toEqual([liveId, unrelatedId].sort())
  })

  it('reproduces legacy bare DELETE closing an operator-owned live pane', async () => {
    expect(hasSession(liveId)).toBe(true)
    const response = await fetch(`${base}/opsapi/nodes/${liveId}`, {
      method: 'DELETE', headers: { authorization: `Bearer ${token}` }
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, removedIds: [liveId], forced: true })
    expect(hasSession(liveId)).toBe(false)
    expect(hasSession(unrelatedId)).toBe(true)
    const { WorkspaceStore } = await import('../../src/core/workspace-store')
    const persisted = await new WorkspaceStore().load({ sideline: false })
    const ids = persisted.projects[0].nodes.map((node) => node.id)
    expect(ids).not.toContain(liveId)
    expect(ids).toContain(unrelatedId)
  })
})
