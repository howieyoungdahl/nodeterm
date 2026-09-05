// The status badge — one component, two surfaces: a node header and a group frame's label.
//
// It renders GLYPH + WORD + AGE, and a `stale` word when the state is old news. Colour is
// redundant encoding only: every distinction here is already carried by the glyph and the word, so
// the badge survives a colourblind reader, a monochrome screenshot and effects-off. The rule is
// enforced in `shared/node-status.ts` and pinned by its test — do not add a state whose only
// difference is a CSS class.
//
// It states nothing it was not told. The reason line is the hook event's own text (truncated); a
// state with no reason shows the state alone rather than a plausible sentence. `unknown` is a
// visible word, never an empty header.

import type { ReactNode } from 'react'
import type { NodeStatusRollUp, NodeStatusView } from '@shared/node-status'

/** One shared class per state, so the node badge and the frame badge cannot drift apart. */
export function statusClass(kind: NodeStatusView['kind']): string {
  return `nt-status nt-status--${kind}`
}

export function StatusBadge({
  view,
  agentLabel,
  leading,
  compact
}: {
  view: NodeStatusView
  /** For the tooltip's first clause ("Claude is working"), when the caller knows the agent. */
  agentLabel?: string
  /** Optional decoration before the glyph — the node header keeps its walking agent mascot here. */
  leading?: ReactNode
  /** Drop the inline reason (it stays in the tooltip) where the row is too narrow for it — a
   *  kanban card. The state, its freshness and the stale mark are never dropped. */
  compact?: boolean
}) {
  const title = agentLabel ? `${agentLabel} — ${view.detail}` : view.detail
  return (
    <span className={statusClass(view.kind)} title={title} data-status={view.kind}>
      {leading}
      <span className="nt-status__glyph" aria-hidden="true">
        {view.glyph}
      </span>
      <span className="nt-status__word">{view.word}</span>
      {view.age ? <span className="nt-status__age">{view.age}</span> : null}
      {view.stale ? <span className="nt-status__stale">stale</span> : null}
      {view.reason && !compact ? (
        <span className="nt-status__reason" title={view.reason}>
          {view.reason}
        </span>
      ) : null}
    </span>
  )
}

/**
 * The frame's rolled-up badge. Worst member state wins, and the count says how many members are in
 * it — so a closed tray reads `! BLOCKED 2/5` rather than making the operator open it to find out
 * that two sessions are waiting on an approval.
 */
export function GroupStatusBadge({ rollUp }: { rollUp: NodeStatusRollUp }) {
  return (
    <span
      className={`${statusClass(rollUp.kind)} nt-status--rollup`}
      title={`${rollUp.count} of ${rollUp.total} session(s) in this frame: ${rollUp.word.toLowerCase()}`}
      data-status={rollUp.kind}
    >
      <span className="nt-status__glyph" aria-hidden="true">
        {rollUp.glyph}
      </span>
      <span className="nt-status__word">{rollUp.word}</span>
      <span className="nt-status__age">
        {rollUp.count}/{rollUp.total}
      </span>
    </span>
  )
}
