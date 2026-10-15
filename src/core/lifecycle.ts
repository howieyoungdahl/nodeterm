import type { AgentState } from '../shared/agents/normalize'
import { WORKING_STALE_MS } from '../shared/agents/stale'

export type LifecycleState = 'starting' | 'blocked' | 'working' | 'idle-warm' | 'idle-cold' | 'exited' | 'dead' | 'unknown'
export type BlockedKind = 'permission' | 'question' | 'elicitation' | 'input' |
  'codex-hooks-review' | 'codex-dir-trust' | 'claude-folder-trust' | 'claude-resume-menu'
export interface BlockedOn { kind: BlockedKind; since: number; detail: string | null }
/** Independent clocks: tool traffic must never extend the completed turn's cache window. */
export interface LifecycleEvidence {
  lastDoneAt?: number
  lastDoneClean?: boolean
  lastPromptAt?: number
  lastEventAt?: number
  stateSince?: number
  sessionStartedAt?: number
  sessionEndedAt?: number
  blockedKind?: BlockedKind
  blockedSince?: number
  blockedDetail?: string
  transcriptPath?: string
}
export interface LifecycleConfig {
  startingGraceMs: number
  ttlMs: { claude: number; codex: number; default: number }
}
export const DEFAULT_LIFECYCLE_CONFIG: LifecycleConfig = {
  startingGraceMs: 3 * 60_000,
  ttlMs: { claude: 45 * 60_000, codex: 5 * 60_000, default: 5 * 60_000 }
}
export interface LifecycleInput extends LifecycleEvidence {
  paneState: 'alive' | 'dead' | 'none' | 'unknown'
  isAgent: boolean
  provider?: string | null
  sessionId?: string | null
  createdAt?: number | null
  state?: AgentState
  updatedAt?: number
  restored?: boolean
  shell?: boolean
  detectedPrompt?: BlockedOn | null
  transcriptDone?: { at: number; clean: boolean } | null
}
export interface Lifecycle {
  state: LifecycleState
  since: number | null
  provider: string | null
  sessionId: string | null
  lastPromptAt: number | null
  lastDoneAt: number | null
  lastDoneClean: boolean
  blockedOn: BlockedOn | null
  ttlMs: number
  coldAt: number | null
}

export function deriveLifecycle(input: LifecycleInput, now: number,
  config: LifecycleConfig = DEFAULT_LIFECYCLE_CONFIG): Lifecycle {
  const ttlMs = input.provider === 'claude' ? config.ttlMs.claude : input.provider === 'codex' ? config.ttlMs.codex : config.ttlMs.default
  const persistedDone = input.lastDoneAt !== undefined && input.lastDoneClean ? { at: input.lastDoneAt, clean: true } : null
  const transcriptDone = input.restored ? input.transcriptDone : null
  const done = input.restored ? (persistedDone && (!transcriptDone || persistedDone.at >= transcriptDone.at) ? persistedDone : transcriptDone) : null
  const lastDoneAt = done?.at ?? input.lastDoneAt ?? null
  const coldAt = lastDoneAt === null ? null : lastDoneAt + ttlMs
  const result: Lifecycle = {
    state: 'unknown', since: null, provider: input.provider ?? null, sessionId: input.sessionId ?? null,
    lastPromptAt: input.lastPromptAt ?? null, lastDoneAt,
    lastDoneClean: done?.clean ?? input.lastDoneClean ?? false, blockedOn: null, ttlMs, coldAt
  }
  const state = (value: LifecycleState, since: number | null): Lifecycle => ({ ...result, state: value, since })
  if (input.paneState === 'dead' || input.paneState === 'none') return state('dead', null)
  if (input.paneState !== 'alive' || !input.isAgent) return result
  // A shell is positive evidence that the CLI relinquished the pane. A failed process probe is not.
  if (input.shell || (!input.restored && input.sessionEndedAt !== undefined)) return state('exited', input.sessionEndedAt ?? null)
  const blocked = input.detectedPrompt ?? (!input.restored && (input.state === 'blocked' || input.state === 'waiting') ? {
    kind: input.blockedKind ?? (input.state === 'blocked' ? 'permission' : 'input'),
    since: input.blockedSince ?? input.updatedAt ?? now, detail: input.blockedDetail ?? null
  } : null)
  if (blocked) return { ...state('blocked', blocked.since), blockedOn: blocked }
  if (input.restored) {
    if (!done) return result
  } else {
    if (input.state === 'working' && now - (input.lastEventAt ?? input.updatedAt ?? 0) <= WORKING_STALE_MS)
      return state('working', input.stateSince ?? input.updatedAt ?? null)
    if (input.state !== 'done') {
      if (!input.sessionStartedAt && !input.lastPromptAt && input.state === undefined && input.createdAt != null &&
        now - input.createdAt < config.startingGraceMs) return state('starting', input.createdAt)
      return result
    }
  }
  // Failed/interrupted/rescue ends have no completed-turn cache evidence.
  if (lastDoneAt === null || (!done && !input.lastDoneClean)) return result
  return now < coldAt! ? state('idle-warm', lastDoneAt) : state('idle-cold', coldAt)
}

export function lifecycleConfigFromEnv(env: Record<string, string | undefined>): LifecycleConfig {
  const ms = (key: string, fallback: number): number => {
    const value = Number(env[key])
    return env[key]?.trim() && Number.isSafeInteger(value) && value > 0 ? value : fallback
  }
  return {
    startingGraceMs: ms('NODETERM_LIFECYCLE_STARTING_GRACE_MS', DEFAULT_LIFECYCLE_CONFIG.startingGraceMs),
    ttlMs: {
      claude: ms('NODETERM_LIFECYCLE_CLAUDE_TTL_MS', DEFAULT_LIFECYCLE_CONFIG.ttlMs.claude),
      codex: ms('NODETERM_LIFECYCLE_CODEX_TTL_MS', DEFAULT_LIFECYCLE_CONFIG.ttlMs.codex),
      default: ms('NODETERM_LIFECYCLE_DEFAULT_TTL_MS', DEFAULT_LIFECYCLE_CONFIG.ttlMs.default)
    }
  }
}

/** Validate optional disk fields without trusting hand-edited timestamps or prompt kinds. */
export function lifecycleEvidence(value: LifecycleEvidence): LifecycleEvidence {
  const out: LifecycleEvidence = {}
  for (const key of ['lastDoneAt', 'lastPromptAt', 'lastEventAt', 'stateSince', 'sessionStartedAt', 'sessionEndedAt', 'blockedSince'] as const) {
    const n = value[key]
    if (typeof n === 'number' && Number.isFinite(n) && n >= 0) out[key] = n
  }
  if (typeof value.lastDoneClean === 'boolean') out.lastDoneClean = value.lastDoneClean
  if (['permission', 'question', 'elicitation', 'input'].includes(value.blockedKind ?? '')) out.blockedKind = value.blockedKind
  if (typeof value.blockedDetail === 'string') out.blockedDetail = value.blockedDetail.slice(0, 240)
  if (typeof value.transcriptPath === 'string') out.transcriptPath = value.transcriptPath
  return out
}
