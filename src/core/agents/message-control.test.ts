import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { hookServer } from './hook-server'
import { nodeAuthToken } from './node-auth-token'
import { createMessageControl, type MessageControlRuntime } from './message-control'
import { createDeliveryQueue, isDeliverRequest, type AgentMessagingDeps } from './agent-messaging'
import type { QueuedDeliveryRequest, DeliveryQueue } from './delivery-queue'
import { resetMessageFlow } from './agent-message-flow'
import { initPlatform, resetPlatformForTests } from '../platform'
import { fakePlatform } from '../platform-fake'
import { MANAGED_SCRIPT_REVISION } from './hooks/managed-script'
import type { MessageActor } from './message-integrity'
import { parseControlRequest } from '../canvas-control-core'
import { canonicalAssignmentValidator } from './canonical-assignment'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'

const assignmentModule = process.env.NODETERM_TEST_ASSIGNMENT_MODULE
const assignmentProducer = process.env.NODETERM_TEST_ASSIGNMENT_PRODUCER
if (Boolean(assignmentModule) !== Boolean(assignmentProducer))
  throw new Error('Canonical conformance requires both NODETERM_TEST_ASSIGNMENT_MODULE and NODETERM_TEST_ASSIGNMENT_PRODUCER')
if (assignmentModule && (!path.isAbsolute(assignmentModule) || !path.isAbsolute(assignmentProducer!)))
  throw new Error('Canonical conformance module and producer paths must be absolute')

const secret = Buffer.alloc(32, 27)
const actor = (node: string): MessageActor => ({ agent_id: node, node, pane: '%1',
  session_id: `session-${node}`, incarnation: 'incarnation-1', provider: 'claude' })
const recipient = actor('target')
const issuer = actor('source')
const request = (): QueuedDeliveryRequest => ({ sourceNodeId: 'source', targetNodeId: 'target',
  sourceTitle: 'caller title ignored', verb: 'send', body: 'issued body', message: {
    message_id: 'message-1', action_id: 'action-1', task_id: 'task', assignment_id: 'assignment-task',
    assignment_epoch: 1, actor: recipient, contract_ref: { uri: '/contract', sha256: 'a'.repeat(64) },
    policy_ref: { uri: '/policy', sha256: 'b'.repeat(64) }, created_at: 1000, expires_at: 2000
  } })

describe('identified producer → registered hook transport → actual messaging service', () => {
  let dir: string
  let queue: DeliveryQueue
  let now: number
  let epoch: number
  let busy: boolean
  let principal: MessageActor
  let authorityCode: string
  let sent: string[]
  let runtime: MessageControlRuntime
  let deps: AgentMessagingDeps

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeterm-message-consumer-'))
    resetPlatformForTests()
    initPlatform(fakePlatform({ userDataDir: dir }))
    resetMessageFlow()
    now = 1000; epoch = 1; busy = false; principal = recipient; authorityCode = 'ok'; sent = []
    deps = {
      now: () => now,
      paneOwner: async () => ({ tty: '/dev/pts/9', panePid: 100, paneId: '%1',
        command: 'claude', argv: ['claude'], pids: [200] }),
      sendEnvelope: vi.fn(async (_id, envelope) => { sent.push(envelope); return true }),
      hasLiveSession: () => true,
      mirrorEntry: () => ({ state: busy ? 'working' : 'done', updatedAt: now,
        stateVerified: true, clientRevision: MANAGED_SCRIPT_REVISION }),
      projects: () => [{ id: 'project', nodes: [{ id: 'source', title: 'Trusted source', agentId: 'claude' },
        { id: 'target', title: 'Target', agentId: 'claude' }] }],
      isRemoteNode: () => false, messagingEnabled: () => true, paneOwnerProject: () => 'project',
      callerOwnsTarget: (source, target) => source === 'source' && target === 'target',
      customAgents: () => undefined, appendBoardLog: async () => false,
      subscribeReceipts: (cb) => {
        const timer = setTimeout(() => cb({ nodeId: 'target', verified: true, newTurn: true }), 5)
        return () => clearTimeout(timer)
      }
    }
    queue = createDeliveryQueue(deps, { schedule: () => () => {}, validateAssignment: async (binding) => ({
      ok: authorityCode === 'ok' && binding.assignment_epoch === epoch,
      code: authorityCode !== 'ok' ? authorityCode : binding.assignment_epoch === epoch ? 'ok' : 'stale_epoch'
    }) })
    runtime = {
      authenticate: vi.fn(async (node, credential) => credential === 'issuer-credential' && node === issuer.node
        ? issuer : credential === 'recipient-credential' && node === recipient.node ? principal : null),
      issuedMessage: vi.fn(async (caller, messageId, actionId) => caller.node === issuer.node &&
        messageId === 'message-1' && actionId === 'action-1' ? request() : null),
      validateIssuer: vi.fn(async () => true),
      claimIssuedAttempt: vi.fn(async () => 'claimed' as const)
    }
    await hookServer.start()
    hookServer.setNodeAuthSecret(secret)
    hookServer.setControlHandler(createMessageControl(queue, runtime))
  })

  afterEach(() => {
    queue.resetForTests()
    hookServer.clearNodeAuthSecretForTests()
    hookServer.stop()
    resetPlatformForTests()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  async function post(verb = 'message-deliver', node = 'source', credential = 'issuer-credential',
    args: Record<string, string> = { message_id: 'message-1', action_id: 'action-1' }) {
    const response = await fetch(`http://127.0.0.1:${hookServer.getPort()}/control/${verb}`, {
      method: 'POST', headers: { 'content-type': 'application/json',
        'X-Nodeterm-Hook-Token': hookServer.getToken(), 'X-Nodeterm-Node-Token': nodeAuthToken(secret, node),
        'X-Nodeterm-Message-Credential': credential }, body: JSON.stringify({ nodeId: node, args })
    })
    return response.json()
  }
  const ack = (node = 'target', credential = 'recipient-credential') => post('message-ack', node, credential,
    { source_node: 'source', message_id: 'message-1', action_id: 'action-1', status: 'accepted' })

  it('delivers immutable issued identity once, and never mistakes observed turns for authenticated acceptance', async () => {
    const result = await post(undefined, undefined, undefined, { message_id: 'message-1', action_id: 'action-1', body: 'edited' })
    expect(result.result.message.status).toBe('delivered')
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('issued body')
    expect(sent[0]).toContain('"message_id":"message-1"')
    expect(sent[0]).not.toContain('edited')
    expect(sent[0]).not.toContain('credential')
    expect((await post()).result.message.status).toBe('delivered')
    expect(sent).toHaveLength(1)
    expect((await ack()).result.message.status).toBe('accepted')
    expect((await post('message-receipt')).result.message.status).toBe('accepted')
  })

  it('refuses absent runtime, absent issuer context and legacy IPC identity smuggling visibly', async () => {
    hookServer.setControlHandler(createMessageControl(queue))
    expect((await post()).error).toContain('message-principal-and-issuer-adapter-unavailable')
    expect(isDeliverRequest({ ...request() })).toBe(false)
    expect(parseControlRequest('send', { node: 'target', text: 'body', message_id: 'invented' }))
      .toHaveProperty('error', expect.stringContaining('identified-message-requires-trusted-host-route'))
    hookServer.setControlHandler(createMessageControl(queue, runtime))
    expect((await post(undefined, undefined, undefined, { message_id: 'invented', action_id: 'invented' })).error)
      .toContain('issued-message-unavailable')
    expect(sent).toEqual([])
  })

  it('isolates sender credentials from recipient ACK, and rejects changed incarnations', async () => {
    await post()
    expect((await ack('source', 'issuer-credential')).error).toContain('recipient-mismatch')
    expect((await ack('target', 'issuer-credential')).error).toContain('message-caller-unverified')
    principal = { ...recipient, incarnation: 'incarnation-2' }
    expect((await ack()).error).toContain('recipient-mismatch')
    expect(queue.messages.receipt(request()).message?.status).toBe('delivered')
    expect(await queue.messages.acknowledge(request(), 'accepted')).toMatchObject({ reason: 'recipient-authentication-unavailable' })
  })

  it('rechecks incarnation after asynchronous authority validation', async () => {
    await post()
    let reads = 0
    runtime.authenticate = async () => ++reads < 3 ? recipient : { ...recipient, session_id: 'replaced' }
    expect((await ack()).error).toContain('recipient-mismatch')
    expect(queue.messages.receipt(request()).message?.status).toBe('delivered')
  })

  it.each(['stale_epoch', 'suspended', 'reference_mismatch'])('refuses %s before send', async (code) => {
    authorityCode = code
    expect((await post()).error).toContain(code)
    expect(sent).toEqual([])
    // A separate issued identity is unnecessary: this refusal is terminal for its admitted ID.
  })

  it('fences queued transfer and original TTL without resetting either', async () => {
    busy = true
    expect((await post()).result.message.status).toBe('queued')
    epoch = 2; busy = false
    await queue.onTargetIdle('target')
    expect((await post('message-receipt')).error).toContain('stale_epoch')
    expect(sent).toEqual([])
  })

  it('does not extend TTL while awaiting recipient proof', async () => {
    await post()
    runtime.authenticate = async () => { now = 2000; return recipient }
    expect((await ack()).result.message.status).toBe('expired')
    expect(queue.messages.receipt(request()).message?.status).toBe('delivered')
  })

  it('refuses ACK after a transfer even though the original turn was observed', async () => {
    await post(); epoch = 2
    expect((await ack()).error).toContain('stale_epoch')
    expect(queue.messages.receipt(request()).message?.status).toBe('delivered')
  })

  it('rechecks canonical authority after an asynchronous recipient authentication', async () => {
    await post()
    let reads = 0
    runtime.authenticate = async () => { if (++reads === 3) epoch = 2; return recipient }
    expect((await ack()).error).toContain('stale_epoch')
    expect(queue.messages.receipt(request()).message?.status).toBe('delivered')
  })

  it('preserves unknown possible delivery across retries and receipt reads', async () => {
    deps.sendEnvelope = vi.fn(async (_id, envelope) => { sent.push(envelope); throw new Error('lost result') })
    expect((await post()).result.message.status).toBe('unknown')
    expect((await post()).result.message.status).toBe('unknown')
    expect((await post('message-receipt')).result.message.status).toBe('unknown')
    expect(sent).toHaveLength(1)
    expect(runtime.claimIssuedAttempt).toHaveBeenCalledTimes(1)
  })

  it('does not replay a previous-host attempt when this process has no receipt', async () => {
    runtime.claimIssuedAttempt = vi.fn(async () => 'unknown' as const)
    expect((await post('message-receipt')).result).toMatchObject({ kind: 'unknown', reason: 'receipt-unavailable' })
    expect((await post()).result).toMatchObject({ kind: 'unknown', reason: 'prior-delivery-attempt-unresolved' })
    expect((await post()).result.message.status).toBe('unknown')
    expect(sent).toEqual([])
    expect(runtime.claimIssuedAttempt).toHaveBeenCalledTimes(1)
  })

  it('refuses a replaced issuer during intent lookup before claiming or sending', async () => {
    runtime.issuedMessage = async () => {
      runtime.authenticate = async () => ({ ...issuer, incarnation: 'replaced' })
      return request()
    }
    expect((await post()).error).toContain('issuer-authority-unverifiable')
    expect(runtime.claimIssuedAttempt).not.toHaveBeenCalled()
    expect(sent).toEqual([])
  })

  it('retains UNKNOWN when issuer authority transfers during the durable claim', async () => {
    runtime.claimIssuedAttempt = vi.fn(async () => {
      runtime.validateIssuer = async () => false
      return 'claimed' as const
    })
    expect((await post()).result).toMatchObject({ kind: 'unknown', reason: 'issuer-authority-changed-after-claim' })
    expect((await post()).result.message.status).toBe('unknown')
    expect(runtime.claimIssuedAttempt).toHaveBeenCalledTimes(1)
    expect(sent).toEqual([])
  })

  it('rechecks the full issuer actor at the pane-send boundary and after queue delay', async () => {
    const paneOwner = deps.paneOwner
    deps.paneOwner = async (id) => {
      runtime.authenticate = async () => ({ ...issuer, session_id: 'replaced' })
      return paneOwner(id)
    }
    expect((await post()).result.message.status).toBe('unknown')
    expect(sent).toEqual([])
  })

  it('keeps issuer validation attached to a queued message without credential serialization', async () => {
    busy = true
    expect((await post()).result.message.status).toBe('queued')
    runtime.authenticate = async () => ({ ...issuer, pane: '%replaced' })
    busy = false
    await queue.onTargetIdle('target')
    expect(queue.messages.receipt(request()).message?.status).toBe('unknown')
    expect(sent).toEqual([])
    expect(runtime.claimIssuedAttempt).toHaveBeenCalledTimes(1)
  })

  it('does not pass message credentials into a legacy control handler', async () => {
    const handler = vi.fn(async (_input: unknown) => ({ ok: true }))
    hookServer.setControlHandler(handler)
    await post('send')
    expect(handler.mock.calls[0][0]).not.toHaveProperty('messageCredential')
  })

  it.skipIf(!assignmentModule)('consumes actual D15 producer output across the registered route', async () => {
    const modulePath = assignmentModule!
    const ledgerPath = path.join(dir, 'canonical.json')
    execFileSync('/usr/bin/python3', ['-I', '-B', assignmentProducer!,
      modulePath, ledgerPath], { timeout: 5000, env: { LC_ALL: 'C.UTF-8' } })
    const before = fs.readFileSync(ledgerPath)
    queue.resetForTests()
    queue = createDeliveryQueue(deps, { schedule: () => () => {}, validateAssignment: canonicalAssignmentValidator({
      pythonPath: '/usr/bin/python3', modulePath, ledgerPath,
      moduleSha256: createHash('sha256').update(fs.readFileSync(modulePath)).digest('hex')
    }) })
    hookServer.setControlHandler(createMessageControl(queue, runtime))
    expect((await post()).result.message.status).toBe('delivered')
    expect((await ack()).result.message.status).toBe('accepted')
    expect(sent).toHaveLength(1)
    expect(fs.readFileSync(ledgerPath)).toEqual(before)
  })
})
