import { randomUUID } from 'node:crypto'
import { normalizeFor, type NormalizedAgentEvent } from '../shared/agents/normalize'
import { CLAUDE_HOOK_EVENTS } from '../shared/agents/hook-events'
import { CODEX_EVENTS } from './agents/hooks/codex'
import type { OperatorSessionTarget } from '../shared/operator-conversations'

interface BoundSession {
  sessionId: string
  agentId: string
  generation: string
  transcriptPath?: string
}

export interface OperatorProject {
  id: string
  nodes: readonly { id: string; kind: string }[]
}

export class OperatorTargetError extends Error {
  constructor(public code: string, public status = 409) { super(code) }
}

export function safeOperatorId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9._-]{1,200}$/.test(value)
}

export function isOperatorTarget(value: unknown): value is OperatorSessionTarget {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const o = value as Record<string, unknown>
  return Object.keys(o).length === 4 &&
    ['projectId', 'nodeId', 'sessionId', 'generation'].every((key) => safeOperatorId(o[key]))
}

/** Current-run verified hooks are authority. Restored mirror files never establish a binding. */
export class OperatorSessionBindings {
  private readonly bootId = randomUUID()
  private readonly sessions = new Map<string, BoundSession>()

  /** Discovery uses authenticated native hooks, including ones with no UI state transition.
   * Apply lifecycle and its path together: raw listeners run before the normalized UI stream,
   * and attaching to the previous generation loses the first/resume path on rotation. */
  observeHook(agentId: string, nodeId: string, payload: Record<string, unknown>, verified: boolean,
    transcriptPath?: string): void {
    // A Codex child's session_id is its parent's, but transcript_path belongs to the child.
    if (agentId === 'codex' && payload.agent_id !== undefined) return
    const normalized = normalizeFor(agentId, { agentId, nodeId, payload })
    const eventName = payload.hook_event_name ?? (agentId === 'codex' ? payload.hookEventName : undefined)
    const recognized = typeof eventName === 'string' && (
      agentId === 'claude' ? (CLAUDE_HOOK_EVENTS as readonly string[]).includes(eventName) :
      agentId === 'codex' ? (CODEX_EVENTS as readonly string[]).includes(eventName) || eventName === 'SessionEnd' : false)
    if (!normalized && !recognized) return
    const event: NormalizedAgentEvent = { ...(normalized ?? { agentId, nodeId, kind: 'session',
      sessionId: typeof payload.session_id === 'string' ? payload.session_id : undefined }), verified }
    // A recognized native session hook establishes identity even when its normalized kind is
    // subagent/recurring rather than state. This grants no creator ownership or UI state.
    if (recognized) {
      event.kind = 'session'
      event.sessionPhase = eventName === 'SessionStart' ? 'start' : eventName === 'SessionEnd' ? 'end' : undefined
    }
    this.observe(event)
    if (verified && event.sessionPhase !== 'end' && safeOperatorId(event.sessionId) && transcriptPath)
      this.transcript(nodeId, event.sessionId, agentId, transcriptPath)
  }

  observe(event: NormalizedAgentEvent): void {
    if (!safeOperatorId(event.nodeId)) return
    if (event.verified !== true) {
      const old = this.sessions.get(event.nodeId)
      if (old && (event.sessionPhase || (event.sessionId && old.sessionId !== event.sessionId)))
        this.sessions.delete(event.nodeId)
      return
    }
    if (event.sessionPhase === 'end') { this.sessions.delete(event.nodeId); return }
    if (event.kind !== 'state' && event.kind !== 'session') return
    if (!safeOperatorId(event.sessionId)) {
      // An authenticated lifecycle boundary with missing identity cannot keep the old
      // generation readable or deliverable while a replacement's identity is unknown.
      if (event.sessionPhase === 'start') this.sessions.delete(event.nodeId)
      return
    }
    const current = this.sessions.get(event.nodeId)
    if (!current || current.sessionId !== event.sessionId || current.agentId !== event.agentId ||
      event.sessionPhase === 'start') {
      this.sessions.set(event.nodeId, {
        sessionId: event.sessionId, agentId: event.agentId,
        generation: `${this.bootId}.${randomUUID()}`
      })
    }
  }

  /** Called only with a jailed path from a verified raw hook, never from API input.
   * A generation's first path is immutable: a delayed same-ID hook cannot switch it back
   * to an earlier rollout. Legitimate path replacement needs a new lifecycle/identity boundary. */
  transcript(nodeId: string, sessionId: string, agentId: string, transcriptPath: string): void {
    const session = this.sessions.get(nodeId)
    if (session?.sessionId === sessionId && session.agentId === agentId && session.transcriptPath === undefined)
      session.transcriptPath = transcriptPath
  }

  targets(projects: readonly OperatorProject[]): OperatorSessionTarget[] {
    const targets: OperatorSessionTarget[] = []
    for (const [nodeId, session] of this.sessions) {
      const claimants = projects.filter((p) => p.nodes.some((n) => n.id === nodeId))
      if (claimants.length !== 1 || claimants[0].nodes.filter((n) => n.id === nodeId).length !== 1)
        continue
      if (claimants[0].nodes.find((n) => n.id === nodeId)?.kind !== 'terminal') continue
      targets.push({ projectId: claimants[0].id, nodeId, sessionId: session.sessionId,
        generation: session.generation })
    }
    return targets.sort((a, b) => a.nodeId.localeCompare(b.nodeId))
  }

  resolve(projects: readonly OperatorProject[], target: OperatorSessionTarget): BoundSession {
    const claimants = projects.filter((p) => p.nodes.some((n) => n.id === target.nodeId))
    if (claimants.length > 1 || claimants.some((p) => p.nodes.filter((n) => n.id === target.nodeId).length > 1))
      throw new OperatorTargetError('ambiguous_target')
    if (claimants.length !== 1 || claimants[0].id !== target.projectId)
      throw new OperatorTargetError('target_not_found', 404)
    if (claimants[0].nodes.find((n) => n.id === target.nodeId)?.kind !== 'terminal')
      throw new OperatorTargetError('unsupported_target', 422)
    const session = this.sessions.get(target.nodeId)
    if (!session || session.sessionId !== target.sessionId || session.generation !== target.generation)
      throw new OperatorTargetError('stale_target')
    return session
  }
}
