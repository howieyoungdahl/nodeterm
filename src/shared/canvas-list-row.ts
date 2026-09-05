/**
 * The one definition of a canvas-control `list` row.
 *
 * `list` is the verb an orchestrating agent calls before it does anything else, and its cost is
 * LINEAR in node count — so every byte here is paid once per node, per call, in someone's context
 * window. That is the whole reason this is a module with a measurement rather than a template
 * literal inside a 10,000-line switch: the row shape is a context-budget decision, and the
 * agent-facing help text in `core/canvas-control-core.ts` is DERIVED from the field names below so
 * a change to the row cannot leave the documentation describing a row that no longer exists.
 *
 * ── WHAT THE ROW CARRIES, AND WHY ───────────────────────────────────────────────────────────────
 * `id [kind] title` is what a reader needs to address a node, and it is unchanged.
 *
 * The optional fields answer the question the old row forced a second call to answer: HOW DO THESE
 * NODES RELATE. A fan-out of a dozen sessions came back as a flat list with no parent, no task and
 * no grouping, so an agent that had just opened half of them could not tell which half — and the
 * one hop of hierarchy that already exists in the runtime (who opened whom) was thrown away.
 *
 *  - `opened-by=<id>` — the node that opened this one, from the creator ledger.
 *  - `task=<id>` — the task a registry projection names this node as belonging to.
 *
 * ── BOTH ARE OMITTED WHEN UNKNOWN, AND THAT IS LOAD-BEARING ────────────────────────────────────
 * Omitted, not `-`, not `unknown`:
 *
 *  1. A node with neither field renders BYTE-IDENTICALLY to the pre-change row. On a canvas of
 *     hand-opened nodes — the common case — the verb costs exactly what it did before, which is the
 *     "shorter or equal in the common case" rule this row is held to.
 *  2. A creator ledger is process-local and fails closed: after a restart nothing is proven, and a
 *     placeholder would read as a positive statement ("this node has no parent") where the truth is
 *     "we cannot say". Never fabricate the hop — a reader that trusts an invented parent builds the
 *     wrong tree and has no way to find out.
 */

/** The `opened-by` field's name, in the row and in the generated help text. */
export const LIST_FIELD_OPENED_BY = 'opened-by'
/** The `task` field's name, in the row and in the generated help text. */
export const LIST_FIELD_TASK = 'task'
/** Suffix marking a station whose last turn died on an API/model error (issue #521). */
export const LIST_MARKER_LAST_TURN_ERRORED = ' — LAST TURN ERRORED'

export interface CanvasListRow {
  id: string
  /** React Flow node type: `terminal`, `sticky`, `group`, … */
  kind: string | undefined
  title: string | undefined
  /** The node that opened this one, when the creator ledger can prove it. */
  openedBy?: string
  /** The task a registry projection names this node as belonging to. Never inferred. */
  taskId?: string
  lastTurnErrored?: boolean
}

/**
 * One row. Fields are appended in a fixed order so a reader can split on ` ` + `<name>=` without
 * having to parse; the error marker stays LAST, where every existing consumer already expects it.
 *
 * An empty or whitespace-only field value is treated as absent: these values come from a canvas
 * whose `project.json` is git-shared and hand-editable, and `opened-by=` with nothing after it is
 * worse than no field at all.
 */
export function renderCanvasListRow(row: CanvasListRow): string {
  const parts = [`${row.id} [${row.kind ?? 'node'}] ${row.title ?? ''}`.trimEnd()]
  const openedBy = row.openedBy?.trim()
  if (openedBy) parts.push(`${LIST_FIELD_OPENED_BY}=${openedBy}`)
  const taskId = row.taskId?.trim()
  if (taskId) parts.push(`${LIST_FIELD_TASK}=${taskId}`)
  return parts.join(' ') + (row.lastTurnErrored ? LIST_MARKER_LAST_TURN_ERRORED : '')
}

/** The whole `list` reply body. */
export function renderCanvasList(rows: readonly CanvasListRow[]): string {
  return rows.map(renderCanvasListRow).join('\n')
}

/**
 * The row's description for the agent-facing help text, derived here so the two generated bodies in
 * `core/canvas-control-core.ts` cannot drift from what `renderCanvasListRow` emits. Returned as
 * lines because both call sites assemble their bodies line by line.
 */
export function listRowHelpLines(): string[] {
  return [
    `  Each row is \`id [kind] title\`, then \`${LIST_FIELD_OPENED_BY}=<id>\` when this canvas can prove which`,
    '  node opened this one, then',
    `  \`${LIST_FIELD_TASK}=<id>\` when a task registry names it. Both are OPTIONAL and are omitted — never`,
    '  guessed — when unknown, so a missing field means "not recorded here", not "no parent" and not',
    '  "no task". Use `opened-by` to rebuild the fan-out tree instead of asking each node in turn.'
  ]
}
