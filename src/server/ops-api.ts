import http from 'node:http'

import type {
  OpsAdoptResult,
  OpsNodeInventoryItem,
  OpsRemoveResult,
  OpsSweepResult
} from './node-ops'
import { opsBearerMatches } from './ops-token'
import type { SpawnHandlerSnapshot } from './spawn-handler-state'

const OPS_BODY_MAX_BYTES = 10 * 1024

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
  token: string
  nodes(): Promise<OpsNodeInventoryItem[]>
  sweep(dryRun: boolean): Promise<OpsSweepResult>
  remove(nodeId: string, force: boolean): Promise<OpsRemoveResult>
  /** The sweep's mirror image: card a live `nt-<id>` session that no project still lists. */
  adoptOrphans(): Promise<OpsAdoptResult>
  health(): OpsHealth | Promise<OpsHealth>
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

function readJson(req: http.IncomingMessage): Promise<unknown> {
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
      if (size > OPS_BODY_MAX_BYTES) {
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
      if (!opsBearerMatches(req.headers.authorization, deps.token)) {
        res.setHeader('WWW-Authenticate', 'Bearer realm="nodeterm-ops"')
        sendJson(res, 401, { error: 'unauthorized' })
        return
      }

      if (pathname === '/opsapi/nodes') {
        if (method !== 'GET') {
          res.setHeader('Allow', 'GET')
          sendJson(res, 405, { error: 'method_not_allowed' })
          return
        }
        sendJson(res, 200, { nodes: await deps.nodes() })
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
        if (
          !body ||
          typeof body !== 'object' ||
          Array.isArray(body) ||
          typeof (body as { dryRun?: unknown }).dryRun !== 'boolean' ||
          Object.keys(body).some((key) => key !== 'dryRun')
        ) {
          sendJson(res, 400, { error: 'body_must_be_exactly_dryRun_boolean' })
          return
        }
        sendJson(res, 200, await deps.sweep((body as { dryRun: boolean }).dryRun))
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

      const removeMatch = /^\/opsapi\/nodes\/([^/]+)$/.exec(pathname)
      if (removeMatch) {
        if (method !== 'DELETE') {
          res.setHeader('Allow', 'DELETE')
          sendJson(res, 405, { error: 'method_not_allowed' })
          return
        }
        const nodeId = validNodeIdSegment(removeMatch[1])
        if (!nodeId) {
          sendJson(res, 400, { error: 'invalid_node_id' })
          return
        }
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
