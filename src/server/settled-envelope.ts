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
  captureStyledSession?(nodeId: string): Promise<string>
  sendText(nodeId: string, text: string, opts?: { enter?: boolean }): Promise<boolean>
}

export interface SettledEnvelopeOptions {
  wait?: (ms: number) => Promise<void>
  polls?: number
  /** Operator-only: reject a prefilled supported composer using styled capture evidence. */
  rejectPrefilledComposer?: boolean
  /** Revalidate permission/session after each awaited capture and immediately before a write. */
  beforeAction?: () => Promise<boolean>
  /** Fires when paste bytes were accepted, before waiting or submitting. */
  onAccepted?: () => void
}

export class SettledEnvelopeGuardError extends Error {
  constructor(readonly reason: 'composer-draft' | 'composer-unrecognized' | 'authorization-revoked', readonly pasted: boolean) {
    super(reason)
    this.name = 'SettledEnvelopeGuardError'
  }
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

async function capture(pty: SettledEnvelopePty, nodeId: string, styled = false): Promise<string | null> {
  try {
    if (styled) {
      if (!pty.captureStyledSession) return null
      return visibleSnapshot(await pty.captureStyledSession(nodeId))
    }
    return visibleSnapshot(await pty.captureSession(nodeId))
  } catch {
    return null
  }
}

type ComposerInspection = 'clear' | 'draft' | 'unknown'

/** Recognize only a prompt row whose style data is present. Dim text is a suggestion; ordinary
 * text after the Claude/Codex prompt glyph is a human draft and must be preserved. */
export function inspectOperatorComposer(captureText: string): ComposerInspection {
  const rows: Array<{ text: string; dim: boolean[]; sgr: boolean }> = []
  let dim = false
  for (const raw of captureText.split('\n')) {
    let text = ''
    const styles: boolean[] = []
    let sgr = false
    const re = /\x1b\[([0-9;]*)m|\x1b\[[0-?]*[ -/]*[@-~]/g
    let cursor = 0
    for (let m; (m = re.exec(raw));) {
      for (const ch of raw.slice(cursor, m.index)) { text += ch; for (let i = 0; i < ch.length; i++) styles.push(dim) }
      if (m[0].endsWith('m')) {
        sgr = true
        if (m[1] === undefined) return 'unknown' // unsupported SGR encoding, never assume dim
        const codes = (m[1] || '0').split(';').map((v) => Number(v || 0))
        // SGR parameters apply sequentially: 2;22 and 2;0 both END at normal intensity.
        for (let i = 0; i < codes.length; i++) {
          const code = codes[i]
          // Extended-color mode/values are not intensity commands (38;2;R;G;B, 48;5;index).
          if (code === 38 || code === 48 || code === 58) {
            const mode = codes[i + 1]
            const count = mode === 2 ? 4 : mode === 5 ? 2 : 0
            if (!count || i + count >= codes.length) return 'unknown'
            i += count
            continue
          }
          if (code === 0 || code === 22) dim = false
          else if (code === 2) dim = true
        }
      }
      cursor = re.lastIndex
    }
    for (const ch of raw.slice(cursor)) { text += ch; for (let i = 0; i < ch.length; i++) styles.push(dim) }
    rows.push({ text, dim: styles, sgr })
  }
  const candidates: Array<{ start: number; row: typeof rows[number]; offset: number }> = []
  rows.forEach((row, start) => {
    const match = /^\s*(?:│\s*)?([❯›])\s*/.exec(row.text)
    if (match) candidates.push({ start, row, offset: match[0].length })
  })
  if (candidates.length !== 1) return 'unknown'
  const { start, row, offset } = candidates[0]
  if (!row.sgr || !captureText.includes('\x1b[')) return 'unknown'
  // Treat any visible non-dim material at or below the recognized prompt as occupied.
  // Multi-line composer drafts are common; checking only the prompt row would risk
  // appending after a draft whose first line happens to be empty.
  for (let line = start; line < rows.length; line++) {
    const current = rows[line]
    const first = line === start ? offset : 0
    for (let i = first; i < current.text.length; i++) {
      if (!/\s/.test(current.text[i]) && !current.dim[i]) return 'draft'
    }
  }
  return 'clear'
}

async function waitForAdvance(
  pty: SettledEnvelopePty,
  nodeId: string,
  composed: string,
  wait: (ms: number) => Promise<void>,
  polls: number,
  styled = false
): Promise<boolean> {
  for (let i = 0; i < polls; i++) {
    if (i > 0) await wait(ENVELOPE_SETTLE_POLL_MS)
    const current = await capture(pty, nodeId, styled)
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
  const styled = options.rejectPrefilledComposer === true
  const before = await capture(pty, nodeId, styled)
  if (styled) {
    if (before === null || inspectOperatorComposer(before) === 'unknown')
      throw new SettledEnvelopeGuardError('composer-unrecognized', false)
    if (inspectOperatorComposer(before) === 'draft')
      throw new SettledEnvelopeGuardError('composer-draft', false)
  }
  if (options.beforeAction && !(await options.beforeAction()))
    throw new SettledEnvelopeGuardError('authorization-revoked', false)
  let pasted = false
  try {
    pasted = await pty.sendText(nodeId, envelope, { enter: false })
  } catch {
    return false
  }
  if (!pasted) return false
  try { options.onAccepted?.() } catch { /* acceptance observers cannot interrupt delivery */ }

  const footer = compact(envelope.split('\n').at(-1) ?? '')
  const wait = options.wait ?? delay
  const polls = Math.max(1, options.polls ?? ENVELOPE_SETTLE_POLLS)
  let priorChanged: string | null = null
  let composed: string | null = null
  let settled = false

  for (let i = 0; i < polls; i++) {
    if (i > 0) await wait(ENVELOPE_SETTLE_POLL_MS)
    const current = await capture(pty, nodeId, styled)
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
    if (options.beforeAction && !(await options.beforeAction()))
      throw new SettledEnvelopeGuardError('authorization-revoked', true)
    try {
      // A false return is not proof the key missed the pane: a transport can fail after a partial
      // write. Re-capture either way, and retry once only when the composer did not advance.
      await pty.sendText(nodeId, '', { enter: true })
    } catch {
      // Same partial-delivery contract: verification, not the transport's throw, decides.
    }
    if (await waitForAdvance(pty, nodeId, composed, wait, polls, styled)) {
      return true
    }
  }
  return true
}
