import { creationAdmission, parseAssistantCreation } from '../shared/assistant-creation'
import { receiptPublication } from './assistant-creation-receipts'
import { CleanupError, type SessionCleanup } from '../core/session-cleanup'
import http from 'node:http'
import path from 'node:path'
import { parseTaskPlanning } from '../shared/task-planning'
import {
  OPERATOR_NODE_HEIGHT_BOUNDS,
  OPERATOR_NODE_WIDTH_BOUNDS,
  type OpsAdoptResult,
  type OpsCreateInput,
  type OpsCreateResult,
  type OpsNodeInventoryItem,
  type OpsRemoveResult,
  type OpsSweepResult,
  type OpsUpdateInput,
  type OpsUpdateResult
} from './node-ops'
import { opsBearerMatches } from './ops-token'
import type { SpawnHandlerSnapshot } from './spawn-handler-state'
import { organizationId, organizationKey, parseOrganizationMetadata, parseOrganizationPolicy } from '../shared/kanban-organization'
import type { OrganizationMetadata } from '../shared/kanban-organization'

const OPS_BODY_MAX_BYTES = 10 * 1024
const OPS_CREATE_TITLE_MAX = 200
const OPS_CREATE_CMD_MAX = 4_000
const OPS_CREATE_STRING_MAX = 4_096

/** No NUL bytes (never let a string field smuggle a C-string terminator into a downstream call),
 *  within the given length. */
function validString(value: unknown, maxLen: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLen && !value.includes('\u0000')
}

function validInt(value: unknown, bounds: { min: number; max: number }): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= bounds.min &&
    value <= bounds.max
  )
}

export interface OpsHealth {
  startedAt: number
  uptimeMs: number
  wsClientCount: number
  canvasControlEnabled: boolean
  spawnHandler: SpawnHandlerSnapshot
  deliveryQueueDepths: Record<string, number>
  projects: Array<{ id: string; nodeCount: number }>
}

export interface OpsApiDeps {
  cleanup?: SessionCleanup
  creationReceipt?(key: string): Promise<unknown>
  boards?(): Promise<unknown>
  previewOrganization?(projectId: string, entries: Array<{ nodeId: string; metadata: OrganizationMetadata }>): Promise<unknown>
  organizationAudit?(nodeId: string): Promise<unknown>
  undoOrganization?(nodeId: string, receiptId: string, expectedRevision: string): Promise<OpsUpdateResult>
  retryOrganizationEvents?(): Promise<unknown>
  token: string
  /** A separate principal authenticates versioned conversation routes. No management-token fallback. */
  conversations?: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>
  nodes(): Promise<OpsNodeInventoryItem[]>
  sweep(dryRun: boolean, force: boolean): Promise<OpsSweepResult>
  remove(nodeId: string, force: boolean): Promise<OpsRemoveResult>
  /** The sweep's mirror image: card a live `nt-<id>` session that no project still lists. */
  adoptOrphans(): Promise<OpsAdoptResult>
  /** Create a terminal node with no live source node to anchor it. See `ServerNodeOps.create`. */
  createNode(input: OpsCreateInput): Promise<OpsCreateResult>
  /** Rename and/or resize one node. `force` mirrors `remove`'s gate for a non-operator-created node. */
  updateNode(nodeId: string, input: OpsUpdateInput, force: boolean): Promise<OpsUpdateResult>
  health(): OpsHealth | Promise<OpsHealth>
}

function organizationFields(raw: Record<string, unknown>, input: OpsCreateInput | OpsUpdateInput, invalid: string[]): void {
  if (raw.organization !== undefined) {
    const value = parseOrganizationMetadata(raw.organization)
    if (value) input.organization = value
    else invalid.push('organization')
  }
  if (raw.organizationPolicy !== undefined) {
    const value = parseOrganizationPolicy(raw.organizationPolicy)
    if (value) input.organizationPolicy = value
    else invalid.push('organizationPolicy')
  }
  if (raw.expectedRevision !== undefined) {
    if (typeof raw.expectedRevision === 'string' && /^[a-f0-9]{64}$/.test(raw.expectedRevision)) input.expectedRevision = raw.expectedRevision
    else invalid.push('expectedRevision')
  }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Length': Buffer.byteLength(payload)
  })
  res.end(payload)
}

/** TCP-peer gate. Forwarded headers are deliberately irrelevant to this operator-only surface. */
export function isLoopbackPeer(address: string | undefined): boolean {
  if (!address) return false
  if (address === '::1') return true
  const ipv4 = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address
  const octets = ipv4.split('.')
  if (octets.length !== 4) return false
  const nums = octets.map((part) => Number(part))
  return nums.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) && nums[0] === 127
}

function readJson(req: http.IncomingMessage, maxBytes = OPS_BODY_MAX_BYTES): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const fail = (error: Error): void => {
      if (settled) return
      settled = true
      reject(error)
    }
    req.on('data', (chunk: Buffer) => {
      if (settled) return
      size += chunk.length
      if (size > maxBytes) {
        fail(Object.assign(new Error('body_too_large'), { code: 'BODY_TOO_LARGE' }))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (settled) return
      settled = true
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('invalid_json'))
      }
    })
    req.on('error', fail)
  })
}

function validNodeIdSegment(segment: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(segment)
  } catch {
    return null
  }
  // Current and legacy nodeterm ids all stay in this tmux-safe alphabet. Do not let an operator
  // URL become an alternate path/command grammar even though the id is looked up before use.
  if (!decoded || decoded.length > 512 || !/^[A-Za-z0-9._:-]+$/.test(decoded)) return null
  return decoded
}

/** Standalone REST handler; `http.ts` routes `/opsapi/*` here before browser-cookie auth. */
export function createOpsApiHandler(
  deps: OpsApiDeps
): (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void> {
  return async function handleOps(req, res): Promise<void> {
    try {
      const url = new URL(req.url || '/', 'http://ops.local')
      const pathname = url.pathname
      const method = req.method || 'GET'

      if (pathname !== '/opsapi' && !pathname.startsWith('/opsapi/')) {
        sendJson(res, 404, { error: 'not_found' })
        return
      }
      if (!isLoopbackPeer(req.socket.remoteAddress)) {
        sendJson(res, 403, { error: 'loopback_only' })
        return
      }
      if (pathname === '/opsapi/v1' || pathname.startsWith('/opsapi/v1/')) {
        if (deps.conversations) await deps.conversations(req, res)
        else sendJson(res, 404, { error: 'not_found' })
        return
      }
      if (!opsBearerMatches(req.headers.authorization, deps.token)) {
        res.setHeader('WWW-Authenticate', 'Bearer realm="nodeterm-ops"')
        sendJson(res, 401, { error: 'unauthorized' })
        return
      }

      if (pathname === '/opsapi/boards' && method === 'GET') {
        sendJson(res, deps.boards ? 200 : 501, deps.boards ? await deps.boards() : { error: 'unsupported' })
        return
      }
      const creationMatch = /^\/opsapi\/creation-receipts\/([^/]+)$/.exec(pathname)
      if (creationMatch && method === 'GET') {
        if (!organizationKey(creationMatch[1])) { sendJson(res, 400, { error: 'invalid_idempotency_key' }); return }
        sendJson(res, deps.creationReceipt ? 200 : 501,
          deps.creationReceipt ? await deps.creationReceipt(creationMatch[1]) : { error: 'unsupported' })
        return
      }
      const auditMatch = /^\/opsapi\/nodes\/([^/]+)\/organization-audit$/.exec(pathname)
      if (auditMatch && method === 'GET') {
        const id = auditMatch[1]
        if (!organizationId(id)) { sendJson(res, 400, { error: 'invalid_node_id' }); return }
        sendJson(res, deps.organizationAudit ? 200 : 501, deps.organizationAudit ? await deps.organizationAudit(id) : { error: 'unsupported' })
        return
      }
      const undoMatch = /^\/opsapi\/nodes\/([^/]+)\/organization-undo$/.exec(pathname)
      if (pathname === '/opsapi/organization/preview' || undoMatch) {
        if (method !== 'POST') { sendJson(res, 405, { error: 'method_not_allowed' }); return }
        if (req.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
          sendJson(res, 415, { error: 'application_json_required' }); return
        }
        let body: unknown
        try { body = await readJson(req) } catch { sendJson(res, 400, { error: 'bad_json_or_body_too_large' }); return }
        if (!body || typeof body !== 'object' || Array.isArray(body)) { sendJson(res, 400, { error: 'invalid_body' }); return }
        const raw = body as Record<string, unknown>
        if (undoMatch) {
          if (Object.keys(raw).some((k) => !['receiptId', 'expectedRevision'].includes(k)) ||
            !organizationId(undoMatch[1]) || !organizationId(raw.receiptId) ||
            typeof raw.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(raw.expectedRevision)) {
            sendJson(res, 400, { error: 'invalid_undo' }); return
          }
          const result = await deps.undoOrganization?.(undoMatch[1], raw.receiptId, raw.expectedRevision)
          sendJson(res, result ? result.ok ? 200 : result.status : 501, result ?? { error: 'unsupported' })
          if (result?.ok) await deps.retryOrganizationEvents?.()
          return
        }
        if (Object.keys(raw).some((k) => !['projectId', 'entries'].includes(k)) || !organizationId(raw.projectId) ||
          !Array.isArray(raw.entries) || raw.entries.length < 1 || raw.entries.length > 100) {
          sendJson(res, 400, { error: 'invalid_preview' }); return
        }
        const entries: Array<{ nodeId: string; metadata: OrganizationMetadata }> = []
        for (const row of raw.entries) {
          const metadata = row && parseOrganizationMetadata(row.metadata)
          if (!row || typeof row !== 'object' || Array.isArray(row) || Object.keys(row).some((k) => !['nodeId', 'metadata'].includes(k)) ||
            !organizationId(row.nodeId) || !metadata || metadata.projectId !== raw.projectId || entries.some((e) => e.nodeId === row.nodeId)) {
            sendJson(res, 400, { error: 'invalid_preview_entry' }); return
          }
          entries.push({ nodeId: row.nodeId, metadata })
        }
        sendJson(res, deps.previewOrganization ? 200 : 501,
          deps.previewOrganization ? await deps.previewOrganization(raw.projectId, entries) : { error: 'unsupported' })
        return
      }
      if (pathname === '/opsapi/organization/retry-events' && method === 'POST') {
        sendJson(res, deps.retryOrganizationEvents ? 200 : 501,
          deps.retryOrganizationEvents ? await deps.retryOrganizationEvents() : { error: 'unsupported' })
        return
      }

      if (pathname.startsWith('/opsapi/cleanup/')) {
        if (!deps.cleanup) { sendJson(res, 501, { version: 1, error: 'cleanup_unavailable' }); return }
        const action = pathname.slice('/opsapi/cleanup/'.length)
        const receiptMatch = /^receipts\/([a-f0-9-]{36})$/.exec(action)
        const expected = action === 'preview' || action === 'receipts' || receiptMatch ? 'GET' : 'POST'
        if (method !== expected) { res.setHeader('Allow', expected); sendJson(res, 405, { version: 1, error: 'method_not_allowed' }); return }
        try {
          if (action === 'preview') { sendJson(res, 200, await deps.cleanup.preview()); return }
          if (action === 'receipts') { sendJson(res, 200, await deps.cleanup.receipts()); return }
          if (receiptMatch) { sendJson(res, 200, await deps.cleanup.receipt(receiptMatch[1])); return }
          if (action !== 'archive' && action !== 'undo' && action !== 'reviewed-preview') { sendJson(res, 404, { version: 1, error: 'not_found' }); return }
          if (req.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
            sendJson(res, 415, { version: 1, error: 'application_json_required' }); return
          }
          const body = await readJson(req, 64_000)
          if (action === 'reviewed-preview') { sendJson(res, 200, await deps.cleanup.reviewedPreview(body)); return }
          if (action === 'archive') { sendJson(res, 200, await deps.cleanup.archive(body)); return }
          if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).join() !== 'receiptId' ||
            typeof (body as { receiptId?: unknown }).receiptId !== 'string') {
            sendJson(res, 400, { version: 1, error: 'receipt_id_required' }); return
          }
          sendJson(res, 200, await deps.cleanup.undo((body as { receiptId: string }).receiptId)); return
        } catch (e) {
          const status = e instanceof CleanupError ? e.status : (e as NodeJS.ErrnoException)?.code === 'BODY_TOO_LARGE' ? 413 : e instanceof SyntaxError || (e as Error)?.message === 'invalid_json' ? 400 : 500
          sendJson(res, status, { version: 1, error: e instanceof CleanupError ? e.code : status === 400 ? 'bad_json' : status === 413 ? 'body_too_large' : 'cleanup_failed' }); return
        }
      }
      if (pathname === '/opsapi/nodes') {
        if (method === 'GET') {
          sendJson(res, 200, { nodes: await deps.nodes() })
          return
        }
        if (method === 'POST') {
          const contentType = req.headers['content-type']?.split(';', 1)[0].trim().toLowerCase()
          if (contentType !== 'application/json') {
            sendJson(res, 415, { error: 'application_json_required' })
            return
          }
          let body: unknown
          try {
            body = await readJson(req)
          } catch (error) {
            const tooLarge = (error as NodeJS.ErrnoException)?.code === 'BODY_TOO_LARGE'
            sendJson(res, tooLarge ? 413 : 400, { error: tooLarge ? 'body_too_large' : 'bad_json' })
            return
          }
          if (!body || typeof body !== 'object' || Array.isArray(body)) {
            sendJson(res, 400, { error: 'body_must_be_an_object' })
            return
          }
          const raw = body as Record<string, unknown>
          const allowed = new Set(['projectId', 'cmd', 'cwd', 'title', 'width', 'height', 'organization', 'organizationPolicy', 'expectedRevision', 'idempotencyKey', 'creation'])
          const unknownKey = Object.keys(raw).find((key) => !allowed.has(key))
          if (unknownKey) {
            sendJson(res, 400, { error: `unknown_field: ${unknownKey}` })
            return
          }
          const invalid: string[] = []
          const input: OpsCreateInput = {}
          organizationFields(raw, input, invalid)
          input.creation = parseAssistantCreation(raw.creation)
          if (!input.creation) invalid.push('creation')
          if (raw.idempotencyKey !== undefined) {
            if (organizationKey(raw.idempotencyKey)) input.idempotencyKey = raw.idempotencyKey
            else invalid.push('idempotencyKey')
          }
          if (raw.projectId !== undefined) {
            if (validString(raw.projectId, OPS_CREATE_STRING_MAX)) input.projectId = raw.projectId
            else invalid.push('projectId')
          }
          if (raw.cmd !== undefined) {
            if (validString(raw.cmd, OPS_CREATE_CMD_MAX)) input.cmd = raw.cmd
            else invalid.push('cmd')
          }
          if (raw.cwd !== undefined) {
            if (validString(raw.cwd, OPS_CREATE_STRING_MAX) && path.isAbsolute(raw.cwd)) {
              input.cwd = raw.cwd
            } else invalid.push('cwd')
          }
          if (raw.title !== undefined) {
            if (validString(raw.title, OPS_CREATE_TITLE_MAX)) input.title = raw.title
            else invalid.push('title')
          }
          if (raw.width !== undefined) {
            if (validInt(raw.width, OPERATOR_NODE_WIDTH_BOUNDS)) input.width = raw.width
            else invalid.push('width')
          }
          if (raw.height !== undefined) {
            if (validInt(raw.height, OPERATOR_NODE_HEIGHT_BOUNDS)) input.height = raw.height
            else invalid.push('height')
          }
          if (invalid.length) {
            sendJson(res, 400, { error: `invalid_field(s): ${invalid.join(', ')}` })
            return
          }
          const admission = creationAdmission(input.creation, input.organization, input.projectId, input.idempotencyKey)
          if (admission || !input.idempotencyKey) { sendJson(res, 400, { error: admission ?? 'assistant_creation_key_required' }); return }
          const result = await deps.createNode(input)
          if (!result.ok) {
            sendJson(res, result.status, {
              error: result.error,
              ...(result.id ? { id: result.id } : {}),
              ...(result.tmuxSession ? { tmuxSession: result.tmuxSession } : {}),
              ...(result.idempotencyKey ? { idempotencyKey: result.idempotencyKey } : {}),
              ...(result.replayed ? { replayed: true } : {})
            })
            return
          }
          sendJson(res, 201, {
            id: result.id,
            projectId: result.projectId,
            title: result.title,
            tmuxSession: result.tmuxSession,
            ...(result.idempotencyKey ? { idempotencyKey: result.idempotencyKey } : {}),
            ...(result.organization ? { organization: result.organization } : {}),
            ...(result.replayed ? { replayed: true } : {})
          })
          return
        }
        res.setHeader('Allow', 'GET, POST')
        sendJson(res, 405, { error: 'method_not_allowed' })
        return
      }

      if (pathname === '/opsapi/sweep') {
        if (method !== 'POST') {
          res.setHeader('Allow', 'POST')
          sendJson(res, 405, { error: 'method_not_allowed' })
          return
        }
        const contentType = req.headers['content-type']?.split(';', 1)[0].trim().toLowerCase()
        if (contentType !== 'application/json') {
          sendJson(res, 415, { error: 'application_json_required' })
          return
        }
        let body: unknown
        try {
          body = await readJson(req)
        } catch (error) {
          const tooLarge = (error as NodeJS.ErrnoException)?.code === 'BODY_TOO_LARGE'
          sendJson(res, tooLarge ? 413 : 400, { error: tooLarge ? 'body_too_large' : 'bad_json' })
          return
        }
        // `force` is optional and defaults to false: the mass-sweep guard must be opted OUT of by
        // a human typing the flag, never inherited by an operator script that predates it.
        const sweepBody = body as { dryRun?: unknown; force?: unknown }
        if (
          !body ||
          typeof body !== 'object' ||
          Array.isArray(body) ||
          typeof sweepBody.dryRun !== 'boolean' ||
          (sweepBody.force !== undefined && typeof sweepBody.force !== 'boolean') ||
          Object.keys(body).some((key) => key !== 'dryRun' && key !== 'force')
        ) {
          sendJson(res, 400, { error: 'body_must_be_dryRun_boolean_with_optional_force_boolean' })
          return
        }
        sendJson(res, 200, await deps.sweep(sweepBody.dryRun as boolean, sweepBody.force === true))
        return
      }

      if (pathname === '/opsapi/adopt-orphans') {
        if (method !== 'POST') {
          res.setHeader('Allow', 'POST')
          sendJson(res, 405, { error: 'method_not_allowed' })
          return
        }
        // No body at all, and none accepted. There is nothing to parameterise: the routine adopts
        // exactly the sessions it can prove live and place, and a dry-run flag would be a second
        // code path over the same evidence for an operation that only ever ADDS a card.
        const result = await deps.adoptOrphans()
        sendJson(res, 200, {
          ...result,
          ...(result.live
            ? {}
            : { note: 'no attached browser received these live — reload to see them' })
        })
        return
      }

      if (pathname === '/opsapi/health') {
        if (method !== 'GET') {
          res.setHeader('Allow', 'GET')
          sendJson(res, 405, { error: 'method_not_allowed' })
          return
        }
        sendJson(res, 200, await deps.health())
        return
      }

      // Separate from conversation capabilities. Older management servers do not promise
      // private task receipts and must not receive a mixed-version helper's creation POST.
      if (pathname === '/opsapi/creation-contract') {
        if (method !== 'GET') {
          res.setHeader('Allow', 'GET')
          sendJson(res, 405, { error: 'method_not_allowed' })
          return
        }
        sendJson(res, 200, { version: 1, receiptPublication: receiptPublication(), assistantCreation: { version: 1,
          taskId: 'required', creationKey: 'exact-required', metadata: 'owner-project-workstream-functionalRole-required',
          privateReceipt: 'before-save-and-spawn', verifiedCreatorSource: true,
          taskPlanning: 'category-urgency-reason-relationship-before-save-and-spawn' } })
        return
      }

      const nodeMatch = /^\/opsapi\/nodes\/([^/]+)$/.exec(pathname)
      if (nodeMatch) {
        const nodeId = validNodeIdSegment(nodeMatch[1])
        if (!nodeId) {
          sendJson(res, 400, { error: 'invalid_node_id' })
          return
        }
        if (method === 'DELETE') {
          const result = await deps.remove(nodeId, url.searchParams.get('force') === '1')
          if (!result.ok) {
            sendJson(res, result.status, {
              error: result.error,
              ...(result.paneState ? { paneState: result.paneState } : {})
            })
            return
          }
          sendJson(res, 200, result)
          return
        }
        if (method === 'PATCH') {
          const contentType = req.headers['content-type']?.split(';', 1)[0].trim().toLowerCase()
          if (contentType !== 'application/json') {
            sendJson(res, 415, { error: 'application_json_required' })
            return
          }
          let body: unknown
          try {
            body = await readJson(req)
          } catch (error) {
            const tooLarge = (error as NodeJS.ErrnoException)?.code === 'BODY_TOO_LARGE'
            sendJson(res, tooLarge ? 413 : 400, { error: tooLarge ? 'body_too_large' : 'bad_json' })
            return
          }
          if (!body || typeof body !== 'object' || Array.isArray(body)) {
            sendJson(res, 400, { error: 'body_must_be_an_object' })
            return
          }
          const raw = body as Record<string, unknown>
          const allowed = new Set(['title', 'width', 'height', 'organization', 'organizationPolicy', 'expectedRevision', 'taskPlanning'])
          const unknownKey = Object.keys(raw).find((key) => !allowed.has(key))
          if (unknownKey) {
            sendJson(res, 400, { error: `unknown_field: ${unknownKey}` })
            return
          }
          if (raw.title === undefined && raw.width === undefined && raw.height === undefined && raw.organization === undefined && raw.taskPlanning === undefined) {
            sendJson(res, 400, { error: 'body_must_set_title_width_or_height' })
            return
          }
          const invalid: string[] = []
          const input: OpsUpdateInput = {}
          organizationFields(raw, input, invalid)
          if (raw.taskPlanning !== undefined) {
            input.taskPlanning = parseTaskPlanning(raw.taskPlanning)
            if (!input.taskPlanning) invalid.push('taskPlanning')
            if (raw.organization !== undefined || raw.organizationPolicy !== undefined || raw.title !== undefined || raw.width !== undefined || raw.height !== undefined)
              invalid.push('taskPlanning_cannot_change_placement_geometry_or_title')
          }
          if ((input.organization || input.organizationPolicy) &&
            (raw.title !== undefined || raw.width !== undefined || raw.height !== undefined)) invalid.push('organization_cannot_change_geometry_or_title')
          if (raw.title !== undefined) {
            if (validString(raw.title, OPS_CREATE_TITLE_MAX)) input.title = raw.title
            else invalid.push('title')
          }
          if (raw.width !== undefined) {
            if (validInt(raw.width, OPERATOR_NODE_WIDTH_BOUNDS)) input.width = raw.width
            else invalid.push('width')
          }
          if (raw.height !== undefined) {
            if (validInt(raw.height, OPERATOR_NODE_HEIGHT_BOUNDS)) input.height = raw.height
            else invalid.push('height')
          }
          if (invalid.length) {
            sendJson(res, 400, { error: `invalid_field(s): ${invalid.join(', ')}` })
            return
          }
          const result = await deps.updateNode(nodeId, input, url.searchParams.get('force') === '1')
          if (!result.ok) {
            sendJson(res, result.status, { error: result.error, ...(result.id ? { id: result.id } : {}) })
            return
          }
          sendJson(res, 200, result)
          if (input.organization) await deps.retryOrganizationEvents?.()
          return
        }
        res.setHeader('Allow', 'DELETE, PATCH')
        sendJson(res, 405, { error: 'method_not_allowed' })
        return
      }

      sendJson(res, 404, { error: 'not_found' })
    } catch (error) {
      console.warn(
        '[nodeterm-ops] request failed',
        error instanceof Error ? error.message : String(error)
      )
      if (!res.headersSent) sendJson(res, 500, { error: 'internal' })
      else res.end()
    }
  }
}
