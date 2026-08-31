import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'

import { sessionName, TMUX_SOCKET } from '../../src/core/tmux-naming'
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
