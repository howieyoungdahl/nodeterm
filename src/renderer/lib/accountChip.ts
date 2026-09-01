import type { ClaudeAccount, ObservedClaudeAccount } from '@shared/types'
import { accountChipLabel, systemAccountDisplay } from '../state/workspace'

/**
 * Per-node Claude account labelling — the pure half of the account chip (plan §5 WP-B.2,
 * decisions D5–D7).
 *
 * A node's account has TWO possible sources and they routinely disagree:
 *  - `data.accountId` — the managed/linked account the node was CREATED with. Immutable, and the
 *    only thing that steers `CLAUDE_CONFIG_DIR` at spawn.
 *  - `ObservedClaudeAccount` — what the RUNNING session's hooks reported (agent-status store).
 *    For a plain terminal where the user ran `export CLAUDE_CONFIG_DIR=~/.claude-2; claude`, this
 *    is the only identity that exists anywhere.
 *
 * Everything here is pure and display/read-only. An observed account is a LABEL (see the
 * `ObservedClaudeAccount` doc comment in shared/types): it may decide what we SHOW and whose
 * transcripts we READ, never what is permitted — so nothing in this module is a gate.
 *
 * PASS THE LIVE `accounts` LIST AT EVERY CALL SITE. It is optional only so the parameter could be
 * added without touching every caller, and the default `[]` is not "don't resolve" — it means "no
 * accounts exist", which is a real state (the user just unlinked their only one) and makes
 * `resolveObserved` degrade every observed id to its bare dir. Omitting it therefore reads as
 * "every account was removed", which is exactly wrong in the one case it matters.
 */

/** The account key for the system default (`~/.claude`), which has no `ClaudeAccount` record. */
export const SYSTEM_ACCOUNT_KEY = 'sys'

/** Chip labels are ~one word wide; the same cap `accountChipLabel` applies to a managed label. */
const MAX_CHIP_LABEL = 10

/** `systemAccountDisplay`'s generic fallback, mirrored so the chip can recognise "there is no
 *  identity here to shorten" (see `accountChipFor`). */
const GENERIC_SYSTEM_DISPLAY = 'System account'

/**
 * Is this path string Windows-shaped? The owning filesystem is NOT known here — a config dir may
 * come from this machine, an SSH host, or Windows — so the shape of the string decides, rather
 * than treating `/` and `\` as interchangeable: on POSIX a backslash is legal filename text
 * (CONTRIBUTING). A drive letter, a UNC prefix, or backslashes with no forward slash is Windows.
 */
function isWindowsShapedPath(dir: string): boolean {
  return (
    /^[a-zA-Z]:[\\/]/.test(dir) ||
    dir.startsWith('\\\\') ||
    (dir.includes('\\') && !dir.includes('/'))
  )
}

/**
 * The comparable form of a config dir. ONE function, used on BOTH sides of every config-dir
 * comparison in this module (CONTRIBUTING: "normalize BOTH sides of a path comparison, through one
 * function" — the half-normalized version of this is issue #558).
 *
 * Trims, drops trailing separators, and — only for a Windows-shaped path — folds separators to `\`
 * and lowercases, because Windows paths are case-insensitive and `C:/x` and `C:\x` name the same
 * dir. A POSIX path is left case- and backslash-sensitive, because there both are significant.
 *
 * This is a LABEL comparison (which account name to show, whose transcripts to read); the jail and
 * every real permission check live in core and are unaffected by it.
 */
export function normalizeConfigDirForCompare(dir: string | undefined | null): string {
  const trimmed = (dir ?? '').trim()
  if (!trimmed) return ''
  const windows = isWindowsShapedPath(trimmed)
  let out = windows ? trimmed.replace(/\//g, '\\') : trimmed
  const sep = windows ? '\\' : '/'
  while (out.length > 1 && out.endsWith(sep)) out = out.slice(0, -1)
  return windows ? out.toLowerCase() : out
}

/** Do these two config dirs name the same directory? Empty never matches — an absent `configDir`
 *  (every managed account has none) must not collide with an unlinked observation. */
export function configDirsMatch(a: string | undefined | null, b: string | undefined | null): boolean {
  const left = normalizeConfigDirForCompare(a)
  return !!left && left === normalizeConfigDirForCompare(b)
}

/**
 * Re-resolve an observation against the CURRENT account list.
 *
 * The hook server classifies `transcript_path` at POST time, so an observation is frozen as of the
 * account list that existed then — and nothing else would ever revisit it: a quiet pane may not
 * post another hook for hours. Linking and unlinking are settings edits, so the renderer is the
 * only place that can notice, and this is where it does. Everything else in this module goes
 * through it, so the chip, the keys, the detected list and the readers cannot disagree about the
 * same dir.
 *
 * Two directions, and both are about the DIR, which is the one fact that outlives the record:
 *  - unknown dir + an account now claiming it  ⇒ that account (the link case);
 *  - a known id that no longer exists          ⇒ back to the bare dir, `known: false` (the unlink
 *    or remove case). Without this the pane showed "Unknown account" and its dir vanished from
 *    Settings → Detected, so there was no way back to Link short of waiting for the next turn.
 *    A re-link under a NEW id is picked up by the same dir match, hence one code path.
 *
 * The system account (`known` with `accountId: null`) is never touched: it has no record to lose.
 * `data.accountId` is likewise untouched — a NODE created under a removed account still reads
 * "Unknown account", which is correct: that binding really is dangling.
 */
export function resolveObserved(
  observed: ObservedClaudeAccount | undefined,
  accounts: readonly ClaudeAccount[] = []
): ObservedClaudeAccount | undefined {
  if (!observed) return observed
  if (observed.known) {
    if (!observed.accountId) return observed // the system default — nothing to lose
    if (accounts.some((a) => a.id === observed.accountId)) return observed
    // The id is gone (unlinked/removed since the observation). Fall back to the dir — unless there
    // is none, in which case there is nothing better to say than the id we already have.
    if (!observed.configDir) return observed
    const relinked = accounts.find((a) => configDirsMatch(a.configDir, observed.configDir))
    return relinked
      ? { ...observed, accountId: relinked.id, known: true }
      : { ...observed, accountId: null, known: false }
  }
  if (!observed.configDir) return observed
  const match = accounts.find((a) => configDirsMatch(a.configDir, observed.configDir))
  return match ? { ...observed, accountId: match.id, known: true } : observed
}

/**
 * D5 — the account a node's READERS (transcript root, session name, context meter, ⌘M chat) must
 * use: the node's own account when it has one, else whatever the session was observed running as.
 *
 * `known` is what makes the observed id meaningful: an unrecognised config dir reports
 * `accountId: null`, and must resolve to `undefined` (→ the system account's readers) rather than
 * to some other account's transcripts. Deliberately NOT used for spawn/env — launch identity stays
 * creation-time.
 */
export function effectiveAccountId(
  dataAccountId?: string,
  observed?: ObservedClaudeAccount,
  /** The current account list, so a dir linked SINCE the observation resolves to its account
   *  without waiting for the pane's next hook event (see `resolveObserved`). */
  accounts: readonly ClaudeAccount[] = []
): string | undefined {
  if (dataAccountId) return dataAccountId
  const known = resolveObserved(observed, accounts)
  if (known?.known && known.accountId) return known.accountId
  return undefined
}

/**
 * D6 — the identity key a node counts as, for "is more than one account in play?".
 *
 *  - `<accountId>` — a managed or linked account (from the node, or observed);
 *  - `'sys'`       — the system default (`~/.claude`), which has no id of its own;
 *  - `ext:<dir>`   — a config dir nodeterm has no record of, keyed by its path because that is the
 *                    only thing that tells two unlinked dirs apart;
 *  - `null`        — nothing is known about this node's account. NOT a key: an unobserved plain
 *                    terminal must not count as a second identity (it would put a chip on every
 *                    system pane the moment one shell was opened), and it gets no chip.
 */
export function accountKey(
  dataAccountId?: string,
  observed?: ObservedClaudeAccount,
  /** See `resolveObserved`: a dir linked since the observation keys as its ACCOUNT, so the linked
   *  pane and a node created under that account count as one identity, not two. */
  accounts: readonly ClaudeAccount[] = []
): string | null {
  if (dataAccountId) return dataAccountId
  const resolved = resolveObserved(observed, accounts)
  if (!resolved) return null
  if (resolved.known) return resolved.accountId ?? SYSTEM_ACCOUNT_KEY
  // A `known: false` entry with no dir is not evidence of anything — it names no identity, so it
  // cannot be a distinct key (degrade to nothing, never to something wrong).
  return resolved.configDir ? `ext:${resolved.configDir}` : null
}

/** The distinct account keys across a set of nodes (see `accountKey`); unknown nodes contribute
 *  nothing. `size >= 2` is D6's "there's multiple". */
export function distinctAccountKeys(
  entries: Iterable<{ dataAccountId?: string; observed?: ObservedClaudeAccount }>,
  accounts: readonly ClaudeAccount[] = []
): Set<string> {
  const keys = new Set<string>()
  for (const e of entries) {
    const key = accountKey(e.dataAccountId, e.observed, accounts)
    if (key) keys.add(key)
  }
  return keys
}

/**
 * The selector form of `distinctAccountKeys().size >= 2`, over an agent-status table plus THIS
 * node's own `data.accountId`.
 *
 * Returns a PRIMITIVE on purpose (the `usageScopeKey` rule): a chip subscriber runs this on every
 * hook event of every node, and a Set/array result would give each of them fresh props and
 * re-render every node header on an unrelated status edit. Early-exits at two keys.
 *
 * The store only knows OBSERVED accounts, so other nodes' creation-time `data.accountId` is not
 * counted — a managed node that has never posted a hook is invisible here. That is the cheap,
 * store-only reading of D6 and it fails in the safe direction: one chip fewer, never a wrong one.
 */
export function hasMultipleAccountKeys(
  byId: Record<string, { account?: ObservedClaudeAccount }>,
  ownAccountId?: string,
  accounts: readonly ClaudeAccount[] = []
): boolean {
  const keys = new Set<string>()
  const own = accountKey(ownAccountId, undefined, accounts)
  if (own) keys.add(own)
  for (const entry of Object.values(byId)) {
    const key = accountKey(undefined, entry.account, accounts)
    if (key) keys.add(key)
    if (keys.size >= 2) return true
  }
  return keys.size >= 2
}

/**
 * The config dirs seen running on this core that nodeterm has no account for — Settings →
 * Accounts lists these as one-click "Link" candidates (D7).
 *
 * Derived from OBSERVATIONS only: a dir gets in here because a session posted a hook from it, so
 * the list is a record of what actually ran, and nothing here reads the filesystem (a forged POST
 * must not make us stat anything).
 *
 * Membership is decided by `resolveObserved` — the SAME resolution the chip uses — so a dir can
 * never be both "belongs to an account" (chipped as linked) and "detected" (offered for linking),
 * in either direction: linking removes it from this list at once, and unlinking puts it back at
 * once, with no hook event in between.
 */
export function unlinkedConfigDirs(
  byId: Record<string, { account?: ObservedClaudeAccount }>,
  accounts: readonly ClaudeAccount[] = []
): string[] {
  const dirs = new Set<string>()
  for (const entry of Object.values(byId)) {
    const a = resolveObserved(entry.account, accounts)
    if (!a || a.known || !a.configDir) continue
    dirs.add(a.configDir)
  }
  // Sorted so the list does not reshuffle itself as unrelated nodes come and go.
  return [...dirs].sort()
}

export interface AccountChipInfo {
  /** Chip text — one short word. */
  short: string
  /** Native tooltip: the full identity, or (unlinked) what to do about it. */
  tooltip: string
  kind: 'system' | 'managed' | 'linked' | 'unlinked'
}

/** `label` → chip text: the part before `@`, capped with an ellipsis. Same rule as
 *  `accountChipLabel` (which owns it for managed accounts and also builds their tooltip); kept
 *  here for the system/unlinked labels rather than importing a cycle back out of `state/`. */
function shortAccountLabel(label: string): string {
  const base = label.split('@')[0]
  return base.length > MAX_CHIP_LABEL ? `${base.slice(0, MAX_CHIP_LABEL)}…` : base
}

/**
 * Last segment of a config dir path, for an unlinked dir's chip (D7 — named by path, never read).
 *
 * The owning filesystem is NOT known here: the dir string comes from a hook that may have run on
 * this machine, on an SSH host, or on Windows. So the separator is picked from the SHAPE of the
 * string instead of treating both as interchangeable — on POSIX a backslash is legal filename text
 * (CONTRIBUTING: "do not treat both separators as interchangeable unless the owning filesystem is
 * known to be Windows"). A drive letter, a UNC prefix, or backslashes with no forward slash is
 * Windows-shaped; everything else is POSIX-shaped.
 */
export function configDirLabel(configDir: string): string {
  const dir = configDir.trim()
  if (!dir) return ''
  const windowsShaped = isWindowsShapedPath(dir)
  const sep = windowsShaped ? '\\' : '/'
  const parts = dir.split(sep).filter((p) => p.length > 0)
  // A bare root (`/`, `C:\`) has no segment to name; fall back to the whole string so the chip
  // still says something rather than rendering empty.
  return parts[parts.length - 1] ?? dir
}

/**
 * The chip for one node, or `null` for no chip.
 *
 * D6 visibility: a node that is NOT on the system account always gets a chip (it is the exception
 * the user needs to see), and system nodes get one only when `multiple` — i.e. when at least two
 * identities are in play, so two panes side by side are always told apart.
 */
export function accountChipFor({
  dataAccountId,
  observed,
  accounts,
  systemLabel,
  systemEmail,
  multiple
}: {
  dataAccountId?: string
  observed?: ObservedClaudeAccount
  accounts: ClaudeAccount[]
  /** `settings.systemAccountLabel` — the user's own name for the `~/.claude` login. */
  systemLabel?: string
  /** The detected `~/.claude` login email (`state/systemAccount`), when known. */
  systemEmail?: string | null
  /** D6: are ≥ 2 distinct account keys in play on this core? (`hasMultipleAccountKeys`) */
  multiple?: boolean
}): AccountChipInfo | null {
  // Resolved against the CURRENT list: linking a detected dir must repaint every chip on it
  // immediately, not at that pane's next hook event (see `resolveObserved`).
  const key = accountKey(dataAccountId, observed, accounts)
  if (!key) return null // nothing known — no chip, and nothing counted either
  if (key === SYSTEM_ACCOUNT_KEY) {
    if (!multiple) return null // one identity in play: the system pane is the unremarkable case
    const display = systemAccountDisplay(systemLabel, systemEmail)
    return {
      // With neither a custom label nor a detected email the display is the generic "System
      // account", which the 10-char cap turns into "System acc…" — an ellipsis that promises a
      // longer name there isn't one of. Nothing to shorten: say "System".
      short: display === GENERIC_SYSTEM_DISPLAY ? 'System' : shortAccountLabel(display),
      tooltip: `${display} — system Claude account (~/.claude)`,
      kind: 'system'
    }
  }
  if (key.startsWith('ext:')) {
    // D7: named by its path and NEVER read. The tooltip is the whole affordance — it says what the
    // dir is and where to turn it into a real account.
    const dir = key.slice('ext:'.length)
    return {
      short: shortAccountLabel(configDirLabel(dir)),
      tooltip: `Unlinked Claude config dir ${dir} — link it in Settings → Accounts`,
      kind: 'unlinked'
    }
  }
  const label = accountChipLabel(key, accounts)
  if (!label) return null // unreachable: `key` is a non-empty id here
  // A linked account is a dir the user already owned (`ClaudeAccount.configDir`), which is worth
  // showing differently from a managed one: removing it keeps the folder, and it is the identity a
  // hand-launched `claude` will keep using whatever nodeterm does.
  const linked = !!accounts.find((a) => a.id === key)?.configDir
  return { short: label.short, tooltip: label.tooltip, kind: linked ? 'linked' : 'managed' }
}
