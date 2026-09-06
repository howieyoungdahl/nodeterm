import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import WebSocket from 'ws'

import { sessionName, TMUX_SOCKET } from '../../src/core/tmux-naming'
import { startServer } from '../../src/server/index'
import { IPC } from '../../src/shared/ipc'
import { decodePtyData } from '../../src/shared/rpc'
import type { CanvasNodeState, Workspace } from '../../src/shared/types'

const hasTmux = (() => {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

const SOURCE_ID = `term-hand-relaunch-${Date.now().toString(36)}`
const TARGET_ID = `${SOURCE_ID}-unowned`
const PROJECT_ID = 'hand-relaunch-project'

function terminal(id: string, title: string, x: number): CanvasNodeState {
  return {
    id,
    kind: 'terminal',
    position: { x, y: 0 },
    size: { width: 640, height: 440 },
    title,
    color: '#d97757',
    group: null,
    tags: []
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

describe.skipIf(!hasTmux)('disposable Server hand-relaunch canvas control', () => {
  let dataDir = ''
  let projectDir = ''
  let disposableHome = ''
  let tmuxTmpDir = ''
  let fakeAgent = ''
  let shim = ''
  let close: (() => Promise<void>) | undefined
  let ws: WebSocket | undefined
  let sessionId = ''
  let output = ''
  let requestId = 0
  const pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
  >()
  const oldEnv = {
    HOME: process.env.HOME,
    TMUX_TMPDIR: process.env.TMUX_TMPDIR,
    NODETERM_SERVER_CANVAS_CONTROL: process.env.NODETERM_SERVER_CANVAS_CONTROL
  }

  const rpc = <T>(method: string, args: unknown[], timeoutMs = 10_000): Promise<T> => {
    const id = ++requestId
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`${method} timed out`))
      }, timeoutMs)
      pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer
      })
      ws!.send(JSON.stringify({ t: 'req', id, method, args }))
    })
  }

  const cast = (method: string, args: unknown[]): void => {
    ws!.send(JSON.stringify({ t: 'cast', method, args }))
  }

  const until = async (predicate: () => boolean | Promise<boolean>, label: string): Promise<void> => {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      if (await predicate()) return
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    throw new Error(`${label} timed out; pane tail: ${output.slice(-1200)}`)
  }

  const runInPane = async (command: string, marker: string): Promise<string> => {
    const start = output.length
    cast(IPC.ptyWrite, [sessionId, `${command}\r`])
    await until(() => output.slice(start).includes(marker), marker)
    return output.slice(start)
  }

  const loadWorkspace = (): Promise<Workspace> => rpc(IPC.workspaceLoad, [])

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-server-hand-relaunch-'))
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-server-hand-project-'))
    disposableHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-server-hand-home-'))
    tmuxTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-server-hand-tmux-'))
    process.env.HOME = disposableHome
    process.env.TMUX_TMPDIR = tmuxTmpDir
    process.env.NODETERM_SERVER_CANVAS_CONTROL = '1'

    const initial: Workspace = {
      version: 2,
      activeProjectId: PROJECT_ID,
      projects: [
        {
          id: PROJECT_ID,
          name: 'Disposable hand relaunch',
          color: '#0a84ff',
          cwd: projectDir,
          viewport: { x: 0, y: 0, zoom: 1 },
          nodes: [terminal(TARGET_ID, 'Unowned target', 700)],
          bridges: [],
          ropes: []
        }
      ]
    }
    fs.writeFileSync(path.join(dataDir, 'workspace.json'), JSON.stringify(initial), 'utf8')

    fakeAgent = path.join(disposableHome, 'fake-claude-agent.sh')
    fs.writeFileSync(
      fakeAgent,
      `#!/bin/sh
set -eu
printf 'FAKE_AGENT_ENV:%s:%s\\n' "$NODETERM_NODE_ID" "\${NODETERM_CANVAS_CONTROL-unset}"
. "$NODETERM_HOOK_ENDPOINT"
nt_node_token=$(sed -n '1p' "$NODETERM_NODE_TOKEN_DIR/$NODETERM_NODE_ID")
nt_payload='{"hook_event_name":"Stop","session_id":"hand-relaunch-e2e","is_interrupt":false,"last_assistant_message":"done"}'
if [ -n "\${NODETERM_HOOK_SOCK:-}" ]; then
  nt_code=$(curl -sS -o /dev/null -w '%{http_code}' --unix-socket "$NODETERM_HOOK_SOCK" \\
    -X POST --config - http://localhost/hook/claude \\
    -H 'content-type: application/x-www-form-urlencoded' \\
    --data-urlencode "nodeId=$NODETERM_NODE_ID" --data-urlencode "payload=$nt_payload" <<EOF
header = "X-Nodeterm-Hook-Token: $NODETERM_HOOK_TOKEN"
header = "X-Nodeterm-Node-Token: $nt_node_token"
EOF
  )
else
  nt_code=$(curl -sS -o /dev/null -w '%{http_code}' -X POST --config - \\
    "http://127.0.0.1:$NODETERM_HOOK_PORT/hook/claude" \\
    -H 'content-type: application/x-www-form-urlencoded' \\
    --data-urlencode "nodeId=$NODETERM_NODE_ID" --data-urlencode "payload=$nt_payload" <<EOF
header = "X-Nodeterm-Hook-Token: $NODETERM_HOOK_TOKEN"
header = "X-Nodeterm-Node-Token: $nt_node_token"
EOF
  )
fi
printf 'FAKE_AGENT_REGISTERED_%s\\n' "$nt_code"
`,
      { encoding: 'utf8', mode: 0o700 }
    )

    const server = await startServer({
      port: 0,
      host: '127.0.0.1',
      dataDir,
      rendererDir: path.join(dataDir, 'no-renderer'),
      insecureHttp: false,
      passwordSeed: 'disposable-hand-relaunch-password',
      installHooks: false,
      canvasControl: true,
      headless: false
    })
    close = server.close
    shim = path.join(dataDir, 'canvas-control', 'nodeterm.sh')

    const login = await fetch(`http://127.0.0.1:${server.port}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'password=disposable-hand-relaunch-password',
      redirect: 'manual'
    })
    expect(login.status).toBe(303)
    const cookie = login.headers.get('set-cookie')!.split(';')[0]
    ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, { headers: { cookie } })
    await new Promise<void>((resolve, reject) => {
      ws!.once('open', resolve)
      ws!.once('error', reject)
    })
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const frame = decodePtyData(new Uint8Array(data as Buffer))
        if (frame && frame.sessionId === sessionId) output += frame.data
        return
      }
      const message = JSON.parse(data.toString()) as {
        t?: string
        id?: number
        ok?: boolean
        result?: unknown
        error?: string
      }
      if (message.t !== 'res' || typeof message.id !== 'number') return
      const waiter = pending.get(message.id)
      if (!waiter) return
      pending.delete(message.id)
      clearTimeout(waiter.timer)
      if (message.ok) waiter.resolve(message.result)
      else waiter.reject(new Error(message.error ?? 'RPC failed'))
    })
  }, 30_000)

  afterAll(async () => {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer)
      waiter.reject(new Error('test teardown'))
    }
    pending.clear()
    ws?.close()
    await close?.()
    if (tmuxTmpDir) {
      try {
        execFileSync(
          'tmux',
          ['-L', TMUX_SOCKET, 'kill-session', '-t', `=${sessionName(SOURCE_ID)}`],
          { stdio: 'ignore', env: { ...process.env, TMUX_TMPDIR: tmuxTmpDir } }
        )
      } catch {
        // The exact disposable session already ended.
      }
    }
    for (const dir of [dataDir, projectDir, disposableHome, tmuxTmpDir]) {
      if (dir) fs.rmSync(dir, { recursive: true, force: true })
    }
    for (const [key, value] of Object.entries(oldEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  it('promotes a fake hand launch, preserves ownership, and recovers a stale-save card', async () => {
    // Capture the browser's pre-create snapshot: replaying this after the pane exists is the exact
    // stale whole-workspace-save race that used to leave a live tmux session with no canvas card.
    const staleBeforeSource = structuredClone(await loadWorkspace())
    const withSource = structuredClone(staleBeforeSource)
    withSource.projects[0].nodes.push(terminal(SOURCE_ID, 'Plain terminal', 0))
    await rpc(IPC.workspaceSave, [withSource])

    const created = await rpc<{ sessionId: string; fresh: boolean }>(IPC.ptyCreate, [
      {
        cols: 100,
        rows: 30,
        cwd: projectDir,
        persistKey: SOURCE_ID,
        ownerProjectId: PROJECT_ID
      }
    ], 20_000)
    expect(created.fresh).toBe(true)
    sessionId = created.sessionId
    expect(sessionId).not.toBe('')

    // Prevent the terminal driver's command echo from satisfying marker waits before a command
    // actually runs. This changes only the disposable pane.
    cast(IPC.ptyWrite, [sessionId, 'stty -echo\r'])
    await new Promise((resolve) => setTimeout(resolve, 200))

    const registered = await runInPane(
      `${shellQuote(fakeAgent)}; printf 'FIRST_HOOK_DONE\\n'`,
      'FIRST_HOOK_DONE'
    )
    expect(registered).toContain(`FAKE_AGENT_ENV:${SOURCE_ID}:unset`)
    expect(registered).toContain('FAKE_AGENT_REGISTERED_204')
    await until(async () => {
      const workspace = await loadWorkspace()
      return workspace.projects[0].nodes.find((node) => node.id === SOURCE_ID)?.agentId === 'claude'
    }, 'verified hook promotion')

    const renamed = await runInPane(
      `sh ${shellQuote(shim)} rename --node ${shellQuote(SOURCE_ID)} --title ${shellQuote('Hand relaunched')}` +
        ` 2>&1; printf 'RENAME_EXIT_%s\\n' "$?"`,
      'RENAME_EXIT_0'
    )
    expect(renamed).toContain(`renamed ${SOURCE_ID}`)
    expect(renamed).not.toContain('Canvas control is not available')

    const refused = await runInPane(
      `sh ${shellQuote(shim)} send --node ${shellQuote(TARGET_ID)} --text probe 2>&1; ` +
        `printf 'SEND_EXIT_%s\\n' "$?"`,
      'SEND_EXIT_1'
    )
    expect(refused).toMatch(/ownership/i)

    await rpc(IPC.workspaceSave, [staleBeforeSource])
    await until(async () => {
      const workspace = await loadWorkspace()
      return !workspace.projects[0].nodes.some((node) => node.id === SOURCE_ID)
    }, 'stale snapshot removal')
    // Current-run pane provenance retained this credential; no serialized project membership was
    // treated as authorization. The next verified fake-agent hook is what performs recovery.
    expect(fs.existsSync(path.join(dataDir, 'node-tokens', SOURCE_ID))).toBe(true)

    const recoveredHook = await runInPane(
      `${shellQuote(fakeAgent)}; printf 'RECOVERY_HOOK_DONE\\n'`,
      'RECOVERY_HOOK_DONE'
    )
    expect(recoveredHook).toContain('FAKE_AGENT_REGISTERED_204')
    await until(async () => {
      const workspace = await loadWorkspace()
      const source = workspace.projects[0].nodes.find((node) => node.id === SOURCE_ID)
      return source?.agentId === 'claude' && source.title === 'Hand relaunched'
    }, 'live missing-card recovery')
  }, 30_000)
})
