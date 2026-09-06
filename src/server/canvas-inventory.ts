/**
 * The two READ-ONLY Server Edition canvas-control verbs, as pure text/shape builders.
 *
 * Why a separate module rather than more methods on `HeadlessNodeFactory`: everything here is a
 * projection of a `Project` plus three lookups (agent state, agent id, creator ledger). Keeping it
 * pure is what lets the reply TEXT be pinned by unit tests — and the text is the contract, because
 * `nodeterm.sh` prints the handler's `message` verbatim and an agent reads that, not `result`.
 *
 * The line shapes deliberately keep the desktop's prefixes so an agent that learned one edition
 * reads the other:
 *   - `list`  → `<id> [<kind>] <title>` (renderer `Canvas.tsx`, `case 'list'`), then a `|`-separated
 *     tail carrying the three things Server Edition can answer and desktop's list does not print.
 *   - `board` → desktop's `<Column> (n) [column id: …]:` / `  - <title> (id: …)` body verbatim.
 *
 * The one addition on both is a HEADER naming the project. Desktop's `list` has no header because
 * desktop has a current view and the answer is obviously "the canvas you are looking at". Server
 * Edition has no view at all, so an unqualified node list would be a claim with no subject: the
 * project here is defined as the one that owns the CALLING node, and the header says so.
 */
import type { AgentState } from '../shared/agents/normalize'
import type { CanvasNodeState, Project, ProjectKanban } from '../shared/types'

/** One row of the `list` reply. `null` means "not applicable to this node", never "unknown". */
export interface InventoryEntry {
  id: string
  kind: string
  title: string
  /** Parent group FRAME id (`CanvasNodeState.parentId`), or null when the node sits on the root. */
  group: string | null
  /** The agent this node runs, when it runs one — a stored `agentId`, else the hook mirror's. */
  agentId: string | null
  /**
   * Agent-status snapshot state for an agent node: `working` | `waiting` | `blocked` | `done`, or
   * `unknown` when the mirror has never seen this node. `null` for a node that is not an agent at
   * all, because "a sticky note is idle" is a sentence with no meaning.
   *
   * Deliberately the mirror's own four-word vocabulary, not a coarser working/idle pair: `waiting`
   * (the agent is asking the user something) and `blocked` are the two states an orchestrator most
   * needs to tell apart, and collapsing them into "idle" would destroy exactly that distinction.
   */
  status: string | null
  /** True when THIS caller opened the node during THIS server run (the creator ledger). */
  openedByCaller: boolean
}

export interface InventoryLookups {
  /** Hook-mirror agent state for a node, or undefined when nothing has ever been observed. */
  stateOf(nodeId: string): AgentState | undefined
  /** Runtime agent id for a plain terminal that turned out to be running an agent. */
  agentIdOf?(nodeId: string): string | undefined
  /** Creator proof: did `callerNodeId` spawn this node during the current server run? */
  openedByCaller(nodeId: string): boolean
}

/** Node kinds the kanban board treats as CARDS — the server twin of `toKanbanSession`. */
const CARD_KINDS: ReadonlySet<string> = new Set(['terminal', 'sticky', 'browser'])

/**
 * The header both verbs open with. It carries the project AND the reason the project is what it
 * is, because "Server Edition has no current view" is the single fact that makes these two replies
 * differ from their desktop counterparts, and an agent that does not know it will assume the
 * desktop meaning (the canvas the user is looking at) and be wrong.
 */
export function inventoryHeader(what: string, project: Project, callerNodeId: string): string {
  return (
    `${what} in "${project.name}" (project ${project.id}) — Server Edition has no current view, ` +
    `so this is the project that owns the calling node (${callerNodeId}).`
  )
}

export function inventoryEntries(
  project: Project,
  lookups: InventoryLookups
): InventoryEntry[] {
  return project.nodes.map((node) => {
    const agentId = node.agentId || lookups.agentIdOf?.(node.id) || null
    return {
      id: node.id,
      kind: node.kind,
      title: node.title,
      group: node.parentId ?? null,
      agentId,
      status: agentId ? lookups.stateOf(node.id) ?? 'unknown' : null,
      openedByCaller: lookups.openedByCaller(node.id)
    }
  })
}

/**
 * One `list` line. The `<id> [<kind>] <title>` head is desktop's, character for character; the
 * tail is `key=value` pairs so an agent can read a field without a positional guess, and `-`
 * (never a blank) marks a field that does not apply — a blank would be indistinguishable from a
 * field whose value failed to resolve.
 */
export function formatInventoryLine(entry: InventoryEntry): string {
  return (
    `${entry.id} [${entry.kind}] ${entry.title || '(untitled)'}` +
    ` | group=${entry.group ?? '-'}` +
    ` | agent=${entry.agentId ?? '-'}` +
    ` | status=${entry.status ?? '-'}` +
    ` | opened-by-you=${entry.openedByCaller ? 'yes' : 'no'}`
  )
}

export function formatListMessage(
  project: Project,
  callerNodeId: string,
  entries: readonly InventoryEntry[]
): string {
  const lines = [inventoryHeader('Nodes', project, callerNodeId)]
  // A project always contains at least the caller, so the empty branch is defensive rather than
  // reachable — but "no nodes" and "the list failed" must never render the same way.
  if (!entries.length) lines.push('(no nodes)')
  else lines.push(...entries.map(formatInventoryLine))
  return lines.join('\n')
}

/**
 * The board card TITLE for a node, mirroring the renderer's `toKanbanSession` so the two editions
 * cannot disagree about what a card is called. Returns null for a node that is not a card.
 */
export function boardCardTitle(node: CanvasNodeState): string | null {
  if (!CARD_KINDS.has(node.kind)) return null
  if (node.kind === 'browser') return node.title || 'Browser'
  if (node.kind === 'sticky') {
    // A note has no title of its own: its trimmed first line is the label, with a leading markdown
    // heading marker treated as presentation. Same slice(80) bound the renderer applies.
    const text = node.text ?? ''
    const firstLine = text.trim().split('\n')[0] ?? ''
    return firstLine.replace(/^#{1,6}\s+/, '').trim().slice(0, 80) || 'Note'
  }
  return node.title || 'Untitled'
}

/** Node ids assigned to `columnId`, in board order. Twin of the renderer's `assignedTo`. */
export function assignedToColumn(board: ProjectKanban, columnId: string): string[] {
  return board.assignments.filter((a) => a.columnId === columnId).map((a) => a.nodeId)
}

/**
 * Card ids with no LIVE assignment — never assigned, or assigned to a column that no longer
 * exists (a merge can keep the assignment and lose the column). Twin of the renderer's
 * `unassigned`; order follows `cardIds`, which is canvas order.
 */
export function unassignedCards(board: ProjectKanban, cardIds: readonly string[]): string[] {
  const columns = new Set(board.columns.map((c) => c.id))
  const assigned = new Set(
    board.assignments.filter((a) => columns.has(a.columnId)).map((a) => a.nodeId)
  )
  return cardIds.filter((id) => !assigned.has(id))
}

export interface BoardColumnView {
  id: string
  title: string
  cards: string[]
}

export interface BoardView {
  columns: BoardColumnView[]
  ungrouped: string[]
  /** Card id → card label, for rendering. */
  titles: Map<string, string>
  /** True when this project's file carries no kanban board at all. */
  noColumns: boolean
}

export function buildBoardView(project: Project): BoardView {
  const titles = new Map<string, string>()
  const cardIds: string[] = []
  for (const node of project.nodes) {
    const title = boardCardTitle(node)
    if (title === null) continue
    cardIds.push(node.id)
    titles.set(node.id, title || 'Untitled')
  }
  const board = project.kanban
  if (!board) return { columns: [], ungrouped: cardIds, titles, noColumns: true }
  return {
    // A dangling assignment (a card the canvas no longer has) is dropped rather than printed as a
    // phantom id, exactly as the renderer's `titleOf.has(id)` filter does.
    columns: board.columns.map((column) => ({
      id: column.id,
      title: column.title,
      cards: assignedToColumn(board, column.id).filter((id) => titles.has(id))
    })),
    ungrouped: unassignedCards(board, cardIds),
    titles,
    noColumns: false
  }
}

/**
 * Server Edition v1 has no way to CREATE columns: `assign` is not implemented here and the column
 * editor lives in the browser UI. So a project whose file has never carried a board renders one
 * virtual Ungrouped column and says why, rather than inventing the lazy default three columns the
 * renderer shows — inventing them would name column ids that exist nowhere and that no server verb
 * could ever move a card into.
 */
export const SERVER_BOARD_NO_COLUMNS_NOTE =
  'Server Edition v1 has no columns yet — this project has no kanban board on disk, so every ' +
  'session card is Ungrouped. Columns appear once the board is edited in the browser UI; there ' +
  'is no `assign` verb on this edition.'

export function formatBoardMessage(
  project: Project,
  callerNodeId: string,
  view: BoardView
): string {
  const label = (id: string): string => `  - ${view.titles.get(id) ?? id} (id: ${id})`
  const lines = [inventoryHeader('Kanban board', project, callerNodeId)]
  if (view.noColumns) lines.push(SERVER_BOARD_NO_COLUMNS_NOTE)
  else {
    for (const column of view.columns) {
      lines.push(`${column.title} (${column.cards.length}) [column id: ${column.id}]:`)
      lines.push(...column.cards.map(label))
    }
  }
  lines.push(`Ungrouped (${view.ungrouped.length}):`)
  lines.push(...view.ungrouped.map(label))
  return lines.join('\n')
}
