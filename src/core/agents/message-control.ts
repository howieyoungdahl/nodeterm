import type { DeliveryQueue, QueuedDeliveryRequest } from './delivery-queue'
import { canonicalMessage, sameMessageActor, type MessageActor } from './message-integrity'
import type { AgentMessageOutcome } from './agent-message-decide'
import { renderMessageOutcome } from './agent-messaging'
import type { AgentMessageReply } from '../../shared/agents/agent-messaging'

export const IDENTIFIED_MESSAGE_VERBS: ReadonlySet<string> = new Set([
  'message-deliver', 'message-receipt', 'message-ack'
])

/** Not implemented by node-token auth: it proves no session/incarnation or issuing authority.
 * An adapter must resolve its own authenticated principal and immutable issued intent. No IDs,
 * recipient bindings or authority are synthesized here from browser/operator read rights. */
export interface MessageControlRuntime {
  authenticate(nodeId: string, credential: string): Promise<MessageActor | null>
  issuedMessage(issuer: MessageActor, messageId: string, actionId: string): Promise<QueuedDeliveryRequest | null>
  /** Read current issuer assignment/incarnation, contract/policy and permission for this exact
   * issued action/recipient from the canonical issuer/intent substrate on EVERY invocation.
   * Unknown, revoked, transferred or stale evidence must return false. A durable claim by itself
   * proves none of this. No production implementation is supplied by either shell. */
  validateIssuer(issuer: MessageActor, request: QueuedDeliveryRequest): Promise<boolean>
  /** Claim in the issuer's EXISTING durable intent substrate before a possible send. A prior
   * attempt/lost result/new host must answer unknown, never infer replay permission from an
   * empty process-local receipt cache. No production adapter exists for this contract yet. */
  claimIssuedAttempt(issuer: MessageActor, request: QueuedDeliveryRequest): Promise<'claimed' | 'unknown'>
}

export interface MessageControlRequest {
  verb: string
  nodeId: string
  verified: boolean
  args: Record<string, string>
  messageCredential?: string
}

const refuse = (reason: string): AgentMessageReply => renderMessageOutcome({ kind: 'messageRejected', reason })

/** Runs inside the authenticated hook route, never through renderer IPC. */
export function createMessageControl(queue: DeliveryQueue, runtime?: MessageControlRuntime) {
  return async (input: MessageControlRequest): Promise<AgentMessageReply> => {
    if (!input.verified) return refuse('message-caller-unverified')
    if (!runtime) return refuse('message-principal-and-issuer-adapter-unavailable')
    const credential = input.messageCredential
    if (!credential || credential.length > 4096) return refuse('message-credential-unavailable')
    const authenticate = async (): Promise<MessageActor | null> => {
      const actor = await runtime.authenticate(input.nodeId, credential)
      return actor?.node === input.nodeId ? actor : null
    }
    try {
      const actor = await authenticate()
      if (!actor) return refuse('message-caller-unverified')
      if (input.verb === 'message-ack') {
        if (!['acknowledged', 'accepted'].includes(input.args.status)) return refuse('invalid-ack-status')
        if (![input.args.source_node, input.args.message_id, input.args.action_id].every((value) =>
          typeof value === 'string' && value.length > 0 && value.length <= 192)) return refuse('invalid-message-reference')
        return renderMessageOutcome(await queue.messages.acknowledgeReceipt({ sourceNodeId: input.args.source_node,
          message_id: input.args.message_id, action_id: input.args.action_id },
          input.args.status as 'acknowledged' | 'accepted', authenticate))
      }
      if (!['message-deliver', 'message-receipt'].includes(input.verb)) return refuse('message-verb-unsupported')
      if (!input.args.message_id || !input.args.action_id || input.args.message_id.length > 192 ||
        input.args.action_id.length > 192) return refuse('issued-message-required')
      const issued = await runtime.issuedMessage(actor, input.args.message_id, input.args.action_id)
      if (!issued?.message || issued.sourceNodeId !== actor.node ||
        issued.message.message_id !== input.args.message_id || issued.message.action_id !== input.args.action_id ||
        !canonicalMessage(issued.message, issued.targetNodeId) || !['send', 'reply'].includes(String(issued.verb))) {
        return refuse('issued-message-unavailable')
      }
      // Copy the trusted issuer result, never overlay caller-supplied fields on the envelope.
      const request = structuredClone(issued)
      let claimed = false
      const issuerGuard = async (): Promise<AgentMessageOutcome | undefined> => {
        const failed = (): AgentMessageOutcome => claimed
          ? { kind: 'unknown', reason: 'issuer-authority-changed-after-claim' }
          : { kind: 'messageRejected', reason: 'issuer-authority-unverifiable' }
        try {
          if (!sameMessageActor(await authenticate(), actor) ||
            !await runtime.validateIssuer(structuredClone(actor), structuredClone(request)) ||
            !sameMessageActor(await authenticate(), actor) ||
            !await runtime.validateIssuer(structuredClone(actor), structuredClone(request))) return failed()
        } catch { return failed() }
      }
      return renderMessageOutcome(input.verb === 'message-receipt'
        ? queue.messages.receipt(request) : await queue.deliverIdentified(request, async () => {
          const refusal = await issuerGuard()
          if (refusal) return refusal
          const result = await runtime.claimIssuedAttempt(structuredClone(actor), structuredClone(request))
          claimed = result === 'claimed'
          return claimed ? undefined : { kind: 'unknown', reason: 'prior-delivery-attempt-unresolved' }
        }, issuerGuard))
    } catch {
      // An exception may follow publication. Do not label the result safe to replay. The
      // process-local receipt query can distinguish a retained outcome without sending again.
      return renderMessageOutcome({ kind: 'unknown', reason: 'message-control-outcome-unknown' })
    }
  }
}
