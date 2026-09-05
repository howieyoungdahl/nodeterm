// The rules the layout engine reads, and where each half of them lives.
//
// TWO TIERS, and the split follows CLAUDE.md's existing one ("the shared file carries content,
// not identity"):
//
//   .nodeterm/project.json  `layoutRules`        — WHAT the rules are. A statement about this
//                                                  canvas, so it travels with the repo.
//   settings.json           `canvasLayout`       — this machine's default rules, AND the single
//                                                  switch that decides whether the engine runs
//                                                  here at all.
//
// **`enabled` is machine-local and lives NOWHERE ELSE.** The shared block deliberately has no
// such key. A repository must not be able to switch on automatic rearrangement for everyone who
// clones it — that is the same rule PR-D's reduced-motion setting follows, for the same reason:
// a preference about what an application is allowed to do to your screen is not the repo's to
// set. It defaults to OFF, so an existing install upgrades to byte-identical behaviour.
//
// FORWARD AND BACKWARD COMPATIBLE, and the compatibility is a real requirement rather than a
// nicety: `project.json` is git-shared, so two machines running different builds read and REWRITE
// the same file. Hence two rules that look redundant and are not —
//
//   * an unknown `version` is recorded and changes nothing (the block is read field by field, so
//     there is no schema to reject and an older build still renders a newer canvas), and
//   * `sanitizeCanvasLayoutRules` PRESERVES keys it does not know, verbatim, in `unknown`.
//     Dropping them is what would make an older build silently delete a newer build's rules on
//     the next save — the same data-loss shape as a stale node list overwriting live cards. What
//     is preserved is inert: nothing reads `unknown`, and anything that later wants to must
//     sanitize it first, exactly as this module sanitizes what it does know.

import { LAYOUT_TRIGGERS, type LayoutTrigger } from './canvas-layout'

/** The `layoutRules.version` this build writes. Recorded, never enforced. */
export const LAYOUT_RULES_VERSION = 1

/** What happens to a node the moment a control-capable agent opens it. */
export interface SpawnLayoutRules {
  /**
   * Where a new worker lands. `tray` puts it under the frame derived from its spawner
   * (@shared/worker-frame); `none` leaves it where the factory dropped it.
   */
  place?: 'tray' | 'none'
  /** Open a worker at the compact footprint, at the configured normal size, or leave it alone. */
  size?: 'compact' | 'normal' | 'none'
}

/** How a spawn tray behaves once it exists. */
export interface TrayLayoutRules {
  /** Ship a newly created tray frame closed. A tray full of compact cards is the point. */
  collapsed?: boolean
  /**
   * Move a member OUT of its tray when its status needs the operator (blocked or failed), so an
   * approval inside a closed frame is reachable without opening it. This is the ONE rule that
   * gives `status-changed` any ops at all; with it off, a status change only ever moves a badge.
   */
  floatOnAttention?: boolean
}

/**
 * `Project.layoutRules` — the shared rule block.
 *
 * `appearance` is deliberately NOT declared here. It is the visual-preferences branch's half of
 * the same block (`@shared/appearance`'s `AppearanceRules`), and the two halves land in separate
 * changes; until they meet, each side's sanitizer carries the other's key through `unknown`
 * rather than either of them owning a second validator for JSON it does not read.
 */
export interface CanvasLayoutRules {
  version?: number
  spawn?: SpawnLayoutRules
  tray?: TrayLayoutRules
  /**
   * Triggers this project answers. Absent = all of them. A project that wants placement at spawn
   * but no whole-canvas sweeps says so here rather than by turning the engine off.
   */
  triggers?: LayoutTrigger[]
  /**
   * Every key this build did not recognise, kept verbatim so a newer build's rules survive a save
   * by an older one. Never read. Not written by this build — it only ever round-trips.
   */
  unknown?: Record<string, unknown>
}

/** `Settings.canvasLayout` — this machine's switch and its default rules. */
export interface CanvasLayoutSettings {
  /** The whole feature, off by default. Machine-local by design; see the header. */
  enabled?: boolean
  /** The default rules for a project whose shared file carries none. */
  defaults?: CanvasLayoutRules
}

/**
 * What the engine does when nobody has said anything. Chosen to be the least surprising thing an
 * operator who just switched the feature on could see: new workers are filed into their spawner's
 * tray at the compact size, the tray ships closed, and a member that needs attention floats out
 * of it — which is the only reason a closed tray is safe to ship in the first place.
 */
export const BUILTIN_LAYOUT_RULES: Required<Pick<CanvasLayoutRules, 'spawn' | 'tray'>> = {
  spawn: { place: 'tray', size: 'compact' },
  tray: { collapsed: true, floatOnAttention: true }
}

/** Rules with every field settled — what `plan()` actually reads. */
export interface ResolvedLayoutRules {
  spawn: Required<SpawnLayoutRules>
  tray: Required<TrayLayoutRules>
  triggers: readonly LayoutTrigger[]
}

function pick<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined
}

function flag(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

const KNOWN_RULE_KEYS = new Set(['version', 'spawn', 'tray', 'triggers', 'unknown'])

function sanitizeSpawn(value: unknown): SpawnLayoutRules | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const out: SpawnLayoutRules = {}
  const place = pick(raw.place, ['tray', 'none'] as const)
  if (place) out.place = place
  const size = pick(raw.size, ['compact', 'normal', 'none'] as const)
  if (size) out.size = size
  return Object.keys(out).length ? out : undefined
}

function sanitizeTray(value: unknown): TrayLayoutRules | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const out: TrayLayoutRules = {}
  const collapsed = flag(raw.collapsed)
  if (collapsed !== undefined) out.collapsed = collapsed
  const floatOnAttention = flag(raw.floatOnAttention)
  if (floatOnAttention !== undefined) out.floatOnAttention = floatOnAttention
  return Object.keys(out).length ? out : undefined
}

/**
 * `Project.layoutRules`, off a hand-editable, git-shared file — so it is read as hostile input,
 * the same posture as `sanitizeNodeTriggers`. An unrecognised value for a KNOWN key is dropped
 * (leaving the tier below to answer); an unrecognised KEY is preserved untouched (see the header).
 */
export function sanitizeCanvasLayoutRules(value: unknown): CanvasLayoutRules | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const out: CanvasLayoutRules = {}
  if (typeof raw.version === 'number' && Number.isFinite(raw.version)) out.version = raw.version
  const spawn = sanitizeSpawn(raw.spawn)
  if (spawn) out.spawn = spawn
  const tray = sanitizeTray(raw.tray)
  if (tray) out.tray = tray
  if (Array.isArray(raw.triggers)) {
    const triggers = [...new Set(raw.triggers.filter((t): t is LayoutTrigger =>
      LAYOUT_TRIGGERS.includes(t as LayoutTrigger)
    ))]
    if (triggers.length) out.triggers = triggers
  }
  const carried: Record<string, unknown> = {
    ...(raw.unknown && typeof raw.unknown === 'object' && !Array.isArray(raw.unknown)
      ? (raw.unknown as Record<string, unknown>)
      : {})
  }
  for (const [key, v] of Object.entries(raw)) {
    if (!KNOWN_RULE_KEYS.has(key)) carried[key] = v
  }
  if (Object.keys(carried).length) out.unknown = carried
  return Object.keys(out).length ? out : undefined
}

/** `Settings.canvasLayout`, off a hand-editable settings.json. */
export function sanitizeCanvasLayoutSettings(value: unknown): CanvasLayoutSettings | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const raw = value as Record<string, unknown>
  const out: CanvasLayoutSettings = {}
  const enabled = flag(raw.enabled)
  if (enabled !== undefined) out.enabled = enabled
  const defaults = sanitizeCanvasLayoutRules(raw.defaults)
  if (defaults) out.defaults = defaults
  return Object.keys(out).length ? out : undefined
}

/**
 * The precedence, in one place so the Settings UI, the preview and the engine cannot disagree:
 * **project rule > machine default > built-in**, field by field. Field-by-field rather than
 * block-by-block on purpose — a project that sets only `tray.collapsed` must not thereby reset
 * `spawn.place` to the built-in, which is what a whole-object override would do.
 *
 * `unknown` is not consulted: an unrecognised key cannot participate in a decision this build
 * does not know how to make.
 */
export function resolveLayoutRules(
  project?: CanvasLayoutRules,
  machine?: CanvasLayoutRules
): ResolvedLayoutRules {
  const spawn = {
    place: project?.spawn?.place ?? machine?.spawn?.place ?? BUILTIN_LAYOUT_RULES.spawn.place!,
    size: project?.spawn?.size ?? machine?.spawn?.size ?? BUILTIN_LAYOUT_RULES.spawn.size!
  }
  const tray = {
    collapsed:
      project?.tray?.collapsed ?? machine?.tray?.collapsed ?? BUILTIN_LAYOUT_RULES.tray.collapsed!,
    floatOnAttention:
      project?.tray?.floatOnAttention ??
      machine?.tray?.floatOnAttention ??
      BUILTIN_LAYOUT_RULES.tray.floatOnAttention!
  }
  return { spawn, tray, triggers: project?.triggers ?? machine?.triggers ?? LAYOUT_TRIGGERS }
}

/**
 * Whether the engine may run on this machine at all. Reads ONLY the machine-local switch, and
 * fails closed for every shape it does not recognise — an absent block, a hand-edited string, a
 * settings.json from a newer build. Off is the answer that changes nothing.
 */
export function layoutEngineEnabled(settings?: CanvasLayoutSettings): boolean {
  return settings?.enabled === true
}
