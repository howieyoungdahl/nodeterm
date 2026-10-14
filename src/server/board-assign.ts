/**
 * Pure kanban-board transforms for the Server Edition `assign` verb.
 *
 * Server code may not import from `src/renderer` (tsconfig.node.json excludes it), so these are
 * the server-side twins of the renderer's `resolveColumnRef` / `assignNode` / `addColumn`
 * (`src/renderer/lib/kanban.ts`), the same precedent `canvas-inventory.ts` follows for the board
 * READ path. The semantics are copied on purpose, not redesigned: an agent that learned `assign`
 * on the desktop must get the same answer here. Every function returns a new board and never
 * mutates its input.
 */
import { randomBytes } from 'node:crypto'

import { withManualAssignment } from '../shared/kanban-organization'
import { NODE_COLORS } from '../shared/node-colors'
import type { KanbanAssignment, KanbanColumn, ProjectKanban } from '../shared/types'

/** Why a GitHub-synced board cannot grow a column from the control plane. */
export const GITHUB_BOARD_CREATE_REFUSAL =
  'assign --create is not available on a GitHub-synced board; add the column in the browser UI'

/**
 * Resolve a user-supplied column reference to a column id.
 *
 * - empty or `ungrouped` (case-insensitive) -> `null` (the virtual Ungrouped column = unassign)
 * - exact column id, then case-insensitive title -> that column's id
 * - anything else -> `undefined`, so the caller can tell "no such column" from "Ungrouped"
 *
 * A project with no board yet resolves like a board with no columns.
 */
export function resolveBoardColumn(
  board: ProjectKanban | undefined,
  ref: string
): string | null | undefined {
  const raw = ref.trim()
  if (!raw || raw.toLowerCase() === 'ungrouped') return null
  const columns = board?.columns ?? []
  const byId = columns.find((column) => column.id === raw)
  if (byId) return byId.id
  const byTitle = columns.find((column) => column.title.toLowerCase() === raw.toLowerCase())
  return byTitle ? byTitle.id : undefined
}

/**
 * Assign or move one session card. `columnId` null = back to Ungrouped (the assignment is
 * dropped; Ungrouped order is canvas order, so `beforeNodeId` is ignored there). Otherwise the card
 * is inserted before `beforeNodeId`'s assignment when that assignment is in the target column, else
 * appended. An unknown target column is a no-op, and so is `nodeId === beforeNodeId`.
 */
export function assignBoardCard(
  board: ProjectKanban,
  nodeId: string,
  columnId: string | null,
  beforeNodeId: string | null
): ProjectKanban {
  if (nodeId === beforeNodeId) return board
  const without = board.assignments.filter((assignment) => assignment.nodeId !== nodeId)
  if (columnId === null) return withManualAssignment({ ...board, assignments: without }, nodeId)
  if (!board.columns.some((column) => column.id === columnId)) return board
  const moved: KanbanAssignment = { nodeId, columnId }
  const before = beforeNodeId
    ? without.find((assignment) => assignment.nodeId === beforeNodeId && assignment.columnId === columnId)
    : undefined
  const index = before ? without.indexOf(before) : -1
  const at = index === -1 ? without.length : index
  return withManualAssignment(
    { ...board, assignments: [...without.slice(0, at), moved, ...without.slice(at)] },
    nodeId
  )
}

/** `kcol-` plus eight base36 characters, the renderer's id shape, distinct from `taken`. */
function newColumnId(taken: ReadonlySet<string>): string {
  for (;;) {
    let suffix = ''
    for (const byte of randomBytes(8)) suffix += (byte % 36).toString(36)
    const id = `kcol-${suffix}`
    if (!taken.has(id)) return id
  }
}

export type AddBoardColumnResult =
  | { ok: true; board: ProjectKanban; column: KanbanColumn }
  | { ok: false; error: string }

/**
 * Append a column titled `title` to `board` (an absent board becomes a one-column board). The color
 * cycles the node palette by the number of existing columns, as the renderer's `nextColumnColor`
 * does.
 *
 * A GitHub-synced board is refused: its columns map to issue labels, and the renderer's `addColumn`
 * keeps `github.columnMappings` in step with every new column. That bookkeeping is the browser's
 * job; adding a bare column here would leave a column the sync cannot map.
 */
export function addBoardColumn(board: ProjectKanban | undefined, title: string): AddBoardColumnResult {
  if (board?.github) return { ok: false, error: GITHUB_BOARD_CREATE_REFUSAL }
  const base: ProjectKanban = board ?? { columns: [], assignments: [] }
  const column: KanbanColumn = {
    id: newColumnId(new Set(base.columns.map((existing) => existing.id))),
    title,
    color: NODE_COLORS[base.columns.length % NODE_COLORS.length]
  }
  return { ok: true, board: { ...base, columns: [...base.columns, column] }, column }
}

/**
 * Read `--create`. The POSIX shim sends a flag with no value as the empty string (`--create` ->
 * `create: ''`), and the long-standing `--flag yes` form is the other spelling agents use, so both
 * count, as do `true`/`1`. An explicit negative leaves it off. Anything else is ambiguous (the
 * peek in the shim would also swallow a stray word that follows the flag), so it is refused rather
 * than guessed at.
 */
export function parseCreateFlag(value: string | undefined): boolean | undefined {
  if (value === undefined) return false
  const raw = value.trim().toLowerCase()
  if (['', 'true', 'yes', '1'].includes(raw)) return true
  if (['false', 'no', '0'].includes(raw)) return false
  return undefined
}
