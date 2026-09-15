// Core-side validation for an external usage profile's directory.
//
// This is the authoritative check, and it runs at READ time rather than only when the settings
// UI saves a row. `settings.json` is 0600 and not git-shared, but it is hand-editable, and the
// codebase already treats a settings-supplied id as hostile input for exactly this reason
// (`ACCOUNT_ID_RE`'s "a hostile id from a git-shared settings.json can never traverse out of the
// accounts root"). A path deserves the same suspicion an id gets: a write-time check would be a
// check on the wrong event, because the file can change under us between save and read.
//
// What is actually at stake, given the profile is only ever READ: the credential files are
// `{dir}/.credentials.json` (Claude) and `{dir}/auth.json` (Codex). Reading the wrong directory
// means displaying a different account's numbers than the row claims — the same "no mixing"
// property the per-account Codex homes exist to enforce. Confining the path to the user's own
// home, and refusing anything that is not a real directory, is what keeps a row honest about
// whose numbers it is showing.
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import type { ExternalProfileProvider, ExternalUsageProfile } from '../../shared/external-profile'
import { externalProfileId, isPlausibleProfileDir } from '../../shared/external-profile'

export type ProfileDirVerdict =
  | { ok: true; dir: string }
  | { ok: false; reason: string }

/**
 * Whether `dir` may be read for usage, judged WITHOUT touching the filesystem.
 *
 * Deliberately narrow: absolute, already normalized (so no `.`/`..` segments survive to be
 * resolved against a cwd that differs between the desktop app and the Server Edition), and
 * strictly inside `$HOME` — a profile is something the user already has in their own home, and
 * nothing about reading usage needs to reach outside it.
 */
export function checkProfileDir(dir: unknown, home: string = os.homedir()): ProfileDirVerdict {
  if (!isPlausibleProfileDir(dir)) return { ok: false, reason: 'Not an absolute path.' }
  const trimmed = dir.trim()

  // A trailing separator is harmless and common (shell tab-completion adds one).
  const cleaned = trimmed.length > 1 ? trimmed.replace(/[\\/]+$/, '') : trimmed
  if (path.normalize(cleaned) !== cleaned) {
    return { ok: false, reason: 'Path must not contain "." or ".." segments.' }
  }

  const normalizedHome = path.normalize(home)
  if (cleaned === normalizedHome) {
    return { ok: false, reason: 'Point at a profile directory inside your home, not your home itself.' }
  }
  if (!cleaned.startsWith(normalizedHome + path.sep)) {
    return { ok: false, reason: `Profile directories must live inside ${normalizedHome}.` }
  }
  return { ok: true, dir: cleaned }
}

/**
 * Whether the directory exists and is a real directory.
 *
 * `stats.isDirectory()` follows symlinks, which is intended: `~/.claude-2` is commonly reached
 * through one, and refusing a symlinked profile would reject working setups for no gain — the
 * path is read-only, so there is nothing a symlink could redirect into a write.
 */
export async function profileDirExists(dir: string): Promise<boolean> {
  try {
    return (await fs.stat(dir)).isDirectory()
  } catch {
    return false
  }
}

/** One row the usage service can fetch, from one settings entry. */
export interface ResolvedExternalProfile {
  id: string
  dir: string
  label: string
  provider: ExternalProfileProvider
}

/**
 * External Codex profiles shaped as usage-service rows — byte-identical to what
 * `codexUsageAccounts` produces for a managed account, so the service treats both kinds the same
 * way and the only difference is where the home came from.
 *
 * `fetchCodexUsage(home, identity)` already takes the home as an argument, so this is the WHOLE
 * Codex-side change: no spawn, no daemon, no socket derivation, no migration sweep, and no
 * `remove()` anywhere near a directory nodeterm did not mint.
 */
export function externalCodexUsageAccounts(
  entries: readonly ExternalUsageProfile[] | undefined,
  home: string = os.homedir()
): Array<{ id: string; home: string; label: string; email?: string | null }> {
  return resolveExternalProfiles(entries, 'codex', home).map((p) => ({
    id: p.id,
    home: p.dir,
    label: p.label,
    email: null
  }))
}

/**
 * Turn the settings list into fetchable rows for ONE provider, dropping anything that fails
 * validation. Never throws — a malformed settings list must not take the usage sweep down with
 * it, the same fail-closed rule `codexAccounts()` follows.
 *
 * Two entries naming the same directory collapse to one row: they would carry the same id, and
 * rendering the same numbers twice under two labels would misstate how many accounts there are.
 */
export function resolveExternalProfiles(
  entries: readonly ExternalUsageProfile[] | undefined,
  provider: ExternalProfileProvider,
  home: string = os.homedir()
): ResolvedExternalProfile[] {
  const out: ResolvedExternalProfile[] = []
  const seen = new Set<string>()
  for (const entry of entries ?? []) {
    if (!entry || entry.provider !== provider) continue
    const verdict = checkProfileDir(entry.dir, home)
    if (!verdict.ok) continue
    const label =
      typeof entry.label === 'string' && entry.label.trim() ? entry.label.trim() : undefined
    const id = externalProfileId({ provider, dir: verdict.dir })
    if (seen.has(id)) continue
    seen.add(id)
    out.push({
      id,
      dir: verdict.dir,
      label: label ?? verdict.dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? verdict.dir,
      provider
    })
  }
  return out
}
