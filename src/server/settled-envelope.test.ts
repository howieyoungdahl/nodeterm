import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  deliverAgentMessage,
  type DeliveryDeps,
  type ReceiptEvent
} from '../core/agents/agent-message'
import type { MirrorEntry } from '../core/agent-status-mirror'
import { MANAGED_SCRIPT_REVISION } from '../core/agents/hooks/managed-script'
import type { PaneOwner } from '../shared/agents/pane-owner-predicate'
import { sendSettledEnvelope, type SettledEnvelopePty } from './settled-envelope'

const pane: PaneOwner = {
  panePid: 4242,
  tty: '/dev/pts/9',
  command: 'node',
  paneId: '%7',
  argv: ['node /usr/local/bin/claude'],
  pids: [5100]
}

const idle: MirrorEntry = {
  state: 'done',
  updatedAt: 1,
  stateVerified: true,
  clientRevision: MANAGED_SCRIPT_REVISION
}

function deliveryDeps(
  pty: SettledEnvelopePty,
  subscribeEvents: DeliveryDeps['subscribeEvents']
): DeliveryDeps {
  return {
    paneOwner: async () => pane,
    bracketPasteRequested: async () => true,
    sendEnvelope: (nodeId, envelope) => sendSettledEnvelope(pty, nodeId, envelope),
    mirrorEntry: () => idle,
    tokenFilePresent: () => true,
    lock: async (_nodeId, work) => work(),
    now: () => 1,
    nonce: () => 'NONCE0123456',
    trace: async () => ({ traceId: 'trace-server', traced: 'memory' }),
    subscribeEvents
  }
}

const request = {
  targetNodeId: 'target',
  sourceNodeId: 'source',
  sourceTitle: 'Director',
  body: 'do the work',
  targetAgentId: 'claude'
}

afterEach(() => vi.useRealTimers())

describe('sendSettledEnvelope', () => {
  it('submits only after the footer is visible and verifies the consumed turn by hook receipt', async () => {
    const listeners = new Set<(event: ReceiptEvent) => void>()
    const writes: Array<{ text: string; enter: boolean | undefined }> = []
    let pasted = ''
    let submitted = false
    const pty: SettledEnvelopePty = {
      captureSession: async () =>
        submitted
          ? 'Claude working'
          : pasted ? `Claude composer\n${pasted.split('\n').at(-1)}` : 'Claude composer',
      sendText: async (_nodeId, text, opts) => {
        writes.push({ text, enter: opts?.enter })
        if (text) pasted = text
        else {
          submitted = true
          queueMicrotask(() => {
            for (const listener of listeners) {
              listener({ nodeId: 'target', state: 'working', newTurn: true, verified: true })
            }
          })
        }
        return true
      }
    }
    const outcome = await deliverAgentMessage(
      request,
      deliveryDeps(pty, (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      })
    )

    expect(outcome.kind).toBe('delivered')
    expect(outcome).toMatchObject({ signal: 'newTurn' })
    expect(writes).toHaveLength(2)
    expect(writes[0]).toMatchObject({ enter: false })
    expect(writes[0].text).toContain('--- END NODETERM MESSAGE NONCE0123456 ---')
    expect(writes[1]).toEqual({ text: '', enter: true })
  })

  it('presses Enter once more when the first submit leaves the envelope composed', async () => {
    const listeners = new Set<(event: ReceiptEvent) => void>()
    const writes: Array<{ text: string; enter: boolean | undefined }> = []
    let pasted = ''
    let enters = 0
    const pty: SettledEnvelopePty = {
      captureSession: async () =>
        enters >= 2 ? 'Claude working' : `Claude composer\n${pasted.split('\n').at(-1) ?? ''}`,
      sendText: async (_nodeId, text, opts) => {
        writes.push({ text, enter: opts?.enter })
        if (text) pasted = text
        else {
          enters += 1
          if (enters >= 2) {
            queueMicrotask(() => {
              for (const listener of listeners) {
                listener({ nodeId: 'target', state: 'working', newTurn: true, verified: true })
              }
            })
          }
        }
        return true
      }
    }

    const outcome = await deliverAgentMessage(
      request,
      deliveryDeps(pty, (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      })
    )

    expect(outcome).toMatchObject({ kind: 'delivered', signal: 'newTurn' })
    expect(writes).toHaveLength(3)
    expect(writes.slice(1)).toEqual([
      { text: '', enter: true },
      { text: '', enter: true }
    ])
  })

  it('reports stalled only after both bounded submit attempts leave the composer unchanged', async () => {
    vi.useFakeTimers()
    const writes: Array<{ text: string; enter: boolean | undefined }> = []
    let pasted = ''
    const pty: SettledEnvelopePty = {
      captureSession: async () =>
        pasted ? `Claude composer\n${pasted.split('\n').at(-1)}` : 'Claude composer',
      sendText: async (_nodeId, text, opts) => {
        writes.push({ text, enter: opts?.enter })
        if (text) {
          pasted = text
          return true
        }
        return false
      }
    }
    const run = deliverAgentMessage(request, deliveryDeps(pty, () => () => {}))
    await vi.runAllTimersAsync()
    const outcome = await run

    expect(outcome.kind).toBe('stalled')
    expect(writes).toHaveLength(3)
    expect(writes.slice(1)).toEqual([
      { text: '', enter: true },
      { text: '', enter: true }
    ])
  })
})
