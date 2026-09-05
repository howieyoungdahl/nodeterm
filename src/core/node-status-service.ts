// The one thing in the status surface that does I/O: proving whether a node's backend is still
// there. Everything else — the table, the words, the glyphs, the freshness rule — is pure and
// lives in `shared/node-status.ts`.
//
// This is the ONLY input that may produce `failed`. It is deliberately narrow:
//
//  * It asks `PtyManager.sessionPresence` — the same tri-state primitive the operator API's
//    dead-card sweep asks (`server/node-ops.ts`), which is the one liveness proof in the product.
//    No second prober, no `ps` parsing, no reading what the pane printed.
//  * It repeats the probe before returning `dead`, exactly as that sweep does. A single miss is a
//    tmux that was busy, a socket that hiccuped, a session-host that had not answered yet; two
//    definite misses are a fact. `unknown` is never promoted by repetition.
//  * A shell that wired no prober answers `unknown` for every id. That is the fail-safe direction
//    and it is what makes "no pane prober available" render as the word `unknown` instead of as a
//    stale `working` badge that quietly reads as healthy.
//
// Registered by BOTH shells from this one body, beside `registerAgentStatusSnapshotIpc` — same
// reason it is written once: this repo has shipped a hook/mirror change to exactly one shell three
// times, and a shared body reduces the drift surface to one greppable call per shell.

import { IPC } from '../shared/ipc'
import { platform } from './platform'
import type { PaneEvidence } from '../shared/node-status'

export interface NodeStatusServiceDeps {
  /**
   * Proven presence of the backend behind a node id. Absent ⇒ this shell can prove nothing, and
   * every answer is `unknown`. Optional on purpose: a shell without a PtyManager (or a future one
   * that cannot reach the backend) must be able to register the channel and answer honestly rather
   * than leave the renderer with no channel at all, which is indistinguishable from a hung call.
   */
  panePresence?: (nodeId: string) => Promise<PaneEvidence>
}

/**
 * How many ids one call may probe. The request comes from the renderer, and each id is a tmux
 * round trip (two, for a dead one), so the list is bounded here rather than trusted. Ids past the
 * cap answer `unknown` — the same word every other "we could not check" answer uses.
 *
 * The renderer only ever asks about STALE working nodes (`paneProbeCandidates`), so hitting this
 * cap means 64 sessions went quiet at once, which is a case for the panel, not for the badge.
 */
export const MAX_PANE_PROBE_IDS = 64

/**
 * One id, double-checked. `alive` and `unknown` are returned as they come; only `dead` is asked
 * twice, and the second answer wins — so a probe that says `dead` then `alive` reports `alive`,
 * and one that says `dead` then throws reports `unknown`. There is no path from a single `dead` to
 * a reported `dead`.
 */
export async function confirmedPaneEvidence(
  nodeId: string,
  deps: NodeStatusServiceDeps
): Promise<PaneEvidence> {
  const probe = deps.panePresence
  if (!probe) return 'unknown'
  const first = await probe(nodeId).catch((): PaneEvidence => 'unknown')
  if (first !== 'dead') return first
  return await probe(nodeId).catch((): PaneEvidence => 'unknown')
}

/**
 * Probe a batch. Every requested id gets an entry — a missing key would be indistinguishable from
 * a dropped reply, and the renderer's derivation treats "absent" as "nobody asked", which is a
 * different badge from "asked, could not tell".
 */
export async function probePaneEvidence(
  nodeIds: readonly string[],
  deps: NodeStatusServiceDeps
): Promise<Record<string, PaneEvidence>> {
  const unique = [...new Set(nodeIds.filter((id) => typeof id === 'string' && id.length > 0))]
  const probed = unique.slice(0, MAX_PANE_PROBE_IDS)
  const out: Record<string, PaneEvidence> = {}
  for (const id of unique.slice(MAX_PANE_PROBE_IDS)) out[id] = 'unknown'
  const answers = await Promise.all(probed.map((id) => confirmedPaneEvidence(id, deps)))
  probed.forEach((id, i) => {
    out[id] = answers[i]
  })
  return out
}

/** The one registration for the pane-evidence channel, called by both shells. */
export function registerNodeStatusIpc(deps: NodeStatusServiceDeps): void {
  platform().handle(IPC.nodeStatusPanes, (nodeIds: unknown) =>
    probePaneEvidence(Array.isArray(nodeIds) ? (nodeIds as string[]) : [], deps)
  )
}
