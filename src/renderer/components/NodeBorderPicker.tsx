import { NODE_COLORS } from '@shared/node-colors'
import {
  APPEARANCE_TIER_ORDER,
  type BorderAppearance,
  type ResolvedAppearance
} from '@shared/appearance'

/**
 * The explicit per-node / per-group border override — the top tier of `resolveNodeAppearance`.
 *
 * Lives in the colour popover both node kinds already open, because that is where a user goes to
 * change how one card looks and a second entry point would be a second thing to find. The palette
 * is `NODE_COLORS`, the same closed set the node colour itself uses: these values are persisted
 * into a git-shared file and interpolated into a CSS custom property, so the picker offers exactly
 * what the sanitizer will accept rather than an arbitrary colour input whose value silently
 * degrades to the built-in on the next load.
 *
 * "Inherit" is a real choice, not a colour: it CLEARS the override so the node falls back through
 * the project rules to the global default. The caption underneath says what it will fall back TO,
 * because "inherit" with no visible answer is the state that makes a preference system feel broken.
 */
export function NodeBorderPicker({
  override,
  resolved,
  onChange
}: {
  /** The node's current `data.appearance`. */
  override: BorderAppearance | undefined
  /** What the resolver currently answers for this node, used for the inherited-from caption. */
  resolved: ResolvedAppearance
  /** Called with the next override; `undefined` removes it entirely. */
  onChange: (next: BorderAppearance | undefined) => void
}): React.JSX.Element {
  const current = override?.color
  const set = (color: string | undefined): void => {
    const next: BorderAppearance = { ...override }
    if (color) next.color = color
    else delete next.color
    onChange(Object.keys(next).length ? next : undefined)
  }
  return (
    <div className="border-picker">
      <span className="border-picker__label">Border</span>
      <div className="border-picker__swatches">
        <button
          type="button"
          className={`border-picker__none${current ? '' : ' is-current'}`}
          title="Inherit"
          aria-label="Inherit border colour"
          onClick={() => set(undefined)}
        >
          ⊘
        </button>
        {NODE_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            style={{ background: c }}
            className={current === c ? 'is-current' : undefined}
            aria-label={`Border ${c}`}
            title={c}
            onClick={() => set(c)}
          />
        ))}
      </div>
      <span className="border-picker__note">{inheritedNote(override, resolved)}</span>
    </div>
  )
}

/** Where the border a user is looking at actually comes from. Reads the resolver's own per-field
 *  provenance rather than re-deriving it, so the caption cannot claim a tier the canvas did not
 *  use. */
export function inheritedNote(
  override: BorderAppearance | undefined,
  resolved: ResolvedAppearance
): string {
  if (override?.color) return 'Set on this card.'
  const tier = resolved.sources.color
  if (tier === 'builtin' || !resolved.color) return 'No border set — using the built-in look.'
  const label: Partial<Record<(typeof APPEARANCE_TIER_ORDER)[number], string>> = {
    override: 'this card',
    taskGroup: 'a task-group rule',
    director: 'a director rule',
    provider: 'a provider rule',
    project: 'this project',
    global: 'your global default'
  }
  return `Inherited from ${label[tier as (typeof APPEARANCE_TIER_ORDER)[number]] ?? 'a rule'}.`
}
