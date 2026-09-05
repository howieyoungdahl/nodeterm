/**
 * Persistent visual preferences: the model, its sanitizers, and THE resolver.
 *
 * Two independent surfaces, deliberately not one setting:
 *  - the **window/app edge** — a statement about THIS display, so it is machine-local
 *    (`Settings.appearance.windowEdge`) and `resolveWindowEdgeAppearance` takes no project rules
 *    at all. A git-shared repo file is structurally incapable of painting someone's window frame;
 *  - **node and group borders** — a statement about THIS canvas, so the derivation rules and the
 *    explicit per-node/per-group overrides ride `.nodeterm/project.json`
 *    (`Project.layoutRules.appearance`, `CanvasNodeState.appearance`), with a machine-local
 *    global default underneath for the user who wants the same look in every project.
 *
 * That split is the one CLAUDE.md already states for this file pair ("the shared file carries
 * content, not identity"); getting it wrong means a repo carries one person's monitor settings to
 * everyone who clones it.
 *
 * **One resolver, per field.** `resolveNodeAppearance` is the only implementation of the
 * precedence, so the Settings preview and the canvas cannot drift. The cascade is per FIELD, not
 * per object: a project rule that sets only `thickness` must not silently drop a global `color`,
 * which is what a whole-object "first tier that exists wins" would do.
 *
 * **Status is not an input.** There is no status parameter and no status-derived output here. That
 * is structural, not a convention: appearance can never become the only channel a state is
 * communicated on (CLAUDE.md's "never colour alone"), and nothing status-shaped can reach a
 * project-file write through this module. Any status tint a caller adds is redundant encoding on
 * top of a glyph and a word, computed at render time, and never persisted.
 *
 * **Every value here is hostile input.** `layoutRules` and a node's `appearance` are git-shared and
 * hand-editable; `settings.json` is hand-editable too. Colours end up interpolated into CSS custom
 * properties, where the browser does no validation of its own, so they are re-checked against a
 * closed syntax at the sanitizer AND at the interpolation site, and anything unrecognised degrades
 * to the built-in default rather than throwing a render. Same stance as `sanitizeProjectIcon` /
 * `readProjectCapabilities`.
 *
 * **Forward compatible.** An unknown `layoutRules.version` is IGNORED, never a reason to reject the
 * block; unknown keys inside an appearance object are dropped while its known keys survive; an
 * absent block means built-in defaults. So an older build renders a canvas a newer one saved.
 */

/** Hard cap on a border thickness, in CSS px. A frame is a background container — a 40px border
 *  would swallow its own contents, and this value reaches a stylesheet unbounded otherwise. */
export const APPEARANCE_MAX_THICKNESS = 8

/** The `layoutRules` schema this build writes. A file carrying a HIGHER version is still read
 *  (unknown keys are dropped field by field); the number exists so a future migration can tell
 *  what wrote a block, never as an admission gate. */
export const APPEARANCE_RULES_VERSION = 1

/** Longest accepted rule key. Keys are provider ids, frame labels and director slugs. */
export const APPEARANCE_RULE_KEY_MAX = 120

/** Most entries accepted per rule map, so a hostile/careless project.json cannot make every canvas
 *  load walk an unbounded table. */
export const APPEARANCE_RULE_ENTRIES_MAX = 200

/**
 * `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa` — and nothing else.
 *
 * Deliberately narrower than CSS accepts. These values are written into CSS CUSTOM PROPERTIES,
 * which the browser stores as arbitrary text and only interprets where they are substituted; a
 * named colour would be harmless but `red;background:url(…)` sitting in a var that a later rule
 * drops into a shorthand is not. A closed syntax means there is nothing to escape.
 */
const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i

/** Control characters survive JSON and reach debug surfaces; nothing legitimate keys a rule with one. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

/** The four knobs the operator asked for, on any one surface. Every field is optional: absent
 *  means "inherit from the next tier down", which is what makes the cascade per-field. */
export interface BorderAppearance {
  /** Border colour as `#rgb`/`#rgba`/`#rrggbb`/`#rrggbbaa`. Absent = the built-in (a node's own
   *  colour / the theme's border token). */
  color?: string
  /** Border width in CSS px, 0…{@link APPEARANCE_MAX_THICKNESS}. Absent = the built-in. */
  thickness?: number
  /** Soft outer glow in the border colour. An EFFECT: machine-local effects-off wins over it. */
  glow?: boolean
  /** Emphasise the surface while it has focus (a node: while selected; the window edge: while the
   *  window is focused, dimmed while it is not). An EFFECT: effects-off wins over it. */
  focusHighlight?: boolean
}

/** Which tier supplied a resolved field. Surfaced so the Settings UI can say where a value came
 *  from, and so the precedence table is asserted directly rather than inferred from pixels. */
export type AppearanceTier =
  | 'override'
  | 'taskGroup'
  | 'director'
  | 'provider'
  | 'project'
  | 'global'
  | 'builtin'
  /** The machine-local effects-off switch turned an effect off; no shared tier can undo it. */
  | 'localEffectsOff'

export interface ResolvedAppearance {
  /** null = no explicit colour anywhere; the caller keeps its built-in. */
  color: string | null
  /** null = no explicit thickness anywhere; the caller keeps its built-in. */
  thickness: number | null
  glow: boolean
  focusHighlight: boolean
  /** True when animation must be suppressed — the machine-local switch OR the OS setting. Carried
   *  in the resolved value so a caller cannot render a decision the resolver did not make. */
  reducedMotion: boolean
  /** Per-field provenance, in the same shape as the value. */
  sources: {
    color: AppearanceTier
    thickness: AppearanceTier
    glow: AppearanceTier
    focusHighlight: AppearanceTier
  }
}

/** The machine-local half — `Settings.appearance`. Never written into a project file. */
export interface AppearanceSettings {
  /** The app's outer window edge. Machine-local by construction; see the module header. */
  windowEdge?: BorderAppearance
  /** Global default for terminal/other node borders, under every project rule. */
  node?: BorderAppearance
  /** Global default for group frame borders, under every project rule. */
  group?: BorderAppearance
  /**
   * Freeze decorative motion. Machine-local and it OVERRIDES any shared rule — accessibility is
   * never something a repo file can switch back on. ORed with the OS `prefers-reduced-motion`.
   */
  reducedMotion?: boolean
  /**
   * Drop glow and focus highlighting everywhere. Machine-local and it OVERRIDES any shared rule,
   * for the same reason. Colour and thickness are NOT effects and survive: switching effects off
   * must not also throw away the border a team agreed on.
   */
  effectsOff?: boolean
}

/**
 * The shared half — `Project.layoutRules.appearance`, git-travelling.
 *
 * Four derivation dimensions, narrowest first when they disagree: a node sits in exactly one task
 * frame, a frame belongs to one director, a director drives several providers, and `project`
 * covers the canvas.
 *
 * Keys are case-insensitive and trimmed, because these are written by hand into a JSON file as
 * often as by an agent — but the folding happens ONCE, in `sanitizeAppearanceRules`, which every
 * load path runs. The resolver's own lookup is then an O(1) hit on an already-normalized map
 * rather than a scan per node per frame.
 */
export interface AppearanceRules {
  /** Whole-canvas default — the broadest project-scoped tier. */
  project?: BorderAppearance
  /** By the director that owns the node (see {@link resolveDirectorKey}). */
  byDirector?: Record<string, BorderAppearance>
  /** By the task frame the node sits in — matched on the frame's id, then on its label. */
  byTaskGroup?: Record<string, BorderAppearance>
  /** By the agent that runs in the node (`data.agentId`). */
  byProvider?: Record<string, BorderAppearance>
}

/**
 * `Project.layoutRules` — the shared rule block. Only `appearance` is defined here; the layout
 * halves (`spawn`, `tray`) belong to the layout-rule engine and extend this interface when they
 * land. `version` is recorded, never enforced.
 */
export interface ProjectLayoutRules {
  version?: number
  appearance?: AppearanceRules
}

/** What the caller knows about the thing being painted. Every dimension is optional: an unknown
 *  dimension simply cannot match a rule, which is not the same as matching an empty one. */
export interface AppearanceSubject {
  /** Picks which machine-local global default applies. */
  kind: 'node' | 'group'
  /** The explicit per-node/per-group override — the top tier. */
  override?: BorderAppearance
  /** `data.agentId`, for `byProvider`. */
  provider?: string
  /** The containing frame's id, for `byTaskGroup` (exact match, tried first). */
  taskGroupId?: string
  /** The containing frame's label, for `byTaskGroup` (tried when the id matches nothing). */
  taskGroupLabel?: string
  /** The owning director's key, for `byDirector`. See {@link resolveDirectorKey}. */
  director?: string
}

export interface AppearanceEnvironment {
  /** The active project's shared rules. */
  rules?: AppearanceRules
  /** This machine's `Settings.appearance`. */
  settings?: AppearanceSettings
  /** The OS `prefers-reduced-motion` answer, read by the renderer. ORed with the setting. */
  systemReducedMotion?: boolean
}

const BUILTIN: ResolvedAppearance = {
  color: null,
  thickness: null,
  glow: false,
  focusHighlight: false,
  reducedMotion: false,
  sources: {
    color: 'builtin',
    thickness: 'builtin',
    glow: 'builtin',
    focusHighlight: 'builtin'
  }
}

/** A fresh built-in result — never the shared constant, which callers would then mutate. */
function builtinResult(): ResolvedAppearance {
  return { ...BUILTIN, sources: { ...BUILTIN.sources } }
}

/** A colour we are willing to write into a stylesheet, normalized to lowercase; else undefined. */
export function sanitizeAppearanceColor(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const v = value.trim()
  return HEX_COLOR.test(v) ? v.toLowerCase() : undefined
}

/** A finite thickness clamped into [0, {@link APPEARANCE_MAX_THICKNESS}] and rounded to the
 *  nearest half pixel; else undefined. Out-of-range is CLAMPED rather than dropped — a `999` is a
 *  mis-typed intent to have a thick border, and the honest answer is the thickest border we allow,
 *  not silently none. */
export function sanitizeAppearanceThickness(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.min(APPEARANCE_MAX_THICKNESS, Math.max(0, Math.round(value * 2) / 2))
}

/** Strict `true`/`false` only — `"true"`, `1` and `{}` are not answers. */
function sanitizeFlag(value: unknown): boolean | undefined {
  return value === true ? true : value === false ? false : undefined
}

/**
 * One appearance object off disk. Unknown keys are DROPPED while the known ones survive (that is
 * the forward-compatibility rule), and an object that contributes nothing returns `undefined` so
 * it never adds empty bytes to a committed file.
 */
export function sanitizeBorderAppearance(value: unknown): BorderAppearance | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const out: BorderAppearance = {}
  const color = sanitizeAppearanceColor(raw.color)
  if (color !== undefined) out.color = color
  const thickness = sanitizeAppearanceThickness(raw.thickness)
  if (thickness !== undefined) out.thickness = thickness
  const glow = sanitizeFlag(raw.glow)
  if (glow !== undefined) out.glow = glow
  const focusHighlight = sanitizeFlag(raw.focusHighlight)
  if (focusHighlight !== undefined) out.focusHighlight = focusHighlight
  return Object.keys(out).length ? out : undefined
}

/** The lookup form of a rule key: trimmed and lower-cased, so a hand-written `"Claude"` matches
 *  the `claude` agent id and a frame renamed only in case still matches its rule. */
export function normalizeAppearanceRuleKey(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const v = value.trim().toLowerCase()
  if (!v || v.length > APPEARANCE_RULE_KEY_MAX) return undefined
  if (CONTROL_CHARS.test(v)) return undefined
  return v
}

function sanitizeRuleMap(value: unknown): Record<string, BorderAppearance> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const out: Record<string, BorderAppearance> = {}
  let n = 0
  for (const [rawKey, rawVal] of Object.entries(value as Record<string, unknown>)) {
    if (n >= APPEARANCE_RULE_ENTRIES_MAX) break
    const key = normalizeAppearanceRuleKey(rawKey)
    // `Object.prototype.hasOwnProperty` rather than `key in out`: `out` is a plain object, so
    // `'constructor' in out` is true and a legitimately-named rule would be silently skipped.
    if (key === undefined || Object.prototype.hasOwnProperty.call(out, key)) continue
    const appearance = sanitizeBorderAppearance(rawVal)
    if (!appearance) continue
    out[key] = appearance
    n++
  }
  return n ? out : undefined
}

/** The `appearance` block of `layoutRules`, off disk. */
export function sanitizeAppearanceRules(value: unknown): AppearanceRules | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const out: AppearanceRules = {}
  const project = sanitizeBorderAppearance(raw.project)
  if (project) out.project = project
  const byDirector = sanitizeRuleMap(raw.byDirector)
  if (byDirector) out.byDirector = byDirector
  const byTaskGroup = sanitizeRuleMap(raw.byTaskGroup)
  if (byTaskGroup) out.byTaskGroup = byTaskGroup
  const byProvider = sanitizeRuleMap(raw.byProvider)
  if (byProvider) out.byProvider = byProvider
  return Object.keys(out).length ? out : undefined
}

/**
 * The keys `AppearanceSettings` owns. They are machine-local by design — a window edge is a
 * statement about this display, and reduced-motion is an accessibility choice a git-shared file
 * must never be able to switch back on for somebody else. The carry-through below keeps another
 * OWNER's rules alive in the shared block; it must not become a way for these to travel, whether
 * they were hand-added or written by a confused build.
 */
const MACHINE_LOCAL_APPEARANCE_KEYS: ReadonlySet<string> = new Set([
  'windowEdge',
  'node',
  'group',
  'reducedMotion',
  'effectsOff'
])

/**
 * `Project.layoutRules`, off disk.
 *
 * An unrecognised `version` is kept as-is and changes nothing; rejecting on version is what would
 * stop an older build from rendering a newer canvas.
 *
 * **Unknown TOP-LEVEL keys are carried through, not dropped.** This block is shared property: it is
 * the same object the layout-rule engine keeps its `spawn` / `tray` rules in, and it travels in git.
 * A build that reads a key it does not know and writes the block back without it does not "ignore"
 * that key — it DELETES it, out of everyone's checkout, on the next ordinary save. Field-by-field
 * reconstruction here is therefore silent data loss across two owners of one block, not strictness.
 * Known keys are still fully re-validated below and overwrite whatever was copied.
 *
 * Inside a key this file owns (`appearance`), validation stays strict — an unknown *appearance*
 * knob really is ignorable, because nothing else writes there.
 */
export function sanitizeProjectLayoutRules(value: unknown): ProjectLayoutRules | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const [key, v] of Object.entries(raw)) {
    if (key === 'version' || key === 'appearance') continue
    if (MACHINE_LOCAL_APPEARANCE_KEYS.has(key)) continue
    if (v !== undefined) out[key] = v
  }
  if (typeof raw.version === 'number' && Number.isFinite(raw.version)) out.version = raw.version
  const appearance = sanitizeAppearanceRules(raw.appearance)
  if (appearance) out.appearance = appearance
  return Object.keys(out).length ? (out as ProjectLayoutRules) : undefined
}

/** `Settings.appearance`, off a hand-editable settings.json. */
export function sanitizeAppearanceSettings(value: unknown): AppearanceSettings | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const out: AppearanceSettings = {}
  const windowEdge = sanitizeBorderAppearance(raw.windowEdge)
  if (windowEdge) out.windowEdge = windowEdge
  const node = sanitizeBorderAppearance(raw.node)
  if (node) out.node = node
  const group = sanitizeBorderAppearance(raw.group)
  if (group) out.group = group
  const reducedMotion = sanitizeFlag(raw.reducedMotion)
  if (reducedMotion !== undefined) out.reducedMotion = reducedMotion
  const effectsOff = sanitizeFlag(raw.effectsOff)
  if (effectsOff !== undefined) out.effectsOff = effectsOff
  return Object.keys(out).length ? out : undefined
}

/** The tiers, narrowest first. Exported so the Settings UI can label them in the order the
 *  resolver walks them, rather than restating it. */
export const APPEARANCE_TIER_ORDER: readonly AppearanceTier[] = [
  'override',
  'taskGroup',
  'director',
  'provider',
  'project',
  'global'
] as const

function lookup(
  map: Record<string, BorderAppearance> | undefined,
  ...keys: (string | undefined)[]
): BorderAppearance | undefined {
  if (!map) return undefined
  for (const raw of keys) {
    const key = normalizeAppearanceRuleKey(raw)
    if (key === undefined) continue
    if (Object.prototype.hasOwnProperty.call(map, key)) return map[key]
  }
  return undefined
}

/**
 * THE resolver — the single implementation of the precedence in the plan's D5:
 *
 *   explicit per-node/per-group override > project rule > global default > built-in
 *
 * with the project-rule tier itself ordered narrowest-first (task group > director > provider >
 * whole-project), and the machine-local accessibility switches applied LAST so no shared rule can
 * undo them.
 *
 * Both the Settings preview and the canvas call this, which is the point: a preview computed any
 * other way is a promise the canvas does not have to keep.
 */
export function resolveNodeAppearance(
  subject: AppearanceSubject,
  env: AppearanceEnvironment = {}
): ResolvedAppearance {
  const rules = env.rules
  const settings = env.settings
  const global = subject.kind === 'group' ? settings?.group : settings?.node

  // Narrowest first. A tier that does not set a field simply does not answer for it.
  const tiers: [AppearanceTier, BorderAppearance | undefined][] = [
    ['override', subject.override],
    ['taskGroup', lookup(rules?.byTaskGroup, subject.taskGroupId, subject.taskGroupLabel)],
    ['director', lookup(rules?.byDirector, subject.director)],
    ['provider', lookup(rules?.byProvider, subject.provider)],
    ['project', rules?.project],
    ['global', global]
  ]

  const out = builtinResult()
  for (const [tier, appearance] of tiers) {
    if (!appearance) continue
    if (out.sources.color === 'builtin' && appearance.color !== undefined) {
      out.color = appearance.color
      out.sources.color = tier
    }
    if (out.sources.thickness === 'builtin' && appearance.thickness !== undefined) {
      out.thickness = appearance.thickness
      out.sources.thickness = tier
    }
    if (out.sources.glow === 'builtin' && appearance.glow !== undefined) {
      out.glow = appearance.glow
      out.sources.glow = tier
    }
    if (out.sources.focusHighlight === 'builtin' && appearance.focusHighlight !== undefined) {
      out.focusHighlight = appearance.focusHighlight
      out.sources.focusHighlight = tier
    }
  }

  // Machine-local, last, and unconditional: a shared project file must never be able to switch an
  // accessibility choice back on. Colour and thickness are untouched — they are not effects.
  applyLocalAccessibility(out, settings, env.systemReducedMotion)
  return out
}

/** The machine-local last word, shared by both resolvers so neither can forget half of it. */
function applyLocalAccessibility(
  out: ResolvedAppearance,
  settings: AppearanceSettings | undefined,
  systemReducedMotion: boolean | undefined
): void {
  if (settings?.effectsOff === true) {
    out.glow = false
    out.focusHighlight = false
    out.sources.glow = 'localEffectsOff'
    out.sources.focusHighlight = 'localEffectsOff'
  }
  out.reducedMotion = settings?.reducedMotion === true || systemReducedMotion === true
}

/**
 * The window/app edge.
 *
 * It takes `AppearanceSettings` and nothing else — there is no rules parameter to pass, so the
 * git-shared project file cannot reach this surface even by accident. That is D2's whole content:
 * the outer window is a statement about this display, not about the canvas.
 */
export function resolveWindowEdgeAppearance(
  settings: AppearanceSettings | undefined,
  opts: { systemReducedMotion?: boolean } = {}
): ResolvedAppearance {
  const out = builtinResult()
  const edge = settings?.windowEdge
  if (edge) {
    if (edge.color !== undefined) {
      out.color = edge.color
      out.sources.color = 'global'
    }
    if (edge.thickness !== undefined) {
      out.thickness = edge.thickness
      out.sources.thickness = 'global'
    }
    if (edge.glow !== undefined) {
      out.glow = edge.glow
      out.sources.glow = 'global'
    }
    if (edge.focusHighlight !== undefined) {
      out.focusHighlight = edge.focusHighlight
      out.sources.focusHighlight = 'global'
    }
  }
  applyLocalAccessibility(out, settings, opts.systemReducedMotion)
  return out
}

/**
 * Which director owns a node, from the lineage the app already persists.
 *
 * `project.ropes` is the display-only "spawned by" edge an agent draws when it opens a node
 * (source = the agent node that opened it, target = the node it opened). Walking it up to the
 * outermost spawner names the director without inventing new node state — and it is READ-ONLY, so
 * nothing here can change lineage, grouping or ownership.
 *
 * The returned key is the root spawner's LABEL when one is known (a rule someone writes by hand
 * says `"reviewer"`, not `"term-mf3k…"`), else its node id. Cycles and self-edges terminate: the
 * walk refuses to revisit a node, so a hand-edited `a → b → a` pair ends rather than spinning.
 */
export function resolveDirectorKey(
  nodeId: string,
  ropes: readonly { source: string; target: string }[] | undefined,
  labelById?: (id: string) => string | undefined
): string | undefined {
  if (!ropes?.length) return undefined
  const parent = new Map<string, string>()
  for (const r of ropes) {
    if (!r || typeof r.source !== 'string' || typeof r.target !== 'string') continue
    if (r.source === r.target) continue
    // First rope wins for a target: a node is opened once, and a second edge would be a stale
    // duplicate. Deterministic beats "most recent" here — the answer must be stable across loads,
    // or the canvas repaints itself for no reason the user can see.
    if (!parent.has(r.target)) parent.set(r.target, r.source)
  }
  const seen = new Set<string>([nodeId])
  let cur = nodeId
  for (;;) {
    const next = parent.get(cur)
    if (next === undefined || seen.has(next)) break
    seen.add(next)
    cur = next
  }
  if (cur === nodeId) return undefined
  const label = labelById?.(cur)?.trim()
  return label || cur
}

/**
 * The resolved appearance as CSS custom properties.
 *
 * One producer for every surface (node, group frame, window edge) so the three cannot disagree
 * about what a resolved value means, and so a value that failed sanitizing is simply ABSENT rather
 * than written as an empty string a shorthand would then mis-parse. Colours and thicknesses are
 * re-checked HERE, at the interpolation site — the type is compile-time only, and this is the last
 * point before the value reaches a stylesheet (the rule `permissionModeFlag` follows for tmux
 * command lines, applied to CSS).
 */
export function appearanceStyleVars(a: ResolvedAppearance): Record<string, string> {
  const vars: Record<string, string> = {}
  const color = sanitizeAppearanceColor(a.color)
  if (color) vars['--nt-appearance-color'] = color
  const thickness = sanitizeAppearanceThickness(a.thickness)
  if (thickness !== undefined) vars['--nt-appearance-thickness'] = `${thickness}px`
  return vars
}

/** The classes a surface should carry for its resolved appearance. Kept beside the vars so no
 *  surface spells an effect class itself and the three cannot drift apart. */
export function appearanceClassNames(a: ResolvedAppearance, prefix: string): string {
  const out: string[] = []
  if (sanitizeAppearanceColor(a.color)) out.push(`${prefix}--tinted`)
  if (sanitizeAppearanceThickness(a.thickness) !== undefined) out.push(`${prefix}--sized`)
  if (a.glow) out.push(`${prefix}--glow`)
  if (a.focusHighlight) out.push(`${prefix}--focus`)
  return out.join(' ')
}
