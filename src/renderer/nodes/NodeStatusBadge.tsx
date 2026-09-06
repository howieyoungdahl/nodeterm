// The status badge, bound to one node.
//
// It exists as its own component so the SUBSCRIPTIONS live where the value is read — the same rule
// `PresenceChips` and the kanban `SessionCard` already follow. The badge needs two things that
// change on their own: the agent-status table (every hook event) and a clock (freshness ages, and a
// state goes stale with no event to announce it). Subscribing to either from `TerminalNode` would
// re-render that whole component — and, for the clock, would do it on every node on the canvas
// every 15 seconds, including the ones that show no badge at all.

import type { AgentId } from '@shared/agents/config'
import { StatusBadge } from '../components/StatusBadge'
import { statusViewFor } from '../lib/nodeStatusView'
import { useStatusNow } from '../lib/statusClock'
import { useAgentStatus } from '../state/agentStatus'
import { AgentMascot } from './AgentMascot'

export function NodeStatusBadge({
  nodeId,
  agentId,
  agentLabel,
  compact
}: {
  nodeId: string
  agentId?: AgentId
  agentLabel?: string
  /** Kanban cards: keep the reason in the tooltip, the row is too narrow for it inline. */
  compact?: boolean
}) {
  const status = useAgentStatus((s) => s.byId[nodeId])
  const view = statusViewFor(status, useStatusNow())
  return (
    <StatusBadge
      view={view}
      agentLabel={agentLabel}
      compact={compact}
      // The walking mascot the RUNNING chip always carried, kept where it belongs: on the one
      // state that is actually in motion.
      leading={view.kind === 'working' && !compact ? <AgentMascot agentId={agentId} /> : null}
    />
  )
}
