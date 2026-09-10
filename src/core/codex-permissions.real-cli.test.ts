// Opt-in regression against an installed Codex, without its live home, daemon or credentials:
// NODETERM_CODEX_TEST_BIN=/absolute/path/to/codex npm test -- codex-permissions.real-cli
// Reopening in a NEW process matters: a same-process resume retains the in-memory sandbox and
// conceals the legacy full-access restoration bug in Codex 0.153.4/0.154.0.
import { expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { codexThreadPermissionParams } from './codex-session-name'

const binary = process.env.NODETERM_CODEX_TEST_BIN

async function appServer(binaryPath: string, home: string, cwd: string) {
  const child = spawn(binaryPath, ['app-server', '--stdio'], {
    cwd,
    // No auth, production or Nodeterm variables, and no live Codex configuration.
    env: { PATH: process.env.PATH, HOME: process.env.HOME, USER: process.env.USER, CODEX_HOME: home },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  let nextId = 0
  let stderr = ''
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>()
  const rejectPending = (error: Error) => {
    for (const call of pending.values()) call.reject(error)
    pending.clear()
  }
  child.stdin.on('error', rejectPending)
  child.on('error', rejectPending)
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString()).slice(-4000) })
  const exited = new Promise<void>((resolve) => child.once('exit', () => {
    rejectPending(new Error(`Disposable Codex exited: ${stderr}`))
    resolve()
  }))
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line)
    const call = pending.get(message.id)
    if (!call) return
    pending.delete(message.id)
    if (message.error) call.reject(new Error(JSON.stringify(message.error)))
    else call.resolve(message.result)
  })
  const timeout = setTimeout(() => {
    rejectPending(new Error('Disposable Codex timed out'))
    child.kill()
  }, 15000)
  const rpc = (method: string, params: Record<string, unknown>): Promise<any> => new Promise((resolve, reject) => {
    const id = ++nextId
    pending.set(id, { resolve, reject })
    child.stdin.write(JSON.stringify({ id, method, params }) + '\n')
  })
  const close = async () => {
    clearTimeout(timeout)
    child.stdin.end()
    // Let the rollout writer flush on EOF before the separate process reads the saved thread.
    const terminate = setTimeout(() => child.kill(), 2000)
    try { await exited } finally { clearTimeout(terminate) }
  }
  try {
    await rpc('initialize', { clientInfo: { name: 'nodeterm_permission_test', version: '1' }, capabilities: { experimentalApi: true } })
    child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n')
    return { rpc, close }
  } catch (error) {
    await close()
    throw error
  }
}

it.skipIf(!binary)('keeps explicit Full Access after a saved thread reload despite a workspace-only project default', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-cx-policy-'))
  const home = path.join(root, 'codex')
  const cwd = path.join(root, 'project')
  fs.mkdirSync(home)
  fs.mkdirSync(path.join(cwd, '.codex'), { recursive: true })
  fs.writeFileSync(path.join(home, 'config.toml'), [
    'approval_policy = "on-request"',
    'sandbox_mode = "danger-full-access"',
    `[projects.${JSON.stringify(cwd)}]`,
    'trust_level = "trusted"',
    '[features]',
    'hooks = false',
    ''
  ].join('\n'))
  fs.writeFileSync(path.join(cwd, '.codex', 'config.toml'), 'sandbox_mode = "workspace-write"\napproval_policy = "on-request"\n')
  let server: Awaited<ReturnType<typeof appServer>> | undefined
  try {
    server = await appServer(binary!, home, cwd)
    const params = codexThreadPermissionParams({ approvalPolicy: 'never', sandbox: 'danger-full-access' })
    const seed = await server.rpc('thread/start', { cwd, ...params })
    expect(seed.sandbox.type).toBe('dangerFullAccess')
    // Materialize a turn without a model response or credentials, then fork before it like the
    // managed launcher. No user prompt is submitted and no live daemon is contacted.
    const turn = await server.rpc('turn/start', { threadId: seed.thread.id, input: [] })
    await server.rpc('turn/interrupt', { threadId: seed.thread.id, turnId: turn.turn.id }).catch((error: Error) => {
      if (!error.message.includes('no active turn')) throw error
    })
    await expect.poll(() => fs.existsSync(seed.thread.path) && fs.statSync(seed.thread.path).size > 0, { timeout: 5000 }).toBe(true)
    const fork = await server.rpc('thread/fork', { threadId: seed.thread.id, beforeTurnId: turn.turn.id, cwd, ...params })
    await expect.poll(() => fs.existsSync(fork.thread.path) && fs.statSync(fork.thread.path).size > 0, { timeout: 5000 }).toBe(true)
    await server.close()
    server = undefined
    server = await appServer(binary!, home, cwd)
    const resumed = await server.rpc('thread/resume', { threadId: fork.thread.id })
    expect(resumed.thread.id).toBe(fork.thread.id)
    expect(resumed.approvalPolicy).toBe('never')
    expect(resumed.sandbox.type).toBe('dangerFullAccess')
    expect(resumed.activePermissionProfile?.id).toBe(':danger-full-access')
  } finally {
    await server?.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
}, 35000)
