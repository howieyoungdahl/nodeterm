import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  deliverAgentMessage,
  type DeliveryDeps,
  type ReceiptEvent
} from '../core/agents/agent-message'
import type { MirrorEntry } from '../core/agent-status-mirror'
import { MANAGED_SCRIPT_REVISION } from '../core/agents/hooks/managed-script'
import type { PaneOwner } from '../shared/agents/pane-owner-predicate'
import { inspectOperatorComposer, sendSettledEnvelope, SettledEnvelopeGuardError, type SettledEnvelopePty } from './settled-envelope'

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
  it('recognizes empty Claude/Codex composers and ignores only styled dim suggestions', () => {
    expect(inspectOperatorComposer('\x1b[32m❯\x1b[0m \x1b[2mTry asking about your code\x1b[0m')).toBe('clear')
    expect(inspectOperatorComposer('\x1b[32m›\x1b[0m ')).toBe('clear')
    expect(inspectOperatorComposer('\x1b[32m❯\x1b[0m keep this draft')).toBe('draft')
    expect(inspectOperatorComposer('plain unstyled terminal')).toBe('unknown')
  })

  it('refuses a prefilled human composer before paste and preserves the draft', async () => {
    const writes: string[] = []
    const pty: SettledEnvelopePty = {
      captureSession: async () => '',
      captureStyledSession: async () => '\x1b[32m❯\x1b[0m human draft',
      sendText: async (_id, text) => { writes.push(text); return true }
    }
    await expect(sendSettledEnvelope(pty, 'target', 'envelope', { rejectPrefilledComposer: true }))
      .rejects.toMatchObject({ name: 'SettledEnvelopeGuardError', reason: 'composer-draft', pasted: false })
    expect(writes).toEqual([])
  })

  it.each(['2;22', '2;0', '38;2;111;222;123', '48;5;2'])('preserves a human draft under normal-intensity SGR %s', async (codes) => {
    const snapshot = `\x1b[32m❯\x1b[0m \x1b[${codes}mhuman draft`
    const writes: string[] = []
    expect(inspectOperatorComposer(snapshot)).toBe('draft')
    await expect(sendSettledEnvelope({
      captureSession: async () => '', captureStyledSession: async () => snapshot,
      sendText: async (_id, text) => { writes.push(text); return true }
    }, 'target', 'envelope', { rejectPrefilledComposer: true }))
      .rejects.toMatchObject({ reason: 'composer-draft', pasted: false })
    expect(writes).toEqual([])
  })

  it('rechecks authorization after styled capture before paste', async () => {
    let release!: () => void
    const pendingCapture = new Promise<void>((resolve) => { release = resolve })
    const writes: string[] = []
    let allowed = true
    const pty: SettledEnvelopePty = {
      captureSession: async () => '',
      captureStyledSession: async () => { await pendingCapture; return '\x1b[32m❯\x1b[0m ' },
      sendText: async (_id, text) => { writes.push(text); return true }
    }
    const sent = sendSettledEnvelope(pty, 'target', 'envelope', {
      rejectPrefilledComposer: true, beforeAction: async () => allowed
    })
    allowed = false
    release()
    await expect(sent).rejects.toMatchObject({ reason: 'authorization-revoked', pasted: false })
    expect(writes).toEqual([])
  })

  it('does not submit or nudge after the target is revoked during paste settlement', async () => {
    const writes: Array<{ text: string; enter: boolean | undefined }> = []
    let allowed = true
    let pasted = false
    const pty: SettledEnvelopePty = {
      captureSession: async () => '',
      captureStyledSession: async () => pasted
        ? '\x1b[32m❯\x1b[0m envelope footer'
        : '\x1b[32m❯\x1b[0m ',
      sendText: async (_id, text, opts) => {
        writes.push({ text, enter: opts?.enter })
        if (text) { pasted = true; allowed = false }
        return true
      }
    }
    await expect(sendSettledEnvelope(pty, 'target', 'envelope footer', {
      rejectPrefilledComposer: true, beforeAction: async () => allowed,
      wait: async () => {}, polls: 1
    })).rejects.toMatchObject({ reason: 'authorization-revoked', pasted: true })
    expect(writes).toEqual([{ text: 'envelope footer', enter: false }])
  })

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
