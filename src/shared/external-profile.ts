// A profile directory the usage panel READS, without adopting it as a managed account.
//
// Why this is not a `ClaudeAccount` / `CodexAccount`: those records mean "nodeterm minted this
// directory and can launch sessions into it", and every consumer assumes exactly that — the
// account pickers, node chips, the spawn env injection, the agent-status mirror, and (on the
// Codex side) the per-account daemon and app-server socket. Filing an existing profile like
// `~/.claude-2` under one of those records would make every one of them offer a launch path
// that does not exist, and would put the directory in reach of `remove()` — which is an
// `fs.rm(…, { recursive: true, force: true })` (claude-accounts-service.ts, codex-accounts.ts).
//
// A row here is display-only BY CONSTRUCTION: nothing is ever written to it, launched from it,
// or deleted. That is the whole safety argument for pointing one at a profile the user already
// has. The type is deliberately narrow for the same reason — there is no field a future caller
// could widen into a launch or a delete without changing this file.
//
// Import-safe from `src/core` AND `src/renderer`: it pulls in nothing, so the settings UI can
// key its rows off `externalProfileId` without dragging node path machinery into the bundle.

/**
 * Which provider's credential the directory holds. The two are read by different code paths
 * (`usage-service` for Claude, the shells' `codexAccounts()` for Codex) but share one settings
 * list so the panel and its settings page have a single notion of "an extra profile".
 */
export type ExternalProfileProvider = 'claude' | 'codex'

/**
 * One profile directory to read usage from.
 *
 * `dir` is an absolute path to a directory the user already owns — `~/.claude-2`, `~/.codex-2`.
 * It is validated at READ time, not only when it is saved: the settings file is hand-editable,
 * so a write-time check would be a check on the wrong event.
 */
export interface ExternalUsageProfile {
  provider: ExternalProfileProvider
  /** Absolute path to the profile directory. */
  dir: string
  /** Display label; the settings UI defaults it to the directory's basename. */
  label: string
}

/**
 * The id one profile is addressed by, in the usage service and in React keys.
 *
 * Prefixed with `ext:` on purpose: a managed account id is a UUID, and `:` is outside the
 * alphabet `ACCOUNT_ID_RE` allows, so an external profile id can never collide with a real
 * account id — and can never be mistaken for one by a path builder that validates its input.
 */
export function externalProfileId(profile: Pick<ExternalUsageProfile, 'provider' | 'dir'>): string {
  return `ext:${profile.provider}:${profile.dir}`
}

/**
 * Whether a string is usable as a profile directory at all, judged WITHOUT touching the
 * filesystem — so the settings UI can give immediate feedback and core can reject the obvious
 * cases before any read. The authoritative check (is it a real directory? is it under `$HOME`?)
 * is core-side; see `core/usage/external-profile-dir.ts`.
 *
 * Absolute-only is the load-bearing rule here: a relative path would resolve against whatever
 * the process's cwd happens to be, which differs between the desktop app and the Server Edition.
 */
export function isPlausibleProfileDir(dir: unknown): dir is string {
  if (typeof dir !== 'string') return false
  const trimmed = dir.trim()
  if (!trimmed) return false
  // POSIX absolute, or a Windows drive/UNC path. Both platforms ship this app.
  if (trimmed.startsWith('/')) return true
  return /^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith('\\\\')
}

/** The label a profile falls back to — the directory's own name — or the raw path if it has none. */
export function defaultProfileLabel(dir: string): string {
  const parts = dir.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || dir
}
