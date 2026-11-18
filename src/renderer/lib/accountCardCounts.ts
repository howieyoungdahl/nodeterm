import type { ClaudeAccount, ObservedClaudeAccount } from '@shared/types'
import { externalProfileId, type ExternalUsageProfile } from '@shared/external-profile'
import { configDirsMatch, normalizeConfigDirForCompare, resolveObserved } from './accountChip'

/**
 * Which cards run on which Claude login, for the usage panel: each account row says how many of
 * the canvas's cards are spending it, and a profile the canvas sees in use but has no usage row
 * for (a `CLAUDE_CONFIG_DIR=~/.claude-3` pane with nothing configured) is listed instead of
 * silently missing from the overview.
 *
 * The source is the account each running session was OBSERVED on (its hooks), re-resolved against
 * the live account list exactly as the node chip is. A card with no observation is not counted:
 * the panel cannot say whose limit it spends. Display only.
 */
export interface AccountCardCounts {
  /** The system default account (`~/.claude`). */
  system: number
  /** Managed or linked account id, or an external profile's `ext:` id → card count. */
  byId: Record<string, number>
  /** Observed config dirs with no row in the panel, most cards first. */
  unconfigured: { configDir: string; count: number }[]
}

export function countCardsByAccount(
  nodeIds: readonly string[],
  observedOf: (nodeId: string) => ObservedClaudeAccount | undefined,
  accounts: readonly ClaudeAccount[],
  externalProfiles: readonly ExternalUsageProfile[]
): AccountCardCounts {
  const out: AccountCardCounts = { system: 0, byId: {}, unconfigured: [] }
  const loose = new Map<string, { configDir: string; count: number }>()
  const bump = (id: string) => (out.byId[id] = (out.byId[id] ?? 0) + 1)
  for (const nodeId of new Set(nodeIds)) {
    const observed = resolveObserved(observedOf(nodeId), accounts)
    if (!observed) continue
    if (observed.accountId) {
      bump(observed.accountId)
      continue
    }
    if (observed.known) {
      out.system++
      continue
    }
    const profile = externalProfiles.find(
      (p) => p.provider === 'claude' && configDirsMatch(p.dir, observed.configDir)
    )
    if (profile) {
      bump(externalProfileId(profile))
      continue
    }
    const key = normalizeConfigDirForCompare(observed.configDir)
    if (!key) continue
    const entry = loose.get(key) ?? { configDir: observed.configDir ?? key, count: 0 }
    entry.count++
    loose.set(key, entry)
  }
  out.unconfigured = [...loose.values()].sort(
    (a, b) => b.count - a.count || a.configDir.localeCompare(b.configDir)
  )
  return out
}

/** "3 cards" / "1 card"; empty for none, so an idle account row stays as it was. */
export function cardCountText(n: number | undefined): string {
  if (!n) return ''
  return n === 1 ? '1 card' : `${n} cards`
}
