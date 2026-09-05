// The status a canvas node SHOWS, and the only rules that may produce it.
//
// ── The one rule ─────────────────────────────────────────────────────────────────────────────────
// Never infer state from what a terminal looks like. There is no output parsing here, no "it has
// not printed in a while so it is stuck", and no timer that promotes a guess into a fact. Two
// sources, and only two:
//
//  1. the hook-fed agent-status mirror (`AgentState` + the instant it was last asserted), which is
//     what `working | waiting | blocked | completed` come from; and
//  2. a PROVEN session fact about the node's pane (`PaneEvidence`), which is the only thing that
//     may produce `failed`.
//
// Everything the two cannot answer is `unknown` — a word on screen, never silence, and never
// laundered into "idle" or "completed". That is decision D3 of the auto-organizer plan.
//
// ── Why this lives in `src/shared` ───────────────────────────────────────────────────────────────
// The renderer has no `@core` alias (see electron.vite.config.ts), and the badge is rendered by the
// renderer while the pane probe runs in core. A second copy of the table on each side is exactly the
// drift CONTRIBUTING warns about, so the table is here — imported by core's probe service, by both
// shells through it, and by the renderer directly. `src/core/node-status-service.ts` is the part
// that does I/O; nothing in this file does any.

import type { AgentState } from './agents/normalize'

/**
 * The six states the operator asked to tell apart. `completed` is the hook mirror's `done`
 * renamed for the screen (a finished turn), `failed` is derived only from session facts, and
 * `unknown` is the honest answer — it is a rendered word, not an absence.
 */
export type NodeStatusKind =
  | 'working'
  | 'waiting'
  | 'blocked'
  | 'failed'
  | 'completed'
  | 'unknown'

/**
 * What a session probe PROVED about a node's pane.
 *
 * `unknown` is a first-class answer and the fail-safe one: an unreadable tmux, a shell with no
 * prober wired, a stored SSH project this process holds no ControlMaster for, a probe that threw.
 * It may never be rounded to `dead` — a wrong `failed` is the expensive error here (plan §8).
 */
export type PaneEvidence = 'alive' | 'dead' | 'unknown'

/**
 * How long a state may go unasserted before the badge says so.
 *
 * Half of `WORKING_STALE_MS` (the 20-minute window after which the mirror presumes a `working`
 * node gone and sweeps it). Ten minutes is also the longest legitimate gap between hook events we
 * know of — a Claude `Bash` tool call caps out around there, and every tool call refreshes the
 * entry — so a badge marked stale at ten minutes is saying "this is old news", not "this is
 * wrong". Marking is all it does: a stale state is still rendered as the state it is.
 */
export const NODE_STATUS_STALE_MS = 10 * 60_000

/** How much of the hook event's own reason string the badge carries (B3). */
export const STATUS_REASON_MAX = 90

/**
 * Glyph + word per state. **Never colour alone**: every distinction on this badge is carried by a
 * glyph AND a word, so it survives a colourblind reader, a monochrome screenshot and the
 * effects-off setting. `node-status.test.ts` asserts both columns are injective; do not add a
 * state whose only difference from another is its colour.
 */
export const NODE_STATUS_PRESENTATION: Record<
  NodeStatusKind,
  { glyph: string; word: string }
> = {
  working: { glyph: '▶', word: 'WORKING' },
  waiting: { glyph: '?', word: 'WAITING' },
  blocked: { glyph: '!', word: 'BLOCKED' },
  failed: { glyph: '✕', word: 'FAILED' },
  completed: { glyph: '✓', word: 'COMPLETED' },
  unknown: { glyph: '·', word: 'UNKNOWN' }
}

/**
 * Roll-up order for a group frame: worst first, and "worst" means *most likely to be waiting on
 * the operator*. Failures and approvals lead because the whole point of the frame badge is that
 * they stay discoverable when their terminals are collapsed.
 *
 * `unknown` deliberately outranks `working`: a running member is a positive fact, an unaccounted
 * one is the absence of any fact, and a frame that reports the healthy member while hiding the
 * one it cannot see is the failure mode this badge exists to prevent. `completed` is last —
 * everything in the frame has settled.
 */
export const NODE_STATUS_SEVERITY: readonly NodeStatusKind[] = [
  'failed',
  'blocked',
  'waiting',
  'unknown',
  'working',
  'completed'
]

/** Why a node is `failed`, as proven — never as guessed. */
export interface NodeFailureFact {
  /** When the pane was proven gone (ms epoch). */
  at: number
  /** The hook state that was standing when the pane died. Only `working` can produce `failed`. */
  from: AgentState
  /** Short human reason, if the prover had one. */
  reason?: string
}

export interface NodeStatusInput {
  /** Last hook-fed state. `undefined` = nothing has ever reported for this node. */
  state?: AgentState
  /** When `state` was last ASSERTED (freshness, not transition time). Absent = no clock. */
  updatedAt?: number
  /**
   * What a probe proved about the pane. **Absent means nobody asked**, which is not the same as
   * `'unknown'` (asked, could not tell) — the two produce different badges, on purpose:
   * a fresh `working` is never probed at all and must keep reading `working`.
   */
  pane?: PaneEvidence
  /** A failure already proven for this node and latched by the detector. */
  failure?: NodeFailureFact
  /** The reason the hook event itself carried (permission prompt / question text / last message). */
  reason?: string
  /** How the shell classified a needs-you edge (`NormalizedAgentEvent.askKind`). */
  askKind?: 'question' | 'approval'
  now: number
  staleMs?: number
}

export interface NodeStatusView {
  kind: NodeStatusKind
  glyph: string
  word: string
  /** ms since the state was asserted; `null` when there is no clock to measure from. */
  ageMs: number | null
  /** Compact freshness for the badge (`''` when `ageMs` is null). */
  age: string
  /** Past the staleness window: the state is old news, and the badge says so in a word. */
  stale: boolean
  /** Truncated reason the hook event provided; `''` when it provided none. Never invented. */
  reason: string
  /** One sentence for the tooltip: what we know, how old it is, and why we cannot say more. */
  detail: string
}

/** Compact age for a badge: `now`, `34m`, `3h`, `2d`. */
export function formatStatusAge(ms: number): string {
  const clamped = Math.max(0, ms)
  const min = Math.floor(clamped / 60_000)
  if (min < 1) return 'now'
  if (min < 60) return `${min}m`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h`
  return `${Math.floor(hr / 24)}d`
}

/** Trim a hook-provided reason to badge length without inventing anything. */
export function truncateReason(text: string | undefined, max = STATUS_REASON_MAX): string {
  const one = (text ?? '').replace(/\s+/g, ' ').trim()
  if (!one) return ''
  return one.length <= max ? one : `${one.slice(0, Math.max(0, max - 1))}…`
}

/**
 * The whole derivation table. Pure; `now` is injected.
 *
 * ```
 * failure latched                              → failed      (proven, and it stays proven)
 * state undefined                              → unknown     (no event has ever reported)
 * state working + pane 'dead'                  → failed      (the ONLY way to reach failed)
 * state working + pane 'unknown' + stale       → unknown     (we asked, we could not tell)
 * state working + pane 'unknown' + fresh       → working     (a 3-second-old hook event is a fact)
 * state working + pane 'alive' | absent        → working
 * state waiting                                → waiting
 * state blocked                                → blocked
 * state done                                   → completed
 * ```
 *
 * Two consequences worth stating out loud, because both were choices:
 *
 *  - **A missing prober can never manufacture `failed`.** `pane` absent (nobody asked) and `pane`
 *    `'unknown'` (asked, inconclusive) both refuse it. The detector that drives this hands back
 *    `'unknown'` for every candidate on a surface with no prober, which is why "no pane prober
 *    available" surfaces as the word `unknown` rather than as a stale `working` that quietly reads
 *    as healthy.
 *  - **Only `working` consults the pane.** A dead pane under `blocked`/`waiting`/`done` leaves the
 *    state alone, because the plan derives `failed` from "the last hook state was `working` AND the
 *    pane is proven dead" and nothing else. Those states are marked stale instead.
 */
/** The states whose reason belongs on the badge itself rather than only in its tooltip. */
const ATTENTION_KINDS = new Set<NodeStatusKind>(['blocked', 'waiting', 'failed'])

export function deriveNodeStatus(input: NodeStatusInput): NodeStatusView {
  const staleMs = input.staleMs ?? NODE_STATUS_STALE_MS
  const ageMs =
    typeof input.updatedAt === 'number' ? Math.max(0, input.now - input.updatedAt) : null
  const stale = ageMs !== null && ageMs > staleMs
  const reason = truncateReason(input.reason)

  const kind = resolveKind(input, stale)
  const { glyph, word } = NODE_STATUS_PRESENTATION[kind]
  return {
    kind,
    glyph,
    word,
    ageMs: kind === 'failed' && input.failure ? Math.max(0, input.now - input.failure.at) : ageMs,
    age:
      kind === 'failed' && input.failure
        ? formatStatusAge(Math.max(0, input.now - input.failure.at))
        : ageMs === null
          ? ''
          : formatStatusAge(ageMs),
    stale: kind === 'failed' ? false : stale,
    // INLINE only where the question is "why does this need me?" — B3's actual wording. A
    // `working` node's last assistant message and a finished turn's closing line are interesting
    // but they are not a call for attention, and putting either on a node header turns a badge
    // into a log line. Both still reach the tooltip through `detail`.
    reason: ATTENTION_KINDS.has(kind)
      ? truncateReason(input.failure?.reason ?? input.reason)
      : '',
    detail: buildDetail(kind, input, ageMs, stale)
  }
}

function resolveKind(input: NodeStatusInput, stale: boolean): NodeStatusKind {
  if (input.failure) return 'failed'
  if (!input.state) return 'unknown'
  if (input.state === 'working') {
    if (input.pane === 'dead') return 'failed'
    if (input.pane === 'unknown' && stale) return 'unknown'
    return 'working'
  }
  if (input.state === 'done') return 'completed'
  return input.state
}

/** `formatStatusAge` is written for a badge, where the unit alone reads fine; a sentence needs the
 *  preposition, and "now ago" is not English. */
function ago(ms: number): string {
  const age = formatStatusAge(Math.max(0, ms))
  return age === 'now' ? 'just now' : `${age} ago`
}

function buildDetail(
  kind: NodeStatusKind,
  input: NodeStatusInput,
  ageMs: number | null,
  stale: boolean
): string {
  const parts: string[] = []
  switch (kind) {
    case 'failed':
      parts.push('Failed: the session was working and its terminal session is gone.')
      break
    case 'unknown':
      if (input.state === 'working') {
        parts.push(
          'Unknown: last reported working, and the terminal session could not be checked.'
        )
      } else {
        parts.push('Unknown: no status event has been received for this node.')
      }
      break
    case 'working':
      parts.push('Working.')
      break
    case 'waiting':
      parts.push('Waiting for your response.')
      break
    case 'blocked':
      parts.push(
        input.askKind === 'question'
          ? 'Blocked: waiting on your answer to a question.'
          : 'Blocked: waiting on your approval.'
      )
      break
    case 'completed':
      parts.push('Completed its turn.')
      break
  }
  if (kind === 'failed' && input.failure) {
    parts.push(`Detected ${ago(input.now - input.failure.at)}.`)
  } else if (ageMs !== null) {
    parts.push(`Reported ${ago(ageMs)}.`)
    // Only where the state is still being presented as itself. A proven failure is current news,
    // not old news, so calling it stale here would contradict the view's own `stale: false`.
    if (stale && kind !== 'failed') {
      parts.push('Older than the freshness window — shown as stale, not as current.')
    }
  } else {
    parts.push('No freshness information.')
  }
  const reason = truncateReason(input.failure?.reason ?? input.reason)
  if (reason) parts.push(reason)
  return parts.join(' ')
}

/** One member of a group frame, as the roll-up sees it. */
export interface RollUpMember {
  id: string
  kind: NodeStatusKind
}

export interface NodeStatusRollUp {
  kind: NodeStatusKind
  glyph: string
  word: string
  /** How many members are in the winning state. */
  count: number
  /** How many members the frame has at all. */
  total: number
}

/**
 * Worst member state wins (`NODE_STATUS_SEVERITY`). Returns `null` for a frame with no
 * status-bearing members, which is the signal to render no badge at all — a frame of editor and
 * sticky nodes must not grow a status chip.
 */
export function rollUpNodeStatus(members: readonly RollUpMember[]): NodeStatusRollUp | null {
  if (members.length === 0) return null
  for (const kind of NODE_STATUS_SEVERITY) {
    const count = members.reduce((n, m) => (m.kind === kind ? n + 1 : n), 0)
    if (count > 0) {
      const { glyph, word } = NODE_STATUS_PRESENTATION[kind]
      return { kind, glyph, word, count, total: members.length }
    }
  }
  return null
}

/**
 * Which nodes are worth a pane probe right now.
 *
 * Only a `working` state whose freshness has passed the window: that is the one combination where
 * the session fact can change the badge (`working` → `failed`, or → `unknown`). A fresh `working`
 * is never probed — a hook event from ten seconds ago already answers the question, and probing
 * every node on every tick would be a tmux round trip per pane per tick for no pixels.
 *
 * A node that already carries a latched failure is not re-probed either: the latch is cleared by a
 * live hook event (the store's self-heal), not by us asking again.
 */
export function paneProbeCandidates(
  entries: ReadonlyArray<{ id: string; state?: AgentState; updatedAt?: number; failed?: boolean }>,
  now: number,
  staleMs: number = NODE_STATUS_STALE_MS
): string[] {
  const out: string[] = []
  for (const e of entries) {
    if (e.failed) continue
    if (e.state !== 'working') continue
    if (typeof e.updatedAt !== 'number') continue
    if (now - e.updatedAt <= staleMs) continue
    out.push(e.id)
  }
  return out
}
