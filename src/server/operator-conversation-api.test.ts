import http from 'node:http'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OperatorSessionBindings } from '../core/operator-session-bindings'
import { tokenDigest, OPERATOR_POLICY_FILE } from './operator-conversation-policy'
import { createOperatorConversationApi } from './operator-conversation-api'
import type { OperatorDeliveryInput } from '../core/agents/operator-messaging'

const token = 'operator-token-012345678901234567890123456789'
const secondToken = 'second-operator-012345678901234567890123456789'
const management = 'management-token-012345678901234567890123456789'
const targetBase = { projectId: 'p1', nodeId: 'n1', sessionId: 'session1' }
const transcriptRow = (type: string, content: unknown) => JSON.stringify({ type, sessionId: 'session1', message: { content } })

describe('operator conversation HTTP API', () => {
  let server: http.Server | undefined
  let dir = ''
  let base = ''
  let bindings: OperatorSessionBindings
  let projects: Array<{ id: string; nodes: Array<{ id: string; kind: string }> }>
  let sends: OperatorDeliveryInput[]
  let drain: (() => Promise<void>) | undefined

  async function setup(scopes: { read?: boolean; message?: boolean } = { read: true, message: true }) {
    dir = await mkdtemp(path.join(os.tmpdir(), 'operator-api-'))
    const transcript = path.join(dir, 'transcript.jsonl')
    await writeFile(transcript, [transcriptRow('user', [{ type: 'text', text: 'hello' }]),
      transcriptRow('assistant', [{ type: 'thinking', thinking: 'private reasoning' }, { type: 'text', text: 'Bearer abcdefghijklmnop' }])].join('\n') + '\n')
    const scope = { ...targetBase }
    await writeFile(path.join(dir, OPERATOR_POLICY_FILE), JSON.stringify({ version: 1, principals: [{
      id: 'operator1', tokenSha256: tokenDigest(token), expiresAt: '2099-01-01T00:00:00Z',
      read: scopes.read ? [scope] : [], message: scopes.message ? [scope] : []
    }, { id: 'operator2', tokenSha256: tokenDigest(secondToken), expiresAt: '2099-01-01T00:00:00Z', read: [scope], message: [scope] }] }), { mode: 0o600 })
    bindings = new OperatorSessionBindings()
    bindings.observe({ nodeId: 'n1', agentId: 'claude', kind: 'session', sessionId: 'session1', sessionPhase: 'start', verified: true })
    const target = bindings.targets([{ id: 'p1', nodes: [{ id: 'n1', kind: 'terminal' }] }])[0]
    bindings.transcript('n1', 'session1', 'claude', transcript)
    projects = [{ id: 'p1', nodes: [{ id: 'n1', kind: 'terminal' }] }]
    sends = []
    const handler = createOperatorConversationApi({ dataDir: dir, managementToken: management, bindings,
      projects: () => projects,
      sendMessage: async (input) => { sends.push(input); return { kind: 'queued', retryAfterMs: 10 } as never }
    })
    drain = handler.drain
    server = http.createServer((req, res) => void handler(req, res))
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    return target
  }
  async function close() {
    if (server) await new Promise<void>((resolve) => server!.close(() => resolve()))
    server = undefined
    await drain?.()
    drain = undefined
    if (dir) await rm(dir, { recursive: true, force: true })
    dir = ''
  }
  afterEach(close)
  const auth = { authorization: `Bearer ${token}` }
  const conversationUrl = (t: object) =>
    `${base}/opsapi/v1/conversation?${new URLSearchParams(Object.entries(t).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))}`

  it('separates management auth, cookies, browser origins, and read from message scope', async () => {
    const target = await setup({ read: true, message: false })
    expect((await fetch(`${base}/opsapi/v1/sessions`)).status).toBe(401)
    expect((await fetch(`${base}/opsapi/v1/sessions`, { headers: { cookie: 'nt_session=anything' } })).status).toBe(401)
    expect((await fetch(`${base}/opsapi/v1/sessions`, { headers: { authorization: `Bearer ${management}` } })).status).toBe(401)
    expect((await fetch(`${base}/opsapi/v1/sessions`, { headers: { ...auth, origin: 'https://attacker.test' } })).status).toBe(403)
    expect((await fetch(conversationUrl(target), { headers: auth })).status).toBe(200)
    const denied = await fetch(`${base}/opsapi/v1/messages`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json', 'idempotency-key': 'request-001' },
      body: JSON.stringify({ target, text: 'hello' }) })
    expect(denied.status).toBe(403)
    expect(sends).toHaveLength(0)
  })

  it('returns scoped synthetic paginated transcript with redaction, excluding reasoning', async () => {
    const target = await setup()
    const first = await fetch(conversationUrl({ ...target, limit: '1' }), { headers: auth })
    expect(first.status).toBe(200)
    const page = await first.json()
    expect(page.items).toHaveLength(1)
    expect(page.items[0].text).toBe('hello')
    expect(page.nextCursor).toBeTruthy()
    const next = await fetch(conversationUrl({ ...target, limit: '5', cursor: page.nextCursor }), { headers: auth })
    const item = (await next.json()).items[0]
    expect(item.text).toContain('Bearer [REDACTED]')
    expect(item.text).not.toContain('private reasoning')
  })

  it('does not let message-only authority read or another valid caller read a receipt', async () => {
    const target = await setup({ read: false, message: true })
    expect((await fetch(conversationUrl(target), { headers: auth })).status).toBe(403)
    const created = await fetch(`${base}/opsapi/v1/messages`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json', 'idempotency-key': 'request-003' },
      body: JSON.stringify({ target, text: 'caller-private receipt' }) })
    const receipt = await created.json()
    expect((await fetch(`${base}/opsapi/v1/receipts/${receipt.id}`, { headers: { authorization: `Bearer ${secondToken}` } })).status).toBe(404)
  })

  it('rejects duplicate or unknown query controls, stale generations and duplicate node ownership', async () => {
    const target = await setup()
    expect((await fetch(conversationUrl({ ...target, x: '1' }), { headers: auth })).status).toBe(400)
    expect((await fetch(`${conversationUrl(target)}&nodeId=n1`, { headers: auth })).status).toBe(400)
    expect((await fetch(conversationUrl({ ...target, generation: 'stale' }), { headers: auth })).status).toBe(409)
    projects.push({ id: 'other', nodes: [{ id: 'n1', kind: 'terminal' }] })
    expect((await fetch(conversationUrl(target), { headers: auth })).status).toBe(409)
  })

  it('deduplicates concurrent same-key posts to one queue call and exposes caller-scoped receipt', async () => {
    const target = await setup()
    const body = JSON.stringify({ target, text: 'synthetic operator message' })
    const post = () => fetch(`${base}/opsapi/v1/messages`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json', 'idempotency-key': 'request-001' }, body })
    const [a, b] = await Promise.all([post(), post()])
    expect(a.status).toBe(202); expect(b.status).toBe(202)
    const [ra, rb] = await Promise.all([a.json(), b.json()])
    expect(ra.id).toBe(rb.id)
    expect(sends).toHaveLength(1)
    const conflict = await fetch(`${base}/opsapi/v1/messages`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json', 'idempotency-key': 'request-001' },
      body: JSON.stringify({ target, text: 'different synthetic body' }) })
    expect(conflict.status).toBe(409)
    expect((await fetch(`${base}/opsapi/v1/receipts/${ra.id}`, { headers: auth })).status).toBe(200)
    const other = await fetch(`${base}/opsapi/v1/receipts/${ra.id}`, { headers: { authorization: `Bearer ${secondToken}` } })
    expect(other.status).toBe(404)
    const files = (await Promise.all(['operator-message-receipts.json', 'operator-conversation-audit.jsonl'].map((f) => readFile(path.join(dir, f), 'utf8')))).join('\n')
    expect(files).not.toContain('synthetic operator message')
    expect(files).not.toContain(token)
  })

  it('rejects malformed message payloads before dispatch', async () => {
    const target = await setup()
    for (const body of ['{', JSON.stringify({ target, text: '  ' }), JSON.stringify({ target, text: 'x', extra: 1 })]) {
      const response = await fetch(`${base}/opsapi/v1/messages`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json', 'idempotency-key': 'request-001' }, body })
      expect(response.status).toBe(400)
    }
    expect(sends).toHaveLength(0)
  })

  it('rechecks authorization at queue admission and records only verified delivery evidence', async () => {
    const target = await setup()
    const response = await fetch(`${base}/opsapi/v1/messages`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json', 'idempotency-key': 'request-002' },
      body: JSON.stringify({ target, text: 'another synthetic message' }) })
    const accepted = await response.json()
    expect(sends).toHaveLength(1)
    expect(await sends[0].authorize()).toBe(true)
    await sends[0].onAccepted?.()
    await sends[0].onOutcome({ kind: 'delivered', traceId: 'synthetic-trace', traced: 'memory', receipt: 'observed', signal: 'newTurn' })
    const receipt = await fetch(`${base}/opsapi/v1/receipts/${accepted.id}`, { headers: auth })
    expect(await receipt.json()).toMatchObject({ state: 'acknowledged', evidence: 'verified_correlated_prompt' })

    const pathToPolicy = path.join(dir, OPERATOR_POLICY_FILE)
    await writeFile(pathToPolicy, JSON.stringify({ version: 1, principals: [] }), { mode: 0o600 })
    expect(await sends[0].authorize()).toBe(false)
  })

  it('fails delivery receipts on queue failure and denies an expired credential before dispatch', async () => {
    const target = await setup()
    const response = await fetch(`${base}/opsapi/v1/messages`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json', 'idempotency-key': 'request-004' },
      body: JSON.stringify({ target, text: 'failure path synthetic' }) })
    const accepted = await response.json()
    await sends[0].onOutcome({ kind: 'messageRejected', reason: 'synthetic_failure' } as never)
    expect(await (await fetch(`${base}/opsapi/v1/receipts/${accepted.id}`, { headers: auth })).json()).toMatchObject({ state: 'failed', outcome: 'messageRejected' })
    await writeFile(path.join(dir, OPERATOR_POLICY_FILE), JSON.stringify({ version: 1, principals: [{
      id: 'operator1', tokenSha256: tokenDigest(token), expiresAt: '2000-01-01T00:00:00Z', read: [], message: [{ ...targetBase }]
    }] }), { mode: 0o600 })
    const denied = await fetch(`${base}/opsapi/v1/messages`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json', 'idempotency-key': 'request-005' },
      body: JSON.stringify({ target, text: 'expired synthetic' }) })
    expect(denied.status).toBe(401)
    expect(sends).toHaveLength(1)
  })
})
