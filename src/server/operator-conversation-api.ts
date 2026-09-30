import http from 'node:http'
import path from 'node:path'
import { isLoopbackPeer } from './ops-api'
import {
  authenticateOperator, loadOperatorPrincipals, operatorAllowed, OPERATOR_POLICY_FILE,
  type OperatorOperation
} from './operator-conversation-policy'
import { OperatorReceiptStore, OperatorStoreError, appendOperatorAudit, type OperatorAuditEntry } from './operator-receipts'
import { OperatorSessionBindings, OperatorTargetError, isOperatorTarget, type OperatorProject } from '../core/operator-session-bindings'
import { readOperatorConversation, OperatorConversationError } from '../core/operator-conversation'
import type { OperatorDeliveryInput } from '../core/agents/operator-messaging'
import type { AgentMessageOutcome } from '../core/agents/agent-message-decide'
import type { OperatorSessionTarget } from '../shared/operator-conversations'

export interface OperatorConversationApiDeps {
  dataDir: string
  managementToken: string
  bindings: OperatorSessionBindings
  projects(): readonly OperatorProject[]
  sendMessage(input: OperatorDeliveryInput): Promise<AgentMessageOutcome>
}

export interface OperatorConversationHandler {
  (req: http.IncomingMessage, res: http.ServerResponse): Promise<void>
  /** Wait for admitted transport/receipt writes; does not replay or flush busy queues. */
  drain(): Promise<void>
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
  res.end(JSON.stringify(body))
}

async function requestBody(req: http.IncomingMessage): Promise<unknown> {
  if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json')
    throw new OperatorTargetError('content_type_required', 415)
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of req) {
    bytes += Buffer.byteLength(chunk)
    if (bytes > 16 * 1024) throw new OperatorTargetError('body_too_large', 413)
    chunks.push(Buffer.from(chunk))
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { throw new OperatorTargetError('invalid_json', 400) }
}

/** Separate authenticated principal routed before, never through, management-token auth. */
export function createOperatorConversationApi(deps: OperatorConversationApiDeps): OperatorConversationHandler {
  const store = new OperatorReceiptStore(deps.dataDir)
  let admission: Promise<void> = Promise.resolve()
  let readsInFlight = 0
  const jobs = new Set<Promise<void>>()
  const track = (job: Promise<void>): Promise<void> => {
    const safe = job.catch(() => {})
    jobs.add(safe)
    void safe.then(() => jobs.delete(safe))
    return safe
  }
  const policyFile = path.join(deps.dataDir, OPERATOR_POLICY_FILE)
  const handler = (async (req: http.IncomingMessage, res: http.ServerResponse) => {
    let caller = 'unauthenticated'
    let operation: OperatorAuditEntry['operation'] = 'targets'
    let target: OperatorSessionTarget | undefined
    try {
      const url = new URL(req.url ?? '/', 'http://operator.local')
      if (url.pathname === '/opsapi/v1/conversation') operation = 'read'
      else if (url.pathname === '/opsapi/v1/messages') operation = 'message'
      else if (url.pathname.startsWith('/opsapi/v1/receipts/')) operation = 'receipt'
      if (!isLoopbackPeer(req.socket.remoteAddress)) throw new OperatorTargetError('loopback_only', 403)
      // A browser Origin never belongs to the external operator CLI. No CORS or proxy widening.
      if (req.headers.origin) throw new OperatorTargetError('origin_forbidden', 403)
      const principal = authenticateOperator(req.headers.authorization,
        loadOperatorPrincipals(policyFile), deps.managementToken)
      if (!principal) throw new OperatorTargetError('unauthorized', 401)
      caller = principal.id
      const permission = (op: OperatorOperation, t: OperatorSessionTarget): void => {
        // Body reads, receipt recovery and serialized admission can yield across a revocation.
        const current = authenticateOperator(req.headers.authorization,
          loadOperatorPrincipals(policyFile), deps.managementToken)
        if (!current || current.id !== caller || !operatorAllowed(current, op, t))
          throw new OperatorTargetError('scope_denied', 403)
      }
      const audit = (outcome: string, receiptId?: string): void =>
        appendOperatorAudit(deps.dataDir, { caller, operation, target, receiptId, outcome })

      if (url.pathname === '/opsapi/v1/capabilities' && req.method === 'GET') {
        if (url.search) throw new OperatorTargetError('invalid_query', 400)
        audit('ok')
        sendJson(res, 200, { version: 1, permissions: {
          read: principal.read.length > 0, message: principal.message.length > 0
        }, receipts: true, pagination: 'snapshot', terminalSuggestions: false })
        return
      }
      if (url.pathname === '/opsapi/v1/sessions' && req.method === 'GET') {
        if (url.search) throw new OperatorTargetError('invalid_query', 400)
        const targets = deps.bindings.targets(deps.projects()).filter((t) =>
          operatorAllowed(principal, 'read', t) || operatorAllowed(principal, 'message', t))
        audit('ok')
        sendJson(res, 200, { version: 1, targets })
        return
      }
      if (url.pathname === '/opsapi/v1/conversation' && req.method === 'GET') {
        operation = 'read'
        const allowedKeys = ['projectId', 'nodeId', 'sessionId', 'generation', 'cursor', 'limit']
        if ([...url.searchParams.keys()].some((key) => !allowedKeys.includes(key) ||
          url.searchParams.getAll(key).length !== 1)) throw new OperatorTargetError('invalid_query', 400)
        const candidate = Object.fromEntries(['projectId', 'nodeId', 'sessionId', 'generation']
          .map((key) => [key, url.searchParams.get(key)]))
        if (!isOperatorTarget(candidate)) throw new OperatorTargetError('invalid_target', 400)
        target = candidate
        permission('read', target)
        const session = deps.bindings.resolve(deps.projects(), target)
        if (!session.transcriptPath) throw new OperatorTargetError('transcript_unavailable', 404)
        if (readsInFlight >= 2) throw new OperatorTargetError('read_capacity', 429)
        readsInFlight++
        const credentialValues = [deps.managementToken,
          typeof req.headers.authorization === 'string' ? req.headers.authorization.slice('Bearer '.length) : '']
        let result: Awaited<ReturnType<typeof readOperatorConversation>>
        try {
          result = await readOperatorConversation(target, session.agentId, session.transcriptPath,
            url.searchParams.get('cursor') ?? undefined, Number(url.searchParams.get('limit') ?? '50'), credentialValues)
        } finally { readsInFlight-- }
        result.items = result.items.map((item) => ({ ...item, text: credentialValues.reduce((text, secret) =>
          secret ? text.split(secret).join('[REDACTED CREDENTIAL]') : text, item.text) }))
        // Reading may yield while a replacement occurs or the policy is revoked.
        permission('read', target)
        deps.bindings.resolve(deps.projects(), target)
        audit('ok')
        sendJson(res, 200, result)
        return
      }
      const receiptMatch = /^\/opsapi\/v1\/receipts\/([a-f0-9-]{36})$/.exec(url.pathname)
      if (receiptMatch && req.method === 'GET') {
        operation = 'receipt'
        if (url.search) throw new OperatorTargetError('invalid_query', 400)
        const stored = await store.get(receiptMatch[1])
        if (!stored || stored.callerId !== caller) throw new OperatorTargetError('receipt_not_found', 404)
        target = stored.receipt.target
        permission('message', target)
        audit('ok', stored.receipt.id)
        sendJson(res, 200, stored.receipt)
        return
      }
      if (url.pathname === '/opsapi/v1/messages' && req.method === 'POST') {
        operation = 'message'
        if (url.search) throw new OperatorTargetError('invalid_query', 400)
        const key = req.headers['idempotency-key']
        if (typeof key !== 'string' || !/^[A-Za-z0-9._-]{8,128}$/.test(key))
          throw new OperatorTargetError('idempotency_key_required', 400)
        const body = await requestBody(req) as Record<string, unknown>
        if (!body || typeof body !== 'object' || Array.isArray(body) ||
          Object.keys(body).length !== 2 || !isOperatorTarget(body.target) ||
          typeof body.text !== 'string' || body.text.trim().length === 0 ||
          Buffer.byteLength(body.text) > 8000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(body.text))
          throw new OperatorTargetError('invalid_message', 400)
        target = body.target
        permission('message', target)
        let isNew = false
        const previous = admission
        let release!: () => void
        admission = new Promise<void>((resolve) => { release = resolve })
        await previous
        let entry: Awaited<ReturnType<OperatorReceiptStore['admit']>>
        try {
          permission('message', target)
          entry = store.find(caller, key, target, body.text)!
          if (!entry) {
            deps.bindings.resolve(deps.projects(), target)
            audit('admission_started')
            entry = await store.admit(caller, key, target, body.text)
            isNew = true
          }
          try { permission('message', target) }
          catch (error) {
            // Preserve deduplication if revocation races the durable admission write.
            if (isNew) await store.update(entry.receipt.id, 'failed', 'notPermitted')
            throw error
          }
        } finally { release() }
        audit(isNew ? 'accepted' : 'duplicate', entry.receipt.id)
        if (isNew) {
          const pinnedTarget = { ...target }
          const update = async (state: 'accepted' | 'queued' | 'failed' | 'acknowledged', outcome: string, evidence?: string): Promise<void> => {
            // Audit failure cannot cause a retry of already-submitted bytes.
            appendOperatorAudit(deps.dataDir, { caller, operation: 'delivery', target: pinnedTarget,
              receiptId: entry.receipt.id, outcome })
            await store.update(entry.receipt.id, state, outcome, evidence)
          }
          const observe = (outcome: AgentMessageOutcome): Promise<void> => {
            const state = outcome.kind === 'queued' ? 'queued' : outcome.kind === 'delivered' ? 'acknowledged' : 'failed'
            return track(update(state, outcome.kind, outcome.kind === 'delivered' ?
              'verified_correlated_prompt' : undefined))
          }
          const authorized = async (): Promise<boolean> => {
            try {
              const current = authenticateOperator(req.headers.authorization,
                loadOperatorPrincipals(policyFile), deps.managementToken)
              if (!current || current.id !== caller || !operatorAllowed(current, 'message', pinnedTarget)) return false
              deps.bindings.resolve(deps.projects(), pinnedTarget)
              // Losing the durable audit sink must close the write gate before pane submission.
              appendOperatorAudit(deps.dataDir, { caller, operation: 'delivery', target: pinnedTarget,
                receiptId: entry.receipt.id, outcome: 'authorized' })
              return true
            } catch { return false }
          }
          // The normal queue owns all pane operations; the API never types, wakes or restarts.
          void track(deps.sendMessage({ callerId: caller, target: pinnedTarget, text: body.text,
            messageId: entry.receipt.id, authorize: authorized, onOutcome: observe,
            onAccepted: () => track(update('accepted', 'transport_accepted', 'awaiting_verified_receipt'))
          }).then(observe, () => track(update('failed', 'delivery_failed'))))
        }
        sendJson(res, 202, entry.receipt)
        return
      }
      throw new OperatorTargetError('not_found', 404)
    } catch (error) {
      const known = error instanceof OperatorTargetError || error instanceof OperatorStoreError ||
        error instanceof OperatorConversationError
      const code = known ? error.code : 'internal_error'
      const status = known ? error.status : 503
      try {
        appendOperatorAudit(deps.dataDir, { caller, operation, target, outcome: code })
        sendJson(res, status, { version: 1, error: code })
      } catch { sendJson(res, 503, { version: 1, error: 'audit_unavailable' }) }
    }
  }) as OperatorConversationHandler
  handler.drain = async () => { while (jobs.size) await Promise.all([...jobs]) }
  return handler
}
