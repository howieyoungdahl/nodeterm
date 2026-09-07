/**
 * Container-scoped layout geometry: `arrange`, `align`, and the one-container rule both depend on.
 *
 * This lives in `src/shared` because BOTH canvases run it. The renderer applies it to React Flow
 * nodes (`renderer/state/workspace.ts`), and the Server Edition's headless factory applies it to
 * persisted `CanvasNodeState` records — the same verbs, the same refusals, on a host with no
 * renderer at all. The two shapes disagree about where a node's size lives (React Flow measures it
 * at runtime; the persisted record carries `size`), so the geometry is written against a minimal
 * `ArrangeSubject` and each side adapts into it.
 *
 * Everything here returns a POSITION MAP rather than a new node array. That is what lets each
 * caller keep its own record shape — and its own array identity on a no-op, which the renderer's
 * callers test for with `toBe(nodes)`.
 *
 * Positions are only comparable inside one container: a top-level node's position is absolute, a
 * frame child's is relative to its frame. So a set spanning two containers is refused (an empty
 * map) rather than scrambled — see `commonContainerOf`.
 */

export type ArrangeLayout = 'grid' | 'row' | 'column'
export type AlignEdge = 'left' | 'right' | 'top' | 'bottom' | 'hcenter' | 'vcenter'

export const ARRANGE_LAYOUTS: readonly ArrangeLayout[] = ['grid', 'row', 'column']
export const ALIGN_EDGES: readonly AlignEdge[] = [
  'left',
  'right',
  'top',
  'bottom',
  'hcenter',
  'vcenter'
]

export function isArrangeLayout(value: unknown): value is ArrangeLayout {
  return typeof value === 'string' && (ARRANGE_LAYOUTS as readonly string[]).includes(value)
}

export function isAlignEdge(value: unknown): value is AlignEdge {
  return typeof value === 'string' && (ALIGN_EDGES as readonly string[]).includes(value)
}

/** The only facts layout needs: identity, container, top-left, and a measured box. */
export interface ArrangeSubject {
  id: string
  /** The containing frame, or null/undefined for a top-level node. */
  parentId?: string | null
  position: { x: number; y: number }
  width: number
  height: number
}

export interface ArrangeOptions {
  layout?: ArrangeLayout
  cols?: number
  gap?: number
  origin?: { x: number; y: number }
}

const DEFAULT_GAP = 40

function membersOf(
  subjects: readonly ArrangeSubject[],
  ids: readonly string[]
): ArrangeSubject[] | null {
  const wanted = new Set(ids)
  const members = subjects.filter((subject) => wanted.has(subject.id))
  if (!members.length) return null
  // Mixed containers have no shared coordinate space — refuse rather than scramble.
  if (new Set(members.map((member) => member.parentId ?? null)).size > 1) return null
  return members
}

/**
 * The single container the given ids all live in: `null` (all top-level), a frame id (all children
 * of that one frame), or `undefined` when they resolve to no subject OR span more than one
 * container (a frame's children mixed with top-level nodes, or two different frames).
 */
export function commonContainerOf(
  subjects: readonly ArrangeSubject[],
  ids: readonly string[]
): string | null | undefined {
  const members = membersOf(subjects, ids)
  if (!members) return undefined
  return members[0].parentId ?? null
}

/**
 * Non-overlapping layout for the given ids, starting at `origin` (default: the bounding-box
 * top-left of their current positions). 'row' packs left-to-right, 'column' top-to-bottom, 'grid'
 * wraps at `cols` (default ~square) with each row advancing by its tallest member. Unknown ids are
 * skipped; a mixed-container or empty set yields an EMPTY map (the caller's no-op). Pure and
 * deterministic.
 */
export function arrangePositions(
  subjects: readonly ArrangeSubject[],
  ids: readonly string[],
  opts?: ArrangeOptions
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>()
  const members = membersOf(subjects, ids)
  if (!members) return positions
  const layout = opts?.layout ?? 'grid'
  const gap = opts?.gap ?? DEFAULT_GAP
  const origin = opts?.origin ?? {
    x: Math.min(...members.map((member) => member.position.x)),
    y: Math.min(...members.map((member) => member.position.y))
  }
  const cols =
    layout === 'row'
      ? members.length
      : layout === 'column'
        ? 1
        : Math.max(1, opts?.cols ?? Math.ceil(Math.sqrt(members.length)))

  let x = origin.x
  let y = origin.y
  let rowH = 0
  members.forEach((member, index) => {
    if (index > 0 && index % cols === 0) {
      x = origin.x
      y += rowH + gap
      rowH = 0
    }
    positions.set(member.id, { x, y })
    x += member.width + gap
    rowH = Math.max(rowH, member.height)
  })
  return positions
}

/**
 * Snap the given ids to a shared edge/center computed from their joint bounding box.
 * left/right/hcenter move x; top/bottom/vcenter move y. Same one-container rule as
 * `arrangePositions`; a mixed or empty set yields an EMPTY map.
 */
export function alignPositions(
  subjects: readonly ArrangeSubject[],
  ids: readonly string[],
  edge: AlignEdge
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>()
  const members = membersOf(subjects, ids)
  if (!members) return positions
  const minX = Math.min(...members.map((member) => member.position.x))
  const maxR = Math.max(...members.map((member) => member.position.x + member.width))
  const minY = Math.min(...members.map((member) => member.position.y))
  const maxB = Math.max(...members.map((member) => member.position.y + member.height))
  const cx = (minX + maxR) / 2
  const cy = (minY + maxB) / 2
  for (const member of members) {
    switch (edge) {
      case 'left':
        positions.set(member.id, { x: minX, y: member.position.y })
        break
      case 'right':
        positions.set(member.id, { x: maxR - member.width, y: member.position.y })
        break
      case 'hcenter':
        positions.set(member.id, { x: cx - member.width / 2, y: member.position.y })
        break
      case 'top':
        positions.set(member.id, { x: member.position.x, y: minY })
        break
      case 'bottom':
        positions.set(member.id, { x: member.position.x, y: maxB - member.height })
        break
      case 'vcenter':
        positions.set(member.id, { x: member.position.x, y: cy - member.height / 2 })
        break
    }
  }
  return positions
}
