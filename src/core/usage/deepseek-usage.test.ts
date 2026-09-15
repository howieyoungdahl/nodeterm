import { describe, it, expect, vi, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  fetchDeepseekUsage,
  formatAmount,
  mapDeepseekBalances,
  opencodeDataHome,
  parseDeepseekBalance,
  readDeepseekKey
} from './deepseek-usage'

/** The documented `GET /user/balance` response. */
const RESPONSE = {
  is_available: true,
  balance_infos: [
    { currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' }
  ]
}

function tmpHome(entry?: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepseek-'))
  if (entry !== undefined) fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify(entry))
  return dir
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('readDeepseekKey', () => {
  it('reads the api key from opencode\'s store', async () => {
    const dir = tmpHome({ deepseek: { type: 'api', key: 'sk-abc' } })
    await expect(readDeepseekKey(dir)).resolves.toBe('sk-abc')
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('ignores an entry that is not an api key', async () => {
    // An OAuth record shares the provider slot but carries no `key` to send as a bearer.
    const dir = tmpHome({ deepseek: { type: 'oauth', access: 'tok' } })
    await expect(readDeepseekKey(dir)).resolves.toBeNull()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('reads only its own provider, never a sibling entry', async () => {
    const dir = tmpHome({ meta: { type: 'api', key: 'meta-key' } })
    await expect(readDeepseekKey(dir)).resolves.toBeNull()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('returns null for a missing file rather than throwing', async () => {
    const dir = tmpHome()
    await expect(readDeepseekKey(dir)).resolves.toBeNull()
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('parseDeepseekBalance', () => {
  it('parses the documented payload', () => {
    expect(parseDeepseekBalance(RESPONSE)).toEqual({
      isAvailable: true,
      balances: [
        {
          currency: 'CNY',
          totalBalance: '110.00',
          grantedBalance: '10.00',
          toppedUpBalance: '100.00'
        }
      ]
    })
  })

  it('rejects a payload that is not the documented shape', () => {
    // A key that authenticates but returns something else means the contract moved; the caller
    // reports an error rather than an empty row that would read as "no balance".
    expect(parseDeepseekBalance(null)).toBeNull()
    expect(parseDeepseekBalance({ balance_infos: [] })).toBeNull()
    expect(parseDeepseekBalance({ is_available: true, balance_infos: 'nope' })).toBeNull()
  })

  it('refuses an amount that is not a plain number', () => {
    // The value is remote text headed for the DOM — a non-numeric one would print as nonsense.
    const parsed = parseDeepseekBalance({
      is_available: true,
      balance_infos: [{ currency: 'USD', total_balance: 'call us' }]
    })
    expect(parsed?.balances).toEqual([])
  })

  it('drops an entry with no currency', () => {
    const parsed = parseDeepseekBalance({
      is_available: true,
      balance_infos: [{ total_balance: '5.00' }]
    })
    expect(parsed?.balances).toEqual([])
  })
})

describe('formatAmount', () => {
  it('prefixes a known currency with its symbol', () => {
    expect(formatAmount('USD', '12.40')).toBe('$12.40')
    expect(formatAmount('CNY', '110.00')).toBe('¥110.00')
  })

  it('prints the code for a currency it does not know', () => {
    expect(formatAmount('CHF', '12.40')).toBe('12.40 CHF')
  })
})

describe('mapDeepseekBalances', () => {
  it('carries the amount and no percentage', () => {
    const limits = mapDeepseekBalances(parseDeepseekBalance(RESPONSE)!)
    expect(limits).toHaveLength(1)
    expect(limits[0].amountText).toBe('¥110.00')
    expect(limits[0].kind).toBe('balance')
    // A balance has no denominator; the row renders amountText and never this.
    expect(limits[0].usedPercent).toBe(0)
    expect(limits[0].resetsAt).toBeNull()
  })

  it('leaves a single balance untitled by currency', () => {
    const limits = mapDeepseekBalances(parseDeepseekBalance(RESPONSE)!)
    expect(limits[0].scopeLabel).toBeNull()
  })

  it('titles each row by currency when several are reported', () => {
    // Two rows headed "Balance" with different numbers under them would be unreadable.
    const limits = mapDeepseekBalances(
      parseDeepseekBalance({
        is_available: true,
        balance_infos: [
          { currency: 'USD', total_balance: '5.00' },
          { currency: 'CNY', total_balance: '30.00' }
        ]
      })!
    )
    expect(limits.map((l) => l.scopeLabel)).toEqual(['USD', 'CNY'])
    expect(limits.map((l) => l.amountText)).toEqual(['$5.00', '¥30.00'])
  })

  it('flags a balance too low to call the API', () => {
    const limits = mapDeepseekBalances({ isAvailable: false, balances: [{ currency: 'USD', totalBalance: '0.00', grantedBalance: null, toppedUpBalance: null }] })
    expect(limits[0].noteText).toBe('Insufficient for API calls')
  })

  it('has no note on a healthy balance', () => {
    const limits = mapDeepseekBalances(parseDeepseekBalance(RESPONSE)!)
    expect(limits[0].noteText).toBeNull()
  })
})

describe('fetchDeepseekUsage', () => {
  it('reports unavailable when no key is stored, without touching the network', async () => {
    const dir = tmpHome()
    await expect(fetchDeepseekUsage(dir)).resolves.toMatchObject({
      provider: 'deepseek',
      status: 'unavailable',
      limits: []
    })
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('reports the balance when the key authenticates', async () => {
    const dir = tmpHome({ deepseek: { type: 'api', key: 'sk-abc' } })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify(RESPONSE), { status: 200 }))
    )
    const usage = await fetchDeepseekUsage(dir)
    expect(usage.status).toBe('ok')
    expect(usage.limits[0].amountText).toBe('¥110.00')
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('treats a revoked key as nothing to show, not an error', async () => {
    const dir = tmpHome({ deepseek: { type: 'api', key: 'sk-dead' } })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })))
    await expect(fetchDeepseekUsage(dir)).resolves.toMatchObject({ status: 'unavailable' })
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('reports an error when the response shape moved', async () => {
    // Authenticated and 200, but nothing parseable — a broken reader must look broken rather
    // than showing an empty row indistinguishable from "no balance".
    const dir = tmpHome({ deepseek: { type: 'api', key: 'sk-abc' } })
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })))
    await expect(fetchDeepseekUsage(dir)).resolves.toMatchObject({ status: 'error' })
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('opencodeDataHome', () => {
  it('honours OPENCODE_DATA_HOME over XDG', () => {
    const prev = { a: process.env.OPENCODE_DATA_HOME, b: process.env.XDG_DATA_HOME }
    process.env.OPENCODE_DATA_HOME = '/tmp/custom-opencode'
    process.env.XDG_DATA_HOME = '/tmp/xdg'
    expect(opencodeDataHome()).toBe('/tmp/custom-opencode')
    if (prev.a === undefined) delete process.env.OPENCODE_DATA_HOME
    else process.env.OPENCODE_DATA_HOME = prev.a
    if (prev.b === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = prev.b
  })
})
