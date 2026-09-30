import http from 'node:http'
import { mkdtemp, writeFile, readFile, rm, realpath } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OperatorSessionBindings } from '../core/operator-session-bindings'
import { tokenDigest, OPERATOR_POLICY_FILE, OPERATOR_STANDING_SCOPE_KIND } from './operator-conversation-policy'
import * as policyModule from './operator-conversation-policy'
import * as conversationModule from '../core/operator-conversation'
import { OperatorReceiptStore } from './operator-receipts'
import { writeFileAtomic } from '../core/fs-atomic'
import { DeliveryQueue } from '../core/agents/delivery-queue'
import { sendOperatorMessage } from '../core/agents/operator-messaging'
import type { AgentMessageOutcome } from '../core/agents/agent-message-decide'
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

  async function setup(scopes: { read?: boolean; message?: boolean; standing?: boolean } = { read: true, message: true },
    dispatch?: (input: OperatorDeliveryInput) => Promise<AgentMessageOutcome>) {
    dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'operator-api-')))
    const transcript = path.join(dir, 'transcript.jsonl')
    await writeFile(transcript, [transcriptRow('user', [{ type: 'text', text: 'hello' }]),
      transcriptRow('assistant', [{ type: 'thinking', thinking: 'private reasoning' }, { type: 'text', text: 'Bearer abcdefghijklmnop' }])].join('\n') + '\n')
    const scope = scopes.standing ? { kind: OPERATOR_STANDING_SCOPE_KIND } : { ...targetBase }
    await writeFile(path.join(dir, OPERATOR_POLICY_FILE), JSON.stringify({ version: scopes.standing ? 2 : 1, principals: [{
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
      sendMessage: async (input) => { sends.push(input); return dispatch ? dispatch(input) : { kind: 'queued', retryAfterMs: 10 } as never }
    })
    drain = handler.drain
    server = http.createServer((req, res) => void handler(req, res))
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    return target
  }
  async function close() {
    vi.restoreAllMocks()
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

  async function editPolicy(edit: (value: ReturnType<typeof JSON.parse>) => void) {
    const file = path.join(dir, OPERATOR_POLICY_FILE)
    const value = JSON.parse(await readFile(file, 'utf8'))
    edit(value)
    await writeFileAtomic(file, JSON.stringify(value), { mode: 0o600 })
  }
  const post = (target: object, key = 'standing-request-001') => fetch(`${base}/opsapi/v1/messages`, {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify({ target, text: 'standing synthetic body' })
  })
  const deferred = () => {
    let resolve!: () => void
    const promise = new Promise<void>((r) => { resolve = r })
    return { promise, resolve }
  }

  it.each(['read', 'message'] as const)('enumerates current and future verified sessions across projects with independent standing %s', async (operation) => {
    const current = await setup({ read: operation === 'read', message: operation === 'message', standing: true })
    expect(await (await fetch(`${base}/opsapi/v1/capabilities`, { headers: auth })).json()).toMatchObject({
      version: 1, permissions: { read: operation === 'read', message: operation === 'message' }
    })
    expect((await (await fetch(`${base}/opsapi/v1/sessions`, { headers: auth })).json()).targets).toEqual([current])
    projects.push({ id: 'p2', nodes: [{ id: 'n2', kind: 'terminal' }, { id: 'persisted', kind: 'terminal' }, { id: 'unverified', kind: 'terminal' }] })
    bindings.observe({ nodeId: 'n2', agentId: 'claude', kind: 'session', sessionId: 'session2', sessionPhase: 'start', verified: true })
    bindings.observe({ nodeId: 'unverified', agentId: 'claude', kind: 'session', sessionId: 'session3', sessionPhase: 'start', verified: false })
    const future = bindings.targets(projects).find((t) => t.nodeId === 'n2')!
    const transcript = path.join(dir, 'future.jsonl')
    await writeFile(transcript, JSON.stringify({ type: 'user', sessionId: 'session2', message: { content: 'future content' } }) + '\n')
    bindings.transcript('n2', 'session2', 'claude', transcript)
    expect((await (await fetch(`${base}/opsapi/v1/sessions`, { headers: auth })).json()).targets).toEqual([current, future])
    const read = await fetch(conversationUrl(future), { headers: auth })
    expect(read.status).toBe(operation === 'read' ? 200 : 403)
    if (operation === 'read') expect((await read.json()).items[0].text).toBe('future content')
    expect((await post(future)).status).toBe(operation === 'message' ? 202 : 403)
    expect(sends).toHaveLength(operation === 'message' ? 1 : 0)
    expect((await fetch(conversationUrl({ ...future, generation: 'stale' }), { headers: auth })).status).toBe(operation === 'read' ? 409 : 403)
    expect((await post({ ...future, generation: 'stale' }, 'standing-stale-001')).status).toBe(operation === 'message' ? 409 : 403)
    expect((await fetch(conversationUrl({ ...future, nodeId: 'persisted' }), { headers: auth })).status).toBe(operation === 'read' ? 409 : 403)
  })

  it('keeps exact v1 targets narrow when new sessions register', async () => {
    const current = await setup()
    projects.push({ id: 'p2', nodes: [{ id: 'n2', kind: 'terminal' }] })
    bindings.observe({ nodeId: 'n2', agentId: 'claude', kind: 'session', sessionId: 'session2', sessionPhase: 'start', verified: true })
    const future = bindings.targets(projects).find((t) => t.nodeId === 'n2')!
    expect((await (await fetch(`${base}/opsapi/v1/sessions`, { headers: auth })).json()).targets).toEqual([current])
    expect((await post(future)).status).toBe(403)
    expect((await fetch(conversationUrl(future), { headers: auth })).status).toBe(403)
  })

  it.each(['revoked', 'identity-changed'] as const)('rechecks standing reads after transcript awaits when %s', async (change) => {
    const target = await setup({ read: true, standing: true })
    const entered = deferred(); const resume = deferred()
    const realRead = conversationModule.readOperatorConversation
    vi.spyOn(conversationModule, 'readOperatorConversation').mockImplementationOnce(async (...args) => {
      entered.resolve(); await resume.promise
      return realRead(...args)
    })
    const request = fetch(conversationUrl(target), { headers: auth })
    await entered.promise
    await editPolicy((value) => { if (change === 'revoked') value.principals[0].read = []; else value.principals[0].id = 'replacement-principal' })
    resume.resolve()
    const response = await request
    expect(response.status).toBe(403)
    expect(await response.json()).toMatchObject({ error: 'scope_denied' })
  })

  it.each(['revoked', 'identity-changed'] as const)('rechecks standing receipt lookup after an await when %s', async (change) => {
    const target = await setup({ message: true, standing: true })
    const receipt = await (await post(target)).json()
    const entered = deferred(); const resume = deferred()
    const realGet = OperatorReceiptStore.prototype.get
    vi.spyOn(OperatorReceiptStore.prototype, 'get').mockImplementationOnce(async function (this: OperatorReceiptStore, id) {
      entered.resolve(); await resume.promise
      return realGet.call(this, id)
    })
    const request = fetch(`${base}/opsapi/v1/receipts/${receipt.id}`, { headers: auth })
    await entered.promise
    await editPolicy((value) => { if (change === 'revoked') value.principals[0].message = []; else value.principals[0].id = 'replacement-principal' })
    resume.resolve()
    expect((await request).status).toBe(403)
    expect((await readFile(path.join(dir, 'operator-conversation-audit.jsonl'), 'utf8'))).toContain('scope_denied')
  })

  it('denies a standing grant revoked during durable admission and the next request waiting behind it', async () => {
    const target = await setup({ message: true, standing: true })
    const entered = deferred(); const resume = deferred()
    const realAdmit = OperatorReceiptStore.prototype.admit
    vi.spyOn(OperatorReceiptStore.prototype, 'admit').mockImplementationOnce(async function (this: OperatorReceiptStore, ...args) {
      const entry = await realAdmit.apply(this, args)
      entered.resolve(); await resume.promise
      return entry
    })
    const first = post(target)
    await entered.promise
    const loads = vi.spyOn(policyModule, 'loadOperatorPrincipals')
    const second = post(target, 'standing-request-002')
    await vi.waitFor(() => expect(loads.mock.calls.length).toBeGreaterThanOrEqual(2))
    await editPolicy((value) => { value.principals[0].message = [] })
    resume.resolve()
    expect((await first).status).toBe(403)
    expect((await second).status).toBe(403)
    expect(sends).toEqual([])
    const records = JSON.parse(await readFile(path.join(dir, 'operator-message-receipts.json'), 'utf8')).records
    expect(records).toHaveLength(1)
    expect(records[0].receipt).toMatchObject({ state: 'failed', outcome: 'notPermitted' })
    await editPolicy((value) => { value.principals[0].message = [{ kind: OPERATOR_STANDING_SCOPE_KIND }] })
    expect((await (await post(target)).json()).id).toBe(records[0].receipt.id)
    expect(sends).toEqual([])
  })

  it('rechecks standing message scope after a slow request body crosses revocation', async () => {
    const target = await setup({ message: true, standing: true })
    const loaded = deferred()
    const realLoad = policyModule.loadOperatorPrincipals
    vi.spyOn(policyModule, 'loadOperatorPrincipals').mockImplementationOnce((file) => {
      const principals = realLoad(file)
      loaded.resolve()
      return principals
    })
    let request!: http.ClientRequest
    const response = new Promise<number>((resolve, reject) => {
      request = http.request(`${base}/opsapi/v1/messages`, { method: 'POST', headers: {
        ...auth, 'content-type': 'application/json', 'idempotency-key': 'standing-slow-body-001'
      } }, (reply) => { reply.resume(); reply.once('end', () => resolve(reply.statusCode!)) })
      request.once('error', reject)
      request.write('{"target":')
    })
    await loaded.promise
    await editPolicy((value) => { value.principals[0].message = [] })
    request.end(`${JSON.stringify(target)},"text":"slow synthetic body"}`)
    expect(await response).toBe(403)
    expect(sends).toEqual([])
  })

  it.each(['revoked', 'expired', 'malformed', 'stale-generation', 'standing-reduced-to-exact'] as const)('revalidates a real queued standing message before submission on %s', async (change) => {
    const submitted: string[] = []
    const queue = new DeliveryQueue({ now: () => Date.now(),
      deliver: async () => { throw new Error('agent path forbidden') },
      deliverOperator: async (request, beforeSend) => {
        const refusal = await beforeSend()
        if (refusal) return refusal
        submitted.push(request.body)
        return { kind: 'delivered', traceId: 'standing-test', traced: 'memory', receipt: 'observed', signal: 'newTurn' }
      },
      trace: async () => ({ traceId: 'standing-queue', traced: 'memory' }),
      onExpired: () => {}, onFlushed: () => {}, schedule: () => () => {}
    })
    const target = await setup({ read: true, message: true, standing: true }, (input) => sendOperatorMessage(input, {
      queue, deliver: async () => ({ kind: 'targetBusy', state: 'working' }),
      isCurrent: (candidate) => { try { bindings.resolve(projects, candidate); return true } catch { return false } }
    }))
    const receipt = await (await post(target)).json()
    await drain?.()
    expect(queue.depth(target.nodeId)).toBe(1)
    expect(await sends[0].authorize()).toBe(true)
    if (change === 'stale-generation') {
      bindings.observe({ nodeId: target.nodeId, agentId: 'claude', kind: 'session', sessionId: target.sessionId, sessionPhase: 'start', verified: true })
    } else await editPolicy((value) => {
      if (change === 'revoked') value.principals[0].message = []
      if (change === 'expired') value.principals[0].expiresAt = '2000-01-01T00:00:00Z'
      if (change === 'malformed') value.principals[0].message = [{ kind: '*' }]
      if (change === 'standing-reduced-to-exact') value.principals[0].message = [{ ...targetBase }]
    })
    await queue.onTargetIdle(target.nodeId)
    await drain?.()
    expect(submitted).toEqual(change === 'standing-reduced-to-exact' ? ['standing synthetic body'] : [])
    expect(queue.depth(target.nodeId)).toBe(0)
    const stored = JSON.parse(await readFile(path.join(dir, 'operator-message-receipts.json'), 'utf8')).records[0].receipt
    expect(stored).toMatchObject(change === 'standing-reduced-to-exact'
      ? { id: receipt.id, state: 'acknowledged', outcome: 'delivered', evidence: 'verified_correlated_prompt' }
      : { id: receipt.id, state: 'failed', outcome: 'notPermitted' })
    const response = await fetch(`${base}/opsapi/v1/receipts/${receipt.id}`, { headers: auth })
    expect(response.status).toBe(change === 'stale-generation' || change === 'standing-reduced-to-exact' ? 200 : change === 'revoked' ? 403 : 401)
    if (change === 'revoked') expect((await fetch(conversationUrl(target), { headers: auth })).status).toBe(200)
  })

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
