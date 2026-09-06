import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { assignmentConfig, canonicalAssignmentValidator, type CanonicalAssignmentConfig } from './canonical-assignment'
import type { MessageAssignment } from './message-integrity'

const assignmentModule = process.env.NODETERM_TEST_ASSIGNMENT_MODULE
const assignmentProducer = process.env.NODETERM_TEST_ASSIGNMENT_PRODUCER
if (Boolean(assignmentModule) !== Boolean(assignmentProducer))
  throw new Error('Canonical conformance requires both NODETERM_TEST_ASSIGNMENT_MODULE and NODETERM_TEST_ASSIGNMENT_PRODUCER')
if (assignmentModule && (!path.isAbsolute(assignmentModule) || !path.isAbsolute(assignmentProducer!)))
  throw new Error('Canonical conformance module and producer paths must be absolute')

const binding = (): MessageAssignment => ({ task_id: 'task', assignment_id: 'assignment-task', assignment_epoch: 1,
  actor: { agent_id: 'target', node: 'target', pane: '%1', session_id: 'session-target',
    incarnation: 'incarnation-1', provider: 'claude' },
  contract_ref: { uri: '/contract', sha256: 'a'.repeat(64) }, policy_ref: { uri: '/policy', sha256: 'b'.repeat(64) } })
const hash = (filename: string) => createHash('sha256').update(fs.readFileSync(filename)).digest('hex')
let dir: string
let config: CanonicalAssignmentConfig

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeterm-canonical-assignment-'))
  config = { pythonPath: '/usr/bin/python3', modulePath: path.join(dir, 'fixture.py'),
    moduleSha256: '', ledgerPath: path.join(dir, 'ledger.json') }
  fs.writeFileSync(config.ledgerPath, 'fixture')
  fs.writeFileSync(config.ledgerPath + '.lock', '')
  fs.writeFileSync(config.modulePath, `import os
def assignment_validate(path, **request):
    if len(os.environ) > 2 or 'NODETERM_TEST_PRIVATE_CREDENTIAL' in os.environ:
        return {'ok': False, 'code': 'credential_leak'}
    return {'ok': True, 'code': 'ok', 'assignment': dict(task_id=request['task_id'],
        assignment_id='assignment-task', assignment_epoch=request['expected_epoch'], actor=request['actor'],
        contract_ref=request['contract_ref'], policy_ref=request['policy_ref'])}
`)
  config.moduleSha256 = hash(config.modulePath)
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('explicit canonical adapter', () => {
  it('has no ambient source and refuses partial/relative startup configuration', async () => {
    expect(assignmentConfig({})).toBeUndefined()
    expect(() => assignmentConfig({ NODETERM_ASSIGNMENT_LEDGER: 'relative' })).toThrow()
    expect(await canonicalAssignmentValidator()(binding(), 'admission')).toEqual({ ok: false, code: 'assignment-validator-unavailable' })
  })
  it('does not inherit credentials or put the binding/body in process argv', async () => {
    const previous = process.env.NODETERM_TEST_PRIVATE_CREDENTIAL
    process.env.NODETERM_TEST_PRIVATE_CREDENTIAL = 'private-test-value'
    try {
      expect(await canonicalAssignmentValidator(config)(binding(), 'delivery')).toEqual({ ok: true, code: 'ok' })
      expect(fs.readFileSync(config.ledgerPath, 'utf8')).toBe('fixture')
    } finally {
      if (previous === undefined) delete process.env.NODETERM_TEST_PRIVATE_CREDENTIAL
      else process.env.NODETERM_TEST_PRIVATE_CREDENTIAL = previous
    }
  })
  it('compares the assignment ID omitted from the public API parameters', async () => {
    expect(await canonicalAssignmentValidator(config)({ ...binding(), assignment_id: 'wrong' }, 'admission'))
      .toEqual({ ok: false, code: 'assignment-binding-mismatch' })
  })
  it('refuses changed module bytes and never creates missing registries or locks', async () => {
    const validator = canonicalAssignmentValidator(config)
    fs.appendFileSync(config.modulePath, '\n# changed\n')
    expect((await validator(binding(), 'admission')).ok).toBe(false)
    fs.unlinkSync(config.ledgerPath)
    expect((await validator(binding(), 'admission')).ok).toBe(false)
    expect(fs.existsSync(config.ledgerPath)).toBe(false)
  })
  it('bounds a blocked canonical API without returning sensitive stderr', async () => {
    fs.writeFileSync(config.modulePath, `import time\ndef assignment_validate(*args, **kw):\n    time.sleep(30)\n`)
    config.moduleSha256 = hash(config.modulePath)
    expect(await canonicalAssignmentValidator(config)(binding(), 'admission'))
      .toEqual({ ok: false, code: 'assignment-source-unavailable' })
  })
  it('refuses a module larger than the bounded source read even with its matching digest', async () => {
    fs.writeFileSync(config.modulePath, Buffer.alloc(2 * 1024 * 1024, 32))
    config.moduleSha256 = hash(config.modulePath)
    expect(await canonicalAssignmentValidator(config)(binding(), 'admission'))
      .toEqual({ ok: false, code: 'assignment-source-unavailable' })
  })
})

// The source is explicit, pinned by this invocation, and used only to produce a new tmp fixture.
// CI without that separate repository still runs the adapter contract tests above.
describe.skipIf(!assignmentModule)('actual canonical D15 conformance', () => {
  it('validates exact bindings read-only and rejects stale epochs, actors and references', async () => {
    config.modulePath = assignmentModule!
    config.moduleSha256 = hash(config.modulePath)
    fs.unlinkSync(config.ledgerPath)
    execFileSync(config.pythonPath, ['-I', '-B', assignmentProducer!,
      config.modulePath, config.ledgerPath], { timeout: 5000, env: { LC_ALL: 'C.UTF-8' } })
    const before = fs.readFileSync(config.ledgerPath)
    const validate = canonicalAssignmentValidator(config)
    for (const phase of ['admission', 'delivery', 'acknowledgment'] as const)
      expect(await validate(binding(), phase)).toEqual({ ok: true, code: 'ok' })
    for (const [change, code] of [
      [{ assignment_epoch: 2 }, 'stale_epoch'],
      [{ actor: { ...binding().actor, incarnation: 'wrong' } }, 'actor_mismatch'],
      [{ contract_ref: { ...binding().contract_ref, sha256: 'c'.repeat(64) } }, 'reference_mismatch'],
      [{ policy_ref: { ...binding().policy_ref, uri: '/wrong' } }, 'reference_mismatch'],
      [{ assignment_id: 'wrong' }, 'assignment-binding-mismatch']
    ] as const) expect(await validate({ ...binding(), ...change }, 'delivery')).toEqual({ ok: false, code })
    expect(fs.readFileSync(config.ledgerPath)).toEqual(before)
  })
})
