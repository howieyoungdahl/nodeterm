import { randomUUID } from 'node:crypto'
import type { NormalizedAgentEvent } from '../shared/agents/normalize'
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
    if (!safeOperatorId(event.sessionId)) return
    const current = this.sessions.get(event.nodeId)
    if (!current || current.sessionId !== event.sessionId || current.agentId !== event.agentId ||
      event.sessionPhase === 'start') {
      this.sessions.set(event.nodeId, {
        sessionId: event.sessionId, agentId: event.agentId,
        generation: `${this.bootId}.${randomUUID()}`
      })
    }
  }

  /** Called only with a jailed path from a verified raw hook, never from API input. */
  transcript(nodeId: string, sessionId: string, agentId: string, transcriptPath: string): void {
    const session = this.sessions.get(nodeId)
    if (session?.sessionId === sessionId && session.agentId === agentId)
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
