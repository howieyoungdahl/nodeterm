import { NODE_COLORS } from '@shared/node-colors'
import {
  APPEARANCE_MAX_THICKNESS,
  appearanceStyleVars,
  resolveNodeAppearance,
  resolveWindowEdgeAppearance,
  sanitizeAppearanceRules,
  type AppearanceSettings,
  type BorderAppearance,
  type ResolvedAppearance
} from '@shared/appearance'
import { Switch } from '@renderer/ui/Switch'
import { FieldRow } from '../FieldRow'
import { cn } from '@renderer/ui/cn'

/**
 * The border editors behind Settings → Appearance, plus the preview.
 *
 * **The preview calls the same resolver the canvas does.** That is the whole reason
 * `resolveNodeAppearance` exists as one exported function: a preview computed any other way is a
 * promise the canvas does not have to keep, and the plan's D5 precedence would then be implemented
 * twice. So `BorderPreview` takes the same `{subject, environment}` the node passes and renders the
 * `ResolvedAppearance` it gets back — including its `sources`, which is what lets the caption say
 * WHY a swatch looks the way it does.
 */

/** The colour palette these editors offer: the same closed set `NODE_COLORS` gives the canvas.
 *  An arbitrary colour input would let a user pick a value the sanitizer then drops on the next
 *  load, which reads as the setting not sticking. */
export function ColorRow({
  label,
  description,
  value,
  onChange
}: {
  label: string
  description?: string
  value: string | undefined
  onChange: (next: string | undefined) => void
}): React.JSX.Element {
  return (
    <div className="flex items-start justify-between gap-6 py-1">
      <div className="min-w-0">
        <span className="block text-sm font-medium text-text">{label}</span>
        {description ? (
          <p className="mt-1 text-[13px] leading-relaxed text-muted">{description}</p>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <button
          type="button"
          aria-label={`${label}: none`}
          title="None"
          onClick={() => onChange(undefined)}
          className={cn(
            'flex size-6 items-center justify-center rounded-full border-2 text-[11px] leading-none text-muted',
            value ? 'border-transparent' : 'border-text'
          )}
        >
          ⊘
        </button>
        {NODE_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            aria-label={`${label}: ${c}`}
            title={c}
            onClick={() => onChange(c)}
            style={{ background: c }}
            className={cn('size-6 rounded-full border-2', value === c ? 'border-text' : 'border-transparent')}
          />
        ))}
      </div>
    </div>
  )
}

/** Thickness in CSS px. `0` is a legitimate answer (a ring the user wants gone without losing the
 *  colour choice), so the slider's floor is 0 and "off" is expressed by clearing the colour. */
export function ThicknessRow({
  label,
  value,
  onChange
}: {
  label: string
  value: number | undefined
  onChange: (next: number | undefined) => void
}): React.JSX.Element {
  const id = `thickness-${label.replace(/\s+/g, '-').toLowerCase()}`
  return (
    <FieldRow
      label={label}
      htmlFor={id}
      control={
        <div className="flex items-center gap-3">
          <input
            id={id}
            type="range"
            min={0}
            max={APPEARANCE_MAX_THICKNESS}
            step={0.5}
            value={value ?? 2}
            aria-label={label}
            onChange={(e) => onChange(Number(e.target.value))}
            className="w-[140px]"
          />
          <span className="w-[52px] text-right text-[13px] tabular-nums text-muted">
            {value === undefined ? 'default' : `${value}px`}
          </span>
        </div>
      }
    />
  )
}

/** One appearance object's four knobs, as a block. `onChange(undefined)` when nothing is left set,
 *  so an untouched surface writes no key at all. */
export function BorderEditor({
  value,
  onChange,
  colorLabel,
  colorDescription,
  effectsDisabledNote
}: {
  value: BorderAppearance | undefined
  onChange: (next: BorderAppearance | undefined) => void
  colorLabel: string
  colorDescription?: string
  /** Set when the machine-local effects-off switch is on: the two effect switches still render
   *  (a hidden control teaches nothing) but say why they will not take effect. */
  effectsDisabledNote?: string
}): React.JSX.Element {
  const patch = (next: BorderAppearance): void => {
    onChange(Object.keys(next).length ? next : undefined)
  }
  const withKey = <K extends keyof BorderAppearance>(
    key: K,
    v: BorderAppearance[K] | undefined
  ): void => {
    const next: BorderAppearance = { ...value }
    if (v === undefined) delete next[key]
    else next[key] = v
    patch(next)
  }
  return (
    <div className="space-y-3">
      <ColorRow
        label={colorLabel}
        description={colorDescription}
        value={value?.color}
        onChange={(c) => withKey('color', c)}
      />
      <ThicknessRow
        label="Thickness"
        value={value?.thickness}
        onChange={(t) => withKey('thickness', t)}
      />
      <FieldRow
        label="Glow"
        description="A soft halo in the border colour. Static — it never pulses."
        note={effectsDisabledNote}
        control={
          <Switch
            checked={value?.glow === true}
            onChange={(on) => withKey('glow', on || undefined)}
            ariaLabel={`${colorLabel}: glow`}
          />
        }
      />
      <FieldRow
        label="Focus highlight"
        description="Thicken the ring on whatever currently has focus, so the active surface is obvious at a glance."
        note={effectsDisabledNote}
        control={
          <Switch
            checked={value?.focusHighlight === true}
            onChange={(on) => withKey('focusHighlight', on || undefined)}
            ariaLabel={`${colorLabel}: focus highlight`}
          />
        }
      />
    </div>
  )
}

/** What the preview swatch says under itself. Reads the resolver's per-field provenance, so it can
 *  never claim a tier the canvas did not use. */
export function previewCaption(resolved: ResolvedAppearance): string {
  const parts: string[] = []
  if (resolved.color === null && resolved.thickness === null) parts.push('Built-in look')
  else parts.push(`from ${TIER_WORDS[resolved.sources.color] ?? 'the built-in look'}`)
  if (resolved.glow) parts.push('glow')
  if (resolved.focusHighlight) parts.push('focus highlight')
  if (resolved.sources.glow === 'localEffectsOff') parts.push('effects off')
  if (resolved.reducedMotion) parts.push('reduced motion')
  return parts.join(' · ')
}

const TIER_WORDS: Record<string, string> = {
  override: 'this card',
  taskGroup: 'a task-group rule',
  director: 'a director rule',
  provider: 'a provider rule',
  project: 'this project',
  global: 'your global default',
  builtin: 'the built-in look',
  localEffectsOff: 'effects off'
}

/**
 * A live swatch of one resolved appearance.
 *
 * It renders the SAME custom properties and the same class suffixes the canvas node does — the
 * markup is a small div rather than a whole terminal, but the values reaching CSS are produced by
 * `appearanceStyleVars`, i.e. the exact function the node calls.
 */
export function BorderPreview({
  resolved,
  caption
}: {
  resolved: ResolvedAppearance
  caption: string
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-4">
      <div className="relative">
        {resolved.glow ? (
          <div
            className="appearance-glow appearance-glow--node"
            style={appearanceStyleVars(resolved)}
            aria-hidden="true"
          />
        ) : null}
        <div
          className={cn(
            'appearance-preview',
            resolved.color ? 'term-node--tinted' : '',
            resolved.thickness !== null ? 'term-node--sized' : ''
          )}
          style={appearanceStyleVars(resolved)}
        >
          <span className="appearance-preview__bar" />
        </div>
      </div>
      <p className="text-[13px] leading-relaxed text-muted">{caption}</p>
    </div>
  )
}

/** The preview for a terminal node, resolved through the real cascade against a hypothetical
 *  project rule — so the swatch answers "what will my canvas look like", not "what did I type". */
export function previewResolved(
  settings: AppearanceSettings | undefined,
  projectRule: BorderAppearance | undefined,
  systemReducedMotion: boolean
): ResolvedAppearance {
  return resolveNodeAppearance(
    { kind: 'node' },
    {
      rules: sanitizeAppearanceRules(projectRule ? { project: projectRule } : undefined),
      settings,
      systemReducedMotion
    }
  )
}

/** The preview for the window edge — its own resolver, which by design takes no project rules. */
export function previewWindowEdge(
  settings: AppearanceSettings | undefined,
  systemReducedMotion: boolean
): ResolvedAppearance {
  return resolveWindowEdgeAppearance(settings, { systemReducedMotion })
}
