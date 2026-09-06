import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import WebSocket from 'ws'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { configuredTaskContextSource, createTaskContextService, decodeCanonicalTaskContext, registerTaskContextIpc } from '../../src/core/task-context-service'
import { initPlatform, resetPlatformForTests } from '../../src/core/platform'
import { ServerPlatform } from '../../src/server/platform-server'
import { Auth } from '../../src/server/auth'
import { attachWsServer } from '../../src/server/ws'
import { SESSION_COOKIE } from '../../src/server/http'
import { IPC } from '../../src/shared/ipc'
import { isHostOnlyChannel } from '../../src/shared/host-control'
import { buildAgentApi, RpcClient } from '../../src/renderer/bridge/ws-bridge'
import type { RemoteOpenTarget } from '../../src/shared/remote-nav/context-page'
import { presenceHub } from '../../src/core/presence/hub'

const script = process.env.NODETERM_TEST_CONTEXT_SCRIPT
const python = process.env.NODETERM_TEST_CONTEXT_PYTHON ?? '/usr/bin/python3'
const expectedDigest = '15222977bdbcc5641987b8848d91abfef3f3c8e6135912cae6baffa25dcad536'
const query = { operation: 'summary' as const, scope: { project_id: 'project-a' } }

describe('task route authority and exact focus boundary', () => {
  it('preserves nanosecond fingerprint integers through a browser JSON round trip', () => {
    const raw = '{"continuation":{"records_source":[2096,7328948,105508,1788661334187973601],"offset":8239}}'
    const decoded = decodeCanonicalTaskContext(raw) as { continuation: { canonical: string } }
    const browser = JSON.parse(JSON.stringify(decoded))
    expect(browser.continuation.canonical).toBe('{"records_source":[2096,7328948,105508,1788661334187973601],"offset":8239}')
  })
  it('has no inferred source and rejects paths/principals supplied by the client', async () => {
    expect(configuredTaskContextSource({})).toBeUndefined()
    expect(configuredTaskContextSource({ NODETERM_TASK_CONTEXT_SCRIPT: '../context.py', NODETERM_TASK_CONTEXT_LEDGER: '/ledger', NODETERM_TASK_CONTEXT_PYTHON: '/python' })).toBeUndefined()
    const service = createTaskContextService({ authorizedOperator: (id) => id === 1 })
    expect(await service(9).read(query)).toMatchObject({ code: 'not_authorized' })
    expect(await service(1).read({ ...query, path: '/secret' } as never)).toMatchObject({ code: 'invalid_query' })
    expect(await service(1).read({ ...query, principal: 'agent' } as never)).toMatchObject({ code: 'invalid_query' })
    expect(await service(1).read(query)).toMatchObject({ code: 'source_unavailable' })
    expect(isHostOnlyChannel(IPC.taskContextRead)).toBe(true)
    expect(isHostOnlyChannel(IPC.taskContextFocus)).toBe(true)
  })
  const target: RemoteOpenTarget = { taskId: 'task-001', nodeId: 'node-001', sessionId: 'session-001',
    provider: 'codex', account: 'account-a', projectId: 'project-a', hostId: 'host-a', hostBootId: 'boot-a', sourceGeneration: 1, assignmentEpoch: 1 }
  const current = { ...target, observedAt: 990, observationClass: 'IDLE', observationState: 'observed', assignmentState: 'active', stale: false, conflicts: [] }
  it('refuses focus without a trusted shell adapter', async () => {
    expect(await createTaskContextService({ authorizedOperator: () => true })(1).focus(target)).toMatchObject({ code: 'focus_authority_unavailable' })
  })
  it.each(['hostId', 'hostBootId', 'projectId', 'account', 'sessionId', 'nodeId', 'taskId', 'provider', 'sourceGeneration', 'assignmentEpoch'] as const)('refuses a changed %s at the final focus boundary', async (field) => {
    const focused: string[] = []
    const service = createTaskContextService({ authorizedOperator: () => true, now: () => 1000000,
      focusCurrent: async (_sender, clicked, validate) => {
        const result = validate({ ...current, [field]: typeof current[field] === 'number' ? 2 : 'wrong' })
        if (result.ok) focused.push(clicked.nodeId)
        return result
      } })
    expect((await service(1).focus(target)).ok).toBe(false)
    expect(focused).toEqual([])
  })
  it('rechecks authority and age at focus, and permits only an exact fresh synthetic target', async () => {
    let allowed = true
    let now = 1000000
    const focused: string[] = []
    const service = createTaskContextService({ authorizedOperator: () => allowed, now: () => now,
      focusCurrent: async (_sender, clicked, validate) => {
        const result = validate(current)
        if (result.ok) focused.push(clicked.nodeId)
        return result
      } })
    expect(await service(1).focus(target)).toEqual({ ok: true, code: 'focus_only', controlGranted: false })
    now = 1400000
    expect((await service(1).focus(target)).ok).toBe(false)
    allowed = false
    expect((await service(1).focus(target)).ok).toBe(false)
    expect(focused).toEqual(['node-001'])
  })
})

describe.skipIf(!script)('canonical D15 producer → authenticated host route → browser bridge', () => {
  let root: string, server: http.Server, port: number, auth: Auth, platform: ServerPlatform
  const sockets: WebSocket[] = []
  const oldEnv: Record<string, string | undefined> = {}
  function produce(generation = 1): void {
    execFileSync(python, ['-B', path.resolve('test/fixtures/task-context/produce.py'), script!, root, String(generation)], { timeout: 10000 })
  }
  beforeEach(async () => {
    expect(createHash('sha256').update(readFileSync(script!)).digest('hex')).toBe(expectedDigest)
    expect(createHash('sha256').update(readFileSync(path.join(path.dirname(script!), 'ledger.py'))).digest('hex'))
      .toBe('9ca22d3db9e2220460ff998e1d082caa094f16d526672adc6466271d29b3f7b7')
    root = mkdtempSync(path.join(os.tmpdir(), 'nodeterm-task-'))
    produce()
    for (const [key, value] of Object.entries({ NODETERM_TASK_CONTEXT_SCRIPT: script!, NODETERM_TASK_CONTEXT_LEDGER: path.join(root, 'ledger.json'), NODETERM_TASK_CONTEXT_PYTHON: python })) {
      oldEnv[key] = process.env[key]; process.env[key] = value
    }
    platform = new ServerPlatform({ userDataDir: root, appVersion: 'test' })
    initPlatform(platform)
    registerTaskContextIpc()
    auth = new Auth(root)
    server = http.createServer((_req, res) => { res.statusCode = 404; res.end() })
    attachWsServer(server, { platform, auth })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as { port: number }).port
  })
  afterEach(async () => {
    for (const ws of sockets.splice(0)) { ws.terminate() }
    await new Promise<void>((resolve) => server.close(() => resolve()))
    for (let n = 0; n < 100 && presenceHub.peers().length; n++) await new Promise((r) => setTimeout(r, 10))
    resetPlatformForTests()
    for (const key of Object.keys(oldEnv)) {
      if (oldEnv[key] === undefined) delete process.env[key]; else process.env[key] = oldEnv[key]
    }
    rmSync(root, { recursive: true, force: true })
  })
  async function connect() {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: `${SESSION_COOKIE}=${auth.createSession()}`, Origin: `http://127.0.0.1:${port}` } })
    sockets.push(ws)
    await new Promise<void>((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
    const rpc = new RpcClient({ send: (data) => ws.send(data), ready: async () => {},
      onMessage: (cb) => { ws.on('message', (data, binary) => { if (!binary) cb(data.toString()) }) },
      onClose: (cb) => { ws.on('close', cb) } })
    return buildAgentApi(rpc).taskContext
  }
  it('blocks anonymous/cross-origin transport before dispatch', async () => {
    for (const headers of [{}, { Cookie: `${SESSION_COOKIE}=${auth.createSession()}`, Origin: 'https://wrong.invalid' }]) {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers })
      sockets.push(ws)
      const status = await new Promise<number>((resolve, reject) => {
        ws.on('unexpected-response', (_req, response) => { response.resume(); resolve(response.statusCode!) })
        ws.on('open', () => reject(new Error('unauthorized open')))
        ws.on('error', () => {})
      })
      expect(status).toBe(401)
    }
  })
  it('queries the real producer, preserves pagination/reset and refuses unavailable focus', async () => {
    const api = await connect()
    const first = await api.read(query)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.records[0].human_summary).toBeTruthy()
    expect(first.sources[0].coverage).toContain('live inventory and creator grants not read')
    expect(first.continuation).toBeTruthy()
    const next = await api.read({ ...query, cursor: first.continuation, previousSources: first.sources })
    expect(next.ok).toBe(true)
    if (!next.ok) throw new Error(next.code)
    expect(next.records.length).toBeGreaterThan(0)
    expect(next.records[0].task_id).not.toBe(first.records[0].task_id)
    const exact = await api.read({ ...query, scope: { ...query.scope, task_id: 'task-319' } })
    expect(exact).toMatchObject({ ok: true, records: [{ task_id: 'task-319' }] })
    const details = await api.read({ operation: 'task', scope: { ...query.scope, task_id: 'task-319' }, previousSources: first.sources })
    expect(details).toMatchObject({ ok: true, records: [{ fields: { workers: [{ node: 'worker-319', blockers: ['Synthetic blocker'] }] } }] })
    produce(2)
    expect(await api.read({ ...query, cursor: first.continuation, previousSources: first.sources })).toMatchObject({ ok: false, code: 'reset_required' })
    expect(await api.read({ ...query, source: '/arbitrary' } as never)).toMatchObject({ code: 'invalid_query' })
    expect(await api.focus({} as never)).toMatchObject({ code: 'focus_authority_unavailable' })
    expect((await api.read(query)).ok).toBe(true)
    expect(await api.read({ operation: 'overview', scope: { project_id: 'not-in-the-fixture' } })).toMatchObject({
      ok: true, code: 'continue', records: [], truncated: true
    })
  })
})
