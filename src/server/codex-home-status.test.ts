import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
const sandbox = vi.hoisted(() => ({ home: '' }))
vi.mock('os', async (original) => {
  const m = await original<typeof import('os')>()
  return { ...m, homedir: () => sandbox.home || m.homedir(), default: { ...m, homedir: () => sandbox.home || m.homedir() } }
})
import { ServerPlatform } from './platform-server'
import { wireAgentStatus } from './agent-status'
import { hookServer } from '../core/agents/hook-server'
import { nodeAuthToken } from '../core/agents/node-auth-token'
import { setCodexThreadIdentityAuthSecret, resetCodexThreadIdentityAuthSecret, writeCodexThreadIdentity } from '../core/codex-identity-proxy'
import { resolveCodexHomeRouting } from '../core/codex-home-routing'
import { initPlatform, resetPlatformForTests } from '../core/platform'
import { mirrorEntry, _resetForTest, buildFile } from '../core/agent-status-mirror'
import { IPC } from '../shared/ipc'

let dir = ''
let platform: ServerPlatform | undefined
const secret = Buffer.alloc(32, 64)
afterEach(() => {
  if (platform) platform.cast(1, IPC.ptyDestroy, ['node-one'])
  hookServer.stop(); hookServer.clearNodeAuthSecretForTests(); hookServer.setListener(() => {}); hookServer.setRawListener(() => {})
  resetCodexThreadIdentityAuthSecret(); _resetForTest(); resetPlatformForTests(); vi.unstubAllEnvs()
  if (dir) fs.rmSync(dir, { recursive: true, force: true })
  sandbox.home = ''
})

describe('disposable Server Codex home/status/context lifecycle', () => {
  it.each([undefined, '@local-home-2'])('authenticates and meters exact home %s while preserving waiting/done proof', async (scope) => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-codex-status-'))
    sandbox.home = path.join(dir, 'home')
    vi.stubEnv('CODEX_HOME', path.join(sandbox.home, '.codex'))
    platform = new ServerPlatform({ userDataDir: path.join(dir, 'data'), appVersion: 'test' })
    initPlatform(platform)
    setCodexThreadIdentityAuthSecret(secret)
    hookServer.setNodeAuthSecret(secret)
    await hookServer.start()
    const home = resolveCodexHomeRouting(undefined, scope).home
    const thread = 'thread-test'
    const transcript = path.join(home, 'sessions', 'rollout-thread-test.jsonl')
    fs.mkdirSync(path.dirname(transcript), { recursive: true })
    fs.writeFileSync(transcript, JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 12345, cached_input_tokens: 12000 }, total_token_usage: { input_tokens: 999999 }, model_context_window: 100000 } } }) + '\n')
    writeCodexThreadIdentity(thread, 'node-one', hookServer.endpointFilePath(), undefined, scope)
    const bindings: string[] = []
    wireAgentStatus(platform, { onTranscript: (_agent, _node, _thread, p) => bindings.push(p) })
    const send = async (event: string, extra: Record<string, unknown> = {}) => {
      const response = await fetch(`http://127.0.0.1:${hookServer.getPort()}/hook/codex`, { method: 'POST',
        headers: { 'X-Nodeterm-Hook-Token': hookServer.getToken(), 'X-Nodeterm-Node-Token': nodeAuthToken(secret, 'node-one'), 'X-Nodeterm-Hook-Client': '6' },
        body: new URLSearchParams({ nodeId: 'node-one', payload: JSON.stringify({ hook_event_name: event, session_id: thread, transcript_path: transcript, ...extra }) }), signal: AbortSignal.timeout(3000) })
      expect(response.status).toBe(204); await response.text()
    }
    await send('UserPromptSubmit')
    expect(mirrorEntry('node-one')).toMatchObject({ state: 'working', codexHome: home, codexAccountId: scope ?? null, stateVerified: true, stateSource: 'hook' })
    const activity = mirrorEntry('node-one')!.lastActivityAt
    await expect.poll(() => mirrorEntry('node-one')?.context?.usedTokens, { timeout: 3000 }).toBe(12345)
    expect(mirrorEntry('node-one')!.lastActivityAt).toBe(activity)
    expect(bindings).toContain(transcript)
    await send('PreToolUse', { tool_name: 'request_user_input' })
    await send('Stop')
    expect(mirrorEntry('node-one')).toMatchObject({ state: 'waiting', awaitingInput: true, stateVerified: true })
    await send('UserPromptSubmit')
    await send('Stop')
    const e = mirrorEntry('node-one')!
    expect(buildFile({ 'node-one': e }, Date.now()).nodes['node-one']).toMatchObject({ state: 'done', codexHome: home, stateVerified: true, stateSource: 'hook', context: { usedTokens: 12345, windowTokens: 100000 } })
  })
})
