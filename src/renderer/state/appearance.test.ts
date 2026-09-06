import { describe, it, expect, beforeEach } from 'vitest'
import type { BridgeLink, CanvasNodeState, Settings } from '@shared/types'
import {
  appearanceEnvNow,
  appearanceAttrs,
  buildAppearanceEnv,
  resetAppearanceEnv,
  resolveWithEnv,
  setAppearanceEnv,
  windowEdgeAppearance,
  type CanvasAppearanceEnv
} from './appearance'

/**
 * The renderer's half of the visual-preference model (@shared/appearance holds the resolver and
 * its precedence table; this is the assembly of the inputs it is fed).
 *
 * Two properties are load-bearing and asserted here rather than left to review:
 *  - **an unconfigured canvas costs nothing** — no rules and no settings publish the frozen empty
 *    environment, and every surface then emits no style vars and no classes. That is the
 *    byte-identical-look guarantee for every existing install;
 *  - **the lookup tables are built only when a rule needs them**, because they are a pass over the
 *    canvas and would otherwise be paid per publish by users who configured nothing.
 */

const node = (over: Partial<CanvasNodeState> = {}): CanvasNodeState => ({
  id: 'term-a', kind: 'terminal', position: { x: 0, y: 0 },
  size: { width: 400, height: 300 }, title: 't', color: '#fff', group: null, ...over
})
const settingsWith = (appearance: Settings['appearance']): Pick<Settings, 'appearance'> =>
  ({ appearance }) as Pick<Settings, 'appearance'>
const rope = (source: string, target: string): BridgeLink => ({ source, target }) as BridgeLink

beforeEach(() => resetAppearanceEnv())

describe('buildAppearanceEnv', () => {
  it('publishes nothing when nothing is configured', () => {
    expect(buildAppearanceEnv(undefined, undefined, false)).toEqual({})
    expect(buildAppearanceEnv(settingsWith(undefined), { nodes: [node()] }, false)).toEqual({})
  })

  it('carries this machine settings and the project rules, and the OS motion answer', () => {
    const env = buildAppearanceEnv(
      settingsWith({ node: { color: '#7aa2f7' } }),
      { layoutRules: { appearance: { project: { thickness: 3 } } } },
      true
    )
    expect(env.settings).toEqual({ node: { color: '#7aa2f7' } })
    expect(env.rules).toEqual({ project: { thickness: 3 } })
    expect(env.systemReducedMotion).toBe(true)
  })

  // settings.json is hand-editable; the core store sanitizes on read and this does it again, so a
  // renderer handed a settings object by any other path is on the same rules.
  it('sanitizes a hostile settings block rather than trusting its type', () => {
    const env = buildAppearanceEnv(
      settingsWith({ node: { color: 'red;background:url(//x)' } } as never),
      undefined,
      false
    )
    expect(env.settings).toBeUndefined()
  })

  it('builds the group-label table only when a byTaskGroup rule exists', () => {
    const nodes = [node({ id: 'grp-1', kind: 'group', title: 'Reviewers' }), node()]
    expect(buildAppearanceEnv(undefined, {
      layoutRules: { appearance: { project: { thickness: 1 } } }, nodes
    }, false).groupLabels).toBeUndefined()
    expect(buildAppearanceEnv(undefined, {
      layoutRules: { appearance: { byTaskGroup: { reviewers: { color: '#f7768e' } } } }, nodes
    }, false).groupLabels).toEqual({ 'grp-1': 'Reviewers' })
  })

  it('builds the director table only when a byDirector rule exists, keyed by the root spawner', () => {
    const facts = {
      layoutRules: { appearance: { byDirector: { lead: { color: '#9ece6a' } } } },
      nodes: [node({ id: 'dir-1', title: 'Lead' }), node({ id: 'w-1' }), node({ id: 'w-2' })],
      ropes: [rope('dir-1', 'w-1'), rope('w-1', 'w-2')]
    }
    // The walk goes all the way up: a worker spawned BY a worker still belongs to the director.
    expect(buildAppearanceEnv(undefined, facts, false).directors).toEqual({ 'w-1': 'Lead', 'w-2': 'Lead' })
    expect(buildAppearanceEnv(undefined, {
      ...facts, layoutRules: { appearance: { project: { thickness: 1 } } }
    }, false).directors).toBeUndefined()
  })

  // A cycle is hand-edited garbage in a git-shared file. The guarantee is that the walk TERMINATES
  // and is deterministic across loads — not any particular answer: a canvas that repainted itself
  // differently on every load for a reason the user cannot see is the failure worth pinning.
  it('a rope cycle terminates instead of spinning, with a stable answer', () => {
    const facts = {
      layoutRules: { appearance: { byDirector: { a: { color: '#9ece6a' } } } },
      nodes: [node({ id: 'a', title: 'A' }), node({ id: 'b', title: 'B' })],
      ropes: [rope('a', 'b'), rope('b', 'a')]
    }
    const env = buildAppearanceEnv(undefined, facts, false)
    expect(env.directors).toEqual({ a: 'B', b: 'A' })
    expect(buildAppearanceEnv(undefined, facts, false).directors).toEqual(env.directors)
  })

  // A self-edge names no director rather than naming the node itself.
  it('a self-rope yields no director', () => {
    expect(buildAppearanceEnv(undefined, {
      layoutRules: { appearance: { byDirector: { a: { color: '#9ece6a' } } } },
      nodes: [node({ id: 'a', title: 'A' })],
      ropes: [rope('a', 'a')]
    }, false).directors).toBeUndefined()
  })
})

describe('setAppearanceEnv', () => {
  // `useSyncExternalStore` re-renders a subscriber when the snapshot's IDENTITY changes, so
  // identity stability across an equal publish is exactly the property that keeps a canvas of
  // forty terminals from re-rendering on every settings keystroke and every canvas commit.
  it('keeps the same snapshot object when an equal environment is published again', () => {
    setAppearanceEnv({ settings: { node: { color: '#7aa2f7' } } })
    const first = appearanceEnvNow()
    setAppearanceEnv({ settings: { node: { color: '#7aa2f7' } } })
    expect(appearanceEnvNow()).toBe(first)
    setAppearanceEnv({ settings: { node: { color: '#bb9af7' } } })
    expect(appearanceEnvNow()).not.toBe(first)
  })

  it('an empty environment normalizes back to the shared frozen empty object', () => {
    setAppearanceEnv({ settings: { node: { color: '#7aa2f7' } } })
    setAppearanceEnv({})
    const empty = appearanceEnvNow()
    expect(empty).toEqual({})
    // Same object every time, so an unconfigured install never re-renders its nodes either.
    setAppearanceEnv({})
    expect(appearanceEnvNow()).toBe(empty)
  })
})

describe('resolveWithEnv', () => {
  const env: CanvasAppearanceEnv = {
    rules: {
      project: { color: '#7aa2f7' },
      byProvider: { claude: { color: '#bb9af7' } },
      byTaskGroup: { reviewers: { color: '#f7768e' } }
    },
    settings: { node: { color: '#565f89' } },
    groupLabels: { 'grp-1': 'Reviewers' }
  }

  it('applies the precedence: override > task group > provider > project > global', () => {
    expect(resolveWithEnv({ nodeId: 'n', kind: 'node' }, env).color).toBe('#7aa2f7')
    expect(resolveWithEnv({ nodeId: 'n', kind: 'node', provider: 'claude' }, env).color).toBe('#bb9af7')
    // A child matches its PARENT frame's rule, by the frame's label as well as its id.
    expect(resolveWithEnv({ nodeId: 'n', kind: 'node', provider: 'claude', parentId: 'grp-1' }, env).color)
      .toBe('#f7768e')
    expect(resolveWithEnv(
      { nodeId: 'n', kind: 'node', provider: 'claude', parentId: 'grp-1', override: { color: '#9ece6a' } },
      env
    ).color).toBe('#9ece6a')
  })

  it('a frame matches a task-group rule naming the frame itself', () => {
    expect(resolveWithEnv({ nodeId: 'grp-1', kind: 'group' }, env).color).toBe('#f7768e')
  })

  it('an unconfigured environment resolves to the built-in and emits no vars and no classes', () => {
    const resolved = resolveWithEnv({ nodeId: 'n', kind: 'node' }, {})
    expect(resolved.color).toBeNull()
    expect(resolved.thickness).toBeNull()
    expect(appearanceAttrs(resolved, 'term-node')).toEqual({ style: {}, className: '' })
  })
})

describe('windowEdgeAppearance', () => {
  it('reads this machine settings only — there is no project parameter to pass', () => {
    const edge = windowEdgeAppearance(settingsWith({ windowEdge: { color: '#7aa2f7', glow: true } }), false)
    expect(edge.color).toBe('#7aa2f7')
    expect(edge.glow).toBe(true)
  })

  // The stronger half of D4: a shared project file can never switch an accessibility choice back
  // on, so effects-off is applied last and wins over anything the canvas asked for.
  it('machine-local effects-off beats a glow the settings themselves requested', () => {
    const edge = windowEdgeAppearance(
      settingsWith({ windowEdge: { color: '#7aa2f7', glow: true }, effectsOff: true }),
      false
    )
    expect(edge.glow).toBe(false)
    expect(edge.color).toBe('#7aa2f7') // colour is not an effect and survives
    expect(edge.sources.glow).toBe('localEffectsOff')
  })

  it('reduced motion is the OR of the user switch and the OS setting', () => {
    expect(windowEdgeAppearance(settingsWith(undefined), true).reducedMotion).toBe(true)
    expect(windowEdgeAppearance(settingsWith({ reducedMotion: true }), false).reducedMotion).toBe(true)
    expect(windowEdgeAppearance(settingsWith(undefined), false).reducedMotion).toBe(false)
  })
})
