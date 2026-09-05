// The renderer half of the `failed` derivation: decide who is worth probing, ask the core that owns
// the sessions, and record what came back.
//
// It is deliberately small and deliberately lazy. A pane probe is a tmux round trip per node (two
// for a dead one), so this asks about exactly the nodes where the answer could change the badge.
// A canvas of twenty healthy agents produces zero probes.
//
// Three rules a refactor must not undo:
//
//  0. **Only a state a dead pane could change, and not too often.** `paneProbeCandidates` picks a
//     `FAILABLE_STATES` entry past the freshness window whose pane has not been asked about within
//     `PANE_RECHECK_MS`. That bound matters more since `waiting`/`blocked` joined: unlike
//     `working`, they never decay out of the candidate set on their own, so an overnight parked
//     approval would otherwise be probed on every pass until it was answered.
//  1. **`unknown` is recorded, not swallowed.** A shell with no prober, a stub, a rejected call and
//     an unreadable tmux all answer `'unknown'`, and that answer is written to the store — which is
//     what turns a stale `working` we cannot verify into the WORD `unknown` instead of a badge that
//     silently keeps reading as healthy.
//  2. **Eligibility is re-asked at write time.** `markFailed` refuses a node that is no longer
//     `working`; between planning a probe and its answer the node may have posted a new turn.
//  3. **Nothing here is authority.** It reads, and it writes two transient display fields. It never
//     messages, submits, kills a PTY or closes a session.

import type { AgentState } from '@shared/agents/normalize'
import type { PaneEvidence } from '@shared/node-status'
import { NODE_STATUS_STALE_MS, paneProbeCandidates } from '@shared/node-status'

export interface FailureProbeEntry {
  id: string
  state?: AgentState
  /** When the state was last asserted — the store's `stateAt`. */
  updatedAt?: number
  /** When this node's pane was last probed — the store's `paneAt`; drives the re-check interval. */
  paneAt?: number
  failed?: boolean
}

export interface FailureProbeDeps {
  /** The status table, flattened. Read at call time, so it is never a stale snapshot. */
  entries(): FailureProbeEntry[]
  /** `window.nodeTerminal.nodePaneEvidence`, or absent on a surface that has none. */
  probe?: (nodeIds: string[]) => Promise<Record<string, PaneEvidence>>
  setPaneEvidence(evidence: Record<string, PaneEvidence>): void
  markFailed(id: string, at: number, reason?: string): void
  now?: () => number
  staleMs?: number
}

export interface FailureProbeResult {
  probed: string[]
  failed: string[]
  evidence: Record<string, PaneEvidence>
}

const EMPTY: FailureProbeResult = { probed: [], failed: [], evidence: {} }

/** One pass. Never throws: a failed round trip is `unknown` for every candidate, like every other
 *  "we could not check" answer. */
export async function runFailureProbe(deps: FailureProbeDeps): Promise<FailureProbeResult> {
  const now = deps.now ?? Date.now
  const staleMs = deps.staleMs ?? NODE_STATUS_STALE_MS
  const candidates = paneProbeCandidates(deps.entries(), now(), staleMs)
  if (candidates.length === 0) return EMPTY

  // No prober on this surface (a stub api, an older host): every candidate is recorded as
  // inconclusive rather than left unasked, which is the difference between the badge saying
  // `unknown` and the badge saying `working` about a session nobody can account for.
  let evidence: Record<string, PaneEvidence>
  if (!deps.probe) {
    evidence = inconclusive(candidates)
  } else {
    try {
      const answer = await deps.probe(candidates)
      evidence = normalize(candidates, answer)
    } catch {
      evidence = inconclusive(candidates)
    }
  }

  deps.setPaneEvidence(evidence)
  const failed: string[] = []
  const at = now()
  for (const id of candidates) {
    if (evidence[id] !== 'dead') continue
    deps.markFailed(id, at)
    failed.push(id)
  }
  return { probed: candidates, failed, evidence }
}

function inconclusive(ids: readonly string[]): Record<string, PaneEvidence> {
  const out: Record<string, PaneEvidence> = {}
  for (const id of ids) out[id] = 'unknown'
  return out
}

/** Keep only the ids we asked about, and treat any answer that is not one of the three words as
 *  inconclusive — the reply crosses a process boundary and is not ours to trust in shape. */
function normalize(
  ids: readonly string[],
  answer: Record<string, PaneEvidence> | undefined
): Record<string, PaneEvidence> {
  const out: Record<string, PaneEvidence> = {}
  for (const id of ids) {
    const v = answer?.[id]
    out[id] = v === 'alive' || v === 'dead' || v === 'unknown' ? v : 'unknown'
  }
  return out
}
