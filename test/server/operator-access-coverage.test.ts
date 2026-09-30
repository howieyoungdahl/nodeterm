/** Disposable Server + actual hook HTTP ordering. All identities, files and credentials are
 * synthetic; hook installation is disabled and no provider or live pane is touched. */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startServer } from '../../src/server/index'
import { hookServer } from '../../src/core/agents/hook-server'
import { nodeAuthToken } from '../../src/core/agents/node-auth-token'
import { OPERATOR_POLICY_FILE, OPERATOR_STANDING_SCOPE_KIND, tokenDigest } from '../../src/server/operator-conversation-policy'
import type { OperatorSessionTarget } from '../../src/shared/operator-conversations'

const nodeId = 'synthetic-coverage-node'
const sessionId = 'synthetic-coverage-session'
const token = 'synthetic-coverage-operator-token-0123456789'
let root: string, dataDir: string, transcript: string, base: string
let server: Awaited<ReturnType<typeof startServer>> | undefined
let oldCodexHome: string | undefined
const config = () => ({ port: 0, host: '127.0.0.1', dataDir,
  rendererDir: path.join(root, 'no-renderer'), passwordSeed: 'synthetic-coverage-password',
  installHooks: false, canvasControl: false, headless: false, deadCardReapMinutes: 0 })
const auth = { authorization: `Bearer ${token}` }

beforeEach(async () => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nt-operator-coverage-')))
  dataDir = path.join(root, 'server')
  fs.mkdirSync(dataDir, { mode: 0o700 })
  const codexDir = path.join(root, 'codex')
  fs.mkdirSync(path.join(codexDir, 'sessions'), { recursive: true, mode: 0o700 })
  oldCodexHome = process.env.CODEX_HOME
  process.env.CODEX_HOME = codexDir
  transcript = path.join(codexDir, 'sessions', 'synthetic.jsonl')
  writeTranscript(transcript, 'first public message')
  fs.writeFileSync(path.join(dataDir, 'workspace.json'), JSON.stringify({ version: 3,
    activeProjectId: 'synthetic-project', entries: [{ id: 'synthetic-project', project: {
      id: 'synthetic-project', name: 'Synthetic coverage', cwd: root, color: '#0a84ff',
      viewport: { x: 0, y: 0, zoom: 1 }, nodes: [{ id: nodeId, kind: 'terminal',
        title: 'Synthetic coverage', position: { x: 0, y: 0 }, size: { width: 640, height: 440 } }],
      bridges: [], ropes: []
    } }] }), { mode: 0o600 })
  fs.writeFileSync(path.join(dataDir, OPERATOR_POLICY_FILE), JSON.stringify({ version: 2, principals: [{
    id: 'synthetic-operator', tokenSha256: tokenDigest(token), expiresAt: '2099-01-01T00:00:00Z',
    read: [{ kind: OPERATOR_STANDING_SCOPE_KIND }], message: []
  }] }), { mode: 0o600 })
  server = await startServer(config())
  base = `http://127.0.0.1:${server.port}`
})

afterEach(async () => {
  await server?.close()
  server = undefined
  if (oldCodexHome === undefined) delete process.env.CODEX_HOME
  else process.env.CODEX_HOME = oldCodexHome
  fs.rmSync(root, { recursive: true, force: true })
})

function writeTranscript(file: string, text: string) {
  fs.writeFileSync(file, [
    { type: 'session_meta', payload: { id: sessionId } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }
  ].map((row) => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 })
}
async function hook(event: string, extra: Record<string, unknown> = {}, verified = true) {
  const response = await fetch(`http://127.0.0.1:${hookServer.getPort()}/hook/codex`, {
    method: 'POST', headers: { 'X-Nodeterm-Hook-Token': hookServer.getToken(),
      ...(verified ? { 'X-Nodeterm-Node-Token': nodeAuthToken(hookServer.nodeAuthSecretOrNull()!, nodeId) } : {}),
      'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ nodeId, payload: JSON.stringify({ hook_event_name: event,
      session_id: sessionId, transcript_path: transcript, ...extra }) }).toString()
  })
  expect(response.status).toBe(204)
}
async function targets(): Promise<OperatorSessionTarget[]> {
  const response = await fetch(`${base}/opsapi/v1/sessions`, { headers: auth })
  expect(response.status).toBe(200)
  return (await response.json()).targets
}
async function read(target: OperatorSessionTarget) {
  const response = await fetch(`${base}/opsapi/v1/conversation?${new URLSearchParams({ ...target, limit: '1' })}`, { headers: auth })
  return { status: response.status, body: await response.json() }
}

describe('operator authenticated hook coverage', () => {
  it('attaches the first authenticated SessionStart path before a later Stop', async () => {
    await hook('SessionStart')
    const target = (await targets())[0]
    expect(target).toMatchObject({ nodeId, sessionId })
    expect(await read(target)).toMatchObject({ status: 200, body: { items: [{ text: 'first public message' }] } })
  })

  it('rotates same-ID generation and attaches only the resumed hook path', async () => {
    await hook('SessionStart')
    await hook('Stop') // Establish an old path even on the broken baseline.
    const original = (await targets())[0]
    const replacement = path.join(path.dirname(transcript), 'resumed.jsonl')
    writeTranscript(replacement, 'resumed public message')
    await hook('SessionStart', { transcript_path: replacement })
    const resumed = (await targets())[0]
    expect(resumed.generation).not.toBe(original.generation)
    expect(await read(original)).toMatchObject({ status: 409, body: { error: 'stale_target' } })
    expect(await read(resumed)).toMatchObject({ status: 200, body: { items: [{ text: 'resumed public message' }] } })
  })

  it('rediscovers identity after server restart from a normalized-null authenticated hook', async () => {
    await hook('SessionStart')
    await hook('Stop')
    const original = (await targets())[0]
    await server!.close()
    server = await startServer(config())
    base = `http://127.0.0.1:${server.port}`
    expect(await targets()).toEqual([]) // Restored mirrors/cards grant no identity.
    await hook('PostToolUse', { tool_name: 'request_user_input' })
    const rebound = (await targets())[0]
    expect(rebound).toMatchObject({ nodeId, sessionId })
    expect(rebound.generation).not.toBe(original.generation)
    expect(await read(original)).toMatchObject({ status: 409, body: { error: 'stale_target' } })
    expect(await read(rebound)).toMatchObject({ status: 200 })
  })

  it('keeps a missing-path generation unavailable until its own authenticated path arrives', async () => {
    await hook('SessionStart')
    await hook('Stop')
    const original = (await targets())[0]
    await hook('SessionStart', { transcript_path: undefined })
    const resumed = (await targets())[0]
    expect(resumed.generation).not.toBe(original.generation)
    expect(await read(resumed)).toMatchObject({ status: 404, body: { error: 'transcript_unavailable' } })
    await hook('Stop')
    expect(await read(resumed)).toMatchObject({ status: 200 })
  })

  it('cannot replace a resumed generation path with a delayed same-ID hook', async () => {
    await hook('SessionStart')
    const original = (await targets())[0]
    const replacement = path.join(path.dirname(transcript), 'resumed.jsonl')
    writeTranscript(replacement, 'resumed public message')
    await hook('SessionStart', { transcript_path: replacement })
    const resumed = (await targets())[0]
    await hook('PostToolUse', { transcript_path: transcript })
    expect(await targets()).toEqual([resumed])
    expect(await read(original)).toMatchObject({ status: 409, body: { error: 'stale_target' } })
    expect(await read(resumed)).toMatchObject({ status: 200, body: { items: [{ text: 'resumed public message' }] } })
  })

  it('denies unverified, child and malformed discovery and keeps the path jail', async () => {
    await hook('Stop', {}, false)
    await hook('PostToolUse', { agent_id: 'synthetic-child' })
    await hook('SessionStart', { session_id: null })
    expect(await targets()).toEqual([])
    await hook('SessionStart', { transcript_path: path.join(root, 'outside.jsonl') })
    const target = (await targets())[0]
    expect(await read(target)).toMatchObject({ status: 404, body: { error: 'transcript_unavailable' } })
  })

  it('invalidates old targets on malformed or unverified lifecycle replacement', async () => {
    await hook('SessionStart')
    await hook('Stop')
    const original = (await targets())[0]
    await hook('SessionStart', { session_id: null })
    expect(await targets()).toEqual([])
    expect(await read(original)).toMatchObject({ status: 409, body: { error: 'stale_target' } })
    await hook('Stop')
    const rebound = (await targets())[0]
    await hook('SessionStart', {}, false)
    expect(await targets()).toEqual([])
    expect(await read(rebound)).toMatchObject({ status: 409, body: { error: 'stale_target' } })
  })
})
