import path from 'path'
import { homedir } from 'os'
import { codexHome } from './usage/codex-usage'
import { codexHomeFor } from './codex-config-dir'
import { LOCAL_SECOND_CODEX_SCOPE } from '../shared/codex-account'
import { identityCandidates } from './codex-identity-proxy'

/** Reserved record scope for the operator's second local login, never a guessed account. */
export const SECOND_CODEX_HOME_SCOPE = LOCAL_SECOND_CODEX_SCOPE

export function resolveCodexHomeRouting(requested?: string, accountId?: string): {
  home: string; accountId?: string; socket: string
} {
  const primary = codexHome()
  const secondary = path.join(homedir(), '.codex-2')
  const home = requested || (accountId === SECOND_CODEX_HOME_SCOPE ? secondary : accountId ? codexHomeFor(accountId) : primary)
  let scope = accountId
  if (home === secondary) scope = SECOND_CODEX_HOME_SCOPE
  else if (home === primary || home === path.join(homedir(), '.codex')) scope = undefined
  else if (!accountId || accountId === SECOND_CODEX_HOME_SCOPE || home !== codexHomeFor(accountId)) {
    throw new Error('Unsupported Codex home')
  }
  return { home, accountId: scope, socket: path.join(home, 'app-server-control', 'app-server-control.sock') }
}

/** A hook path never expands the jail. Only an exact signed node/thread owner selects a root. */
export function observedCodexHome(nodeId: string, sessionId: unknown): {
  home: string; accountId?: string
} | undefined {
  if (typeof sessionId !== 'string') return undefined
  try {
    const candidates = identityCandidates(sessionId)
    if (candidates.length !== 1 || candidates[0].identity.nodeId !== nodeId) return undefined
    return resolveCodexHomeRouting(undefined, candidates[0].scope === 'system' ? undefined : candidates[0].scope)
  } catch { return undefined } // Unavailable evidence never widens the transcript jail.
}

export function isBoundCodexTranscript(nodeId: string, sessionId: unknown, transcript: unknown): boolean {
  if (typeof transcript !== 'string') return false
  const owner = observedCodexHome(nodeId, sessionId)
  if (!owner) return false
  const root = path.join(owner.home, 'sessions')
  const abs = path.resolve(transcript)
  return abs.startsWith(root + path.sep) && path.basename(abs).endsWith(`-${sessionId}.jsonl`)
}
