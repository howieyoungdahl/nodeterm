// What the layout engine is about to do, and what it refused — as a table the operator reads
// before anything moves.
//
// The refusal half is not an appendix. An automatic layout feature is only usable if you can see
// that it left your own workspace alone, so "6 changes" and "4 left alone, because…" are given the
// same weight, and a plan with NO changes still renders its refusals rather than reporting
// nothing. A plan the operator cannot audit is one they will turn off.

import {
  LAYOUT_SKIP_LABELS,
  describeLayoutOp,
  opsByNode,
  type LayoutPlan
} from '@shared/canvas-layout'

export interface LayoutPlanTableProps {
  plan: LayoutPlan
  /** Node id → the name to show. A node that vanished between plan and preview keeps its id. */
  titleOf: (nodeId: string) => string
}

export function LayoutPlanTable({ plan, titleOf }: LayoutPlanTableProps) {
  const changes = opsByNode(plan)
  return (
    <div className="layout-plan">
      <div className="layout-plan__section">
        <div className="layout-plan__heading">
          {changes.length ? `${changes.length} to change` : 'Nothing to change'}
        </div>
        {changes.map(({ nodeId, ops }) => (
          <div className="layout-plan__row" key={nodeId}>
            <span className="layout-plan__name">{titleOf(nodeId)}</span>
            <span className="layout-plan__what">
              {ops.map((op) => describeLayoutOp(op)).join(' · ')}
            </span>
          </div>
        ))}
      </div>
      {plan.skipped.length > 0 && (
        <div className="layout-plan__section">
          <div className="layout-plan__heading">{plan.skipped.length} left alone</div>
          {plan.skipped.map((skip) => (
            <div className="layout-plan__row layout-plan__row--skipped" key={skip.nodeId}>
              <span className="layout-plan__name">{titleOf(skip.nodeId)}</span>
              <span className="layout-plan__what">{LAYOUT_SKIP_LABELS[skip.reason]}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
