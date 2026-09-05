import { describe, it, expect } from 'vitest'
import {
  BUILTIN_LAYOUT_RULES,
  layoutEngineEnabled,
  resolveLayoutRules,
  sanitizeCanvasLayoutRules,
  sanitizeCanvasLayoutSettings
} from './canvas-layout-rules'
import { LAYOUT_TRIGGERS } from './canvas-layout'

describe('sanitizeCanvasLayoutRules — project.json is hostile input', () => {
  it('drops a non-object outright', () => {
    for (const value of [null, undefined, 'rules', 7, [], true]) {
      expect(sanitizeCanvasLayoutRules(value)).toBeUndefined()
    }
  })

  it('keeps only recognised values for a known key', () => {
    expect(
      sanitizeCanvasLayoutRules({ spawn: { place: 'tray', size: 'huge' } })
    ).toEqual({ spawn: { place: 'tray' } })
  })

  it('drops a whole known block whose every value is unrecognised, leaving the tier below to answer', () => {
    expect(sanitizeCanvasLayoutRules({ tray: { collapsed: 'yes' } })).toBeUndefined()
  })

  it('records an unknown version and enforces nothing — an older build still renders a newer canvas', () => {
    expect(sanitizeCanvasLayoutRules({ version: 99, tray: { collapsed: false } })).toEqual({
      version: 99,
      tray: { collapsed: false }
    })
  })

  it('keeps only triggers it knows, de-duplicated', () => {
    expect(
      sanitizeCanvasLayoutRules({ triggers: ['organize', 'organize', 'cron', 'node-created'] })
    ).toEqual({ triggers: ['organize', 'node-created'] })
  })

  it('PRESERVES an unknown key verbatim — dropping it is how an older build deletes a newer one’s rules', () => {
    const kept = sanitizeCanvasLayoutRules({
      spawn: { place: 'tray' },
      appearance: { byProvider: { claude: { color: '#0a84ff' } } }
    })
    expect(kept?.unknown).toEqual({ appearance: { byProvider: { claude: { color: '#0a84ff' } } } })
  })

  it('round-trips a preserved key through a second sanitize, so a save cannot erode it', () => {
    const once = sanitizeCanvasLayoutRules({ spawn: { place: 'tray' }, appearance: { x: 1 } })
    const twice = sanitizeCanvasLayoutRules(once)
    expect(twice?.unknown).toEqual({ appearance: { x: 1 } })
  })

  it('never invents an `unknown` block when there is nothing to carry', () => {
    expect(sanitizeCanvasLayoutRules({ spawn: { place: 'none' } })).toEqual({
      spawn: { place: 'none' }
    })
  })
})

describe('sanitizeCanvasLayoutSettings', () => {
  it('reads a boolean `enabled` and nothing else', () => {
    expect(sanitizeCanvasLayoutSettings({ enabled: true })).toEqual({ enabled: true })
    expect(sanitizeCanvasLayoutSettings({ enabled: 'true' })).toBeUndefined()
  })

  it('sanitizes the machine defaults with the same rules as the project block', () => {
    expect(
      sanitizeCanvasLayoutSettings({ enabled: false, defaults: { spawn: { size: 'compact' } } })
    ).toEqual({ enabled: false, defaults: { spawn: { size: 'compact' } } })
  })
})

describe('layoutEngineEnabled — off is the answer that changes nothing', () => {
  it('is false for everything but a literal true', () => {
    expect(layoutEngineEnabled(undefined)).toBe(false)
    expect(layoutEngineEnabled({})).toBe(false)
    expect(layoutEngineEnabled({ enabled: false })).toBe(false)
    expect(layoutEngineEnabled({ enabled: true })).toBe(true)
  })
})

describe('resolveLayoutRules — project > machine > built-in, FIELD BY FIELD', () => {
  it('falls all the way through to the built-ins', () => {
    const resolved = resolveLayoutRules()
    expect(resolved.spawn).toEqual(BUILTIN_LAYOUT_RULES.spawn)
    expect(resolved.tray).toEqual(BUILTIN_LAYOUT_RULES.tray)
    expect(resolved.triggers).toEqual(LAYOUT_TRIGGERS)
  })

  it('the machine default beats the built-in', () => {
    expect(resolveLayoutRules(undefined, { spawn: { size: 'normal' } }).spawn.size).toBe('normal')
  })

  it('the project rule beats the machine default', () => {
    expect(
      resolveLayoutRules({ spawn: { size: 'none' } }, { spawn: { size: 'normal' } }).spawn.size
    ).toBe('none')
  })

  it('a project that sets ONE field does not reset the rest to the built-in', () => {
    const resolved = resolveLayoutRules(
      { tray: { collapsed: false } },
      { spawn: { place: 'none' }, tray: { floatOnAttention: false } }
    )
    expect(resolved.tray.collapsed).toBe(false)
    // Still the machine's, not the built-in — a whole-block override would have lost both of these.
    expect(resolved.spawn.place).toBe('none')
    expect(resolved.tray.floatOnAttention).toBe(false)
  })

  it('an explicit `false` wins over a `true` below it (it is a value, not an absence)', () => {
    expect(resolveLayoutRules({ tray: { collapsed: false } }).tray.collapsed).toBe(false)
  })
})
