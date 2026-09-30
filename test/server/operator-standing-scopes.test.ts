/** Real disposable Server Edition wiring with synthetic authenticated hooks only.
 * No provider CLI, account daemon, live data directory, or installed provider hooks are used.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { startServer } from '../../src/server/index'
import { hookServer } from '../../src/core/agents/hook-server'
import { nodeAuthToken } from '../../src/core/agents/node-auth-token'
import { writeFileAtomic } from '../../src/core/fs-atomic'
import { OPERATOR_POLICY_FILE, OPERATOR_STANDING_SCOPE_KIND, tokenDigest } from '../../src/server/operator-conversation-policy'
import { TMUX_SOCKET } from '../../src/core/tmux-naming'
import type { OperatorSessionTarget } from '../../src/shared/operator-conversations'

describe('standing operator scopes on disposable Server Edition', () => {
  it('exposes existing and future verified sessions through the unchanged external CLI, and revokes live', async () => {
    expect(TMUX_SOCKET).toBe(`nt-vitest-${process.pid}`)
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-standing-server-'))
    const dataDir = path.join(root, 'server')
    const codexDir = path.join(root, 'codex')
    const previousCodexHome = process.env.CODEX_HOME
    fs.mkdirSync(dataDir, { mode: 0o700 })
    fs.mkdirSync(path.join(codexDir, 'sessions'), { recursive: true, mode: 0o700 })
    process.env.CODEX_HOME = codexDir
    let server: Awaited<ReturnType<typeof startServer>> | undefined
    try {
      for (const i of [1, 2]) fs.mkdirSync(path.join(root, `project-${i}`), { mode: 0o700 })
      const workspace = { version: 3, activeProjectId: 'project-1', entries: [1, 2].map((i) => ({ id: `project-${i}`, project: {
        id: `project-${i}`, name: `Synthetic ${i}`, cwd: path.join(root, `project-${i}`), color: '#0a84ff',
        viewport: { x: 0, y: 0, zoom: 1 }, nodes: [{ id: `standing-node-${i}`, kind: 'terminal',
          title: `Synthetic ${i}`, position: { x: 0, y: 0 }, size: { width: 640, height: 440 } }], bridges: [], ropes: []
      } })) }
      fs.writeFileSync(path.join(dataDir, 'workspace.json'), JSON.stringify(workspace), { mode: 0o600 })
      server = await startServer({ port: 0, host: '127.0.0.1', dataDir,
        rendererDir: path.join(root, 'no-renderer'), passwordSeed: 'synthetic-standing-password',
        installHooks: false, canvasControl: false, headless: false, deadCardReapMinutes: 0 })
      const base = `http://127.0.0.1:${server.port}`
      const token = 'synthetic-standing-operator-01234567890123456789'
      const credential = path.join(root, 'credential')
      fs.writeFileSync(credential, token, { mode: 0o600 })
      const auth = { authorization: `Bearer ${token}` }
      const policyFile = path.join(dataDir, OPERATOR_POLICY_FILE)
      const principal = { id: 'synthetic-fern', tokenSha256: tokenDigest(token), expiresAt: '2099-01-01T00:00:00Z',
        read: [{ kind: OPERATOR_STANDING_SCOPE_KIND }], message: [{ kind: OPERATOR_STANDING_SCOPE_KIND }] }
      const setPolicy = () => writeFileAtomic(policyFile, JSON.stringify({ version: 2, principals: [principal] }), { mode: 0o600 })
      const register = async (i: number, authenticated = true) => {
        const sessionId = `synthetic-session-${i}`
        const transcript = path.join(codexDir, 'sessions', `synthetic-${i}.jsonl`)
        fs.writeFileSync(transcript, [
          { type: 'session_meta', payload: { id: sessionId } },
          { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `synthetic content ${i}` }] } }
        ].map((row) => JSON.stringify(row)).join('\n') + '\n', { mode: 0o600 })
        const nodeId = `standing-node-${i}`
        // Raw transcript callbacks precede normalized SessionStart. A later Stop binds its path
        // to the established session, as it does after an actual provider's first response.
        for (const hook_event_name of ['SessionStart', 'Stop']) {
          const response = await fetch(`http://127.0.0.1:${hookServer.getPort()}/hook/codex`, {
            method: 'POST', headers: { 'X-Nodeterm-Hook-Token': hookServer.getToken(),
              ...(authenticated ? { 'X-Nodeterm-Node-Token': nodeAuthToken(hookServer.nodeAuthSecretOrNull()!, nodeId) } : {}),
              'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ nodeId, payload: JSON.stringify({ hook_event_name, session_id: sessionId, transcript_path: transcript }) }).toString()
          })
          expect(response.status).toBe(204)
        }
      }
      const targets = async (): Promise<OperatorSessionTarget[]> => {
        const response = await fetch(`${base}/opsapi/v1/sessions`, { headers: auth })
        expect(response.status).toBe(200)
        return (await response.json()).targets
      }
      await register(1)
      await setPolicy()
      const original = (await targets())[0]
      expect(original).toMatchObject({ projectId: 'project-1', nodeId: 'standing-node-1', sessionId: 'synthetic-session-1' })
      expect(await targets()).toHaveLength(1)
      await register(2, false)
      expect(await targets()).toHaveLength(1)
      await register(2)
      expect(await targets()).toHaveLength(2)

      // Spawn only our local CLI. Bearer bytes are read from the private file, never argv.
      const { spawn } = await import('node:child_process')
      const cli = (command: string, extra: string[] = []) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [path.resolve('scripts/nodeterm-operator.mjs'), '--url', base,
          '--credential-file', credential, ...extra, command], { stdio: ['ignore', 'pipe', 'pipe'] })
        let stdout = ''; let stderr = ''
        child.stdout.setEncoding('utf8').on('data', (text) => { stdout += text })
        child.stderr.setEncoding('utf8').on('data', (text) => { stderr += text })
        child.once('error', reject)
        child.once('close', (code) => resolve({ code, stdout, stderr }))
      })
      const capabilities = await cli('capabilities')
      expect(capabilities.code).toBe(0)
      expect(JSON.parse(capabilities.stdout)).toMatchObject({ version: 1, permissions: { read: true, message: true } })
      const listed = await cli('sessions')
      expect(listed.code).toBe(0)
      expect(JSON.parse(listed.stdout).targets).toHaveLength(2)
      const targetFile = path.join(root, 'target.json')
      fs.writeFileSync(targetFile, JSON.stringify(original), { mode: 0o600 })
      const read = await cli('read', ['--target-file', targetFile])
      expect(read.stderr).toBe('')
      expect(read.code).toBe(0)
      expect(JSON.parse(read.stdout).items[0].text).toBe('synthetic content 1')

      await register(1) // An authenticated same-ID restart still changes the pinned generation.
      const stale = await cli('read', ['--target-file', targetFile])
      expect(stale.code).toBe(2)
      expect(JSON.parse(stale.stderr).error).toBe('stale_target')
      principal.read = []
      await setPolicy()
      const denied = await cli('read', ['--target-file', targetFile])
      expect(denied.code).toBe(2)
      expect(JSON.parse(denied.stderr).error).toBe('scope_denied')
      expect(await targets()).toHaveLength(2) // Independent message authority still enumerates.
      principal.message = []
      await setPolicy()
      expect(await targets()).toEqual([])
      const audit = fs.readFileSync(path.join(dataDir, 'operator-conversation-audit.jsonl'), 'utf8')
      expect(audit).toContain('scope_denied')
      expect(audit).not.toContain(token)
      expect(audit).not.toContain('synthetic content')
    } finally {
      await server?.close()
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = previousCodexHome
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)
})
