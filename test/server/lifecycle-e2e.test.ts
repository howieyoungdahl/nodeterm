import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { startServer } from '../../src/server/index'
import { hookServer } from '../../src/core/agents/hook-server'
import { _resetForTest } from '../../src/core/agent-status-mirror'
import { TMUX_SOCKET, sessionName } from '../../src/core/tmux-naming'
import { privateTmuxSocketReason } from '../../src/core/tmux-test-socket'
import type { Workspace } from '../../src/shared/types'

const hasTmux = (() => { try { execFileSync('tmux', ['-V'], { stdio: 'ignore' }); return true } catch { return false } })()
const refusal = privateTmuxSocketReason()
const ids = ['nt-life-claude', 'nt-life-codex', 'nt-life-restored', 'nt-life-prompt', 'nt-life-shell']

describe.skipIf(!hasTmux || !!refusal)('native lifecycle through disposable Server HTTP', () => {
  let dir: string
  let base: string
  let auth: { authorization: string }
  let close: (() => Promise<void>) | undefined
  const restoredSid = '00000000-1111-2222-3333-444444444444'
  const restoredAt = Date.now() - 310_000
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-lifecycle-e2e-'))
    const home = path.join(dir, 'home')
    const dataDir = path.join(dir, 'data')
    fs.mkdirSync(home, { recursive: true })
    fs.mkdirSync(dataDir)
    vi.stubEnv('HOME', home)
    vi.stubEnv('USERPROFILE', home)
    vi.stubEnv('CODEX_HOME', path.join(home, '.codex'))
    vi.stubEnv('NODETERM_DATA_DIR', dataDir)
    const rollout = path.join(home, '.codex', 'sessions', '2026', '10', '14', `rollout-fixture-${restoredSid}.jsonl`)
    fs.mkdirSync(path.dirname(rollout), { recursive: true })
    fs.writeFileSync(rollout, JSON.stringify({ type: 'event_msg', timestamp: new Date(restoredAt).toISOString(), payload: { type: 'task_complete' } }) + '\n')
    fs.writeFileSync(path.join(dataDir, 'agent-status.json'), JSON.stringify({ v: 1, nodes: {
      'nt-life-restored': { agentId: 'codex', sessionId: restoredSid, state: 'done', updatedAt: Date.now(), transcriptPath: rollout }
    } }))
    const workspace: Workspace = { version: 2, activeProjectId: 'life', projects: [{
      id: 'life', name: 'Lifecycle fixture', color: '#fff', viewport: { x: 0, y: 0, zoom: 1 }, bridges: [], ropes: [],
      nodes: [...ids, 'nt-life-dead'].map(id => ({ id, kind: 'terminal', title: id, color: '#fff', group: null,
        position: { x: 0, y: 0 }, agentId: id.includes('claude') ? 'claude' : 'codex' }))
    }] }
    fs.writeFileSync(path.join(dataDir, 'workspace.json'), JSON.stringify(workspace))
    for (const id of ids) {
      // Only private-socket fixture panes. No agent CLI, provider request or real session is used.
      const command = id === 'nt-life-shell' ? 'bash --noprofile --norc' :
        id === 'nt-life-prompt' ? "printf 'Hooks need review\\n\\n1. Trust these hooks\\n2. Continue without hooks\\n'; sleep 120" : 'sleep 120'
      execFileSync('tmux', ['-L', TMUX_SOCKET, 'new-session', '-d', '-s', sessionName(id), '-x', '120', '-y', '36', command])
    }
    _resetForTest()
    const server = await startServer({ port: 0, host: '127.0.0.1', dataDir, rendererDir: path.join(dir, 'no-renderer'),
      insecureHttp: false, passwordSeed: 'lifecycle-fixture', installHooks: false, deadCardReapMinutes: 0 })
    close = server.close
    base = `http://127.0.0.1:${server.port}`
    auth = { authorization: `Bearer ${fs.readFileSync(path.join(dataDir, 'ops-token'), 'utf8').trim()}` }
  }, 30_000)
  afterAll(async () => {
    await close?.()
    for (const id of ids) {
      try { execFileSync('tmux', ['-L', TMUX_SOCKET, 'kill-session', '-t', `=${sessionName(id)}`], { stdio: 'ignore' }) } catch { /* already gone */ }
    }
    _resetForTest()
    vi.unstubAllEnvs()
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
  })
  async function post(provider: string, nodeId: string, hook: string, extra: object = {}) {
    const response = await fetch(`http://127.0.0.1:${hookServer.getPort()}/hook/${provider}`, { method: 'POST', headers: {
      'content-type': 'application/x-www-form-urlencoded', 'x-nodeterm-hook-token': hookServer.getToken()
    }, body: new URLSearchParams({ nodeId, payload: JSON.stringify({ hook_event_name: hook, session_id: `session-${nodeId}`, ...extra }) }) })
    expect(response.status).toBe(204)
  }
  async function inventory() {
    const response = await fetch(`${base}/opsapi/nodes`, { headers: auth })
    expect(response.status).toBe(200)
    const body = await response.json()
    return body.nodes as Array<{ id: string; provider: string; sessionId: string; agentStatus: string; lifecycle: {
      state: string; lastDoneAt: number | null; lastPromptAt: number | null; lastDoneClean: boolean; blockedOn: { kind: string } | null
    } }>
  }
  it('shows working, clean idle and blocked from actual hook POSTs, preserving compatibility status', async () => {
    await post('claude', 'nt-life-claude', 'UserPromptSubmit')
    expect((await inventory()).find(n => n.id === 'nt-life-claude')).toMatchObject({ provider: 'claude', agentStatus: 'working', lifecycle: { state: 'working', lastPromptAt: expect.any(Number) } })
    await post('claude', 'nt-life-claude', 'Stop')
    const completed = (await inventory()).find(n => n.id === 'nt-life-claude')!
    expect(completed).toMatchObject({ sessionId: 'session-nt-life-claude', agentStatus: 'idle', lifecycle: { state: 'idle-warm', lastDoneAt: expect.any(Number), lastDoneClean: true } })
    await post('claude', 'nt-life-claude', 'PostToolUse')
    expect((await inventory()).find(n => n.id === 'nt-life-claude')!.lifecycle.lastDoneAt).toBe(completed.lifecycle.lastDoneAt)
    await post('codex', 'nt-life-codex', 'UserPromptSubmit')
    await post('codex', 'nt-life-codex', 'PermissionRequest')
    expect((await inventory()).find(n => n.id === 'nt-life-codex')).toMatchObject({ agentStatus: 'blocked', lifecycle: { state: 'blocked', blockedOn: { kind: 'permission' } } })
  })
  it('exposes restored rollout cold state, detected prompts, shell exit and missing pane death', async () => {
    const rows = await inventory()
    expect(rows.find(n => n.id === 'nt-life-restored')).toMatchObject({ provider: 'codex', sessionId: restoredSid,
      lifecycle: { state: 'idle-cold', lastDoneAt: restoredAt } })
    expect(rows.find(n => n.id === 'nt-life-prompt')).toMatchObject({ agentStatus: null,
      lifecycle: { state: 'blocked', blockedOn: { kind: 'codex-hooks-review' } } })
    expect(rows.find(n => n.id === 'nt-life-shell')!.lifecycle.state).toBe('exited')
    expect(rows.find(n => n.id === 'nt-life-dead')!.lifecycle.state).toBe('dead')
  })
  it('does not call a failed turn clean, and observes SessionEnd separately', async () => {
    await post('claude', 'nt-life-claude', 'UserPromptSubmit')
    await post('claude', 'nt-life-claude', 'StopFailure')
    expect((await inventory()).find(n => n.id === 'nt-life-claude')!.lifecycle).toMatchObject({ state: 'unknown', lastDoneClean: false })
    await post('codex', 'nt-life-codex', 'SessionEnd')
    expect((await inventory()).find(n => n.id === 'nt-life-codex')!.lifecycle.state).toBe('exited')
  })
})
