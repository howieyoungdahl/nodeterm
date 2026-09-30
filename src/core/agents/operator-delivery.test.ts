import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fakePlatform } from '../platform-fake'
import { initPlatform, resetPlatformForTests } from '../platform'
import { writeNodeTokenFile, resetNodeTokenFilesForTests, sweepNodeTokenFile } from './node-token-files'
import { resetAgentMessageTraceForTests, recentDeliveries } from './agent-message-trace'
import { MANAGED_SCRIPT_REVISION } from './hooks/managed-script'
import { runOperatorDelivery, type AgentMessagingDeps } from './agent-messaging'
import type { ReceiptEvent } from './agent-message'
import type { OperatorSessionTarget } from '../../shared/operator-conversations'
import type { QueuedDeliveryRequest } from './delivery-queue'

const nodeId = 'operator-target'
const target: OperatorSessionTarget = { projectId: 'project-a', nodeId, sessionId: 'session-a', generation: 'generation-a' }
let dataDir = ''

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'operator-delivery-'))
  resetPlatformForTests()
  initPlatform(fakePlatform({ userDataDir: dataDir }))
  resetNodeTokenFilesForTests()
  resetAgentMessageTraceForTests()
  expect(writeNodeTokenFile(nodeId, 'synthetic-token')).toBe(true)
})

afterEach(() => {
  sweepNodeTokenFile(nodeId)
  resetNodeTokenFilesForTests()
  resetPlatformForTests()
  fs.rmSync(dataDir, { recursive: true, force: true })
})

function harness() {
  const pane = {
    panePid: 100, tty: '/dev/pts/4', command: 'node', paneId: '%4',
    argv: ['node /usr/bin/claude'], pids: [200]
  }
  let receipt: ((e: ReceiptEvent) => void) | undefined
  const envelopes: string[] = []
  const accepted = vi.fn()
  const deps: AgentMessagingDeps = {
    paneOwner: async () => pane,
    sendEnvelope: async (_id, envelope, options) => {
      envelopes.push(envelope)
      options?.onAccepted?.()
      receipt?.({ nodeId, sessionId: target.sessionId, submittedPromptSha256: createHash('sha256').update(envelope.replace(/\r\n/g, '\n')).digest('hex'), newTurn: true, verified: true })
      return true
    },
    hasLiveSession: () => true,
    sessionPresence: async () => 'alive',
    mirrorEntry: () => ({ state: 'done', updatedAt: Date.now(), stateVerified: true, clientRevision: MANAGED_SCRIPT_REVISION }),
    projects: () => [{ id: target.projectId, nodes: [{ id: nodeId, title: 'Target', agentId: 'claude' }] }],
    isRemoteNode: () => false,
    messagingEnabled: () => false,
    paneOwnerProject: () => target.projectId,
    callerOwnsTarget: () => false,
    customAgents: () => [],
    appendBoardLog: async () => false,
    subscribeReceipts: (cb) => { receipt = cb; return () => { receipt = undefined } }
  }
  const request: QueuedDeliveryRequest = {
    sourcePrincipal: 'operator', sourceTitle: 'Operator account-1', targetNodeId: nodeId,
    body: 'please inspect the synthetic fixture',
    operator: { target, callerId: 'account-1', messageId: 'message-1', authorize: async () => true, onOutcome: () => {}, onAccepted: accepted }
  }
  return { deps, request, envelopes, accepted }
}

describe('runOperatorDelivery production adapter', () => {
  it('uses the real target gate and verified receipt while framing an operator without reply-to node', async () => {
    const h = harness()
    const out = await runOperatorDelivery(h.request, h.deps, async () => undefined, h.accepted)
    expect(out).toMatchObject({ kind: 'delivered', receipt: 'observed', signal: 'newTurn' })
    expect(h.envelopes).toHaveLength(1)
    expect(h.envelopes[0]).toContain('from: Operator account-1 (operator)')
    expect(h.envelopes[0]).not.toContain('reply-to:')
    expect(h.envelopes[0]).toContain('please inspect the synthetic fixture')
    expect(h.accepted).toHaveBeenCalledOnce()
    expect(recentDeliveries(1)[0]).toMatchObject({ sourcePrincipal: 'operator', targetNodeId: nodeId })
    expect(recentDeliveries(1)[0]).not.toHaveProperty('sourceNodeId')
  })

  it('honors a revoked authorization immediately before paste and writes no bytes', async () => {
    const h = harness()
    const out = await runOperatorDelivery(h.request, h.deps, async () => ({ kind: 'notPermitted', reason: 'switch-off' }))
    expect(out).toMatchObject({ kind: 'notPermitted', reason: 'switch-off' })
    expect(h.envelopes).toEqual([])
    expect(h.accepted).not.toHaveBeenCalled()
  })
})
