import { mkdtemp, writeFile, chmod, symlink, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { authenticateOperator, loadOperatorPrincipals, operatorAllowed, tokenDigest, OPERATOR_STANDING_SCOPE_KIND } from './operator-conversation-policy'

let dir = ''
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = '' })
const target = { projectId: 'p1', nodeId: 'n1', sessionId: 's1', generation: 'g1' }
const token = 'operator-token-012345678901234567890123456789'
async function policy(value: unknown, mode = 0o600) {
  dir = await mkdtemp(path.join(os.tmpdir(), 'operator-policy-'))
  const file = path.join(dir, 'policy.json')
  await writeFile(file, JSON.stringify(value), { mode })
  await chmod(file, mode)
  return file
}
function config(exp = '2099-01-01T00:00:00Z') { return { version: 1, principals: [{ id: 'operator1', tokenSha256: tokenDigest(token), expiresAt: exp,
  read: [{ projectId: 'p1', nodeId: 'n1', sessionId: 's1' }], message: [] }] } }

describe('operator conversation policy', () => {
  it.each(['read', 'message'] as const)('grants standing %s independently, retaining exact scopes in v2', async (operation) => {
    const principal = config().principals[0]
    const exact = principal.read[0]
    const principals = loadOperatorPrincipals(await policy({ version: 2, principals: [{ ...principal,
      read: operation === 'read' ? [exact, { kind: OPERATOR_STANDING_SCOPE_KIND }] : [exact],
      message: operation === 'message' ? [{ kind: OPERATOR_STANDING_SCOPE_KIND }] : []
    }] }))
    expect(principals).toHaveLength(1)
    const authorized = authenticateOperator(`Bearer ${token}`, principals, 'management')!
    const future = { projectId: 'future-project', nodeId: 'future-node', sessionId: 'future-session', generation: 'future-generation' }
    expect(operatorAllowed(authorized, operation, future)).toBe(true)
    expect(operatorAllowed(authorized, operation === 'read' ? 'message' : 'read', future)).toBe(false)
    expect(operatorAllowed(authorized, 'read', target)).toBe(true)
    expect(authenticateOperator(`Bearer ${token}`, principals, 'management', Date.parse('2100-01-01'))).toBeUndefined()
  })

  it.each([
    [1, { kind: OPERATOR_STANDING_SCOPE_KIND }],
    [3, { kind: OPERATOR_STANDING_SCOPE_KIND }],
    [2, { kind: '*' }],
    [2, '*'],
    [2, { kind: OPERATOR_STANDING_SCOPE_KIND, projectId: 'p1' }],
    [2, { kind: OPERATOR_STANDING_SCOPE_KIND, generation: 'g1' }],
    [2, { projectId: '*', nodeId: '*', sessionId: '*' }],
    [2, { kind: 'all-current-verified-sessions' }],
    [2, null]
  ])('rejects version %s with malformed or unsupported scope %j', async (version, scope) => {
    const file = await policy({ version, principals: [{ ...config().principals[0], read: [scope] }] })
    expect(loadOperatorPrincipals(file)).toEqual([])
  })

  it('preserves exact grants in v2 without making them standing grants', async () => {
    const principal = loadOperatorPrincipals(await policy({ ...config(), version: 2 }))[0]
    expect(operatorAllowed(principal, 'read', target)).toBe(true)
    expect(operatorAllowed(principal, 'read', { ...target, sessionId: 'replacement' })).toBe(false)
  })

  it('requires an exact policy and validates its fields', async () => {
    const file = await policy(config())
    expect(loadOperatorPrincipals(file)).toHaveLength(1)
    await writeFile(file, JSON.stringify({ ...config(), permissive: true }))
    expect(loadOperatorPrincipals(file)).toEqual([])
  })

  it.skipIf(process.platform === 'win32').each([1, 2])('rejects permissive policy modes and symlinked v%s policy paths', async (version) => {
    const file = await policy({ ...config(), version })
    await chmod(file, 0o644)
    expect(loadOperatorPrincipals(file)).toEqual([])
    await chmod(file, 0o600)
    const link = path.join(dir, 'link.json')
    await symlink(file, link)
    expect(loadOperatorPrincipals(link)).toEqual([])
  })

  it('rejects duplicate identities, malformed scopes and expired credentials closed', async () => {
    const file = await policy({ version: 1, principals: [...config().principals, ...config().principals] })
    expect(loadOperatorPrincipals(file)).toEqual([])
    await writeFile(file, JSON.stringify({ version: 1, principals: [{ ...config().principals[0], read: [{ ...target, schoolId: 'x' }] }] }))
    expect(loadOperatorPrincipals(file)).toEqual([])
    const expired = loadOperatorPrincipals(await policy(config('2000-01-01T00:00:00Z')))
    expect(authenticateOperator(`Bearer ${token}`, expired, 'management-token-123456789012345678901')).toBeUndefined()
  })

  it('keeps management, read and message authority distinct and target exact', async () => {
    const principals = loadOperatorPrincipals(await policy(config()))
    const principal = authenticateOperator(`Bearer ${token}`, principals, 'management-token-123456789012345678901')!
    // Even an accidentally provisioned management-token hash must not gain new powers.
    expect(authenticateOperator(`Bearer ${token}`, principals, token)).toBeUndefined()
    expect(authenticateOperator('Bearer management-token-123456789012345678901', principals, 'management-token-123456789012345678901')).toBeUndefined()
    expect(operatorAllowed(principal, 'read', target)).toBe(true)
    expect(operatorAllowed(principal, 'message', target)).toBe(false)
    expect(operatorAllowed(principal, 'read', { ...target, nodeId: 'other-node' })).toBe(false)
    expect(operatorAllowed(principal, 'read', { ...target, projectId: 'other-project' })).toBe(false)
    expect(authenticateOperator(`Bearer ${token}`, principals, 'management-token-123456789012345678901', Date.parse('2100-01-01'))).toBeUndefined()
  })
})
