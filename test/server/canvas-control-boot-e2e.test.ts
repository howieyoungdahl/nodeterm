import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'

import { sessionName, TMUX_SOCKET } from '../../src/core/tmux-naming'
import { SANDBOX_ENV, tmuxSocketPath } from '../../src/core/tmux-test-socket'
import { startServer } from '../../src/server/index'
import { IPC } from '../../src/shared/ipc'
import type { Workspace } from '../../src/shared/types'

const hasTmux = (() => {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

const PERSIST_KEY = `boot-rescue-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
const LIVE_PERSIST_KEY = `${PERSIST_KEY}-live`

function backendExists(persistKey: string): boolean {
  try {
    execFileSync('tmux', ['-L', TMUX_SOCKET, 'has-session', '-t', `=${sessionName(persistKey)}`], {
      stdio: 'ignore'
    })
    return true
  } catch {
    return false
  }
}

describe.skipIf(!hasTmux)('disposable Server boot rescue', () => {
  let dataDir = ''
  let projectDir = ''
  let close: (() => Promise<void>) | undefined
  // Everything startServer printed while booting with canvasControl on. Captured rather than
  // asserted through a spy call count because the boot logs several unrelated lines.
  const bootLogs: string[] = []

  // This suite reads and (on cleanup only) kills on the LIVE socket name, because the server it
  // boots binds `TMUX_SOCKET` itself — the whole assertion is that boot spawns nothing, and only
  // that socket can answer it. `TMUX_TMPDIR` is what keeps the name off the developer's live tmux
  // SERVER (this repo is developed from inside nodeterm), so refuse to run at all when the run-wide
  // sandbox is not in effect rather than fall back to it silently. See issue #629 and
  // `src/core/tmux-socket-isolation.guard.test.ts`, where this file is allowlisted.
  beforeAll(() => {
    const sandbox = process.env[SANDBOX_ENV]
    expect(sandbox, 'tmux sandbox not in effect — see test/setup/tmux-sandbox.ts').toBeTruthy()
    expect(process.env.TMUX_TMPDIR).toBe(sandbox)
    const uid = process.getuid?.() ?? 0
    expect(tmuxSocketPath(sandbox!, uid, TMUX_SOCKET)).not.toBe(
      tmuxSocketPath('/tmp', uid, TMUX_SOCKET)
    )
  })
  let port = 0
  let cookie = ''

  async function createFromBrowser(persistKey: string): Promise<Record<string, unknown>> {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie } })
    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve)
      ws.once('error', reject)
    })
    try {
      return await new Promise<Record<string, unknown>>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('pty:create timed out')), 5_000)
        ws.on('message', (data, isBinary) => {
          if (isBinary) return
          const message = JSON.parse(data.toString()) as {
            t?: string
            id?: number
            ok?: boolean
            result?: Record<string, unknown>
            error?: string
          }
          if (message.t !== 'res' || message.id !== 1) return
          clearTimeout(timer)
          if (!message.ok) reject(new Error(message.error || 'pty:create failed'))
          else resolve(message.result ?? {})
        })
        ws.send(
          JSON.stringify({
            t: 'req',
            id: 1,
            method: IPC.ptyCreate,
            args: [
              {
                cols: 80,
                rows: 24,
                cwd: projectDir,
                persistKey,
                ownerProjectId: 'boot-project',
                agentId: 'claude'
              }
            ]
          })
        )
      })
    } finally {
      ws.close()
    }
  }

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-server-boot-rescue-'))
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-server-boot-project-'))
    const workspace: Workspace = {
      version: 2,
      activeProjectId: 'boot-project',
      projects: [
        {
          id: 'boot-project',
          name: 'Disposable boot rescue',
          color: '#0a84ff',
          cwd: projectDir,
          viewport: { x: 0, y: 0, zoom: 1 },
          nodes: [
            {
              id: PERSIST_KEY,
              kind: 'terminal',
              position: { x: 0, y: 0 },
              size: { width: 640, height: 440 },
              title: 'Persisted missing backend',
              color: '#d97757',
              group: null,
              agentId: 'claude',
              pendingLaunch: {
                after: [],
                command: "claude 'must remain dormant'",
                executor: 'server'
              }
            },
            {
              id: LIVE_PERSIST_KEY,
              kind: 'terminal',
              position: { x: 680, y: 0 },
              size: { width: 640, height: 440 },
              title: 'Persisted live backend',
              color: '#0a84ff',
              group: null,
              agentId: 'claude'
            }
          ],
          bridges: [],
          ropes: []
        }
      ]
    }
    fs.writeFileSync(path.join(dataDir, 'workspace.json'), JSON.stringify(workspace), 'utf8')
    expect(backendExists(PERSIST_KEY)).toBe(false)
    execFileSync(
      'tmux',
      ['-L', TMUX_SOCKET, 'new-session', '-d', '-s', sessionName(LIVE_PERSIST_KEY)],
      { stdio: 'ignore' }
    )
    expect(backendExists(LIVE_PERSIST_KEY)).toBe(true)

    const log = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      bootLogs.push(args.map((a) => String(a)).join(' '))
    })
    const server = await startServer({
      port: 0,
      host: '127.0.0.1',
      dataDir,
      rendererDir: path.join(dataDir, 'no-renderer'),
      insecureHttp: false,
      passwordSeed: 'disposable-boot-rescue-password',
      installHooks: false,
      canvasControl: true,
      headless: false
    })
    log.mockRestore()
    close = server.close
    port = server.port
    const login = await fetch(`http://127.0.0.1:${port}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'password=disposable-boot-rescue-password',
      redirect: 'manual'
    })
    expect(login.status).toBe(303)
    cookie = login.headers.get('set-cookie')!.split(';')[0]
  }, 30_000)

  afterAll(async () => {
    await close?.()
    // Never touch the tmux server or any broad target; cleanup is scoped to the two test-owned,
    // unique ids (one intentionally live, one that can exist only if boot rescue regressed).
    for (const persistKey of [PERSIST_KEY, LIVE_PERSIST_KEY]) {
      try {
        execFileSync(
          'tmux',
          ['-L', TMUX_SOCKET, 'kill-session', '-t', sessionName(persistKey)],
          { stdio: 'ignore' }
        )
      } catch {
        // Already gone.
      }
    }
    fs.rmSync(dataDir, { recursive: true, force: true })
    fs.rmSync(projectDir, { recursive: true, force: true })
  })

  // The flag reads as "canvas control", but what it grants is command execution as the server's
  // own user. An operator who never opens docs/SERVER.md still has to be told, so boot says it —
  // and this pins that it is actually said, on a real boot with the flag on.
  it('announces at boot that the flag grants command execution on this host', () => {
    const notice = bootLogs.find((line) => line.includes('Server canvas control ENABLED'))
    expect(notice).toBeDefined()
    expect(notice).toContain('arbitrary commands on this host')
    expect(notice).toContain('open-terminal --cmd')
    expect(notice).toContain('NODETERM_SERVER_CANVAS_CONTROL')
  })

  it('leaves a persisted queued node dormant when no backend exists', () => {
    expect(backendExists(PERSIST_KEY)).toBe(false)
  })

  it('returns a dead card to a reconnecting browser and never recreates the missing backend', async () => {
    const result = await createFromBrowser(PERSIST_KEY)

    expect(result).toMatchObject({ sessionId: '', fresh: false, deadCard: true })
    expect(backendExists(PERSIST_KEY)).toBe(false)
    const persisted = JSON.parse(
      fs.readFileSync(path.join(dataDir, 'workspace.json'), 'utf8')
    ) as Workspace
    expect(persisted.projects[0].nodes[0].pendingLaunch).toMatchObject({
      command: "claude 'must remain dormant'",
      executor: 'server'
    })
  })

  it('reattaches a backend that survived boot without ever using attach-or-create', async () => {
    const result = await createFromBrowser(LIVE_PERSIST_KEY)

    expect(result).toMatchObject({ fresh: false, persistent: true })
    expect(result).not.toHaveProperty('deadCard')
    expect(backendExists(LIVE_PERSIST_KEY)).toBe(true)
  })
})
