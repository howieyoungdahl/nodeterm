import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  _resetForTest,
  mirrorEntry,
  nodeState,
  recordAgentEvent
} from '../core/agent-status-mirror'
import { hookServer } from '../core/agents/hook-server'
import { buildManagedScript } from '../core/agents/hooks/managed-script'
import { nodeAuthToken } from '../core/agents/node-auth-token'
import {
  codexThreadIdentityRoot,
  resetCodexThreadIdentityAuthSecret,
  setCodexThreadIdentityAuthSecret,
  writeCodexThreadIdentity
} from '../core/codex-identity-proxy'
import { initPlatform, resetPlatformForTests } from '../core/platform'
import { fakePlatform } from '../core/platform-fake'
import { WorkspaceStore } from '../core/workspace-store'
import type { NormalizedAgentEvent } from '../shared/agents/normalize'
import { DEFAULT_SETTINGS, type CanvasNodeState } from '../shared/types'
import {
  createHeadlessNodeOwnership,
  HeadlessNodeFactory,
  type HeadlessPty,
  type ServerControlReply
} from './headless-node-factory'

const NODE = 'term-payload-codex'
const SIBLING = 'term-unrelated-shell'
const THREAD = 'payload-only-thread'
const SECRET = Buffer.alloc(32, 73)

const plainTerminal = (id: string): CanvasNodeState => ({
  id,
  kind: 'terminal',
  title: 'Terminal24',
  position: { x: 20, y: 30 },
  size: { width: 640, height: 440 },
  color: '#0a84ff',
  group: null
})

describe.skipIf(process.platform === 'win32')('Codex payload identity reaches server canvas control', () => {
  let dir = ''
  let factory: HeadlessNodeFactory | undefined

  afterEach(() => {
    factory?.stop()
    hookServer.stop()
    hookServer.clearNodeAuthSecretForTests()
    hookServer.setListener(() => {})
    hookServer.setRawListener(() => {})
    resetCodexThreadIdentityAuthSecret()
    _resetForTest()
    resetPlatformForTests()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  })

  it('recognizes a plain terminal only after its payload-only Codex hook authenticates and updates the mirror', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-codex-control-'))
    const dataDir = path.join(dir, 'data')
    const home = path.join(dir, 'home')
    const projectDir = path.join(dir, 'project')
    fs.mkdirSync(dataDir)
    fs.mkdirSync(path.join(home, '.nodeterm', 'pending'), { recursive: true })
    fs.mkdirSync(projectDir)
    _resetForTest()
    resetPlatformForTests()
    initPlatform(fakePlatform({ userDataDir: dataDir }))

    const store = new WorkspaceStore()
    await store.save({
      version: 2,
      activeProjectId: 'project-1',
      projects: [{
        id: 'project-1',
        name: 'Payload identity fixture',
        color: '#0a84ff',
        cwd: projectDir,
        viewport: { x: 0, y: 0, zoom: 1 },
        nodes: [plainTerminal(NODE), plainTerminal(SIBLING)],
        bridges: [],
        ropes: []
      }]
    })
    const pty: HeadlessPty = {
      createHeadless: vi.fn(async () => ({ sessionId: 'fixture-pty', fresh: true, persistent: true })),
      sessionExists: async () => true,
      sendText: async () => true,
      destroySession: async () => {}
    }
    const ownership = createHeadlessNodeOwnership()
    factory = new HeadlessNodeFactory({
      workspaceStore: store,
      ptyManager: pty,
      settings: () => ({ ...DEFAULT_SETTINGS }),
      cliCaps: async () => ({
        version: null,
        autoPermissionMode: false,
        fullscreenTui: false,
        sessionIdFlag: false,
        remoteControlFlag: false
      }),
      codexSharedIdentity: async () => false,
      ownership,
      stateOf: nodeState,
      agentIdOf: (id) => mirrorEntry(id)?.agentId,
      publishNode: () => {},
      publishRemoval: () => {},
      publishProject: () => {}
    })

    hookServer.setNodeAuthSecret(SECRET)
    setCodexThreadIdentityAuthSecret(SECRET)
    await hookServer.start()
    // Node capabilities belong to plain terminals too; possessing one is not agent recognition.
    const tokenDir = path.join(dataDir, 'node-tokens')
    fs.mkdirSync(tokenDir, { mode: 0o700 })
    for (const nodeId of [NODE, SIBLING]) {
      fs.writeFileSync(path.join(tokenDir, nodeId), `${nodeAuthToken(SECRET, nodeId)}\n`, { mode: 0o600 })
    }
    writeCodexThreadIdentity(THREAD, NODE, hookServer.endpointFilePath())

    const events: NormalizedAgentEvent[] = []
    const raws: Record<string, unknown>[] = []
    let receive: ((event: NormalizedAgentEvent) => void) | undefined
    hookServer.setRawListener((_agentId, _nodeId, payload) => raws.push(payload))
    hookServer.setListener((event) => {
      // Same record-first seam as wireAgentStatus, without starting unrelated transcript tails.
      events.push(recordAgentEvent(event))
      receive?.(event)
    })
    hookServer.setControlHandler(async ({ verb, nodeId, args, verified }) => {
      if (!verified) return { ok: false, error: 'verified node identity required' }
      if (verb !== 'list') return { ok: false, error: 'fixture supports list only' }
      return factory!.list(nodeId, args)
    })

    const endpoint = `http://127.0.0.1:${hookServer.getPort()}`
    const list = async (nodeId = NODE): Promise<ServerControlReply> => {
      const response = await fetch(`${endpoint}/control/list`, {
        method: 'POST',
        headers: {
          'X-Nodeterm-Hook-Token': hookServer.getToken(),
          'X-Nodeterm-Node-Token': nodeAuthToken(SECRET, nodeId)
        },
        body: new URLSearchParams({ nodeId }),
        signal: AbortSignal.timeout(3000)
      })
      const reply = await response.json() as ServerControlReply
      expect(response.status).toBe(reply.ok ? 200 : 400)
      return reply
    }
    const refusal = { ok: false, error: 'source node is not a control-capable agent' }
    expect(await list()).toMatchObject(refusal)
    expect(mirrorEntry(NODE)).toBeUndefined()

    const payload = {
      hook_event_name: 'PreToolUse',
      session_id: THREAD,
      tool_name: 'exec_command',
      tool_input: { session_id: 'nested-session-is-not-the-owner', command: 'fixture only' }
    }
    const forged = await fetch(`${endpoint}/hook/codex`, {
      method: 'POST',
      headers: {
        'X-Nodeterm-Hook-Token': hookServer.getToken(),
        'X-Nodeterm-Node-Token': nodeAuthToken(SECRET, SIBLING)
      },
      body: new URLSearchParams({ nodeId: NODE, payload: JSON.stringify(payload) }),
      signal: AbortSignal.timeout(3000)
    })
    expect(forged.status).toBe(403)
    await forged.text()
    expect(events).toEqual([])
    expect(raws).toEqual([])
    expect(await list()).toMatchObject(refusal)

    const script = path.join(dir, 'codex.sh')
    fs.writeFileSync(script, buildManagedScript('codex', codexThreadIdentityRoot()), { mode: 0o700 })
    const runHook = (body: typeof payload): Promise<void> => new Promise((resolve, reject) => {
      const child = spawn('/bin/sh', [script], {
        // Shared-daemon hook processes have session_id on stdin, not CODEX_THREAD_ID or pane env.
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home },
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 5000
      })
      let output = ''
      child.stdout.on('data', (chunk) => { output += String(chunk) })
      child.stderr.on('data', (chunk) => { output += String(chunk) })
      child.on('error', reject)
      child.stdin.on('error', reject)
      child.on('exit', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`Codex hook exited ${code}: ${output}`))
      })
      child.stdin.end(JSON.stringify(body))
    })

    await runHook({ ...payload, session_id: 'thread-without-a-mapping' })
    expect(events).toEqual([])
    expect(await list()).toMatchObject(refusal)

    const received = new Promise<NormalizedAgentEvent>((resolve, reject) => {
      const timer = setTimeout(() => {
        receive = undefined
        reject(new Error('Payload-only Codex hook never reached the normalized listener'))
      }, 3000)
      receive = (event) => {
        clearTimeout(timer)
        receive = undefined
        resolve(event)
      }
    })
    await runHook(payload)
    // Check at process exit, before awaiting a callback or inherited background-pipe EOF.
    expect(mirrorEntry(NODE)?.agentId).toBe('codex')
    expect(await list()).toMatchObject({ ok: true })
    const event = await received
    expect(event).toMatchObject({ nodeId: NODE, agentId: 'codex', sessionId: THREAD, verified: true })
    expect(raws).toEqual([payload])
    expect(mirrorEntry(NODE)).toMatchObject({ agentId: 'codex', sessionId: THREAD, stateVerified: true })
    expect(await list()).toMatchObject({
      ok: true,
      result: {
        caller: NODE,
        nodes: expect.arrayContaining([expect.objectContaining({ id: NODE, agentId: 'codex' })])
      }
    })
    expect(await list(SIBLING)).toMatchObject(refusal)
    expect(mirrorEntry(SIBLING)).toBeUndefined()
    expect(pty.createHeadless).not.toHaveBeenCalled()
    expect((await store.load()).projects[0].nodes.every((node) => !node.agentId)).toBe(true)
  })
})
