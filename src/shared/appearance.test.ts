import { describe, expect, it } from 'vitest'
import {
  APPEARANCE_MAX_THICKNESS,
  APPEARANCE_RULE_ENTRIES_MAX,
  APPEARANCE_TIER_ORDER,
  appearanceClassNames,
  appearanceStyleVars,
  normalizeAppearanceRuleKey,
  resolveDirectorKey,
  resolveNodeAppearance,
  resolveWindowEdgeAppearance,
  sanitizeAppearanceColor,
  sanitizeAppearanceRules,
  sanitizeAppearanceSettings,
  sanitizeAppearanceThickness,
  sanitizeBorderAppearance,
  sanitizeProjectLayoutRules,
  type AppearanceEnvironment,
  type AppearanceRules,
  type AppearanceSubject
} from './appearance'

const RED = '#ff453a'
const GREEN = '#32d74b'
const BLUE = '#0a84ff'
const YELLOW = '#ffd60a'
const PURPLE = '#bf5af2'
const TEAL = '#6ac4dc'

describe('resolveNodeAppearance — the precedence table', () => {
  // One environment carrying a DIFFERENT colour at every tier, so each assertion below names the
  // tier that won by naming its colour. The subject matches every dimension at once, which is the
  // only way the ordering between them is actually exercised.
  const everyTier: AppearanceEnvironment = {
    rules: {
      project: { color: YELLOW, thickness: 5 },
      byProvider: { claude: { color: BLUE, thickness: 4 } },
      byDirector: { alpha: { color: GREEN, thickness: 3 } },
      byTaskGroup: { 'frame-1': { color: RED, thickness: 2 } }
    },
    settings: { node: { color: PURPLE, thickness: 6 } }
  }
  const everyDimension: AppearanceSubject = {
    kind: 'node',
    provider: 'claude',
    director: 'alpha',
    taskGroupId: 'frame-1'
  }

  it('puts an explicit per-node override above every rule tier', () => {
    const r = resolveNodeAppearance({ ...everyDimension, override: { color: TEAL } }, everyTier)
    expect(r.color).toBe(TEAL)
    expect(r.sources.color).toBe('override')
  })

  it('puts a task-group rule above director, provider, project and global', () => {
    const r = resolveNodeAppearance(everyDimension, everyTier)
    expect(r.color).toBe(RED)
    expect(r.sources.color).toBe('taskGroup')
  })

  it('puts a director rule above provider, project and global', () => {
    const r = resolveNodeAppearance({ ...everyDimension, taskGroupId: undefined }, everyTier)
    expect(r.color).toBe(GREEN)
    expect(r.sources.color).toBe('director')
  })

  it('puts a provider rule above project and global', () => {
    const r = resolveNodeAppearance(
      { ...everyDimension, taskGroupId: undefined, director: undefined },
      everyTier
    )
    expect(r.color).toBe(BLUE)
    expect(r.sources.color).toBe('provider')
  })

  it('puts a whole-project rule above the machine-local global default', () => {
    const r = resolveNodeAppearance({ kind: 'node' }, everyTier)
    expect(r.color).toBe(YELLOW)
    expect(r.sources.color).toBe('project')
  })

  it('falls back to the machine-local global default when no project rule answers', () => {
    const r = resolveNodeAppearance({ kind: 'node' }, { settings: everyTier.settings })
    expect(r.color).toBe(PURPLE)
    expect(r.sources.color).toBe('global')
  })

  it('falls back to the built-in when nothing is configured at all', () => {
    const r = resolveNodeAppearance({ kind: 'node' })
    expect(r).toMatchObject({
      color: null,
      thickness: null,
      glow: false,
      focusHighlight: false,
      reducedMotion: false
    })
    expect(r.sources).toEqual({
      color: 'builtin',
      thickness: 'builtin',
      glow: 'builtin',
      focusHighlight: 'builtin'
    })
  })

  it('exports the tier order it actually walks', () => {
    // The Settings UI labels tiers from this list; a reordering here that the resolver does not
    // make would put a wrong "inherited from" caption on screen.
    expect([...APPEARANCE_TIER_ORDER]).toEqual([
      'override',
      'taskGroup',
      'director',
      'provider',
      'project',
      'global'
    ])
  })
})

describe('resolveNodeAppearance — the cascade is per FIELD', () => {
  it('lets a narrow rule set one field without dropping the wider tiers others', () => {
    // The bug this pins: a whole-object "first tier that exists wins" would have thrown away the
    // global colour because the task-group rule happened to mention thickness.
    const r = resolveNodeAppearance(
      { kind: 'node', taskGroupId: 'f1' },
      {
        rules: { byTaskGroup: { f1: { thickness: 3 } } },
        settings: { node: { color: PURPLE, glow: true } }
      }
    )
    expect(r).toMatchObject({ color: PURPLE, thickness: 3, glow: true })
    expect(r.sources).toMatchObject({
      color: 'global',
      thickness: 'taskGroup',
      glow: 'global'
    })
  })

  it('honours an explicit `false` as an answer, not as an absence', () => {
    // `glow: false` in a narrow tier must BEAT `glow: true` in a wider one — otherwise there is no
    // way for a project to switch off a global default it disagrees with.
    const r = resolveNodeAppearance(
      { kind: 'node', override: { glow: false } },
      { rules: { project: { glow: true } }, settings: { node: { glow: true } } }
    )
    expect(r.glow).toBe(false)
    expect(r.sources.glow).toBe('override')
  })

  it('honours an explicit thickness of 0', () => {
    const r = resolveNodeAppearance(
      { kind: 'node', override: { thickness: 0 } },
      { settings: { node: { thickness: 4 } } }
    )
    expect(r.thickness).toBe(0)
    expect(r.sources.thickness).toBe('override')
  })
})

describe('resolveNodeAppearance — the global default is kind-specific', () => {
  it('uses settings.node for a node and settings.group for a frame', () => {
    const settings = { node: { color: BLUE }, group: { color: RED } }
    expect(resolveNodeAppearance({ kind: 'node' }, { settings }).color).toBe(BLUE)
    expect(resolveNodeAppearance({ kind: 'group' }, { settings }).color).toBe(RED)
  })

  it('leaves a frame at the built-in when only the node default is set', () => {
    const r = resolveNodeAppearance({ kind: 'group' }, { settings: { node: { color: BLUE } } })
    expect(r.color).toBeNull()
    expect(r.sources.color).toBe('builtin')
  })
})

describe('resolveNodeAppearance — task-group matching', () => {
  const rules: AppearanceRules = {
    byTaskGroup: { 'group-7': { color: RED }, frontend: { color: GREEN } }
  }

  it('matches the frame id first', () => {
    const r = resolveNodeAppearance(
      { kind: 'node', taskGroupId: 'group-7', taskGroupLabel: 'frontend' },
      { rules }
    )
    expect(r.color).toBe(RED)
  })

  it('falls back to the frame label when the id matches no rule', () => {
    const r = resolveNodeAppearance(
      { kind: 'node', taskGroupId: 'group-99', taskGroupLabel: 'Frontend' },
      { rules }
    )
    expect(r.color).toBe(GREEN)
  })

  it('matches keys case-insensitively and ignores surrounding space', () => {
    // Case-folding happens ONCE, in the sanitizer every load path runs, so the resolver's own
    // lookup stays an O(1) hit on an already-normalized map rather than a scan per node per frame.
    const sanitized = sanitizeAppearanceRules({ byProvider: { Claude: { color: BLUE } } })
    expect(Object.keys(sanitized?.byProvider ?? {})).toEqual(['claude'])
    const r = resolveNodeAppearance({ kind: 'node', provider: '  CLAUDE ' }, { rules: sanitized })
    expect(r.color).toBe(BLUE)
  })

  it('does not treat an inherited Object.prototype key as a rule', () => {
    // `'constructor' in map` is true for any plain object; a lookup written that way would hand a
    // Function to the border-colour reader.
    const r = resolveNodeAppearance({ kind: 'node', provider: 'constructor' }, { rules: {
      byProvider: { claude: { color: BLUE } }
    } })
    expect(r.color).toBeNull()
    expect(r.sources.color).toBe('builtin')
  })
})

describe('reduced motion and effects-off are machine-local and win', () => {
  it('a shared glow rule loses to the local effects-off switch', () => {
    const r = resolveNodeAppearance(
      { kind: 'node', override: { glow: true, focusHighlight: true } },
      { rules: { project: { glow: true } }, settings: { effectsOff: true } }
    )
    expect(r.glow).toBe(false)
    expect(r.focusHighlight).toBe(false)
    expect(r.sources.glow).toBe('localEffectsOff')
    expect(r.sources.focusHighlight).toBe('localEffectsOff')
  })

  it('effects-off keeps colour and thickness — they are not effects', () => {
    const r = resolveNodeAppearance(
      { kind: 'node', override: { color: RED, thickness: 3, glow: true } },
      { settings: { effectsOff: true } }
    )
    expect(r).toMatchObject({ color: RED, thickness: 3, glow: false })
  })

  it('reduced motion comes from the local switch', () => {
    expect(resolveNodeAppearance({ kind: 'node' }, { settings: { reducedMotion: true } }).reducedMotion).toBe(true)
  })

  it('reduced motion comes from the OS setting even with the local switch off', () => {
    const r = resolveNodeAppearance(
      { kind: 'node' },
      { settings: { reducedMotion: false }, systemReducedMotion: true }
    )
    expect(r.reducedMotion).toBe(true)
  })

  it('no shared rule can name reduced motion at all', () => {
    // The type has no such field; this pins the read path — a project file that invents one is
    // dropped by the sanitizer, so it can never reach the resolver.
    const rules = sanitizeAppearanceRules({ project: { glow: true, reducedMotion: false } })
    expect(rules?.project).toEqual({ glow: true })
  })
})

describe('resolveWindowEdgeAppearance', () => {
  it('reads only the machine-local settings — it takes no project rules', () => {
    const r = resolveWindowEdgeAppearance({
      windowEdge: { color: RED, thickness: 3, glow: true, focusHighlight: true }
    })
    expect(r).toMatchObject({ color: RED, thickness: 3, glow: true, focusHighlight: true })
    expect(r.sources.color).toBe('global')
  })

  it('is the built-in when nothing is configured', () => {
    expect(resolveWindowEdgeAppearance(undefined)).toMatchObject({
      color: null,
      thickness: null,
      glow: false,
      focusHighlight: false
    })
  })

  it('obeys the same local effects-off and reduced-motion switches', () => {
    const r = resolveWindowEdgeAppearance(
      { windowEdge: { color: RED, glow: true, focusHighlight: true }, effectsOff: true },
      { systemReducedMotion: true }
    )
    expect(r).toMatchObject({ color: RED, glow: false, focusHighlight: false, reducedMotion: true })
  })
})

describe('sanitizers treat every stored value as hostile input', () => {
  it('accepts only the closed hex-colour syntax', () => {
    expect(sanitizeAppearanceColor('#FFF')).toBe('#fff')
    expect(sanitizeAppearanceColor(' #0A84FF ')).toBe('#0a84ff')
    expect(sanitizeAppearanceColor('#0a84ff80')).toBe('#0a84ff80')
    for (const bad of [
      'red',
      'rgb(1,2,3)',
      'var(--accent)',
      '#0a84ff; background: url(https://x/y)',
      'url(https://x/y)',
      '#12345',
      '#gggggg',
      '',
      42,
      null,
      undefined,
      {}
    ]) {
      expect(sanitizeAppearanceColor(bad)).toBeUndefined()
    }
  })

  it('clamps a thickness rather than dropping it, and refuses non-numbers', () => {
    expect(sanitizeAppearanceThickness(2)).toBe(2)
    expect(sanitizeAppearanceThickness(1.7)).toBe(1.5)
    expect(sanitizeAppearanceThickness(999)).toBe(APPEARANCE_MAX_THICKNESS)
    expect(sanitizeAppearanceThickness(-4)).toBe(0)
    expect(sanitizeAppearanceThickness(Number.NaN)).toBeUndefined()
    // Not clamped: JSON cannot carry an Infinity, so it can only come from code, and there is no
    // mis-typed intent to honour. 999 is a typo; Infinity is a bug, and the built-in is the answer.
    expect(sanitizeAppearanceThickness(Infinity)).toBeUndefined()
    expect(sanitizeAppearanceThickness('3')).toBeUndefined()
  })

  it('keeps known keys and drops unknown ones from an appearance object', () => {
    expect(
      sanitizeBorderAppearance({
        color: RED,
        thickness: 2,
        glow: true,
        focusHighlight: false,
        // Newer writer's key, and an outright forgery. Both simply are not read.
        shadowSpread: 40,
        reducedMotion: true
      })
    ).toEqual({ color: RED, thickness: 2, glow: true, focusHighlight: false })
  })

  it('takes only a literal true/false for the effect flags', () => {
    expect(sanitizeBorderAppearance({ glow: 'true', focusHighlight: 1 })).toBeUndefined()
  })

  it('returns undefined for an object that contributes nothing', () => {
    for (const bad of [null, undefined, 'x', 3, [], {}, { color: 'red' }]) {
      expect(sanitizeBorderAppearance(bad)).toBeUndefined()
    }
  })

  it('refuses rule keys that are empty, over-long or carry control characters', () => {
    expect(normalizeAppearanceRuleKey('  Claude  ')).toBe('claude')
    expect(normalizeAppearanceRuleKey('   ')).toBeUndefined()
    expect(normalizeAppearanceRuleKey('x'.repeat(500))).toBeUndefined()
    expect(normalizeAppearanceRuleKey('a b')).toBeUndefined()
    expect(normalizeAppearanceRuleKey(7)).toBeUndefined()
  })

  it('caps how many entries a rule map may carry', () => {
    const huge: Record<string, unknown> = {}
    for (let i = 0; i < APPEARANCE_RULE_ENTRIES_MAX + 50; i++) huge[`k${i}`] = { color: RED }
    const rules = sanitizeAppearanceRules({ byProvider: huge })
    expect(Object.keys(rules?.byProvider ?? {})).toHaveLength(APPEARANCE_RULE_ENTRIES_MAX)
  })

  it('drops a rule map whose entries are all unusable rather than keeping an empty one', () => {
    expect(sanitizeAppearanceRules({ byProvider: { claude: { color: 'red' } } })).toBeUndefined()
  })

  it('reads a layoutRules block field by field, ignoring an unknown version', () => {
    // The forward-compatibility contract: a canvas saved by a NEWER build still renders here.
    const parsed = sanitizeProjectLayoutRules({
      version: 99,
      spawn: { tray: 'collapsed', unknownFutureKey: true },
      appearance: { project: { color: RED, futureKnob: 'x' } }
    })
    expect(parsed).toEqual({ version: 99, appearance: { project: { color: RED } } })
  })

  it('treats an absent or unusable layoutRules block as built-in defaults', () => {
    for (const bad of [undefined, null, 'x', 3, [], {}, { version: 'one' }]) {
      expect(sanitizeProjectLayoutRules(bad)).toBeUndefined()
    }
  })

  it('reads the machine-local appearance settings with the same strictness', () => {
    expect(
      sanitizeAppearanceSettings({
        windowEdge: { color: RED, thickness: 400 },
        node: { color: 'nope' },
        group: { glow: true },
        reducedMotion: true,
        effectsOff: 'yes',
        futureKnob: 1
      })
    ).toEqual({
      windowEdge: { color: RED, thickness: APPEARANCE_MAX_THICKNESS },
      group: { glow: true },
      reducedMotion: true
    })
  })
})

describe('resolveDirectorKey', () => {
  const label = (id: string): string | undefined => ({ d1: 'Alpha director', d2: '' })[id]

  it('walks the spawned-by ropes up to the outermost spawner', () => {
    const ropes = [
      { source: 'd1', target: 'lead' },
      { source: 'lead', target: 'worker' }
    ]
    expect(resolveDirectorKey('worker', ropes, label)).toBe('Alpha director')
  })

  it('falls back to the node id when the root spawner has no usable label', () => {
    expect(resolveDirectorKey('w', [{ source: 'd2', target: 'w' }], label)).toBe('d2')
    expect(resolveDirectorKey('w', [{ source: 'd3', target: 'w' }], label)).toBe('d3')
  })

  it('answers undefined for a node nothing spawned', () => {
    expect(resolveDirectorKey('solo', [{ source: 'd1', target: 'other' }], label)).toBeUndefined()
    expect(resolveDirectorKey('solo', [], label)).toBeUndefined()
    expect(resolveDirectorKey('solo', undefined, label)).toBeUndefined()
  })

  it('terminates on a hand-edited cycle and on a self-edge', () => {
    expect(
      resolveDirectorKey('a', [
        { source: 'b', target: 'a' },
        { source: 'a', target: 'b' }
      ])
    ).toBe('b')
    expect(resolveDirectorKey('a', [{ source: 'a', target: 'a' }])).toBeUndefined()
  })

  it('ignores malformed rope entries instead of throwing', () => {
    const ropes = [
      null,
      { source: 1, target: 'x' },
      { source: 'd1', target: 'x' }
    ] as unknown as { source: string; target: string }[]
    expect(resolveDirectorKey('x', ropes, label)).toBe('Alpha director')
  })
})

describe('appearanceStyleVars / appearanceClassNames', () => {
  it('emits nothing for a built-in appearance', () => {
    const r = resolveNodeAppearance({ kind: 'node' })
    expect(appearanceStyleVars(r)).toEqual({})
    expect(appearanceClassNames(r, 'term-node')).toBe('')
  })

  it('emits the colour and thickness custom properties', () => {
    const r = resolveNodeAppearance({ kind: 'node', override: { color: RED, thickness: 2.5 } })
    expect(appearanceStyleVars(r)).toEqual({
      '--nt-appearance-color': RED,
      '--nt-appearance-thickness': '2.5px'
    })
    expect(appearanceClassNames(r, 'term-node')).toBe('term-node--tinted term-node--sized')
  })

  it('re-validates at the interpolation site, so a forged colour never reaches a stylesheet', () => {
    // The type is compile-time only; this is the last gate before the value is a CSS var.
    const forged = {
      ...resolveNodeAppearance({ kind: 'node' }),
      color: 'red; background: url(https://x/y)'
    }
    expect(appearanceStyleVars(forged)).toEqual({})
    expect(appearanceClassNames(forged, 'term-node')).toBe('')
  })

  it('names the effect classes', () => {
    const r = resolveNodeAppearance({ kind: 'node', override: { glow: true, focusHighlight: true } })
    expect(appearanceClassNames(r, 'group-node')).toBe('group-node--glow group-node--focus')
  })
})
