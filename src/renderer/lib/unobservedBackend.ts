// Backend presence answers a different question from task status. Keep these observations out
// of the hook store: a shell can be present after a task finished, and an absent backend says
// nothing about whether its unobserved task succeeded.
import type { PaneEvidence } from '@shared/node-status'
import { PANE_RECHECK_MS } from '@shared/node-status'
import { relativeTime } from './relativeTime'

export interface BackendProbeTarget {
  id: string
  projectId: string
  /** False for SSH/relay nodes or any node with a hook state. */
  eligible: boolean
  /** Exact renderer status entry, not saved session identity or a title. */
  statusToken?: object
}

export interface BackendObservation {
  target: BackendProbeTarget
  pane: PaneEvidence
  checkedAt: number
}

export interface BackendPresentation {
  word: string
  detail: string
}

export const MAX_UNOBSERVED_BACKEND_PROBES = 16

function sameTarget(a: BackendProbeTarget, b: BackendProbeTarget): boolean {
  return b.eligible && a.id === b.id && a.projectId === b.projectId && a.statusToken === b.statusToken
}

function fresh(observation: BackendObservation, now: number): boolean {
  const age = now - observation.checkedAt
  return Number.isFinite(age) && age >= 0 && age < PANE_RECHECK_MS
}

export function unobservedBackendPresentation(
  target: BackendProbeTarget,
  observation: BackendObservation | undefined,
  now: number
): BackendPresentation {
  if (!observation || !sameTarget(observation.target, target) || !fresh(observation, now)) {
    return { word: 'backend unverified', detail: 'No current backend observation. Task status is unobserved.' }
  }
  const checked = `Checked ${relativeTime(observation.checkedAt, now)}.`
  switch (observation.pane) {
    case 'dead':
      return { word: 'backend stopped', detail: `Backend absence confirmed twice. ${checked} Task completion is unobserved.` }
    case 'alive':
      return { word: 'backend present', detail: `Terminal backend present. ${checked} Agent activity and task completion are unobserved.` }
    default:
      return { word: 'backend unverified', detail: `Backend could not be verified. ${checked} Task status is unobserved.` }
  }
}

/** One bounded, read-only pass through the EXISTING double-confirmed core API. Re-read targets
 * after awaiting it: a hook, project switch, removal or foreign-core binding invalidates a reply.
 * Missing/corrupt answers stay unknown; unsolicited ids never enter the display cache. */
export async function probeUnobservedBackends(deps: {
  targets(): BackendProbeTarget[]
  observations: Readonly<Record<string, BackendObservation>>
  probe?: (ids: string[]) => Promise<unknown>
  now?: () => number
}): Promise<Record<string, BackendObservation>> {
  const now = deps.now ?? Date.now
  const checkedAt = now()
  const seen = new Set<string>()
  const candidates = deps.targets().filter((target) => {
    if (!target.eligible || seen.has(target.id)) return false
    seen.add(target.id)
    const old = deps.observations[target.id]
    return !old || !sameTarget(old.target, target) || !fresh(old, checkedAt)
  }).slice(0, MAX_UNOBSERVED_BACKEND_PROBES)
  if (candidates.length === 0) return {}

  let answer: unknown
  try {
    answer = await deps.probe?.(candidates.map((target) => target.id))
  } catch {
    // Failed transport is uncertainty, never absence.
  }
  const current = new Map(deps.targets().map((target) => [target.id, target]))
  const out: Record<string, BackendObservation> = {}
  for (const target of candidates) {
    const latest = current.get(target.id)
    if (!latest || !sameTarget(target, latest)) continue
    const value = answer && typeof answer === 'object' && !Array.isArray(answer) &&
      Object.prototype.hasOwnProperty.call(answer, target.id)
      ? (answer as Record<string, unknown>)[target.id] : undefined
    const observation: BackendObservation = {
      target,
      pane: value === 'alive' || value === 'dead' ? value : 'unknown',
      // Starting time is conservative: a slow reply must not make an old probe look fresh.
      checkedAt
    }
    if (fresh(observation, now())) out[target.id] = observation
  }
  return out
}
