import { Fragment, memo, useLayoutEffect, useRef, useState } from 'react'
import type { KanbanColumn as KanbanColumnT } from '@shared/types'
import { NODE_COLORS } from '../../state/workspace'
import type { KanbanCreateChoice, KanbanCreateOption } from './KanbanView'
import { byLane, type KanbanSourceId } from '../../lib/kanbanSources'

/** One source's contribution to one column. The board builds the cards (each source renders its
 *  own leaf); the column only places the lanes, so it knows nothing about where a card came from
 *  beyond the registry's stacking order. */
export interface KanbanLane {
  sourceId: KanbanSourceId
  /** This lane's cards, already keyed by the board. */
  cards: React.ReactNode
  /** Trailing affordance under the lane's cards (e.g. GitHub's "Show more issues"). */
  footer?: React.ReactNode
  /** What this lane adds to the column's header count. Not `cards.length`: a provider-placed
   *  source reports a server-side total that can exceed the page it has fetched. */
  count: number
}

interface KanbanColumnProps {
  /** null = the virtual Ungrouped column: fixed label, no rename/recolor/delete, header not draggable. */
  column: KanbanColumnT | null
  /** The column's card lanes, one per visible source; placed in registry lane order. */
  lanes: KanbanLane[]
  // Column-scoped callbacks carry the column id so KanbanView can hand every column the SAME
  // function references — that identity stability is what lets memo() skip untouched columns.
  onRename?: (columnId: string, title: string) => void
  onRecolor?: (columnId: string, color: string) => void
  onDelete?: (columnId: string) => void
  /** "+ New" menu entries (agents, terminal, sticky) and what to do when one is picked
   *  (columnId null = Ungrouped: no assignment). */
  createOptions: KanbanCreateOption[]
  onCreate: (choice: KanbanCreateChoice, columnId: string | null) => void
  // Drag plumbing — the single drag source of truth lives in KanbanView.
  onColumnDragStart?: (columnId: string) => void
  onDragEnd: () => void
  /** Drop on the column body: a card lands at the END of this column; a column lands BEFORE it. */
  onDropOnColumn: (columnId: string | null) => void
}

export function NewSessionMenu({ columnId, createOptions, onCreate, label = '+ New session' }: Pick<KanbanColumnProps, 'createOptions' | 'onCreate'> & {
  columnId: string | null
  label?: string
}) {
  const [newMenuOpen, setNewMenuOpen] = useState(false)
  // The "+ New session" menu normally drops DOWN (top:100%); a column near the window's bottom edge
  // would push it off-screen, so we flip it UP when it doesn't fit below. Measured on open.
  const [menuUp, setMenuUp] = useState(false)
  const newMenuRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    if (!newMenuOpen) {
      setMenuUp(false)
      return
    }
    const el = newMenuRef.current
    if (!el) return
    // Measured while rendered DOWN. If its bottom clears the viewport AND there's more room above
    // the trigger than below it, flip up. (getBoundingClientRect includes the current position.)
    const rect = el.getBoundingClientRect()
    const overflowsBelow = rect.bottom > window.innerHeight - 8
    const spaceAbove = rect.top // menu top ≈ just under the button
    const spaceBelow = window.innerHeight - rect.top
    if (overflowsBelow && spaceAbove > spaceBelow) setMenuUp(true)
  }, [newMenuOpen])

  return (
    <div className="kanban-col__footer">
      {newMenuOpen && (
        <div ref={newMenuRef} className={menuUp ? 'kanban-col__newmenu kanban-col__newmenu--up' : 'kanban-col__newmenu'}>
          {createOptions.map((o) => (
            <button
              key={o.key}
              onClick={() => {
                setNewMenuOpen(false)
                onCreate(o.choice, columnId)
              }}
            >
              <span className="kanban-col__newicon">{o.icon}</span>
              {o.label}
            </button>
          ))}
        </div>
      )}
      <button className="kanban-col__new" aria-expanded={newMenuOpen} onClick={() => setNewMenuOpen((v) => !v)}>
        {label}
      </button>
    </div>
  )
}

export const KanbanColumn = memo(function KanbanColumn({
  column, lanes, onRename, onRecolor, onDelete,
  createOptions, onCreate, onColumnDragStart, onDragEnd, onDropOnColumn
}: KanbanColumnProps) {
  const [editingTitle, setEditingTitle] = useState(false)
  const [title, setTitle] = useState(column?.title ?? '')
  const [swatchesOpen, setSwatchesOpen] = useState(false)
  // Trello-style drop highlight: counted enter/leave (dragleave fires when crossing children).
  const [dragOverCount, setDragOverCount] = useState(0)

  const colId = column?.id ?? null
  const orderedLanes = byLane(lanes)
  const count = lanes.reduce((total, lane) => total + lane.count, 0)

  const commitTitle = () => {
    const t = title.trim()
    if (column && t && t !== column.title) onRename?.(column.id, t)
    setEditingTitle(false)
  }

  return (
    <div
      className={`kanban-col${column ? '' : ' kanban-col--ungrouped'}${dragOverCount > 0 ? ' kanban-col--drop' : ''}`}
      onDragOver={(e) => e.preventDefault()}
      onDragEnter={() => setDragOverCount((c) => c + 1)}
      onDragLeave={() => setDragOverCount((c) => Math.max(0, c - 1))}
      onDrop={(e) => {
        e.preventDefault()
        setDragOverCount(0)
        onDropOnColumn(colId)
      }}
    >
      <div
        className="kanban-col__header"
        draggable={!!column}
        onDragStart={(e) => {
          if (!column) return
          e.dataTransfer.effectAllowed = 'move'
          onColumnDragStart?.(column.id)
        }}
        onDragEnd={onDragEnd}
      >
        {column ? (
          <button
            className="kanban-col__dot"
            style={{ background: column.color }}
            title="Column color"
            onClick={() => setSwatchesOpen((v) => !v)}
          />
        ) : (
          <span className="kanban-col__dot kanban-col__dot--ungrouped" />
        )}
        {column && editingTitle ? (
          <input
            className="kanban-col__rename"
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitTitle()
              if (e.key === 'Escape') setEditingTitle(false)
            }}
          />
        ) : (
          <span
            className="kanban-col__title"
            onClick={() => {
              if (!column) return
              setTitle(column.title)
              setEditingTitle(true)
            }}
          >
            {column ? column.title : 'Ungrouped'}
          </span>
        )}
        <span className="kanban-col__count">{count}</span>
        {column && (
          <button
            className="kanban-col__close"
            title="Delete column (cards return to Ungrouped)"
            onClick={() => onDelete?.(column.id)}
          >
            ✕
          </button>
        )}
      </div>
      {column && swatchesOpen && (
        <div className="kanban-col__swatches">
          {NODE_COLORS.map((c) => (
            <button
              key={c}
              className="kanban-col__swatch"
              style={{ background: c }}
              onClick={() => {
                if (column) onRecolor?.(column.id, c)
                setSwatchesOpen(false)
              }}
            />
          ))}
        </div>
      )}
      <div className="kanban-col__cards">
        {orderedLanes.map((lane) => (
          <Fragment key={lane.sourceId}>
            {lane.cards}
            {lane.footer}
          </Fragment>
        ))}
      </div>
      <NewSessionMenu columnId={colId} createOptions={createOptions} onCreate={onCreate} />
    </div>
  )
})
