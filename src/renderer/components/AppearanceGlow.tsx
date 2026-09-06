/**
 * The optional glow of a node's or frame's resolved appearance, as its own element.
 *
 * A SIBLING of the node root, not a pseudo-element on it, for two measured reasons this codebase
 * already carries elsewhere: `.term-node` is `overflow: hidden` and would clip its own `::after`
 * (the reason `ColumnPill` is a sibling too), and the wrapper's `::after` is already spoken for by
 * the unread / working / attention status glows — a preference must never be able to suppress a
 * status signal by competing for the same slot. A separate element composes with all of them.
 *
 * It also cannot use the wrapper: CSS custom properties inherit DOWN, and the appearance vars are
 * set on the node, so a `.react-flow__node:has(…)::before` rule could not read them.
 *
 * Never animated. The existing status glows pulse because a state is changing; a border preference
 * is not an event, and a canvas of forty steadily-pulsing terminals is the thing "reduce motion"
 * exists to escape.
 */
export function AppearanceGlow({
  style,
  variant
}: {
  /** The `--nt-appearance-*` custom properties from `appearanceAttrs`. */
  style: Record<string, string>
  /** Picks the corner radius, which has to match the surface it sits behind. */
  variant: 'node' | 'group'
}): React.JSX.Element {
  return (
    <div
      className={`appearance-glow appearance-glow--${variant}`}
      style={style}
      aria-hidden="true"
    />
  )
}
