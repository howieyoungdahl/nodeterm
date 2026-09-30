import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hookServer } from './hook-server'
import { nodeAuthToken } from './node-auth-token'
import { initPlatform, resetPlatformForTests } from '../platform'
import { fakePlatform } from '../platform-fake'
import { OperatorSessionBindings } from '../operator-session-bindings'
import { DeliveryQueue } from './delivery-queue'
import { sendOperatorMessage, type OperatorDeliveryInput } from './operator-messaging'

const SECRET = Buffer.alloc(32, 13)
const NODE = 'codex-restart-node'
const PROJECTS = [{ id: 'project-a', nodes: [{ id: NODE, kind: 'terminal' }] }]
const rawStart = JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'same-session-id' })

let dataDir = ''
let normalized: Array<{ nodeId: string; sessionId?: string; kind: string; state?: string; sessionPhase?: string; verified?: boolean }> = []

async function postAuthenticatedStart(): Promise<Response> {
  return fetch(`http://127.0.0.1:${hookServer.getPort()}/hook/codex`, {
    method: 'POST',
    headers: {
      'X-Nodeterm-Hook-Token': hookServer.getToken(),
      'X-Nodeterm-Node-Token': nodeAuthToken(SECRET, NODE),
      'content-type': 'application/x-www-form-urlencoded'
    },
    body: `nodeId=${encodeURIComponent(NODE)}&payload=${encodeURIComponent(rawStart)}`
  })
}

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'operator-codex-generation-'))
  resetPlatformForTests()
  initPlatform(fakePlatform({ userDataDir: dataDir }))
  hookServer.setNodeAuthSecret(SECRET)
  hookServer.setListener((event) => normalized.push(event))
  await hookServer.start()
})

afterAll(() => {
  hookServer.clearNodeAuthSecretForTests()
  hookServer.stop()
  resetPlatformForTests()
  rmSync(dataDir, { recursive: true, force: true })
})

beforeEach(() => { normalized = [] })

describe('authenticated Codex SessionStart generation binding', () => {
  it('rotates a same-id restart and drops its queued original-generation message', async () => {
    const bindings = new OperatorSessionBindings()
    const observe = (event: typeof normalized[number]): void => {
      expect(event.verified).toBe(true)
      bindings.observe(event as Parameters<OperatorSessionBindings['observe']>[0])
    }
    const firstResponse = await postAuthenticatedStart()
    expect(firstResponse.status).toBe(204)
    observe(normalized[0])
    const original = bindings.targets(PROJECTS)[0]
    expect(normalized[0]).toMatchObject({ kind: 'state', state: 'working', sessionPhase: 'start', sessionId: 'same-session-id' })

    const sent: string[] = []
    const outcomes: unknown[] = []
    const queue = new DeliveryQueue({
      now: () => Date.now(),
      deliver: async () => ({ kind: 'unknown', reason: 'unexpected-agent-path' }),
      deliverOperator: async (request, beforeSend) => {
        const refusal = await beforeSend()
        if (refusal) return refusal
        sent.push(request.body)
        return { kind: 'delivered', traceId: 'test-delivery', traced: 'memory', receipt: 'observed', signal: 'newTurn' }
      },
      trace: async () => ({ traceId: 'queued-test', traced: 'memory' }),
      onExpired: () => {}, onFlushed: () => {}, schedule: () => () => {}
    })
    const input: OperatorDeliveryInput = {
      callerId: 'operator-test', target: original, text: 'do not send after restart', messageId: 'message-test',
      authorize: async () => true, onOutcome: (outcome) => outcomes.push(outcome)
    }
    await expect(sendOperatorMessage(input, {
      queue,
      deliver: async () => ({ kind: 'targetBusy', state: 'working' }),
      isCurrent: (target) => {
        try { bindings.resolve(PROJECTS, target); return true } catch { return false }
      }
    })).resolves.toMatchObject({ kind: 'queued' })

    normalized = []
    const secondResponse = await postAuthenticatedStart()
    expect(secondResponse.status).toBe(204)
    observe(normalized[0])
    const replacement = bindings.targets(PROJECTS)[0]
    expect(normalized[0]).toMatchObject({ kind: 'state', state: 'working', sessionPhase: 'start', sessionId: 'same-session-id' })
    expect(replacement.generation).not.toBe(original.generation)
    expect(() => bindings.resolve(PROJECTS, original)).toThrow()

    await queue.onTargetIdle(NODE)
    expect(sent).toEqual([])
    expect(queue.depth(NODE)).toBe(0)
    expect(outcomes.at(-1)).toMatchObject({ kind: 'notPermitted' })
  })
})
