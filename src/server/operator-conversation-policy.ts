import fs from 'node:fs'
import { createHash, timingSafeEqual } from 'node:crypto'
import { safeOperatorId } from '../core/operator-session-bindings'
import type { OperatorSessionTarget } from '../shared/operator-conversations'

export type OperatorOperation = 'read' | 'message'
export interface OperatorExactScope { projectId: string; nodeId: string; sessionId: string }
export const OPERATOR_STANDING_SCOPE_KIND = 'all-current-and-future-verified-sessions'
export type OperatorScope = OperatorExactScope | { kind: typeof OPERATOR_STANDING_SCOPE_KIND }
export interface OperatorPrincipal {
  id: string
  tokenSha256: string
  expiresAt: string
  read: OperatorScope[]
  message: OperatorScope[]
}

export const OPERATOR_POLICY_FILE = 'operator-conversations.json'
const POLICY_MAX_BYTES = 64 * 1024
export const tokenDigest = (token: string): string => createHash('sha256').update(token).digest('hex')

function exactKeys(o: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(o).length === keys.length && keys.every((key) => Object.hasOwn(o, key))
}

function scopes(value: unknown, standing: boolean): value is OperatorScope[] {
  return Array.isArray(value) && value.length <= 100 && value.every((scope) => {
    if (!scope || typeof scope !== 'object' || Array.isArray(scope)) return false
    // Only v2 can express standing authority. An old server rejects the whole v2 policy.
    if (standing && exactKeys(scope, ['kind'])) return scope.kind === OPERATOR_STANDING_SCOPE_KIND
    return exactKeys(scope, ['projectId', 'nodeId', 'sessionId']) &&
      ['projectId', 'nodeId', 'sessionId'].every((key) => safeOperatorId(scope[key]))
  })
}

/** No provisioning or chmod at boot. Missing, invalid or non-private policy denies access. */
export function loadOperatorPrincipals(file: string): OperatorPrincipal[] {
  let fd: number | undefined
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.size > POLICY_MAX_BYTES ||
      (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 ||
        (process.getuid && stat.uid !== process.getuid())))) return []
    const value = JSON.parse(fs.readFileSync(fd, 'utf8')) as Record<string, unknown>
    if (!exactKeys(value, ['version', 'principals']) || (value.version !== 1 && value.version !== 2) ||
      !Array.isArray(value.principals) || value.principals.length > 100) return []
    const seen = new Set<string>()
    const tokens = new Set<string>()
    for (const p of value.principals) {
      if (!p || typeof p !== 'object' || Array.isArray(p) ||
        !exactKeys(p, ['id', 'tokenSha256', 'expiresAt', 'read', 'message']) ||
        !safeOperatorId(p.id) || !/^[a-f0-9]{64}$/.test(p.tokenSha256) ||
        typeof p.expiresAt !== 'string' || !Number.isFinite(Date.parse(p.expiresAt)) ||
        !scopes(p.read, value.version === 2) || !scopes(p.message, value.version === 2) ||
        seen.has(p.id) || tokens.has(p.tokenSha256)) return []
      seen.add(p.id); tokens.add(p.tokenSha256)
    }
    return value.principals as OperatorPrincipal[]
  } catch { return [] }
  finally { if (fd !== undefined) fs.closeSync(fd) }
}

/** A management bearer never gains conversation authority, even through a mistaken policy. */
export function authenticateOperator(
  authorization: string | string[] | undefined,
  principals: OperatorPrincipal[], managementToken: string, now = Date.now()
): OperatorPrincipal | undefined {
  if (typeof authorization !== 'string' || authorization.length > 160) return undefined
  const match = /^Bearer ([A-Za-z0-9_-]{40,128})$/.exec(authorization)
  if (!match) return undefined
  const supplied = Buffer.from(tokenDigest(match[1]), 'hex')
  if (timingSafeEqual(supplied, Buffer.from(tokenDigest(managementToken), 'hex'))) return undefined
  return principals.find((p) => Date.parse(p.expiresAt) > now &&
    timingSafeEqual(supplied, Buffer.from(p.tokenSha256, 'hex')))
}

export function operatorAllowed(
  principal: OperatorPrincipal, operation: OperatorOperation, target: OperatorSessionTarget
): boolean {
  // This chooses scope only: verified identity and generation still require bindings.resolve().
  return principal[operation].some((s) => 'kind' in s
    ? s.kind === OPERATOR_STANDING_SCOPE_KIND
    : s.projectId === target.projectId && s.nodeId === target.nodeId && s.sessionId === target.sessionId)
}
