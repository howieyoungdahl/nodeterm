// Pure formatting helpers for the usage indicator.

import type { UsageLimit } from '@shared/types'
import { limitShortLabel } from '@shared/usage-limits'

/** "just now" / "5m ago" / "2h ago". */
export function formatTimeAgo(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return 'just now'
  const mins = Math.floor(diff / 60_000)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  return `${hours}h ago`
}

/** "Resets now" / "Resets in 1h 2m" / "Resets in 2d 4h". */
export function formatResetCountdown(resetsAt: number | null): string {
  if (resetsAt == null) return ''
  const ms = resetsAt - Date.now()
  if (ms <= 0) return 'Resets now'
  const totalMins = Math.floor(ms / 60_000)
  if (totalMins < 60) return `Resets in ${totalMins}m`
  const hours = Math.floor(totalMins / 60)
  const mins = totalMins % 60
  if (hours >= 24) {
    const days = Math.floor(hours / 24)
    const remHours = hours % 24
    return remHours > 0 ? `Resets in ${days}d ${remHours}h` : `Resets in ${days}d`
  }
  return mins > 0 ? `Resets in ${hours}h ${mins}m` : `Resets in ${hours}h`
}

/**
 * Short display label for a Claude model id: "claude-opus-4-8" → "Opus 4.8",
 * "claude-haiku-4-5-20251001" → "Haiku 4.5" (date segments dropped), "claude-3-5-sonnet-…"
 * → "Sonnet 3.5". An id with no known family is returned as-is; null stays null.
 */
export function formatModelLabel(model: string | null): string | null {
  if (!model) return null
  const fam = /(opus|sonnet|haiku|fable|mythos)/i.exec(model)
  if (!fam) return model
  const family = fam[1][0].toUpperCase() + fam[1].slice(1).toLowerCase()
  const version = model
    .split(/[^a-zA-Z0-9]+/)
    .filter((p) => /^\d{1,3}$/.test(p))
    .join('.')
  return version ? `${family} ${version}` : family
}

/**
 * Fill color for a CONTEXT-WINDOW meter: green while low, yellow from 60% used, red past 85%.
 * Keyed to USED percent — the inverse scale of `barColor`/`severityColor`, which are keyed to
 * REMAINING provider quota. The two measure different things and must not share thresholds.
 * One definition for every context surface (ContextMeter, session rows, the notch HUD) — each
 * used to carry its own copy of these numbers (issue #78).
 */
export function contextFillColor(usedPercent: number): string {
  if (usedPercent > 85) return '#ff453a'
  if (usedPercent >= 60) return '#ffd60a'
  return '#30d158'
}

/** Bar color by remaining quota: green > 40%, yellow 20–40%, red < 20%. */
export function barColor(leftPercent: number): string {
  if (leftPercent > 40) return '#30d158'
  if (leftPercent >= 20) return '#ffd60a'
  return '#ff453a'
}

/**
 * Bar color for a usage limit. A provider that ships its own `severity` verdict knows the
 * account's plan and how close the window really is to biting — prefer it, and fall back to
 * our own percentage thresholds when it is null (most providers report none) or a value we
 * don't recognize.
 */
export function severityColor(severity: string | null, leftPercent: number): string {
  switch (severity) {
    case 'normal':
      return '#30d158'
    case 'warning':
      return '#ffd60a'
    case 'critical':
    case 'exceeded':
      return '#ff453a'
    default:
      return barColor(leftPercent)
  }
}

/**
 * The percentage a limit renders as, honouring the used/remaining/tokens display setting.
 * 'tokens' has no meaning for a percent-only surface (provider quota limits carry no raw token
 * count), so it folds to the 'used' wording there — never silently treated as 'remaining'.
 */
export function percentText(usedPercent: number, mode: 'used' | 'remaining' | 'tokens'): string {
  return mode === 'remaining'
    ? `${Math.round(100 - usedPercent)}% left`
    : `${Math.round(usedPercent)}% used`
}

/** Compact form for the pill: the bare number, no suffix (the segment label follows it). */
export function percentNumber(usedPercent: number, mode: 'used' | 'remaining' | 'tokens'): number {
  return Math.round(mode === 'remaining' ? 100 - usedPercent : usedPercent)
}

/**
 * Bar fill, honouring the used/remaining/tokens display setting — the fill tracks the same
 * quantity as the adjacent number, so "92% used" shows a nearly-full bar instead of a
 * barely-visible sliver. 'tokens' fills the same as 'used' (it just relabels the number).
 * Color is a separate call (`severityColor`/`barColor`) keyed to the true remaining percentage,
 * never to this value, so severity red/yellow/green doesn't flip meaning with the mode.
 */
export function barFillPercent(usedPercent: number, mode: 'used' | 'remaining' | 'tokens'): number {
  return mode === 'remaining' ? 100 - usedPercent : usedPercent
}

/**
 * Identifies one collapsible popover section, for the persisted `collapsedUsageSections` list.
 *
 * The kinds are namespaced so they can never collide: a Claude account id and a provider id are
 * both plain strings, and a section that collapsed the WRONG row is a bug whose cause the user
 * cannot see. A remote row carries its host, because the same subscription can be signed in on
 * the desktop and on two servers at once.
 */
export type UsageSectionRef =
  | { kind: 'claude'; accountId?: string | null }
  | { kind: 'remote'; hostKey: string; accountId?: string | null }
  | { kind: 'provider'; provider: string; accountId?: string | null }

export function usageSectionKey(ref: UsageSectionRef): string {
  const id = ref.accountId ?? 'system'
  switch (ref.kind) {
    case 'claude':
      return `claude:${id}`
    case 'remote':
      return `remote:${ref.hostKey}#${id}`
    case 'provider':
      return `provider:${ref.provider}:${id}`
  }
}

/**
 * The one-line reading a COLLAPSED usage section shows in place of its bars: whatever it would
 * have led with had it been open (`primaryLimit` — the same choice the pill makes). Collapsing
 * must not hide an exhausted window behind a chevron, or the panel gets quieter exactly when it
 * has the most to say.
 *
 * A balance row has no percentage to round, so it prints its amount verbatim.
 */
export function limitSummary(
  limit: UsageLimit | null,
  mode: 'used' | 'remaining' | 'tokens'
): string {
  if (!limit) return ''
  if (limit.amountText) return limit.amountText
  return `${percentNumber(limit.usedPercent, mode)}% ${limitShortLabel(limit.kind, limit.scopeLabel)}`
}

/** Humanize a token count: 48000 → "48k", 1_000_000 → "1M", 850 → "850". */
export function formatTokensShort(n: number): string {
  if (n >= 1_000_000) return `${Number((n / 1_000_000).toFixed(1)).toString()}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}

/**
 * Context-window pill text: token fraction in 'tokens' mode ("48k/200k"), else the percent
 * number with no suffix (caller appends "%"). Only context-window surfaces (ContextMeter,
 * SessionRow) have usedTokens/windowTokens to show; nothing else should call this.
 */
export function contextPillText(usedTokens: number, windowTokens: number, usedPercent: number, mode: 'used' | 'remaining' | 'tokens'): string {
  return mode === 'tokens'
    ? `${formatTokensShort(usedTokens)}/${formatTokensShort(windowTokens)}`
    : `${percentNumber(usedPercent, mode)}%`
}
