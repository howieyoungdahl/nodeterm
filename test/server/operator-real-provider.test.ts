/** Opt-in only: real provider calls, private tmux socket, disposable server/project.
 * No live canvas sessions or settings are changed. Message delivery MUST use /opsapi/v1/messages;
 * authenticated UI input below is exclusively the synthetic human-draft fixture and its cleanup.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import WebSocket from 'ws'
import { describe, expect, it, vi } from 'vitest'
import { startServer } from '../../src/server/index'
import { IPC } from '../../src/shared/ipc'
import type { NormalizedAgentEvent } from '../../src/shared/agents/normalize'
import type {
  OperatorSessionTarget,
  OperatorConversationItem,
  OperatorMessageReceipt
} from '../../src/shared/operator-conversations'
import { buildManagedScript } from '../../src/core/agents/hooks/managed-script'
import { buildCodexHooksAndTrust } from '../../src/core/agents/hooks/codex'
import { upsertHookTrustEntriesInContent } from '../../src/core/agents/hooks/codex-trust'
import { mergeManagedHook } from '../../src/core/agents/hooks/install-helper'
import { CLAUDE_HOOK_EVENTS } from '../../src/shared/agents/hook-events'
import { inspectOperatorComposer } from '../../src/server/settled-envelope'
import { sessionName, TMUX_SOCKET } from '../../src/core/tmux-naming'
import { PtyManager } from '../../src/core/pty-manager'

const enabled = process.env.NODETERM_REAL_PROVIDER_TEST === '1' && process.platform !== 'win32'
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const sha = (s: string) => createHash('sha256').update(s.replace(/\r\n/g, '\n')).digest('hex')
async function until<T>(
  label: string,
  read: () => T | Promise<T>,
  good: (v: T) => boolean,
  ms = 60_000
): Promise<T> {
  const end = Date.now() + ms
  do {
    const value = await read()
    if (good(value)) return value
    await wait(200)
  } while (Date.now() < end)
  throw new Error(`Timed out: ${label}`)
}

describe.skipIf(!enabled)('operator conversation: real disposable Claude/Codex', () => {
  it('protects a human draft, delivers through the normal queue, and correlates receipts', async () => {
    // The shared Vitest setup mints this socket before imports; reject any inherited live socket.
    expect(TMUX_SOCKET).toBe(`nt-vitest-${process.pid}`)
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-operator-real-'))
    const projectDir = path.join(root, 'synthetic-project')
    const dataDir = path.join(root, 'server')
    const codexDir = path.join(root, 'codex')
    const hookHome = path.join(root, 'hook-home')
    for (const dir of [
      projectDir,
      dataDir,
      codexDir,
      hookHome,
      path.join(root, 'agent-hooks'),
      path.join(root, 'bin')
    ])
      fs.mkdirSync(dir, { mode: 0o700 })
    const previousCodexDir = process.env.CODEX_HOME
    let server: Awaited<ReturnType<typeof startServer>> | undefined
    let ws: WebSocket | undefined
    const nodeIds: string[] = []
    let base = ''
    let managementAuth: Record<string, string> = {}
    const operatorToken = randomBytes(32).toString('hex')
    const operatorAuth = { authorization: `Bearer ${operatorToken}` }
    const scopes: Array<{
      projectId: string
      nodeId: string
      sessionId: string
    }> = []
    const events: NormalizedAgentEvent[] = []
    const safeReport: Array<Record<string, unknown>> = []
    const paneWrites = vi.spyOn(PtyManager.prototype, 'sendText')
    try {
      // Native provider profile isolation, not a change to the live Codex configuration.
      const nativeCodexDir = previousCodexDir || path.join(os.homedir(), '.codex')
      fs.copyFileSync(path.join(nativeCodexDir, 'auth.json'), path.join(codexDir, 'auth.json'))
      fs.chmodSync(path.join(codexDir, 'auth.json'), 0o600)
      process.env.CODEX_HOME = codexDir // the server transcript jail follows this native profile
      const codexScript = path.join(root, 'agent-hooks', 'codex.sh')
      const claudeScript = path.join(root, 'agent-hooks', 'claude.sh')
      fs.writeFileSync(codexScript, buildManagedScript('codex', null), {
        mode: 0o700
      })
      fs.writeFileSync(claudeScript, buildManagedScript('claude', null), {
        mode: 0o700
      })
      const codexHooksFile = path.join(codexDir, 'hooks.json')
      // Only each hook child sees this empty home. Managed discovery cannot find live fallback
      // endpoints or permission-answer files, even if the disposable primary endpoint fails.
      const hookCommand = (script: string) =>
        `env -u NODETERM_PERM_WAIT_SECS HOME=${quote(hookHome)} /bin/sh ${quote(script)}`
      const codexHooks = buildCodexHooksAndTrust({}, hookCommand(codexScript), codexHooksFile)!
      fs.writeFileSync(codexHooksFile, JSON.stringify(codexHooks.config), {
        mode: 0o600
      })
      const config = `model = "gpt-6.1-sol"\nmodel_reasoning_effort = "xhigh"\n[projects.${JSON.stringify(projectDir)}]\ntrust_level = "trusted"\n`
      fs.writeFileSync(
        path.join(codexDir, 'config.toml'),
        upsertHookTrustEntriesInContent(config, codexHooks.trustEntries),
        { mode: 0o600 }
      )
      const claudeSettings = path.join(root, 'claude-settings.json')
      fs.writeFileSync(
        claudeSettings,
        JSON.stringify(
          mergeManagedHook(
            { tui: 'fullscreen', promptSuggestions: false },
            hookCommand(claudeScript),
            CLAUDE_HOOK_EVENTS
          )
        ),
        { mode: 0o600 }
      )
      fs.writeFileSync(
        path.join(dataDir, 'workspace.json'),
        JSON.stringify({
          version: 2,
          activeProjectId: 'synthetic-project',
          projects: [
            {
              id: 'synthetic-project',
              name: 'Disposable operator validation',
              cwd: projectDir,
              color: '#0a84ff',
              viewport: { x: 0, y: 0, zoom: 1 },
              nodes: [],
              bridges: [],
              ropes: []
            }
          ]
        })
      )
      server = await startServer({
        port: 0,
        host: '127.0.0.1',
        dataDir,
        rendererDir: path.join(root, 'no-renderer'),
        passwordSeed: 'synthetic-local-password',
        installHooks: false,
        canvasControl: true,
        headless: false,
        deadCardReapMinutes: 0
      })
      base = `http://127.0.0.1:${server.port}`
      managementAuth = {
        authorization: `Bearer ${fs.readFileSync(path.join(dataDir, 'ops-token'), 'utf8').trim()}`
      }
      const login = await fetch(`${base}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'password=synthetic-local-password',
        redirect: 'manual'
      })
      expect(login.status).toBe(303)
      ws = new WebSocket(`${base.replace('http:', 'ws:')}/ws`, {
        headers: { cookie: login.headers.get('set-cookie')!.split(';')[0] }
      })
      ws.on('message', (raw, binary) => {
        if (binary) return
        const message = JSON.parse(raw.toString())
        if (message.t === 'ev' && message.channel === IPC.agentStatus) events.push(message.args[0])
      })
      await new Promise<void>((resolve, reject) => {
        ws!.once('open', resolve)
        ws!.once('error', reject)
      })
      let rpcId = 0
      const ui = (method: string, args: unknown[]) =>
        new Promise<unknown>((resolve, reject) => {
          const id = ++rpcId
          const timer = setTimeout(() => {
            ws!.off('message', listener)
            reject(new Error(`UI timeout: ${method}`))
          }, 10_000)
          const listener = (raw: WebSocket.RawData, binary: boolean) => {
            if (binary) return
            const message = JSON.parse(raw.toString())
            if (message.id !== id || message.t !== 'res') return
            clearTimeout(timer)
            ws!.off('message', listener)
            if (!message.ok) reject(new Error('Disposable UI request failed'))
            else resolve(message.result)
          }
          ws!.on('message', listener)
          ws!.send(JSON.stringify({ t: 'req', id, method, args }))
        })
      const policy = () =>
        fs.writeFileSync(
          path.join(dataDir, 'operator-conversations.json'),
          JSON.stringify({
            version: 1,
            principals: [
              {
                id: 'synthetic-validator',
                tokenSha256: sha(operatorToken),
                expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
                read: scopes,
                message: scopes
              }
            ]
          }),
          { mode: 0o600 }
        )
      const capture = (nodeId: string, styled = false) =>
        execFileSync(
          'tmux',
          [
            '-L',
            TMUX_SOCKET,
            'capture-pane',
            '-p',
            ...(styled ? ['-e'] : []),
            '-t',
            `${sessionName(nodeId)}:0.0`
          ],
          { encoding: 'utf8' }
        )
      const submit = async (target: OperatorSessionTarget, text: string, key: string) => {
        const res = await fetch(`${base}/opsapi/v1/messages`, {
          method: 'POST',
          headers: {
            ...operatorAuth,
            'content-type': 'application/json',
            'idempotency-key': key
          },
          body: JSON.stringify({ target, text })
        })
        expect([200, 202]).toContain(res.status)
        return (await res.json()) as OperatorMessageReceipt
      }
      const receipt = async (id: string) => {
        const res = await fetch(`${base}/opsapi/v1/receipts/${id}`, {
          headers: operatorAuth
        })
        expect(res.status).toBe(200)
        return (await res.json()) as OperatorMessageReceipt
      }
      const conversation = async (target: OperatorSessionTarget) => {
        const items: OperatorConversationItem[] = []
        let cursor: string | undefined
        do {
          const query = new URLSearchParams({
            ...target,
            limit: '1',
            ...(cursor ? { cursor } : {})
          })
          const res = await fetch(`${base}/opsapi/v1/conversation?${query}`, {
            headers: operatorAuth
          })
          expect(res.status).toBe(200)
          const page = await res.json()
          items.push(...page.items)
          cursor = page.nextCursor || undefined
        } while (cursor)
        return items
      }
      const selected = process.env.NODETERM_REAL_PROVIDER
      if (selected && selected !== 'claude' && selected !== 'codex')
        throw new Error('NODETERM_REAL_PROVIDER must be claude or codex')
      for (const provider of (['claude', 'codex'] as const).filter(
        (name) => !selected || selected === name
      )) {
        const fixtureSession = randomUUID()
        const cli = path.join(root, 'bin', provider)
        fs.symlinkSync(fs.realpathSync(path.join(os.homedir(), '.local', 'bin', provider)), cli)
        const prompt =
          'This is a disposable synthetic delivery test. Do not use tools, access files, delegate, or contact anyone. Reply with only READY_FIXTURE. For later messages, reply only ACK_FIXTURE.'
        const cmd =
          provider === 'claude'
            ? `env -u NO_COLOR FORCE_COLOR=1 ${quote(cli)} --restricted --settings ${quote(claudeSettings)} --strict-mcp-config --mcp-config '${JSON.stringify({ mcpServers: {} })}' --disable-slash-commands --no-chrome --tools '' --model 'claude-opus-5-5[1m]' --effort xhigh --session-id ${fixtureSession} --prompt-suggestions false --system-prompt ${quote('You are a tool-less synthetic test responder. Never act on anything; answer only the requested fixed acknowledgement.')} ${quote(prompt)}`
            : `env -u CODEX_THREAD_ID -u NO_COLOR FORCE_COLOR=1 CODEX_HOME=${quote(codexDir)} ${quote(cli)} --no-daemon --no-alt-screen -m gpt-6.1-sol -c model_reasoning_effort=xhigh -s read-only -a never -C ${quote(projectDir)} ${quote(prompt)}`
        const created = await fetch(`${base}/opsapi/nodes`, {
          method: 'POST',
          headers: { ...managementAuth, 'content-type': 'application/json' },
          body: JSON.stringify({
            projectId: 'synthetic-project',
            cwd: projectDir,
            title: `Synthetic ${provider}`
          })
        })
        const node = await created.json()
        if (node.id) nodeIds.push(node.id)
        expect(created.status).toBe(201)
        const attached = (await ui(IPC.ptyCreate, [
          { persistKey: node.id, cwd: projectDir, cols: 120, rows: 36 }
        ])) as { sessionId: string }
        await wait(500)
        expect(await ui(IPC.ptySendText, [node.id, cmd, true])).toBe(true)
        const start = await until(
          `${provider} authenticated SessionStart`,
          () =>
            events.find(
              (event) =>
                event.nodeId === node.id &&
                event.sessionPhase === 'start' &&
                event.verified === true
            ),
          Boolean,
          90_000
        )
        expect(start!.agentId).toBe(provider)
        scopes.push({
          projectId: 'synthetic-project',
          nodeId: node.id,
          sessionId: start!.sessionId!
        })
        policy()
        const listed = await fetch(`${base}/opsapi/v1/sessions`, {
          headers: operatorAuth
        })
        const target = (await listed.json()).targets.find(
          (candidate: OperatorSessionTarget) => candidate.nodeId === node.id
        ) as OperatorSessionTarget
        expect(target).toBeDefined()
        await until(
          `${provider} initial idle`,
          () => events.filter((event) => event.nodeId === node.id).at(-1),
          (event) => event?.state === 'done',
          120_000
        )
        // UI input simulates an unsent human draft; it is NOT operator message delivery.
        const draft = `UNSENT_HUMAN_DRAFT_${provider.toUpperCase()}`
        await ui(IPC.ptySendText, [node.id, draft, false])
        await until(
          `${provider} visible human draft`,
          () => capture(node.id),
          (value) => value.includes(draft)
        )
        expect(inspectOperatorComposer(capture(node.id, true))).toBe('draft')
        const beforeDraftRefusal = paneWrites.mock.calls.length
        const refused = await submit(target, `SYNTHETIC_REFUSED_${provider}`, `draft-${provider}`)
        const failed = await until(
          `${provider} draft refusal`,
          () => receipt(refused.id),
          (value) => value.state === 'failed'
        )
        expect(capture(node.id)).toContain(draft)
        expect(capture(node.id)).not.toContain(`SYNTHETIC_REFUSED_${provider}`)
        expect(failed.outcome).toMatch(/draft|notPermitted|messageRejected/)
        expect(paneWrites.mock.calls.length).toBe(beforeDraftRefusal)
        // A simulated person clears ONLY their own synthetic draft, using the UI's normal input.
        // Attach retrieves this disposable node's PTY id; it neither resumes nor creates an agent.
        ws.send(
          JSON.stringify({
            t: 'cast',
            method: IPC.ptyWrite,
            args: [attached.sessionId, '\u0001\u000b']
          })
        )
        await until(
          `${provider} draft cleared`,
          () => capture(node.id),
          (value) => !value.includes(draft)
        )
        await wait(10_100) // preserve the normal sender/target rate budget
        expect(inspectOperatorComposer(capture(node.id, true))).toBe('clear')
        const marker = `Synthetic operator ${provider} ${randomBytes(4).toString('hex')}`
        const admitted = await submit(target, marker, `delivery-${provider}`)
        const delivered = await until(
          `${provider} correlated receipt`,
          () => receipt(admitted.id),
          (value) => ['acknowledged', 'failed'].includes(value.state),
          120_000
        )
        const pageItems = await conversation(target)
        const publicMessage = pageItems.find(
          (item) => item.kind === 'user' && item.text.includes(marker)
        )
        expect(publicMessage).toMatchObject({
          provenance: {
            source: 'transcript',
            agentId: provider,
            submitted: true
          }
        })
        expect(publicMessage?.timestamp).toEqual(expect.any(String))
        const submitted = paneWrites.mock.calls.find(
          (call) => call[0] === node.id && call[1].includes(marker)
        )?.[1]
        const correlated =
          !!submitted &&
          events.some(
            (event) =>
              event.nodeId === node.id &&
              event.sessionId === target.sessionId &&
              event.verified &&
              event.newTurn &&
              event.submittedPromptSha256 === sha(submitted)
          )
        safeReport.push({
          provider,
          generation: target.generation,
          draftOutcome: failed.outcome,
          delivery: delivered.state,
          outcome: delivered.outcome,
          evidence: delivered.evidence,
          correlated,
          orderedItems: pageItems.length,
          cliVersion: execFileSync(cli, ['--version'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore']
          }).trim()
        })
        console.log('REAL_PROVIDER_VALIDATION', JSON.stringify(safeReport.at(-1)))
        expect(delivered.state).toBe('acknowledged')
        expect(delivered.evidence).toBe('verified_correlated_prompt')
        expect(correlated).toBe(true)
        expect(
          pageItems.every((item, index) => !index || item.sequence > pageItems[index - 1].sequence)
        ).toBe(true)
        // Duplicate sends keep the original receipt and never create another turn.
        expect((await submit(target, marker, `delivery-${provider}`)).id).toBe(admitted.id)
        await until(
          `${provider} response idle`,
          () => events.filter((event) => event.nodeId === node.id).at(-1),
          (event) => event?.state === 'done',
          120_000
        )
        if (provider === 'codex') {
          const previousEventCount = events.length
          // A person exits/resumes only this disposable CLI. Operator delivery never does so.
          ws.send(
            JSON.stringify({
              t: 'cast',
              method: IPC.ptyWrite,
              args: [attached.sessionId, '\u0004']
            })
          )
          await until(
            'disposable Codex process exited',
            () =>
              execFileSync(
                'tmux',
                [
                  '-L',
                  TMUX_SOCKET,
                  'display-message',
                  '-p',
                  '-t',
                  `${sessionName(node.id)}:0.0`,
                  '#{pane_current_command}'
                ],
                { encoding: 'utf8' }
              ).trim(),
            (command) => command === 'bash'
          )
          const resumeCmd = `${cmd.slice(0, -quote(prompt).length)}resume ${quote(target.sessionId)} ${quote('Reply only ACK_FIXTURE. This is the same disposable synthetic session.')}`
          expect(await ui(IPC.ptySendText, [node.id, resumeCmd, true])).toBe(true)
          const resumed = await until(
            'real authenticated same-ID Codex resume',
            () =>
              events
                .slice(previousEventCount)
                .find(
                  (event) =>
                    event.nodeId === node.id &&
                    event.sessionPhase === 'start' &&
                    event.verified === true
                ),
            Boolean,
            90_000
          )
          expect(resumed!.sessionId).toBe(target.sessionId)
          const newList = await fetch(`${base}/opsapi/v1/sessions`, {
            headers: operatorAuth
          })
          const replacement = (await newList.json()).targets.find(
            (candidate: OperatorSessionTarget) => candidate.nodeId === node.id
          )
          expect(replacement.generation).not.toBe(target.generation)
          const writesBeforeStaleRequests = paneWrites.mock.calls.length
          const oldRead = await fetch(
            `${base}/opsapi/v1/conversation?${new URLSearchParams({ ...target })}`,
            { headers: operatorAuth }
          )
          expect(oldRead.status).toBe(409)
          expect((await oldRead.json()).error).toBe('stale_target')
          const oldSend = await fetch(`${base}/opsapi/v1/messages`, {
            method: 'POST',
            headers: {
              ...operatorAuth,
              'content-type': 'application/json',
              'idempotency-key': 'stale-real-resume'
            },
            body: JSON.stringify({
              target,
              text: 'Never deliver this stale synthetic message'
            })
          })
          expect(oldSend.status).toBe(409)
          expect((await oldSend.json()).error).toBe('stale_target')
          expect(paneWrites.mock.calls.length).toBe(writesBeforeStaleRequests)
          console.log(
            'REAL_CODEX_RESUME_VALIDATION',
            JSON.stringify({
              sameSessionId: true,
              generationRotated: true,
              staleRead: 409,
              staleSend: 409,
              stalePaneWrites: 0
            })
          )
          await until(
            'resumed disposable Codex idle',
            () =>
              events
                .slice(previousEventCount)
                .filter((event) => event.nodeId === node.id)
                .at(-1),
            (event) => event?.state === 'done',
            120_000
          )
        }
        const removed = await fetch(`${base}/opsapi/nodes/${node.id}`, {
          method: 'DELETE',
          headers: managementAuth
        })
        expect(removed.status).toBe(200)
        nodeIds.splice(nodeIds.indexOf(node.id), 1)
      }
      expect(safeReport).toHaveLength(selected ? 1 : 2)
    } finally {
      // Stop our own providers before closing the endpoint, so hook failover cannot reach live servers.
      for (const nodeId of nodeIds) {
        await fetch(`${base}/opsapi/nodes/${nodeId}`, {
          method: 'DELETE',
          headers: managementAuth
        }).catch(() => {})
        const target = `${sessionName(nodeId)}:0.0`
        try {
          execFileSync('tmux', ['-L', TMUX_SOCKET, 'kill-session', '-t', target], {
            stdio: 'ignore'
          })
        } catch {
          /* already closed */
        }
        let remains = false
        try {
          execFileSync('tmux', ['-L', TMUX_SOCKET, 'has-session', '-t', target], {
            stdio: 'ignore'
          })
          remains = true
        } catch {
          /* absent */
        }
        expect(remains).toBe(false)
      }
      ws?.terminate()
      await server?.close()
      paneWrites.mockRestore()
      if (previousCodexDir === undefined) delete process.env.CODEX_HOME
      else process.env.CODEX_HOME = previousCodexDir
      fs.rmSync(root, { recursive: true, force: true })
    }
  }, 600_000)
})
