// Resolve a Claude account's config dir under this app's persistent state root — or, for a LINKED
// account, the pre-existing dir the user already owns (`ClaudeAccount.configDir`, design D4).
// The account LIST + login lifecycle live in main/claude-accounts.ts; this is just the
// impure path resolution (needs the platform seam for userDataDir) split out so core
// modules (pty-manager, etc.) can use it without importing electron.
//
// The linked half needs the account LIST, which core does not own — the settings store lives in
// each shell. So each shell REGISTERS a getter at boot (`registerClaudeAccountsSource`) and every
// account-aware reader keeps calling the one resolver it already called. One registration point
// rather than threading the list through pty-manager, the usage service, the transcript readers
// and both jails: a second copy of "where does this account's config live?" is exactly the drift
// CLAUDE.md warns about, and the answer moved for linked accounts.
import { platform } from './platform'
import { accountConfigDir, normalizeLinkedConfigDir } from './claude-accounts-core'
import type { ClaudeAccount } from '../shared/types'

let accountsSource: (() => readonly ClaudeAccount[]) | undefined

/**
 * Register the shell's settings-backed account list. Called once at boot by BOTH shells
 * (`src/main/index.ts`, `src/server/index.ts`). Unregistered — a unit test, or a boot path that
 * runs before settings exist — means "no linked accounts", i.e. bit-for-bit the managed-only
 * behavior that predates this file's linked branch.
 */
export function registerClaudeAccountsSource(fn: () => readonly ClaudeAccount[]): void {
  accountsSource = fn
}

/** Drop the registration (tests only — the singleton outlives a test file otherwise). */
export function resetClaudeAccountsSourceForTests(): void {
  accountsSource = undefined
}

/**
 * The registered account list, or `[]`. Never throws: this is read on the hook-event hot path and
 * from both jails, and a settings store that throws mid-read must not take a 204 (or a transcript
 * read) down with it. A failed read yields "no linked accounts", which is the safe direction — it
 * can only make a dir read as unknown, never widen a jail.
 */
export function claudeAccountsSnapshot(): readonly ClaudeAccount[] {
  try {
    return accountsSource?.() ?? []
  } catch {
    return []
  }
}

/**
 * A linked account's validated config dir, or null when the id names no linked account. The value
 * is re-validated (absolute, normalized, no `..`) at THIS point of use — it comes from a
 * hand-editable settings.json — and an unusable one yields null, which sends every caller back to
 * the managed path (§3: "never something more destructive than the default").
 */
export function linkedClaudeConfigDirFor(accountId: string): string | null {
  for (const a of claudeAccountsSnapshot()) {
    if (a.id !== accountId || a.host || a.pending) continue
    return normalizeLinkedConfigDir(a.configDir)
  }
  return null
}

/**
 * Every linked account's config dir, for the two raw listeners' transcript jails. Local, settled
 * and re-validated (see above); deduped, because a hand-edited settings.json can name the same dir
 * twice and a duplicated jail root is a duplicated string compare, not a second permission.
 */
export function linkedClaudeConfigDirs(): string[] {
  const out: string[] = []
  for (const a of claudeAccountsSnapshot()) {
    if (a.host || a.pending) continue
    const dir = normalizeLinkedConfigDir(a.configDir)
    if (dir && !out.includes(dir)) out.push(dir)
  }
  return out
}

export function claudeConfigDirFor(accountId: string): string {
  // The managed path is resolved FIRST even for a linked account, because `accountConfigDir` is
  // what validates the id alphabet and it must stay the one gate: a hand-edited row pairing a
  // traversing id with a linked dir must not become the single place that id escapes the check
  // (every other path builder — local and remote — keys off the same alphabet).
  const managed = accountConfigDir(platform().userDataDir, accountId)
  return linkedClaudeConfigDirFor(accountId) ?? managed
}
