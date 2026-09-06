import { useSyncExternalStore } from 'react'
import {
  appearanceClassNames,
  appearanceStyleVars,
  resolveDirectorKey,
  resolveNodeAppearance,
  resolveWindowEdgeAppearance,
  sanitizeAppearanceSettings,
  type AppearanceEnvironment,
  type AppearanceRules,
  type AppearanceSettings,
  type BorderAppearance,
  type ResolvedAppearance
} from '@shared/appearance'
import type { BridgeLink, CanvasNodeState, Project, Settings } from '@shared/types'

/**
 * The renderer's half of the visual-preference model: it assembles the resolver's inputs ONCE per
 * change and hands every node the same environment object, so a canvas of forty terminals resolves
 * against one snapshot rather than forty reconstructions of it.
 *
 * A module-level external store rather than a React context, for the reason the rest of this
 * codebase reaches for one: React Flow instantiates custom nodes itself, so there is no prop path
 * from Canvas to a `TerminalNode`, and a context provider around `<ReactFlow>` would re-render
 * every node on every settings keystroke. Subscribers here re-render only when the environment
 * OBJECT changes, which is a real preference or rule change.
 *
 * **Cost when nothing is configured is zero.** With no `appearance` in settings.json and no
 * `layoutRules.appearance` in project.json — every existing install — the published environment is
 * the frozen empty object, `resolveNodeAppearance` walks six absent tiers and returns the built-in,
 * and the surfaces emit no style vars and no classes. That is the byte-identical-look guarantee.
 *
 * **Nothing here reads agent status.** The environment carries preferences and lineage only, so an
 * appearance can never become the sole channel a state is communicated on, and nothing
 * status-shaped can reach a project-file write through this path.
 */

/** What the environment publisher needs out of the active project. Kept structural rather than
 *  taking `Project` so the publisher can be unit-tested without a store. */
export interface AppearanceProjectFacts {
  layoutRules?: Project['layoutRules']
  nodes?: readonly CanvasNodeState[]
  ropes?: readonly BridgeLink[]
}

/** The environment plus the two lookup tables the per-node subject is built from. */
export interface CanvasAppearanceEnv extends AppearanceEnvironment {
  /** Frame id → its label. Populated ONLY when a `byTaskGroup` rule exists — with no such rule
   *  there is nothing to match, and building it would cost a pass over the canvas per change. */
  groupLabels?: Record<string, string>
  /** Node id → the director that spawned it. Populated ONLY when a `byDirector` rule exists. */
  directors?: Record<string, string>
}

const EMPTY_ENV: CanvasAppearanceEnv = Object.freeze({})

let env: CanvasAppearanceEnv = EMPTY_ENV
const subscribers = new Set<() => void>()

function emit(): void {
  for (const fn of subscribers) fn()
}

/** The current environment. For non-React readers and for tests. */
export function appearanceEnvNow(): CanvasAppearanceEnv {
  return env
}

/**
 * Publish a new environment.
 *
 * Structurally compared before it is published: the publisher runs on every settings and project
 * change, and re-publishing an equal object would re-render every node for nothing. The comparison
 * is `JSON.stringify` over an object that is a handful of preference fields plus two small maps —
 * cheaper than the render it prevents, and exact, which a hand-rolled shallow compare would not be
 * once the maps are in play.
 */
export function setAppearanceEnv(next: CanvasAppearanceEnv): void {
  const normalized = Object.keys(next).length ? next : EMPTY_ENV
  if (JSON.stringify(normalized) === JSON.stringify(env)) return
  env = normalized
  emit()
}

/** Test seam: drop back to "nothing configured". */
export function resetAppearanceEnv(): void {
  if (env === EMPTY_ENV) return
  env = EMPTY_ENV
  emit()
}

function subscribe(fn: () => void): () => void {
  subscribers.add(fn)
  return () => {
    subscribers.delete(fn)
  }
}

/** Subscribe a component to the published environment. */
export function useAppearanceEnv(): CanvasAppearanceEnv {
  return useSyncExternalStore(subscribe, appearanceEnvNow, appearanceEnvNow)
}

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

/**
 * The OS motion preference, live.
 *
 * Read here rather than left to CSS because the resolver has to KNOW it: `ResolvedAppearance`
 * carries one `reducedMotion` answer that the setting and the OS both feed, and a caller must not
 * be able to render a decision the resolver did not make. The CSS media queries elsewhere in the
 * stylesheet stay exactly as they are — this adds the user's own switch beside the OS's, it does
 * not replace it.
 *
 * Guarded for the jsdom/node environments this module is imported from, where `matchMedia` may be
 * absent: no query means no preference, which is the pre-feature behaviour.
 */
export function useSystemReducedMotion(): boolean {
  return useSyncExternalStore(
    (fn) => {
      const mq = typeof matchMedia === 'function' ? matchMedia(REDUCED_MOTION_QUERY) : null
      mq?.addEventListener('change', fn)
      return () => mq?.removeEventListener('change', fn)
    },
    () => (typeof matchMedia === 'function' ? matchMedia(REDUCED_MOTION_QUERY).matches : false),
    () => false
  )
}

/**
 * Build the environment from this machine's settings, the active project and the OS motion
 * preference. Pure — the publisher effect calls it and hands the result to `setAppearanceEnv`.
 *
 * The two lookup tables are built ONLY when a rule needs them, which is what keeps an unconfigured
 * canvas free: with no rules the whole function is a couple of property reads.
 */
export function buildAppearanceEnv(
  settings: Pick<Settings, 'appearance'> | undefined,
  project: AppearanceProjectFacts | undefined,
  systemReducedMotion: boolean
): CanvasAppearanceEnv {
  // settings.json is hand-editable, so what comes back out of it is input. The core store already
  // sanitizes on read; doing it again here costs nothing and keeps a renderer that was handed a
  // settings object by some other path (a test, a future bridge) on the same rules.
  const local: AppearanceSettings | undefined = sanitizeAppearanceSettings(settings?.appearance)
  const rules: AppearanceRules | undefined = project?.layoutRules?.appearance
  const out: CanvasAppearanceEnv = {}
  if (rules) out.rules = rules
  if (local) out.settings = local
  if (systemReducedMotion) out.systemReducedMotion = true

  if (rules?.byTaskGroup && project?.nodes) {
    const groupLabels: Record<string, string> = {}
    for (const n of project.nodes) {
      if (n.kind === 'group' && n.title) groupLabels[n.id] = n.title
    }
    if (Object.keys(groupLabels).length) out.groupLabels = groupLabels
  }

  if (rules?.byDirector && project?.ropes?.length) {
    const titleById = new Map<string, string>()
    for (const n of project.nodes ?? []) if (n.title) titleById.set(n.id, n.title)
    const directors: Record<string, string> = {}
    // Only the rope TARGETS can have a director; walking every node would be the same answer with
    // a pass over the whole canvas instead of over the (much shorter) lineage list.
    for (const rope of project.ropes) {
      const target = rope?.target
      if (typeof target !== 'string' || directors[target] !== undefined) continue
      const director = resolveDirectorKey(target, project.ropes, (id) => titleById.get(id))
      if (director) directors[target] = director
    }
    if (Object.keys(directors).length) out.directors = directors
  }
  return out
}

/** What a surface knows about itself, before the environment fills in the rest. */
export interface NodeAppearanceInput {
  nodeId: string
  kind: 'node' | 'group'
  /** `data.appearance` — the explicit per-node/per-group override. */
  override?: BorderAppearance
  /** `data.agentId`. */
  provider?: string
  /** React Flow's `parentId` — the frame this node sits in. */
  parentId?: string
}

/** Resolve one surface against the published environment. Exported (rather than only the hook) so
 *  the Settings preview can resolve a hypothetical node without mounting one. */
export function resolveWithEnv(
  input: NodeAppearanceInput,
  environment: CanvasAppearanceEnv
): ResolvedAppearance {
  return resolveNodeAppearance(
    {
      kind: input.kind,
      override: input.override,
      provider: input.provider,
      taskGroupId: input.parentId,
      // A frame's own rule may name it by label; for a CHILD the label is its parent frame's.
      taskGroupLabel: input.parentId
        ? environment.groupLabels?.[input.parentId]
        : input.kind === 'group'
          ? environment.groupLabels?.[input.nodeId]
          : undefined,
      director: environment.directors?.[input.nodeId]
    },
    environment
  )
}

/** The resolved appearance for one node or frame, live against the published environment. */
export function useNodeAppearance(input: NodeAppearanceInput): ResolvedAppearance {
  return resolveWithEnv(input, useAppearanceEnv())
}

/**
 * The style object and class string a surface should apply, in one call.
 *
 * `style` is spread into the element's existing inline style, so it must never contain a key the
 * surface itself sets — it contains only `--nt-appearance-*` custom properties, which the
 * stylesheet reads. `className` is appended. Both come from @shared/appearance so the node, the
 * frame and the window edge cannot disagree about what a resolved value looks like.
 */
export function appearanceAttrs(
  resolved: ResolvedAppearance,
  prefix: string
): { style: Record<string, string>; className: string } {
  return {
    style: appearanceStyleVars(resolved),
    className: appearanceClassNames(resolved, prefix)
  }
}

/**
 * The window/app edge, resolved from this machine's settings alone.
 *
 * There is no project parameter to pass — that is D2's whole content, expressed in the signature:
 * a git-shared project.json is structurally incapable of painting someone's window frame.
 */
export function windowEdgeAppearance(
  settings: Pick<Settings, 'appearance'> | undefined,
  systemReducedMotion: boolean
): ResolvedAppearance {
  return resolveWindowEdgeAppearance(sanitizeAppearanceSettings(settings?.appearance), {
    systemReducedMotion
  })
}
