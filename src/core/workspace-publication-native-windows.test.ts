import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProjectCommitStore, revisionOf } from './project-commit-store'
import { WorkspaceStore } from './workspace-store'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'
import { publishWorkspaceFile } from './workspace-retained-publication'
import type { Workspace } from '../shared/types'

// Native execution only, without filesystem or publication-platform mocks. Linux adapter
// simulations elsewhere are additional coverage and cannot establish these Windows results.
describe.skipIf(process.platform !== 'win32')('native Windows publication admission', () => {
  let dir: string
  beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-native-win-publication-')); initPlatform(fakePlatform({ userDataDir: dir })) })
  afterEach(async () => { resetPlatformForTests(); await fs.rm(dir, { recursive: true, force: true }) })
  const raw = '{"version":1,"id":"fixture","nodes":[],"future":{"retained":true}}'
  it('preserves ordinary manual creation, edit and folder/inline saves without retained enrollment', async () => {
    const workspace: Workspace = { version: 2, activeProjectId: 'inline', projects: ['inline', 'folder'].map(id => ({
      id, name: id, color: '#888', ...(id === 'folder' ? { cwd: path.join(dir, 'folder') } : {}),
      viewport: { x: 0, y: 0, zoom: 1 }, nodes: [{ id: `human-${id}`, kind: 'sticky', title: 'Manual', color: '#888',
        group: null, position: { x: 2, y: 3 }, size: { width: 200, height: 100 }, text: 'ordinary content' }]
    })) }
    const store = new WorkspaceStore(); await store.save(workspace)
    const loaded = await store.load({ sideline: false })
    for (const project of loaded.projects) project.nodes[0].text = 'saved edit'
    await store.save(loaded, { requireRevision: true })
    expect((await store.load({ sideline: false })).projects.map(p => p.nodes[0].text)).toEqual(['saved edit', 'saved edit'])
    await expect(fs.lstat(path.join(dir, '.recovery'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await fs.readdir(path.join(dir, 'folder', '.nodeterm'))).toEqual(['project.json'])
  })
  it.each(['update', 'creation', 'bootstrap'] as const)('refuses actual unsupported retained %s with exact unconfirmed evidence and no ordinary downgrade', async kind => {
    const file = path.join(dir, kind === 'bootstrap' ? 'workspace.json' : 'project.json'), store = new ProjectCommitStore(file)
    if (kind === 'update') await fs.writeFile(file, raw)
    const input = kind === 'update' ? { clientId: 'native', operationId: 'attempt', expectedRevision: revisionOf(raw), proposed: raw }
      : kind === 'creation' ? { clientId: 'native', operationId: 'attempt', expectedAbsence: true as const, indexRevision: 'a'.repeat(64), proposed: raw }
      : { clientId: 'native', operationId: 'attempt', expectedAbsence: true as const, bootstrapToken: 'a'.repeat(64), intent: raw }
    const result = kind === 'update' ? await store.commit(input as Parameters<typeof store.commit>[0])
      : kind === 'creation' ? await store.create(input as Parameters<typeof store.create>[0])
      : await store.bootstrapIndex(input as Parameters<typeof store.bootstrapIndex>[0], async () => undefined)
    expect(result.kind).toBe('unavailable')
    expect(result.message).toContain('unconfirmed directory durability')
    expect(await fs.readFile(result.recovery, 'utf8')).toBe(JSON.stringify(input))
    expect((await store.retainUnconfirmed(input, 'same refusal')).recovery).toBe(result.recovery)
    if (kind === 'update') expect(await fs.readFile(file, 'utf8')).toBe(raw)
    else await expect(fs.lstat(file)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(publishWorkspaceFile(file, raw, kind === 'update' ? raw : null)).rejects.toThrow('RETAINED_PLATFORM_UNSUPPORTED')
    expect(await fs.readFile(result.recovery, 'utf8')).toBe(JSON.stringify(input))
  })
})
