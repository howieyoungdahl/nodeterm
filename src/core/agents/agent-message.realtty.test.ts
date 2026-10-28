// THE DELIVERY, JUDGED BY A REAL READER — a real tmux server on a private socket, a real bash on a
// real pty, and the kernel's own answer to "who owns this pane".
//
// The sibling `agent-message.test.ts` asserts SEQUENCING with fake deps: which call happened, in
// what order, exactly once. It cannot tell you what a terminal does with the bytes. This file trusts
// no parser of ours — it writes through real `tmux send-keys` and asks the FILESYSTEM whether the
// attacker's trailing bytes were executed as keys, and `capture-pane` what actually landed.
//
// It exists for the reason `paste-injection.realtty.test.ts` and `control-master.realsh.test.ts`
// exist: a structural test can only catch the tricks it was taught, and this repo has twice shipped
// a defect that a hand-rolled parser passed and the real thing caught.
//
// Two MUTATION CONTROLS are run, not described (bottom of the file): the same body delivered
// UNSANITIZED escapes the frame and creates the marker, and the same envelope delivered UNFRAMED is
// submitted line-by-line (the shell's first error lands BETWEEN the frame lines instead of after
// them). If either ever stops happening, every assertion above it is vacuous.
//
// SAFETY: this file's tmux server lives on its OWN socket inside its OWN TMUX_TMPDIR, holds only
// sessions this file created, and is killed (and verified gone) in afterAll. It never lists, reads
// or signals any other tmux server.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { deliverAgentMessage, type DeliveryDeps, type DeliveryRequest } from './agent-message'
import { PANE_OWNER_FMT, foregroundArgvArgs, paneOwnerFrom, parsePaneOwner } from './pane-owner'
import { PASTE_END, PASTE_START, sanitizePasteText } from '../paste-injection'
import { localPasteDelivery, runPasteDelivery } from '../tmux-naming'
import { buildEnvelope } from './agent-message-envelope'
import { MANAGED_SCRIPT_REVISION } from './hooks/managed-script'
import type { MirrorEntry } from '../agent-status-mirror'

const ESC = '\x1b'
const CR = '\r'
const NONCE = 'REALTTY12345'

/** bash's readline implements bracketed paste from 5.1 (macOS ships 3.2 as /bin/bash). */
function findPasteAwareBash(): string | null {
  for (const c of ['/usr/local/bin/bash', '/opt/homebrew/bin/bash', '/bin/bash', '/usr/bin/bash']) {
    if (!fs.existsSync(c)) continue
    try {
      const v = execFileSync(c, ['-c', 'echo "${BASH_VERSINFO[0]}.${BASH_VERSINFO[1]}"'], {
        encoding: 'utf8'
      }).trim()
      const [maj, min] = v.split('.').map(Number)
      if (maj > 5 || (maj === 5 && min >= 1)) return c
    } catch {
      // not usable — try the next
    }
  }
  return null
}

function findTmux(): string | null {
  for (const c of ['/usr/local/bin/tmux', '/opt/homebrew/bin/tmux', '/usr/bin/tmux', '/bin/tmux']) {
    if (fs.existsSync(c)) return c
  }
  return null
}

const BASH = findPasteAwareBash()
const TMUX = findTmux()

let work: string
let sockDir: string
let socket: string
let env: NodeJS.ProcessEnv

beforeAll(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'ntmsg-'))
  // A unix socket path is capped at ~108 bytes, so the socket dir must be short — it cannot live
  // beside `work` if the tmpdir is deep.
  sockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ntsk-'))
  socket = `nt-pr3-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  env = { ...process.env, TMUX_TMPDIR: sockDir }
})

afterAll(() => {
  if (TMUX) {
    try {
      execFileSync(TMUX, ['-L', socket, 'kill-server'], { env, stdio: 'ignore' })
    } catch {
      // no server was ever started (every test skipped)
    }
    // Verify it is gone rather than assume it: a leaked tmux server on a shared host is exactly the
    // kind of litter this suite must not produce.
    let alive = true
    try {
      execFileSync(TMUX, ['-L', socket, 'has-session', '-t', 'any'], { env, stdio: 'ignore' })
    } catch {
      alive = false
    }
    expect(alive).toBe(false)
  }
  for (const d of [work, sockDir]) if (d) fs.rmSync(d, { recursive: true, force: true })
})

const tmux = (...args: string[]): string =>
  execFileSync(TMUX as string, ['-L', socket, ...args], { env, encoding: 'utf8' })

/**
 * A real pane whose FOREGROUND PROCESS GROUP really is named `binName`.
 *
 * `exec -a claude bash …` is the honest way to get a real, key-interpreting bash that the kernel
 * reports under the agent's name — so gate 1 reads the same kernel truth it will read in
 * production, and the reader judging our bytes is a real terminal application rather than a stub.
 */
function startPane(session: string, binName: string): void {
  // A vitest retry re-runs the test body on the same private socket, so a session left by the
  // failed attempt would make `new-session` die with "duplicate session" and the retry could never
  // pass. Start every attempt from a clean slate (the socket holds only this file's sessions).
  try {
    tmux('kill-session', '-t', `=${session}`)
  } catch {
    // no such session: the first attempt
  }
  tmux(
    'new-session',
    '-d',
    '-s',
    session,
    '-x',
    '200',
    '-y',
    '40',
    `${BASH} -c 'exec -a ${binName} ${BASH} --norc --noprofile -i'`
  )
  waitFor(() => capture(session).includes('#') || capture(session).includes('$'), 5000, 'a prompt')
}

const capture = (session: string): string => {
  try {
    return tmux('capture-pane', '-p', '-t', session)
  } catch {
    return ''
  }
}

function waitFor(cond: () => boolean, ms: number, what: string): void {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (cond()) return
    execFileSync('sleep', ['0.05'])
  }
  throw new Error(`timed out waiting for ${what}`)
}

/** The REAL kernel read from PR #203, against this pane. */
function realPaneOwner(session: string): DeliveryDeps['paneOwner'] {
  return async () => {
    const identity = parsePaneOwner(tmux('display-message', '-p', '-t', session, PANE_OWNER_FMT))
    if (!identity) return null
    const call = foregroundArgvArgs(identity.tty)
    if (!call) return null
    return paneOwnerFrom(identity, execFileSync(call.bin, call.args, { encoding: 'utf8' }))
  }
}

/**
 * The REAL write: the PRODUCTION plan (`localPasteDelivery` with enter=true → `runPasteDelivery`),
 * exactly what `PtyManager.sendEnvelope` runs — the PLAIN envelope over `load-buffer -`'s stdin,
 * `paste-buffer -d -p -r` (tmux draws the frame from the pane's real bracketed-paste state) and a
 * `send-keys Enter` in the same invocation. The plan carries no ESC byte of ours: on tmux ≥ 3.7
 * `paste-buffer` passes buffer content through vis(3), so a payload-carried frame arrives as
 * literal `^[` text (issue #453) — which is why the old already-framed plan is gone.
 */
function realSendEnvelope(session: string): DeliveryDeps['sendEnvelope'] {
  return async (_id, payload) => {
    const plan = localPasteDelivery(socket, session, payload, true)
    if (!plan) return false
    // The regression pin at the transport seam: nothing WE stage for a paste buffer may carry an
    // escape byte — tmux ≥ 3.7 would render it as text, tmux ≤ 3.6 would hand the pane raw
    // structure a payload could have smuggled in.
    expect(plan.body).not.toContain('\x1b')
    return runPasteDelivery(plan, async (args, input) => {
      execFileSync(TMUX as string, args, { env, input, encoding: 'utf8' })
    })
  }
}

const idle: MirrorEntry = {
  state: 'done',
  updatedAt: 1,
  stateVerified: true,
  clientRevision: MANAGED_SCRIPT_REVISION
}

function deps(session: string, over: Partial<DeliveryDeps> = {}): DeliveryDeps {
  return {
    paneOwner: realPaneOwner(session),
    bracketPasteRequested: async () => true,
    sendEnvelope: realSendEnvelope(session),
    mirrorEntry: () => idle,
    tokenFilePresent: () => true,
    lock: async (_id, fn) => fn(),
    now: () => 1,
    nonce: () => NONCE,
    trace: async () => ({ traceId: 'real-1', traced: 'memory' }),
    // No receipt will ever arrive from a bash pane — the delivery ends in `stalled`, which is the
    // honest outcome and is asserted as such below.
    subscribeEvents: () => () => {},
    ...over
  }
}

const req = (over: Partial<DeliveryRequest> = {}): DeliveryRequest => ({
  targetNodeId: 'n-dst',
  sourceNodeId: 'n-src',
  sourceTitle: 'Alpha',
  body: 'hello',
  targetAgentId: 'claude',
  ...over
})

const suite = BASH && TMUX ? describe : describe.skip

suite('REAL tmux pane, REAL bash: what the delivery actually does', () => {
  it(
    'the whole multi-line envelope arrives as ONE block, frame intact',
    async () => {
      const s = 'nt-whole' // an nt- name: the production plan asserts its target at the splice
      startPane(s, 'claude')
      const out = await deliverAgentMessage(
        req({ body: 'line one\nline two' }),
        deps(s, { subscribeEvents: () => () => {} })
      )
      // No hook events come from a bash pane, so the receipt legitimately stalls. It is reported,
      // not swallowed — which is the entire point of having a receipt.
      // `stalled` and not `deliveredToReplacedTarget` is itself an assertion about the REAL read:
      // the post-write check requires a pane id and the agent's own pid on both sides, so this
      // outcome proves tmux answered `#{pane_id}` and `ps` gave a pid column that lined up with
      // argv. A bash pane emits no hook events, so `stalled` is the honest end state.
      expect(out.kind).toBe('stalled')
      const live = await realPaneOwner(s)('n-dst')
      expect(live?.paneId, 'the real read carried no pane id').toMatch(/^%\d+$/)
      expect(live?.pids?.length).toBe(live?.argv.length)
      waitFor(() => capture(s).includes('END NODETERM MESSAGE'), 5000, 'the closing frame line')
      const pane = capture(s)
      for (const line of [
        `--- NODETERM MESSAGE ${NONCE} ---`,
        'from: Alpha (n-src)',
        'reply-to: n-src',
        'line one',
        'line two',
        `--- END NODETERM MESSAGE ${NONCE} ---`
      ]) {
        expect(pane, `missing from the pane: ${line}`).toContain(line)
      }
      // One block, not five turns: bash echoed the paste, THEN reported errors. If the lines had
      // been submitted one at a time, an error would sit between them (the `unframed` control at
      // the bottom of this file demonstrates exactly that).
      const firstErr = pane.indexOf('command not found')
      expect(firstErr).toBeGreaterThan(pane.indexOf(`--- END NODETERM MESSAGE ${NONCE} ---`))
    },
    30_000
  )

  it(
    'a body carrying the paste-END marker plus a command does NOT execute it',
    async () => {
      const s = 'nt-escape' // nt- name, same reason as nt-whole
      const marker = path.join(work, 'PWNED-escape')
      startPane(s, 'claude')
      const out = await deliverAgentMessage(
        req({ body: `hello${PASTE_END}${CR}touch ${marker}${CR}` }),
        deps(s)
      )
      expect(out.kind).toBe('stalled')
      waitFor(() => capture(s).includes('END NODETERM MESSAGE'), 5000, 'the closing frame line')
      execFileSync('sleep', ['1']) // give anything that DID escape time to run
      expect(fs.existsSync(marker), 'the payload EXECUTED — it escaped the frame').toBe(false)
      // …and the text still arrived, as content: ESC has no glyph, its printable tail survives.
      expect(capture(s)).toContain('hello[201~')
    },
    30_000
  )

  it(
    'with bracketed paste OFF the delivery is REFUSED and the pane is untouched',
    async () => {
      const s = 'nopaste'
      startPane(s, 'claude')
      const before = capture(s)
      const out = await deliverAgentMessage(
        req({ body: 'line one\nline two' }),
        deps(s, { bracketPasteRequested: async () => false })
      )
      expect(out).toEqual({ kind: 'targetNotPasteAware' })
      execFileSync('sleep', ['0.5'])
      expect(capture(s)).toBe(before)
    },
    30_000
  )

  it(
    'gate 1 reads the KERNEL: a pane a plain shell owns is refused, and nothing is written',
    async () => {
      const s = 'shellpane'
      startPane(s, 'bash') // a real bash under its own name — not an agent
      const before = capture(s)
      const out = await deliverAgentMessage(req(), deps(s))
      expect(out.kind).toBe('targetNotAgentPane')
      execFileSync('sleep', ['0.5'])
      expect(capture(s)).toBe(before)
    },
    30_000
  )

  it(
    "the running tmux's bracket_paste_flag is MEASURED, and an unreadable flag refuses",
    async () => {
      // Not a skip and not an assumption: read what THIS tmux answers and pin the consequence.
      //
      // Measured on this host (tmux 3.4, Ubuntu 24.04): `#{bracket_paste_flag}` expands to EMPTY —
      // the format does not exist in that build (`strings tmux | grep _flag` lists insert_flag,
      // keypad_flag, wrap_flag … and no bracket one; an unknown format name expands to empty in the
      // same way). `PtyManager.bracketPasteRequested` compares against '1', so on such a host it
      // answers false for every pane, and this delivery primitive refuses with `targetNotPasteAware`
      // rather than sending a multi-line body line-by-line. That is the correct fail direction, and
      // it is the direction this test pins: whatever the flag says, an answer that is not '1' must
      // REFUSE, never fall back to the unframed path.
      const s = 'nt-flagprobe' // nt- name: on a tmux >= 3.7 host the aware branch really delivers
      startPane(s, 'claude')
      const flag = tmux('display-message', '-p', '-t', s, '#{bracket_paste_flag}').trim()
      const probe: DeliveryDeps['bracketPasteRequested'] = async () => flag === '1'
      const before = capture(s)
      const out = await deliverAgentMessage(req({ body: 'a\nb' }), deps(s, { bracketPasteRequested: probe }))
      if (flag === '1') {
        expect(out.kind).toBe('stalled')
        waitFor(() => capture(s).includes('END NODETERM MESSAGE'), 5000, 'the closing frame line')
      } else {
        expect(out).toEqual({ kind: 'targetNotPasteAware' })
        execFileSync('sleep', ['0.5'])
        expect(capture(s)).toBe(before)
      }
    },
    30_000
  )
})

suite('the mutation controls — run, not described', () => {
  const attack = (marker: string): string => `hello${PASTE_END}${CR}touch ${marker}${CR}`

  it(
    'UNSANITIZED: the same body framed without stripping ESC DOES execute the command',
    async () => {
      const s = 'ctrl-unsan'
      const marker = path.join(work, 'PWNED-unsanitized')
      startPane(s, 'claude')
      const envelope = buildEnvelopeUnsanitized(attack(marker))
      tmux('send-keys', '-t', s, '-l', '--', PASTE_START + envelope + PASTE_END + CR)
      waitFor(() => fs.existsSync(marker), 8000, 'the unsanitized attack to land')
      expect(fs.existsSync(marker), 'the attack no longer works — the tests above are vacuous').toBe(
        true
      )
    },
    30_000
  )

  it(
    'UNFRAMED (herdr :260): the same envelope without paste markers IS submitted line-by-line',
    async () => {
      // The exact inverse of the "one block" assertion in the first test, run against the same
      // reader. There, the first shell error appears AFTER the closing frame line, because the
      // whole envelope was one paste. Here it appears BETWEEN the frame lines, because every line
      // became its own turn — which is herdr's shipped bug, and the reason a multi-line body on the
      // unframed fallback is REFUSED rather than sent and hoped for.
      const s = 'ctrl-unframed'
      startPane(s, 'claude')
      const envelope = buildEnvelope({
        nonce: NONCE,
        sourceId: 'n-src',
        sourceTitle: 'Alpha',
        replyTo: 'n-src',
        body: 'line one\nline two'
      })
      tmux('send-keys', '-t', s, '-l', '--', envelope + CR)
      waitFor(() => capture(s).includes('command not found'), 8000, 'the first line to be submitted')
      execFileSync('sleep', ['1'])
      const pane = capture(s)
      expect(pane).toContain(`--- NODETERM MESSAGE ${NONCE} ---`)
      expect(pane.indexOf('command not found')).toBeLessThan(
        pane.indexOf(`--- END NODETERM MESSAGE ${NONCE} ---`)
      )
      // Same fact, said the other way: the frame's own opening line ran as a COMMAND.
      expect(pane).toMatch(/---: command not found/)
    },
    30_000
  )

  it('the shipped sanitizer really strips ESC — byte level, next to the pane level', () => {
    expect(sanitizePasteText(`x${ESC}[201~y`)).toBe('x[201~y')
    expect(sanitizePasteText(`x${ESC}y`)).toBe('xy')
  })
})

/** The envelope as it would be built if the body were NOT sanitized — the control's whole point. */
function buildEnvelopeUnsanitized(body: string): string {
  return [
    `--- NODETERM MESSAGE ${NONCE} ---`,
    'from: Alpha (n-src)',
    'reply-to: n-src',
    body,
    `--- END NODETERM MESSAGE ${NONCE} ---`
  ].join('\n')
}
