import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'
import { WorkspaceStore } from './workspace-store'
import { ProjectCommitStore, revisionOf } from './project-commit-store'
import { localSettingsDelta } from '../shared/local-settings-reconciliation'

let dir: string
let handlers: ReturnType<typeof fakePlatform>['handlers']
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-local-settings-'))
  const fake = fakePlatform({ userDataDir: dir }); initPlatform(fake); handlers = fake.handlers
  await fs.writeFile(path.join(dir, 'workspace.json'), JSON.stringify({ version: 3, activeProjectId: 'p1', future: 7,
    entries: [{ id: 'p1', dataFile: true, name: 'One', color: '#fff', localSettings: { terminal: { theme: 'old', future: 9 } } }] }))
  new WorkspaceStore().registerIpc()
})
afterEach(async () => { vi.restoreAllMocks(); resetPlatformForTests(); await fs.rm(dir, { recursive: true, force: true }) })
const bytes = () => fs.readFile(path.join(dir, 'workspace.json'), 'utf8')
const read = () => handlers['project-settings:read']('p1') as Promise<any>
const input = (snap: any, changes = [{ family: 'terminal', key: 'theme', value: 'new' }], operationId = 'edit') =>
  ({ ...snap.localBase, projectId: 'p1', operationId, changes })
const update = (request: any) => handlers['project-settings:update-local-reconciled']('p1', request) as Promise<any>

it('an actual old boolean consumer sees literal false, never a truthy typed refusal', async () => {
  await read(); const before = await bytes()
  const legacy = await handlers['project-settings:update-local']('p1', { terminal: { theme: 'lost' } })
  expect(legacy).toBe(false); expect(Boolean(legacy)).toBe(false)
  expect(await bytes()).toBe(before); expect((await read()).local.terminal.theme).toBe('old')
})

it('registered settings read enrolls an exact index-only base and local delta commits without a canvas load', async () => {
  const snap = await handlers['project-settings:read']('p1') as any
  expect(snap?.localBase?.indexRevision).toMatch(/^[a-f0-9]{64}$/)
  const result = await handlers['project-settings:update-local-reconciled']('p1', { ...snap.localBase, projectId: 'p1', operationId: 'theme-edit',
    changes: [{ family: 'terminal', key: 'theme', value: 'new' }] }) as any
  expect(result.kind).toBe('committed')
  const disk = JSON.parse(await fs.readFile(path.join(dir, 'workspace.json'), 'utf8'))
  expect(disk.future).toBe(7)
  expect(disk.entries[0].localSettings.terminal).toEqual({ theme: 'new', future: 9 })
  expect(result.current.local).toEqual({ terminal: { theme: 'new' } })
})

it('merges two independent callers and returns a fresh matching projection on an old receipt', async () => {
  const a = await read(), b = await read()
  const first = input(a), second = input(b, [{ family: 'terminal', key: 'fontFamily', value: 'monospace' }], 'font')
  expect((await update(first)).kind).toBe('committed')
  new WorkspaceStore().registerIpc()
  expect((await update(second)).kind).toBe('committed')
  const disk = await bytes(), replay = await update(first)
  expect(replay.kind).toBe('already-applied')
  expect(replay.current.indexRevision).toBe(revisionOf(disk))
  expect(replay.current.local.terminal).toEqual({ theme: 'new', fontFamily: 'monospace' })
  expect(await bytes()).toBe(disk)
  expect((await new WorkspaceStore().readProjectSettings('p1'))?.local).toEqual(replay.current.local)
})

it('same-leaf conflict and malformed or unbound input never leak into host reads', async () => {
  const a = await read(), b = await read()
  await update(input(a))
  const before = await bytes()
  expect((await update(input(b, [{ family: 'terminal', key: 'theme', value: 'loser' }]))).kind).toBe('conflict')
  for (const bad of [undefined, {}, { terminal: { theme: 'bad' } },
    { ...input(b), changes: [{ family: 'terminal', key: 'theme', value: null }] },
    { ...input(b), changes: [{ family: '__proto__', key: 'polluted', value: 'yes' }] },
    { ...input(b), clientId: '00000000-0000-0000-0000-000000000000' }])
    expect((await update(bad)).kind).toBe('publication-refused')
  expect(await bytes()).toBe(before)
  expect((await read()).local.terminal.theme).toBe('new')
})

it('busy retains immutable wire intent; retry cannot change leaves or target', async () => {
  const snap = await read(), request = input(snap), store = new ProjectCommitStore(path.join(dir, 'workspace.json'))
  const lock = path.join(store.recovery, 'writer.lock'); await fs.mkdir(lock)
  const before = await bytes()
  expect((await update(request)).kind).toBe('busy')
  expect((await update({ ...request, changes: [{ family: 'terminal', key: 'theme', value: 'changed' }] })).kind).toBe('publication-refused')
  await expect(read()).rejects.toThrow('E_PUBLICATION_BUSY')
  expect(await bytes()).toBe(before)
  await fs.rmdir(lock) // this fixture's own lock only
  expect((await update(request)).kind).toBe('committed')
})

it.each(['absent', 'relocated', 'tombstone', 'duplicate'])('refuses observed target ABA (%s), even with byte-identical current base', async (kind) => {
  const snap = await read(), before = await bytes(), altered = JSON.parse(before)
  if (kind === 'absent') altered.entries = []
  if (kind === 'relocated') altered.entries[0].cwd = '/synthetic/other'
  if (kind === 'tombstone') altered._reconciliation = { version: 1, deleted: { entries: ['p1'] } }
  if (kind === 'duplicate') altered.entries.push(structuredClone(altered.entries[0]))
  const file = path.join(dir, 'workspace.json'), store = new ProjectCommitStore(file)
  await fs.writeFile(file, JSON.stringify(altered)); await store.observe()
  await fs.writeFile(file, before); await store.observe()
  expect((await update(input(snap))).kind).toBe('publication-refused')
  expect(await bytes()).toBe(before)
})

it('refuses pruned, redirected or corrupt history rather than assuming uninterrupted lineage', async () => {
  await read(); const snap = await read(), store = new ProjectCommitStore(path.join(dir, 'workspace.json'))
  const version = path.join(store.recovery, 'versions', `${snap.localBase.indexRevision}.json`)
  await fs.writeFile(version, '{}')
  const before = await bytes()
  expect((await update(input(snap))).kind).toBe('stale-base')
  expect(await bytes()).toBe(before)
})

it('lost response after an actual durable receipt settles without replay; partial receipt stays unknown', async () => {
  const snap = await read(), request = input(snap), original = ProjectCommitStore.prototype.commit
  const spy = vi.spyOn(ProjectCommitStore.prototype, 'commit').mockImplementationOnce(async function (this: ProjectCommitStore, req, conditional) {
    await original.call(this, req, conditional)
    throw new Error('injected lost transport response')
  })
  expect((await update(request)).kind).toBe('publication-unknown')
  spy.mockRestore()
  const before = await bytes(), recovered = await update(request)
  expect(recovered.kind).toBe('already-applied')
  expect(await bytes()).toBe(before)
  await fs.writeFile(path.join(recovered.recovery, 'receipt.json'), JSON.stringify({ kind: 'committed', recovery: recovered.recovery }))
  expect((await update(request)).kind).toBe('publication-unknown')
  expect(await bytes()).toBe(before)
})

it('actual publication without receipt remains unknown with the identical request and bytes', async () => {
  const snap = await read(), request = input(snap), original = ProjectCommitStore.prototype.commit
  const spy = vi.spyOn(ProjectCommitStore.prototype, 'commit').mockImplementationOnce(async function (this: ProjectCommitStore, req, conditional) {
    return original.call(new ProjectCommitStore(this.file, async (phase) => { if (phase === 'published') throw new Error('lost before receipt') }, new Set(['entries'])), req, conditional)
  })
  const result = await update(request)
  expect(result.kind).toBe('publication-unknown'); spy.mockRestore()
  const before = await bytes()
  expect((await update(request)).kind).toBe('publication-unknown')
  expect(await bytes()).toBe(before)
})

it('known clear preserves unknown nested extensions, siblings, view fields and caches', async () => {
  const raw = JSON.parse(await bytes())
  raw.entries[0].localSettings.ignoreShared = { terminal: true, future: { keep: 1 } }
  raw.entries[0].settingsCache = { future: 1 }; raw.entries[0].viewport = { x: 3, y: 4, zoom: 2 }
  raw.entries.push({ id: 'p2', localSettings: { terminal: { shell: 'keep' } }, future: 9 })
  await fs.writeFile(path.join(dir, 'workspace.json'), JSON.stringify(raw))
  const snap = await read()
  const result = await update({ ...input(snap), changes: localSettingsDelta(snap.local, undefined) })
  expect(result.kind).toBe('committed')
  const disk = JSON.parse(await bytes())
  expect(disk.entries[0].localSettings).toEqual({ terminal: { future: 9 }, ignoreShared: { future: { keep: 1 } } })
  expect(disk.entries[0].settingsCache).toEqual(raw.entries[0].settingsCache)
  expect(disk.entries[0].viewport).toEqual(raw.entries[0].viewport)
  expect(disk.entries[1]).toEqual(raw.entries[1])
})

it('environment edits/removals preserve unseen entries and merge independent callers by variable', async () => {
  const raw = JSON.parse(await bytes())
  raw.entries[0].localSettings.agents = { env: { ONE: '1', TWO: '2', constructor: 'own', 'future-extension': { retain: true } } }
  await fs.writeFile(path.join(dir, 'workspace.json'), JSON.stringify(raw))
  const a = await read(), b = await read()
  expect((await update({ ...input(a), changes: localSettingsDelta(a.local, { ...a.local, agents: { env: { ...a.local.agents.env, ONE: 'changed' } } }) })).kind).toBe('committed')
  expect((await update({ ...input(b), changes: localSettingsDelta(b.local, { ...b.local, agents: { env: { ...b.local.agents.env, TWO: 'changed' } } }) })).kind).toBe('committed')
  const now = await read()
  expect((await update({ ...input(now), changes: localSettingsDelta(now.local, undefined) })).kind).toBe('committed')
  expect(JSON.parse(await bytes()).entries[0].localSettings.agents.env).toEqual({ 'future-extension': { retain: true } })
})
