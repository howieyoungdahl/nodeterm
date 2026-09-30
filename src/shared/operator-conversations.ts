/** Versioned operator-only protocol. A principal is never a canvas node. */
export const OPERATOR_CONVERSATION_VERSION = 1

export interface OperatorSessionTarget {
  projectId: string
  nodeId: string
  sessionId: string
  /** Changes at server boot and every observed session start/replacement. */
  generation: string
}

export interface OperatorConversationItem {
  id: string
  sequence: number
  timestamp: string | null
  kind: 'user' | 'agent' | 'tool_call' | 'tool_result' | 'terminal_suggestion'
  text: string
  provenance: {
    source: 'transcript' | 'terminal'
    agentId: string
    submitted: boolean
  }
}

export interface OperatorConversationPage {
  version: 1
  target: OperatorSessionTarget
  items: OperatorConversationItem[]
  nextCursor: string | null
}

export interface OperatorMessageReceipt {
  version: 1
  id: string
  target: OperatorSessionTarget
  state: 'accepted' | 'queued' | 'failed' | 'acknowledged'
  createdAt: string
  updatedAt: string
  /** A code, never a raw exception or message body. */
  outcome: string
  /** What was observed, not a claim that the agent understood the message. */
  evidence?: string
}
