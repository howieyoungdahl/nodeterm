import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { promises as fs, appendFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readLocalSettingsEvidence } from './local-settings-store'
import { WorkspaceStore } from './workspace-store'
import { fakePlatform } from './platform-fake'
import { initPlatform, resetPlatformForTests } from './platform'
import { renameAtomic } from './fs-atomic'
import { revisionOf } from './project-commit-store'
const hook = vi.hoisted(() => ({ onRead: undefined as (() => void) | undefined, bytes: 0 }))
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>()
  return { ...actual, readSync: (...args: Parameters<typeof actual.readSync>) => {
    const action = hook.onRead; hook.onRead = undefined; action?.()
    const count = actual.readSync(...args); hook.bytes += count; return count
  } }
})
let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-local-evidence-'))
  initPlatform(fakePlatform({ userDataDir: dir })); hook.bytes = 0
  await fs.writeFile(path.join(dir, 'workspace.json'), JSON.stringify({ version: 3, entries: [{ id: 'p1', dataFile: true }] }))
})
afterEach(async () => { hook.onRead = undefined; resetPlatformForTests(); await fs.rm(dir, { recursive: true, force: true }) })

it('consumes at most cap+1 bytes when an actual opened file grows after its stat', async () => {
  const file = path.join(dir, 'grow'); await fs.writeFile(file, '1234')
  hook.onRead = () => appendFileSync(file, '567890')
  expect(() => readLocalSettingsEvidence(file, 4)).toThrow('grew beyond')
  expect(hook.bytes).toBe(5)
})

it('refuses an oversized or redirected evidence leaf without consuming its contents', async () => {
  const file = path.join(dir, 'large'); await fs.writeFile(file, '12345')
  expect(() => readLocalSettingsEvidence(file, 4)).toThrow('byte bound')
  expect(hook.bytes).toBe(0)
  const redirected = path.join(dir, 'link'); await fs.symlink(file, redirected)
  expect(() => readLocalSettingsEvidence(redirected, 100)).toThrow()
  expect(hook.bytes).toBe(0)
})

it('incremental history enumeration refuses literal 4097-entry overflow', async () => {
  const store = new WorkspaceStore(); await store.readAcknowledgedProjectSettings('p1')
  const history = path.join(dir, '.recovery', 'workspace.json', 'versions')
  for (let batch = 0; batch < 4096; batch += 128)
    await Promise.all(Array.from({ length: 128 }, (_, i) => fs.writeFile(path.join(history, `extra-${batch + i}`), '')))
  await expect(store.readAcknowledgedProjectSettings('p1')).rejects.toThrow('4096 entries')
})

it('a redirected retained history directory cannot become an empty or writable base', async () => {
  const store = new WorkspaceStore(); await store.readAcknowledgedProjectSettings('p1')
  const history = path.join(dir, '.recovery', 'workspace.json', 'versions')
  await renameAtomic(history, `${history}-preserved`)
  await fs.symlink(`${history}-preserved`, history)
  await expect(store.readAcknowledgedProjectSettings('p1')).rejects.toThrow('directory is redirected')
})

it('new-adapter enrollment evidence has an actual byte bound', async () => {
  const store = new WorkspaceStore(), snap = await store.readAcknowledgedProjectSettings('p1')
  const client = path.join(dir, 'reconciliation-clients', snap!.localBase!.clientId)
  const enrollment = (await fs.readdir(client))[0]
  await fs.truncate(path.join(client, enrollment), 32 * 1024 * 1024 + 1)
  const before = await fs.readFile(path.join(dir, 'workspace.json'), 'utf8')
  const result = await store.updateLocalProjectSettings('p1', { ...snap!.localBase, projectId: 'p1', operationId: 'edit', changes: [] })
  expect(result.kind).toBe('publication-refused'); expect(result.message).toContain('byte bound')
  expect(await fs.readFile(path.join(dir, 'workspace.json'), 'utf8')).toBe(before)
})

it('oversized immutable intent is a refusal, never a replacement or fresh operation', async () => {
  const store = new WorkspaceStore(), snap = await store.readAcknowledgedProjectSettings('p1')
  const client = path.join(dir, 'reconciliation-clients', snap!.localBase!.clientId)
  const intent = path.join(client, `local-${revisionOf('edit')}.json`)
  await fs.writeFile(intent, ''); await fs.truncate(intent, 1024 * 1024 + 1)
  const before = await fs.readFile(path.join(dir, 'workspace.json'), 'utf8')
  const result = await store.updateLocalProjectSettings('p1', { ...snap!.localBase, projectId: 'p1', operationId: 'edit', changes: [] })
  expect(result.kind).toBe('publication-refused'); expect(result.message).toContain('byte bound')
  expect((await fs.stat(intent)).size).toBe(1024 * 1024 + 1)
  expect(await fs.readFile(path.join(dir, 'workspace.json'), 'utf8')).toBe(before)
})
