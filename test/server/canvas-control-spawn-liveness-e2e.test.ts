import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { hookServer } from '../../src/core/agents/hook-server'
import { nodeAuthToken } from '../../src/core/agents/node-auth-token'
import { sessionName, TMUX_SOCKET } from '../../src/core/tmux-naming'
import { startServer } from '../../src/server/index'
import type { ServerControlReply } from '../../src/server/headless-node-factory'
import type { Workspace } from '../../src/shared/types'

const hasTmux = (() => {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

function killOwnedBackend(nodeId: string): void {
  try {
    execFileSync(
      'tmux',
      ['-L', TMUX_SOCKET, 'kill-session', '-t', `=${sessionName(nodeId)}`],
      { stdio: 'ignore' }
    )
  } catch {
    // Never existed or already exited.
  }
}

describe.skipIf(!hasTmux)('disposable Server canvas-creation liveness', () => {
  let dataDir = ''
  let projectDir = ''
  let close: (() => Promise<void>) | undefined
  const createdIds = new Set<string>()

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-server-spawn-live-'))
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-server-spawn-project-'))
    const workspace: Workspace = {
      version: 2,
      activeProjectId: 'spawn-project',
      projects: [
        {
          id: 'spawn-project',
          name: 'Disposable spawn liveness',
          color: '#0a84ff',
          cwd: projectDir,
          viewport: { x: 0, y: 0, zoom: 1 },
          nodes: [
            {
              id: 'source',
              kind: 'terminal',
              position: { x: 0, y: 0 },
              size: { width: 640, height: 440 },
              title: 'Disposable source',
              color: '#d97757',
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
    // Exercise open-agent --agent codex without starting a provider process or making a network
    // session. The factory still traverses the exact Server Codex-capability path; only the final
    // pane command is replaced with a short-lived local printf.
    fs.writeFileSync(
      path.join(dataDir, 'settings.json'),
      JSON.stringify({ agentLaunchCommands: { codex: 'printf disposable-codex' } }),
      'utf8'
    )

    const server = await startServer({
      port: 0,
      host: '127.0.0.1',
      dataDir,
      rendererDir: path.join(dataDir, 'no-renderer'),
      insecureHttp: false,
      passwordSeed: 'disposable-spawn-liveness-password',
      installHooks: false,
      canvasControl: true,
      headless: false
    })
    close = server.close
  }, 30_000)

  afterAll(async () => {
    await close?.()
    try {
      const workspace = JSON.parse(
        fs.readFileSync(path.join(dataDir, 'workspace.json'), 'utf8')
      ) as Workspace
      for (const node of workspace.projects.flatMap((project) => project.nodes)) {
        if (node.id !== 'source') createdIds.add(node.id)
      }
    } catch {
      // The assertions already carry the useful failure; cleanup remains best effort.
    }
    // Exact, test-minted targets only. Never kill or restart a tmux/server-wide resource.
    for (const nodeId of createdIds) killOwnedBackend(nodeId)
    fs.rmSync(dataDir, { recursive: true, force: true })
    fs.rmSync(projectDir, { recursive: true, force: true })
  })

  async function control(
    verb: string,
    args: Record<string, string>
  ): Promise<{ status: number; reply: ServerControlReply }> {
    const secret = hookServer.nodeAuthSecretOrNull()
    expect(secret).not.toBeNull()
    const nodeToken = nodeAuthToken(secret as Buffer, 'source')
    const body = new URLSearchParams({ nodeId: 'source' })
    for (const [key, value] of Object.entries(args)) body.set(`arg.${key}`, value)
    const response = await fetch(`http://127.0.0.1:${hookServer.getPort()}/control/${verb}`, {
      method: 'POST',
      headers: {
        'X-Nodeterm-Hook-Token': hookServer.getToken(),
        'X-Nodeterm-Node-Token': nodeToken,
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json'
      },
      body,
      signal: AbortSignal.timeout(5_000)
    })
    const raw = await response.text()
    return { status: response.status, reply: JSON.parse(raw) as ServerControlReply }
  }

  it('answers Server Codex promptly, then opens a terminal through the same live endpoint', async () => {
    const codex = await control('open-agent', { agent: 'codex', prompt: 'probe' })
    expect([200, 400]).toContain(codex.status)
    expect(codex.reply.result).toMatchObject({ id: expect.stringMatching(/^term-/) })
    if (!codex.reply.ok) expect(codex.reply.error).toMatch(/^launch-failed:/)
    createdIds.add((codex.reply.result as { id: string }).id)

    const terminal = await control('open-terminal', {})
    expect(terminal.status).toBe(200)
    expect(terminal.reply).toMatchObject({
      ok: true,
      result: { id: expect.stringMatching(/^term-/) }
    })
    createdIds.add((terminal.reply.result as { id: string }).id)
  })
})
