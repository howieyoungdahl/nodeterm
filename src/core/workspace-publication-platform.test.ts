import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { publicationFence, publicationPlatform } from './workspace-publication-platform'
import { publishWorkspaceFile } from './workspace-retained-publication'
import { ProjectCommitStore, readPublicationFile } from './project-commit-store'
import { WorkspaceStore } from './workspace-store'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'
import { createCleanupPersistence } from './session-cleanup-persistence'
import type { Workspace } from '../shared/types'

let dir: string, file: string
const raw = JSON.stringify({ version: 1, id: 'fixture', rev: 1, nodes: [], future: { opaque: true } })
const next = JSON.stringify({ ...JSON.parse(raw), name: 'ordinary edit' })
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-windows-publication-'))
  file = path.join(dir, 'project.json')
  vi.spyOn(publicationPlatform, 'nativePlatform').mockReturnValue('win32')
  initPlatform(fakePlatform({ userDataDir: dir }))
})
afterEach(async () => { vi.restoreAllMocks(); resetPlatformForTests(); await fs.rm(dir, { recursive: true, force: true }) })

it('saves ordinary new and edited Windows inline/folder canvases with directory open unavailable, without enrolling files', async () => {
  const open = fs.open, directoryOpens: string[] = []
  vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
    if ((await fs.stat(args[0]).catch(() => undefined))?.isDirectory()) {
      directoryOpens.push(String(args[0])); throw Object.assign(new Error('native Windows directory open'), { code: 'EPERM' })
    }
    if (['candidate.json', 'request.json'].includes(path.basename(String(args[0]))) && args[1] !== 'r+')
      throw Object.assign(new Error('write-capable private flush handle required'), { code: 'EPERM' })
    return open(...args)
  })
  const node = { id: 'human', kind: 'sticky' as const, title: 'Manual browser creation', group: null,
    color: '#888', position: { x: 10, y: 20 }, size: { width: 200, height: 100 }, text: 'Human content' }
  const workspace: Workspace = { version: 2, activeProjectId: 'inline', projects: [
    { id: 'inline', name: 'Inline', color: '#888', nodes: [node], viewport: { x: 0, y: 0, zoom: 1 } },
    { id: 'folder', name: 'Folder', color: '#888', cwd: path.join(dir, 'folder'), nodes: [{ ...node, id: 'human2' }], viewport: { x: 0, y: 0, zoom: 1 } }
  ] }
  const store = new WorkspaceStore()
  await store.save(workspace)
  const loaded = await store.load({ sideline: false })
  loaded.projects[0].nodes[0].text = 'Manual saved edit'
  loaded.projects[1].nodes[0].title = 'Manual renamed card'
  await store.save(loaded, { requireRevision: true })
  const adopted = await store.load({ sideline: false })
  expect(adopted.projects[0].nodes[0].text).toBe('Manual saved edit')
  expect(adopted.projects[1].nodes[0].title).toBe('Manual renamed card')
  expect(directoryOpens).toEqual([])
  expect(await fs.readdir(dir)).not.toContain('.recovery')
  expect(await fs.readdir(path.join(dir, 'folder', '.nodeterm'))).toEqual(['project.json'])
  const persistence = createCleanupPersistence(store), archived = await persistence.load()
  archived.projects[0].nodes[0].cleanupArchiveId = '00000000-0000-4000-8000-000000000000'
  await expect(persistence.save(archived)).rejects.toThrow('cleanup_retained_platform_unsupported')
  // An unsupported archive admission cannot poison an untouched ordinary workspace.
  await store.save(adopted, { requireRevision: true })
})

it.each(['_reconciliation', 'cleanupArchiveId'])('refuses portable %s evidence rather than downgrading an ordinary save', async key => {
  const held = JSON.stringify({ ...JSON.parse(raw), [key]: key === '_reconciliation' ? { version: 1 } : 'receipt' })
  await fs.writeFile(file, held)
  await expect(publishWorkspaceFile(file, next, held)).rejects.toThrow('RETAINED')
  expect(await fs.readFile(file, 'utf8')).toBe(held)
})
it.each(['versions', 'operations', 'writer.lock', 'unconfirmed', 'tombstones'])('refuses retained %s even if the new request omits its metadata', async leaf => {
  await fs.writeFile(file, raw)
  const history = path.join(dir, '.recovery', 'project.json', leaf)
  await fs.mkdir(history, { recursive: true }); await fs.writeFile(path.join(history, 'evidence'), 'retained bytes')
  await expect(publishWorkspaceFile(file, next, raw)).rejects.toThrow('RETAINED_PLATFORM_UNSUPPORTED')
  expect(await fs.readFile(file, 'utf8')).toBe(raw)
  expect(await fs.readFile(path.join(history, 'evidence'), 'utf8')).toBe('retained bytes')
})
it.each(['cleanup-enrollments', 'session-cleanup'])('refuses pending private %s evidence at the index boundary', async leaf => {
  const index = path.join(dir, 'workspace.json')
  await fs.writeFile(index, raw); await fs.mkdir(path.join(dir, leaf))
  await expect(publishWorkspaceFile(index, next, raw)).rejects.toThrow('RETAINED_PLATFORM_UNSUPPORTED')
  expect(await fs.readFile(index, 'utf8')).toBe(raw)
})
it.each(['cleanup-enrollments', 'session-cleanup'])('fences folder save/registration/removal against private %s before any project bytes change', async leaf => {
  const cwd = path.join(dir, 'folder'), projectFile = path.join(cwd, '.nodeterm', 'project.json')
  const workspace: Workspace = { version: 2, activeProjectId: 'folder', projects: [{
    id: 'folder', name: 'Folder', color: '#888', cwd, viewport: { x: 0, y: 0, zoom: 1 }, nodes: [{
      id: 'term-fixture-1', kind: 'terminal', title: 'Ordinary human card', group: null, color: '#888',
      position: { x: 10, y: 20 }, size: { width: 200, height: 100 }
    }]
  }] }
  const store = new WorkspaceStore(); await store.save(workspace)
  const loaded = await store.load({ sideline: false }), before = await fs.readFile(projectFile, 'utf8')
  const index = await fs.readFile(path.join(dir, 'workspace.json'), 'utf8')
  await fs.mkdir(path.join(dir, leaf)); await fs.writeFile(path.join(dir, leaf, 'pending.json'), '{"pending":"retained evidence"}')
  loaded.projects[0].nodes[0].title = 'Must not publish before the index refuses'
  await expect(store.save(loaded, { requireRevision: true })).rejects.toThrow('RETAINED_PLATFORM_UNSUPPORTED')
  expect(await store.appendRemoteNode('folder', { id: 'term-fixture-2', title: 'Must not append' })).toBe(false)
  expect(await store.removeRemoteNode('term-fixture-1')).toBe(false)
  expect(await fs.readFile(projectFile, 'utf8')).toBe(before)
  expect(await fs.readFile(path.join(dir, 'workspace.json'), 'utf8')).toBe(index)
  expect(await fs.readFile(path.join(dir, leaf, 'pending.json'), 'utf8')).toBe('{"pending":"retained evidence"}')
})
it('fences concurrent retained enrollment before an ordinary Windows displacement', async () => {
  await fs.writeFile(file, raw)
  await publishWorkspaceFile(file, next, raw, async at => {
    if (at !== 'before-displace') return
    await expect(new ProjectCommitStore(file).observe()).rejects.toThrow('E_PUBLICATION_BUSY')
    await expect(fs.lstat(path.join(dir, '.recovery'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  expect(await fs.readFile(file, 'utf8')).toBe(next)
})
it.each(['before-displace', 'before-publish'] as const)('retains actual competing bytes at Windows %s, blocks readers and never steals its unfinished fence', async at => {
  await fs.writeFile(file, raw)
  const competing = '{"external":"actual competing bytes"}\n'
  await expect(publishWorkspaceFile(file, next, raw, async phase => { if (phase === at) await fs.writeFile(file, competing) })).rejects.toThrow()
  expect(await fs.readFile(file, 'utf8')).toBe(competing)
  const lock = publicationFence(file)
  expect(await fs.readFile(path.join(lock, 'candidate.json'), 'utf8')).toBe(next)
  expect(await fs.readFile(path.join(lock, 'displaced.json'), 'utf8')).toBe(at === 'before-displace' ? competing : raw)
  await expect(readPublicationFile(file)).rejects.toThrow('E_PUBLICATION_BUSY')
  await expect(publishWorkspaceFile(file, next, competing)).rejects.toThrow('fenced')
})
it('preserves an interrupted absent destination and candidate instead of interpreting it as virgin absence', async () => {
  await fs.writeFile(file, raw)
  await expect(publishWorkspaceFile(file, next, raw, async at => { if (at === 'before-publish') throw new Error('interruption') })).rejects.toThrow('interruption')
  await expect(fs.readFile(file)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(readPublicationFile(file)).rejects.toThrow('E_PUBLICATION_BUSY')
  expect(await fs.readFile(path.join(publicationFence(file), 'displaced.json'), 'utf8')).toBe(raw)
  await expect(publishWorkspaceFile(file, next, null)).rejects.toThrow('fenced')
  vi.mocked(publicationPlatform.nativePlatform).mockReturnValue('linux')
  await expect(readPublicationFile(file)).rejects.toThrow('E_PUBLICATION_BUSY')
  expect((await new ProjectCommitStore(file).create({ clientId: 'test', operationId: 'foreign-platform', expectedAbsence: true,
    indexRevision: 'a'.repeat(64), proposed: next })).kind).toBe('busy')
  await expect(fs.lstat(path.join(dir, '.recovery'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('retains a proven pre-mutation save refusal separately and permits an ordinary retry', async () => {
  await fs.writeFile(file, raw)
  await expect(publishWorkspaceFile(file, next, raw, async at => {
    if (at === 'before-displace') throw Object.assign(new Error('fixture disk full'), { code: 'ENOSPC' })
  })).rejects.toThrow('fixture disk full')
  expect(await readPublicationFile(file)).toBe(raw)
  const attempts = path.join(dir, '.ordinary-save-refusals'), attempt = (await fs.readdir(attempts))[0]
  expect(JSON.parse(await fs.readFile(path.join(attempts, attempt, 'outcome.json'), 'utf8'))).toMatchObject({ state: 'refused-before-mutation' })
  const request = JSON.parse(await fs.readFile(path.join(attempts, attempt, 'evidence', 'request.json'), 'utf8'))
  expect(request).toMatchObject({ expected: raw, proposed: next })
  await publishWorkspaceFile(file, next, raw)
  expect(await readPublicationFile(file)).toBe(next)
})

it('keeps a pre-displace failure fenced when an external writer changes the original', async () => {
  await fs.writeFile(file, raw)
  const competing = '{"external":"different original"}'
  await expect(publishWorkspaceFile(file, next, raw, async at => {
    if (at === 'before-displace') { await fs.writeFile(file, competing); throw new Error('fixture interruption') }
  })).rejects.toThrow('fixture interruption')
  expect(await fs.readFile(file, 'utf8')).toBe(competing)
  expect(await fs.readFile(path.join(publicationFence(file), 'candidate.json'), 'utf8')).toBe(next)
  await expect(readPublicationFile(file)).rejects.toThrow('E_PUBLICATION_BUSY')
  await expect(publishWorkspaceFile(file, next, competing)).rejects.toThrow('fenced')
})

// This race needs actual POSIX directory durability; native Windows tests cover refusal instead.
it.skipIf(process.platform === 'win32')('first POSIX retained enrollment excludes an ordinary Windows save before history exists', async () => {
  await fs.writeFile(file, raw)
  const recovery = path.join(dir, '.recovery', 'project.json'), mkdir = fs.mkdir
  let release!: () => void, entered!: () => void
  const paused = new Promise<void>(resolve => { release = resolve }), ready = new Promise<void>(resolve => { entered = resolve })
  vi.spyOn(fs, 'mkdir').mockImplementation((async (...args: Parameters<typeof fs.mkdir>) => {
    if (String(args[0]) === recovery) { entered(); await paused }
    return mkdir(...args)
  }) as typeof fs.mkdir)
  vi.mocked(publicationPlatform.nativePlatform).mockReturnValue('linux')
  const observing = new ProjectCommitStore(file).observe()
  await ready
  try {
    await expect(fs.lstat(recovery)).rejects.toMatchObject({ code: 'ENOENT' })
    vi.mocked(publicationPlatform.nativePlatform).mockReturnValue('win32')
    await expect(publishWorkspaceFile(file, next, raw)).rejects.toThrow('fenced')
    expect(await fs.readFile(file, 'utf8')).toBe(raw)
  } finally { release() }
  expect((await observing).raw).toBe(raw)
})

it('does not publish over retained evidence introduced by an external writer during ordinary Windows staging', async () => {
  await fs.writeFile(file, raw)
  await expect(publishWorkspaceFile(file, next, raw, async phase => {
    if (phase === 'before-publish') await fs.mkdir(path.join(dir, '.recovery', 'project.json'), { recursive: true })
  })).rejects.toThrow('RETAINED_PLATFORM_UNSUPPORTED')
  expect(await fs.readFile(file, 'utf8')).toBe(raw)
  expect(await fs.readFile(path.join(publicationFence(file), 'candidate.json'), 'utf8')).toBe(next)
})
