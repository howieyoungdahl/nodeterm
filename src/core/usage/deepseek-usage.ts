// DeepSeek prepaid balance.
//
// DeepSeek publishes no usage windows. The only number its API exposes is the account's
// BALANCE (`GET /user/balance`), so this provider reports money rather than a percentage and the
// row renders an amount instead of a bar — see `UsageLimit.amountText`.
//
// Where the key comes from: opencode's own credential store. DeepSeek is driven through opencode
// here, and there is no `deepseek` CLI holding a home of its own, so opencode's `auth.json` is the
// canonical home of the key rather than a second copy of one kept somewhere else.
//
// That is worth stating plainly, because `gemini-usage.ts` deliberately REFUSES to look in this
// same file: a Google token also lives natively in `~/.gemini`, so scanning opencode's store for
// one would mean reading another application's credentials to learn something already on disk.
// Here the situation is the mirror image — reading it is the only way to know, and refusing would
// mean showing nothing. Read-only, like every provider here: we never write or refresh the key.
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import type { ProviderUsage, UsageLimit } from '../../shared/types'

const BALANCE_URL = 'https://api.deepseek.com/user/balance'
const FETCH_TIMEOUT_MS = 8000

/** The provider id opencode files this key under. */
const OPENCODE_PROVIDER_ID = 'deepseek'

/** Currencies we can prefix with a symbol; anything else prints its code instead. */
const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: '$',
  CNY: '¥',
  EUR: '€',
  GBP: '£',
  JPY: '¥'
}

/**
 * opencode's data directory. `OPENCODE_DATA_HOME` wins (the same escape hatch the other
 * fetchers give their CLI), then XDG, then the platform default — macOS keeps it under
 * Application Support rather than `~/.local/share`.
 */
export function opencodeDataHome(): string {
  const override = process.env.OPENCODE_DATA_HOME?.trim()
  if (override) return override
  const xdg = process.env.XDG_DATA_HOME?.trim()
  if (xdg) return path.join(xdg, 'opencode')
  return process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support', 'opencode')
    : path.join(os.homedir(), '.local', 'share', 'opencode')
}

/**
 * The DeepSeek API key from opencode's `auth.json`, or null. Only the one entry is read: a
 * missing file, a missing provider, a non-`api` entry (an OAuth record, say) and a malformed
 * value all mean "nothing to show" rather than an error the user cannot act on.
 */
export async function readDeepseekKey(home = opencodeDataHome()): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(home, 'auth.json'), 'utf-8')
    const j = JSON.parse(raw) as Record<string, any>
    const entry = j?.[OPENCODE_PROVIDER_ID] as Record<string, any> | undefined
    if (!entry || entry.type !== 'api') return null
    const key = entry.key
    return typeof key === 'string' && key.trim() ? key.trim() : null
  } catch {
    return null
  }
}

export interface DeepseekBalance {
  currency: string
  totalBalance: string
  grantedBalance: string | null
  toppedUpBalance: string | null
}

export interface DeepseekBalancePayload {
  isAvailable: boolean
  balances: DeepseekBalance[]
}

/**
 * Amounts are strings on the wire (`"110.00"`). Validate the shape before it reaches the DOM:
 * this is a remote payload rendered as text, and a value that is not a plain number would print
 * as nonsense. Rejecting it drops the row rather than showing a fabricated figure.
 */
function isAmount(v: unknown): v is string {
  return typeof v === 'string' && /^-?\d+(?:\.\d+)?$/.test(v.trim())
}

function optionalAmount(v: unknown): string | null {
  return isAmount(v) ? v.trim() : null
}

/**
 * Parse the balance response. Returns null when the payload is not the documented shape — the
 * caller turns that into 'error', because a key that authenticates but yields nothing readable
 * means the contract moved, not that the account is empty.
 */
export function parseDeepseekBalance(data: unknown): DeepseekBalancePayload | null {
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, any>
  if (typeof d.is_available !== 'boolean') return null
  if (!Array.isArray(d.balance_infos)) return null

  const balances: DeepseekBalance[] = []
  for (const raw of d.balance_infos) {
    if (!raw || typeof raw !== 'object') continue
    const b = raw as Record<string, any>
    const currency = typeof b.currency === 'string' ? b.currency.trim().toUpperCase() : ''
    if (!currency || !isAmount(b.total_balance)) continue
    balances.push({
      currency,
      totalBalance: b.total_balance.trim(),
      grantedBalance: optionalAmount(b.granted_balance),
      toppedUpBalance: optionalAmount(b.topped_up_balance)
    })
  }
  return { isAvailable: d.is_available, balances }
}

/** `$12.40`, or `12.40 CHF` for a currency with no symbol we know. */
export function formatAmount(currency: string, amount: string): string {
  const symbol = CURRENCY_SYMBOLS[currency]
  return symbol ? `${symbol}${amount}` : `${amount} ${currency}`
}

/**
 * One balance entry → a limit. `usedPercent` is 0 and never displayed: a balance has no
 * denominator, and `amountText` is what the row and the pill actually render.
 *
 * A single balance is titled "Balance"; several (DeepSeek reports one per currency) are titled
 * by currency instead, so two rows never print the same heading with different numbers under it.
 */
export function mapDeepseekBalances(payload: DeepseekBalancePayload): UsageLimit[] {
  const multi = payload.balances.length > 1
  return payload.balances.map((b) => ({
    kind: 'balance',
    group: null,
    usedPercent: 0,
    severity: null,
    resetsAt: null,
    windowMinutes: null,
    scopeLabel: multi ? b.currency : null,
    isActive: false,
    amountText: formatAmount(b.currency, b.totalBalance),
    noteText: payload.isAvailable ? null : 'Insufficient for API calls'
  }))
}

function snapshot(limits: UsageLimit[], status: ProviderUsage['status']): ProviderUsage {
  return { provider: 'deepseek', limits, account: null, updatedAt: Date.now(), status }
}

/**
 * DeepSeek balance. Never rejects — no key, a revoked key and an unreachable API are all "we
 * don't know", which the UI renders as no data rather than an error nobody can act on.
 */
export async function fetchDeepseekUsage(home = opencodeDataHome()): Promise<ProviderUsage> {
  try {
    const key = await readDeepseekKey(home)
    if (!key) return snapshot([], 'unavailable')

    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
    const res = await fetch(BALANCE_URL, {
      headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
      signal: ctrl.signal
    }).finally(() => clearTimeout(t))

    // A key that no longer authenticates is "nothing to show", not a failure worth alarming over.
    if (res.status === 401 || res.status === 403) return snapshot([], 'unavailable')
    if (!res.ok) return snapshot([], 'error')

    const payload = parseDeepseekBalance(await res.json())
    // Authenticated but unreadable: the response shape moved. Report it rather than showing an
    // empty row that would read as "no balance".
    if (!payload || payload.balances.length === 0) return snapshot([], 'error')

    return snapshot(mapDeepseekBalances(payload), 'ok')
  } catch {
    return snapshot([], 'error')
  }
}
