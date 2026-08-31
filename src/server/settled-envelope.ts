/**
 * Server-only agent-message delivery sequencing.
 *
 * A fresh Claude composer can accept a bracketed paste asynchronously: tmux has written the close
 * marker, but an Enter queued in the same command list is consumed before the TUI has installed the
 * pasted block. The next key then submits both messages together. Paste first, observe the pane
 * render the unique envelope footer (or become stably different from its baseline), then submit in
 * a second write.
 *
 * Delivery is not complete merely because Enter was written. After each submit, capture the pane
 * until the composed snapshot visibly advances. If the first Enter was swallowed, send exactly one
 * more and verify again. The boolean still means "the envelope reached the pane": the verified hook
 * receipt remains the final proof of consumption and reports `stalled` when the retry did not land.
 */

export const ENVELOPE_SETTLE_POLL_MS = 40
export const ENVELOPE_SETTLE_POLLS = 15
export const ENVELOPE_SUBMIT_ATTEMPTS = 2

export interface SettledEnvelopePty {
  captureSession(nodeId: string): Promise<string>
  sendText(nodeId: string, text: string, opts?: { enter?: boolean }): Promise<boolean>
}

export interface SettledEnvelopeOptions {
  wait?: (ms: number) => Promise<void>
  polls?: number
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function visibleSnapshot(value: string): string {
  return value.replace(/\r/g, '').replace(/[ \t]+$/gm, '').trimEnd()
}

function compact(value: string): string {
  return value.replace(/\s+/g, '')
}

async function capture(pty: SettledEnvelopePty, nodeId: string): Promise<string | null> {
  try {
    return visibleSnapshot(await pty.captureSession(nodeId))
  } catch {
    return null
  }
}

async function waitForAdvance(
  pty: SettledEnvelopePty,
  nodeId: string,
  composed: string,
  wait: (ms: number) => Promise<void>,
  polls: number
): Promise<boolean> {
  for (let i = 0; i < polls; i++) {
    if (i > 0) await wait(ENVELOPE_SETTLE_POLL_MS)
    const current = await capture(pty, nodeId)
    if (current !== null && current !== composed) return true
  }
  return false
}

/** Paste one complete envelope and submit only after the target pane has visibly settled. */
export async function sendSettledEnvelope(
  pty: SettledEnvelopePty,
  nodeId: string,
  envelope: string,
  options: SettledEnvelopeOptions = {}
): Promise<boolean> {
  if (!envelope) return false
  const before = await capture(pty, nodeId)
  let pasted = false
  try {
    pasted = await pty.sendText(nodeId, envelope, { enter: false })
  } catch {
    return false
  }
  if (!pasted) return false

  const footer = compact(envelope.split('\n').at(-1) ?? '')
  const wait = options.wait ?? delay
  const polls = Math.max(1, options.polls ?? ENVELOPE_SETTLE_POLLS)
  let priorChanged: string | null = null
  let composed: string | null = null
  let settled = false

  for (let i = 0; i < polls; i++) {
    if (i > 0) await wait(ENVELOPE_SETTLE_POLL_MS)
    const current = await capture(pty, nodeId)
    if (current === null) continue
    if (footer && compact(current).includes(footer)) {
      settled = true
      composed = current
      break
    }
    if (current && current !== before) {
      if (current === priorChanged) {
        settled = true
        composed = current
        break
      }
      priorChanged = current
    } else {
      priorChanged = null
    }
  }

  if (!settled || composed === null) return true

  for (let attempt = 0; attempt < ENVELOPE_SUBMIT_ATTEMPTS; attempt++) {
    try {
      // A false return is not proof the key missed the pane: a transport can fail after a partial
      // write. Re-capture either way, and retry once only when the composer did not advance.
      await pty.sendText(nodeId, '', { enter: true })
    } catch {
      // Same partial-delivery contract: verification, not the transport's throw, decides.
    }
    if (await waitForAdvance(pty, nodeId, composed, wait, polls)) {
      return true
    }
  }
  return true
}
