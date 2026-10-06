import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AssistantCreationReceipts, receiptPublication } from './assistant-creation-receipts'
import { publicationPlatform } from '../core/workspace-publication-platform'

let dir: string
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-creation-receipt-')) })
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(dir, { recursive: true, force: true }) })
const source = { principal: 'verified-node' as const, sourceNodeId: 'source', projectId: 'project' }
const creation = { version: 1 as const, taskId: 'stable-task', creationId: 'stable-creation', declaredOwner: 'Declared assistant' }
const nodes = [{ nodeId: 'child', organization: { owner: creation.declaredOwner, projectId: 'project', workstream: 'cleanup', functionalRole: 'ops' } }]
const owner = { ...source, assistantCreationId: 'receipt' }
const record = (store: AssistantCreationReceipts) => store.record(source, creation, nodes, 'a'.repeat(64), 'receipt')
const leaf = async () => (await fs.readdir(dir)).find(f => /^[a-f0-9]{64}\.json$/.test(f))!
const operation = async () => path.join(dir, '.publication', (await fs.readdir(path.join(dir, '.publication')))[0])

it('acknowledges real native receipt publication before creation, preserving exact source/task evidence and idempotency', async () => {
  // No filesystem or platform mocks: this same positive test runs in native Windows CI.
  const store = new AssistantCreationReceipts(dir), receipt = await record(store)
  expect(receipt.publication).toEqual({ version: 1, platform: process.platform,
    guarantee: process.platform === 'win32' ? 'file-flush-visibility' : 'file-and-directory-sync' })
  expect(await store.find(source, creation.creationId)).toEqual(receipt)
  expect(await new AssistantCreationReceipts(dir).find(source, creation.creationId)).toEqual(receipt)
  expect(await record(store)).toEqual(receipt)
  expect(await store.find({ ...source, sourceNodeId: 'other' }, creation.creationId)).toBeUndefined()
  const file = path.join(dir, await leaf()), raw = await fs.readFile(file, 'utf8')
  await expect(store.record(source, creation, [{ ...nodes[0], nodeId: 'different' }], 'a'.repeat(64), 'receipt')).rejects.toThrow('assistant_creation_evidence_conflict')
  expect(await fs.readFile(file, 'utf8')).toBe(raw)
  expect(await store.find(source, creation.creationId)).toEqual(receipt)
  expect(await fs.readFile(path.join(await operation(), 'intent.json'), 'utf8')).toBe(raw)
  await expect(fs.lstat(path.join(await operation(), 'writer.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
  const evidence = await store.attestNode('project', 'child', owner)
  if (process.platform === 'linux') expect(evidence).toMatch(/^[a-f0-9]{64}$/)
  else expect(evidence).toBeUndefined()
  // Durable discovery does not retrospectively enroll a receipt in a new cleanup runtime.
  expect(await new AssistantCreationReceipts(dir).attestNode('project', 'child', owner)).toBeUndefined()
})

it('uses the explicit Windows file-flush adapter with directory handles unavailable and never admits Linux cleanup', async () => {
  vi.spyOn(publicationPlatform, 'nativePlatform').mockReturnValue('win32')
  const open = fs.open, directories: string[] = []
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    if ((await fs.lstat(args[0]).catch(() => undefined))?.isDirectory()) {
      directories.push(String(args[0])); throw Object.assign(new Error('directory handles unavailable'), { code: 'EPERM' })
    }
    return open(...args)
  })
  const store = new AssistantCreationReceipts(dir), receipt = await record(store)
  expect(receipt.publication).toEqual(receiptPublication())
  expect(directories).toEqual([])
  expect(await store.find(source, creation.creationId)).toEqual(receipt)
  vi.mocked(publicationPlatform.nativePlatform).mockReturnValue('linux')
  expect(await store.attestNode('project', 'child', owner)).toBeUndefined()
})

it.each(['before-publish', 'published', 'acknowledged'] as const)('retains interrupted %s receipt bytes and refuses replay, restart adoption and a concurrent writer', async phase => {
  const store = new AssistantCreationReceipts(dir, async at => {
    if (at === phase) {
      await expect(record(new AssistantCreationReceipts(dir))).rejects.toThrow('pending_no_adoption')
      throw new Error('fixture interruption')
    }
  })
  await expect(record(store)).rejects.toThrow('fixture interruption')
  const op = await operation(), intent = await fs.readFile(path.join(op, 'intent.json'), 'utf8')
  expect(JSON.parse(intent)).toMatchObject({ creation, verifiedCreator: source, nodes })
  expect(await fs.readFile(path.join(op, 'publication.json'), 'utf8')).toBe(intent)
  expect((await fs.lstat(path.join(op, 'writer.lock'))).isDirectory()).toBe(true)
  await expect(store.find(source, creation.creationId)).rejects.toThrow('pending_no_adoption')
  await expect(record(new AssistantCreationReceipts(dir))).rejects.toThrow('pending_no_adoption')
  if (phase !== 'before-publish') {
    await expect(store.attestNode('project', 'child', owner)).rejects.toThrow('pending_no_adoption')
    expect(await fs.readFile(path.join(dir, await leaf()), 'utf8')).toBe(intent)
  } else expect(await store.attestNode('project', 'child', owner)).toBeUndefined()
})

it.skipIf(process.platform === 'win32')('retains Linux intent on a directory-sync refusal without granting a retry or cleanup admission', async () => {
  const open = fs.open, store = new AssistantCreationReceipts(dir)
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    if (args[0] === dir) throw Object.assign(new Error('directory sync unsupported'), { code: 'EPERM' })
    return open(...args)
  })
  await expect(record(store)).rejects.toThrow('directory sync unsupported')
  expect(await fs.readdir(dir)).toEqual(['.publication'])
  expect(JSON.parse(await fs.readFile(path.join(await operation(), 'intent.json'), 'utf8'))).toMatchObject({ creation, verifiedCreator: source, nodes })
  await expect(record(store)).rejects.toThrow('pending_no_adoption')
})

it('retains a competing publisher without replacing its bytes or acknowledging this receipt', async () => {
  const store = new AssistantCreationReceipts(dir, async phase => {
    if (phase !== 'before-publish') return
    const name = (await fs.readdir(path.join(dir, '.publication')))[0]
    await fs.writeFile(path.join(dir, `${name}.json`), 'external receipt bytes')
  })
  await expect(record(store)).rejects.toThrow('assistant_creation_evidence_conflict')
  expect(await fs.readFile(path.join(dir, await leaf()), 'utf8')).toBe('external receipt bytes')
  expect(JSON.parse(await fs.readFile(path.join(await operation(), 'intent.json'), 'utf8'))).toMatchObject({ creation, nodes })
  await expect(record(new AssistantCreationReceipts(dir))).rejects.toThrow('pending_no_adoption')
})

it('never adopts a receipt with missing acknowledgment, even when its published bytes still match', async () => {
  const store = new AssistantCreationReceipts(dir)
  await record(store)
  const file = path.join(dir, await leaf()), raw = await fs.readFile(file, 'utf8')
  await fs.unlink(path.join(await operation(), 'ack.json'))
  for (const held of [store, new AssistantCreationReceipts(dir)]) {
    await expect(held.find(source, creation.creationId)).rejects.toThrow('unconfirmed_no_adoption')
    await expect(record(held)).rejects.toThrow('unconfirmed_no_adoption')
    await expect(held.attestNode('project', 'child', owner)).rejects.toThrow('unconfirmed_no_adoption')
  }
  expect(await fs.readFile(file, 'utf8')).toBe(raw)
})

it('refuses unsupported exclusive receipt publication while retaining exact intent and no acknowledgment', async () => {
  vi.spyOn(fs, 'link').mockRejectedValue(Object.assign(new Error('exclusive links unavailable'), { code: 'ENOTSUP' }))
  const store = new AssistantCreationReceipts(dir)
  await expect(record(store)).rejects.toThrow('assistant_creation_evidence_conflict')
  expect(await leaf()).toBeUndefined()
  const op = await operation()
  expect(JSON.parse(await fs.readFile(path.join(op, 'intent.json'), 'utf8'))).toMatchObject({ creation, nodes })
  await expect(fs.lstat(path.join(op, 'ack.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(record(new AssistantCreationReceipts(dir))).rejects.toThrow('pending_no_adoption')
})
