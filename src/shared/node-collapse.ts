// A GROUP FRAME IS A CONTAINER, AND A CONTAINER HAS NO COLLAPSIBLE BODY.
//
// Collapsing a card means "hide my body, keep my header" — a card's height is its own business.
// A FRAME's height is not: every parented node is emitted with `extent: 'parent'`, so React Flow
// clamps each child into the frame's rect (`clampPositionToParent` in `@xyflow/system`:
// `y = clamp(y, top, top + frameHeight - childHeight)`). Shrink the frame to `COLLAPSED_HEIGHT`
// (40) and that range INVERTS for any child taller than 40px — `40 - 440 = -400` — so `Math.min`
// wins unconditionally and EVERY member is pinned to the same constant `frameTop - 400`. The
// members stack on one horizontal line, overlapping each other, and an ordinary autosave then
// writes those clamped positions back to `project.json`. Measured on a real canvas: nine members,
// six overlapping pairs, from saved geometry with zero overlaps.
//
// `data.collapsed` on a group was never a feature either way — `GroupNode.tsx` does not read it;
// the 40px height was the flag's ONLY effect. So card semantics leaked onto a container whose
// height is its children's clamp bounds, and the leak had no upside to weigh against.
//
// The rule this states: `collapsed` never shrinks a group. One predicate rather than an inline
// `type !== 'group'` at each of the four sites that turn the flag into a height, because four
// copies of a rule is how one of them gets missed.
//
// STILL UNBUILT: a real "put the members away" affordance for a frame. It cannot be a height
// change for the reason above; it would have to hide or shrink the MEMBERS (the compact/put-away
// toggle a card already has, applied to a frame's contents) and leave the container's rect alone.
// Until that exists, a spawn tray is a labelled frame around cards that are all visible.

import type { NodeKind } from './types'

/**
 * Whether `collapsed` may shrink a node of this kind. Everything except a group frame; an absent
 * kind reads as `terminal`, matching every other legacy-node default in the serializers.
 */
export function isCollapsibleKind(kind: NodeKind | string | undefined): boolean {
  return (kind ?? 'terminal') !== 'group'
}
