import type { OperatorSessionTarget } from '../../shared/operator-conversations'
import type { AgentMessageOutcome } from './agent-message-decide'
import type { DeliveryDeps } from './agent-message'
import type { DeliveryQueue } from './delivery-queue'
import { MESSAGE_BODY_MAX_BYTES } from './message-integrity'

export interface OperatorDeliveryInput {
  callerId: string
  target: OperatorSessionTarget
  text: string
  messageId: string
  authorize: () => Promise<boolean>
  onOutcome: (outcome: AgentMessageOutcome) => void
  onAccepted?: () => void
}

export interface OperatorMessagingDeps {
  queue: DeliveryQueue
  deliver(input: OperatorDeliveryInput, beforeSend: NonNullable<DeliveryDeps['beforeSend']>): Promise<AgentMessageOutcome>
  isCurrent(target: OperatorSessionTarget): boolean | Promise<boolean>
}

/** Operator is a separate principal. It has no node identity and receives no node reply route. */
export async function sendOperatorMessage(
  input: OperatorDeliveryInput,
  deps: OperatorMessagingDeps
): Promise<AgentMessageOutcome> {
  const target = Object.freeze({ ...input.target })
  const callerId = input.callerId
  const text = input.text
  const messageId = input.messageId
  const targetUnchanged = (): boolean => input.target.projectId === target.projectId &&
    input.target.nodeId === target.nodeId && input.target.sessionId === target.sessionId &&
    input.target.generation === target.generation
  if (Buffer.byteLength(text) > MESSAGE_BODY_MAX_BYTES) {
    const outcome: AgentMessageOutcome = { kind: 'messageRejected', reason: 'body-too-large' }
    input.onOutcome(outcome)
    return outcome
  }
  const allowed = async (): Promise<boolean> => {
    try {
      return targetUnchanged() && await input.authorize() && await deps.isCurrent(target) && targetUnchanged()
    } catch { return false }
  }
  if (!(await allowed())) {
    const outcome: AgentMessageOutcome = { kind: 'notPermitted', reason: 'switch-off' }
    input.onOutcome(outcome)
    return outcome
  }
  const beforeSend: NonNullable<DeliveryDeps['beforeSend']> = async () =>
    await allowed() ? undefined : { kind: 'notPermitted', reason: 'switch-off' }
  let outcome: AgentMessageOutcome
  const stableInput: OperatorDeliveryInput = { ...input, callerId, target, text, messageId }
  try { outcome = await deps.deliver(stableInput, beforeSend) }
  catch { outcome = { kind: 'unknown', reason: 'delivery-exception' } }
  if (outcome.kind === 'targetBusy' || outcome.kind === 'targetNotIdleUnknown') {
    let queued: AgentMessageOutcome
    try { queued = await deps.queue.enqueue({
      sourcePrincipal: 'operator',
      sourceTitle: `Operator ${callerId}`,
      targetNodeId: target.nodeId,
      body: text,
      operator: { target, messageId, callerId, authorize: allowed, onOutcome: input.onOutcome, onAccepted: input.onAccepted }
    }) } catch { queued = { kind: 'unknown', reason: 'queue-exception' } }
    input.onOutcome(queued)
    return queued
  }
  input.onOutcome(outcome)
  return outcome
}
