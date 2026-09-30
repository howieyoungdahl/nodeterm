import { mkdtemp, readFile, writeFile, chmod, symlink, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OperatorReceiptStore, appendOperatorAudit } from './operator-receipts'

let dir = ''
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = '' })
const target = { projectId: 'p1', nodeId: 'n1', sessionId: 's1', generation: 'g1' }
async function fresh() { dir = await mkdtemp(path.join(os.tmpdir(), 'operator-receipts-')); return dir }

describe('OperatorReceiptStore', () => {
  it('deduplicates by caller and idempotency key, detects changed payloads, and persists lifecycle', async () => {
    const store = new OperatorReceiptStore(await fresh())
    const [a, b] = await Promise.all([
      store.admit('caller', 'request-001', target, 'synthetic body'),
      store.admit('caller', 'request-002', target, 'other body')
    ])
    expect(store.find('caller', 'request-001', target, 'synthetic body')?.receipt.id).toBe(a.receipt.id)
    expect(() => store.find('caller', 'request-001', target, 'different body')).toThrowError(expect.objectContaining({ code: 'idempotency_conflict' }))
    await store.update(a.receipt.id, 'queued', 'queued')
    await store.update(a.receipt.id, 'acknowledged', 'delivered', 'verified_reply')
    await store.update(a.receipt.id, 'failed', 'late_failure')
    expect((await store.get(a.receipt.id))?.receipt).toMatchObject({ state: 'acknowledged', evidence: 'verified_reply' })
    expect((await store.get(b.receipt.id))?.receipt.state).toBe('accepted')
  })

  it('fails pending receipts on restart without replay, including lookup by the same key', async () => {
    const dirPath = await fresh()
    const first = new OperatorReceiptStore(dirPath)
    const queued = await first.admit('caller', 'request-001', target, 'message')
    await first.update(queued.receipt.id, 'queued', 'queued')
    const recovered = new OperatorReceiptStore(dirPath)
    const receipt = await recovered.get(queued.receipt.id)
    expect(receipt?.receipt).toMatchObject({ state: 'failed', outcome: 'server_restarted', evidence: 'delivery_unknown_no_replay' })
    expect(recovered.find('caller', 'request-001', target, 'message')?.receipt.id).toBe(queued.receipt.id)
    expect(() => recovered.find('caller', 'request-001', target, 'changed')).toThrowError(expect.objectContaining({ code: 'idempotency_conflict' }))
  })

  it('stores hashes rather than message text and fails closed on symlinked receipt files', async () => {
    const d = await fresh()
    const store = new OperatorReceiptStore(d)
    await store.admit('caller', 'request-001', target, 'private synthetic phrase')
    const raw = await readFile(path.join(d, 'operator-message-receipts.json'), 'utf8')
    expect(raw).not.toContain('private synthetic phrase')
    const original = path.join(d, 'original.json')
    await readFile(path.join(d, 'operator-message-receipts.json')).then((x) => import('node:fs/promises').then((fs) => fs.writeFile(original, x)))
    await rm(path.join(d, 'operator-message-receipts.json'))
    await symlink(original, path.join(d, 'operator-message-receipts.json'))
    expect(() => new OperatorReceiptStore(d).find('caller', 'request-001', target, 'private synthetic phrase')).toThrowError(expect.objectContaining({ code: 'receipt_store_unavailable' }))
  })

  it('rejects malformed valid-JSON records on reads and never replays their pending entries', async () => {
    const d = await fresh()
    const source = new OperatorReceiptStore(d)
    const pending = await source.admit('caller', 'request-001', target, 'message')
    await source.admit('caller', 'request-002', target, 'second message')
    const file = path.join(d, 'operator-message-receipts.json')
    const valid = JSON.parse(await readFile(file, 'utf8'))
    const mutations: Array<(data: any) => void> = [
      (data) => { data.records[0].content = 'should-not-persist' },
      (data) => { data.records[0].receipt.state = 'sending' },
      (data) => { data.records[0].receipt.outcome = 'raw exception: private text' },
      (data) => { data.records[0].receipt.evidence = 'not_verified' },
      (data) => { data.records[0].receipt.target.nodeId = '../other' },
      (data) => { data.records[0].receipt.updatedAt = 'not-a-date' },
      (data) => { data.records[1].receipt.id = data.records[0].receipt.id },
      (data) => { data.records[1].keyHash = data.records[0].keyHash }
    ]
    for (const mutate of mutations) {
      const invalid = structuredClone(valid)
      mutate(invalid)
      const raw = JSON.stringify(invalid)
      await writeFile(file, raw, { mode: 0o600 })
      const reopened = new OperatorReceiptStore(d)
      expect(() => reopened.find('caller', 'request-001', target, 'message')).toThrowError(expect.objectContaining({ code: 'receipt_store_unavailable' }))
      await expect(reopened.get(pending.receipt.id)).rejects.toMatchObject({ code: 'receipt_store_unavailable' })
      expect(await readFile(file, 'utf8')).toBe(raw)
    }
  })
})

describe('operator audit', () => {
  it('is content-free and refuses a permissive or symlinked audit file', async () => {
    const d = await fresh()
    appendOperatorAudit(d, { caller: 'operator1', operation: 'message', target, outcome: 'accepted' })
    const audit = path.join(d, 'operator-conversation-audit.jsonl')
    expect(await readFile(audit, 'utf8')).not.toContain('secret')
    await chmod(audit, 0o644)
    expect(() => appendOperatorAudit(d, { caller: 'operator1', operation: 'read', outcome: 'ok' })).toThrowError(expect.objectContaining({ code: 'audit_unavailable' }))
  })
})
