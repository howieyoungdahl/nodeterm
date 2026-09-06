import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'
import { WorkspaceStore } from './workspace-store'
import { ProjectTrustStore, hashTrustContent, localTrustKey } from './project-trust-store'
import { registerProjectLaunchInfoHandlers } from './project-launch-info-handlers'
import { projectTrustContent, type ProjectLaunchInfo } from '../shared/project-settings'
import type { Project, Workspace } from '../shared/types'
import { localSettingsDelta } from '../shared/local-settings-reconciliation'
import type { ProjectLocalSettings } from '../shared/project-settings'
import { randomUUID } from 'node:crypto'

async function updateLocal(store: WorkspaceStore, id: string, local: ProjectLocalSettings | undefined): Promise<boolean> {
  const snap = await store.readAcknowledgedProjectSettings(id)
  if (!snap?.localBase) return false
  const outcome = await store.updateLocalProjectSettings(id, { ...snap.localBase, projectId: id, operationId: randomUUID(), changes: localSettingsDelta(snap.local, local) })
  return outcome.kind === 'committed'
}

let userData: string
let projRoot: string
let fake: ReturnType<typeof fakePlatform>

const project = (over: Partial<Project> = {}): Project => ({
  id: 'p1', name: 'foo', color: '#7aa2f7', viewport: { x: 0, y: 0, zoom: 1 },
  nodes: [{ id: 'term-1', kind: 'terminal', position: { x: 0, y: 0 }, size: { width: 1, height: 1 }, title: 't', color: '#fff', group: null }],
  ...over
})
const ws = (projects: Project[], active = projects[0]?.id ?? ''): Workspace =>
  ({ version: 2, activeProjectId: active, projects })

beforeEach(async () => {
  userData = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-ws-'))
  projRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-proj-'))
  fake = fakePlatform({ userDataDir: userData })
  initPlatform(fake)
})
afterEach(async () => {
  resetPlatformForTests()
  await fs.rm(userData, { recursive: true, force: true })
  await fs.rm(projRoot, { recursive: true, force: true })
})

describe('project settings — local leg', () => {
  it('write → read round-trips through the store', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ cwd: projRoot })]))
    expect(await store.writeProjectSettings('p1', { terminal: { shell: '/bin/zsh' } })).toBe(true)
    const s = await store.readProjectSettings('p1')
    expect(s?.shared?.terminal?.shell).toBe('/bin/zsh')
    const onDisk = JSON.parse(await fs.readFile(path.join(projRoot, '.nodeterm', 'settings.json'), 'utf-8'))
    expect(onDisk.rev).toBe(1)
  })

  it('a cold store reads before writing, so the rev sequence continues instead of restarting', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ cwd: projRoot })]))
    await store.writeProjectSettings('p1', { terminal: { shell: '/bin/zsh' } }) // rev 1
    const file = path.join(projRoot, '.nodeterm', 'settings.json')
    expect(JSON.parse(await fs.readFile(file, 'utf-8')).rev).toBe(1)

    // A fresh process: nothing has been read this run, so the write must look at the file first.
    const store2 = new WorkspaceStore()
    await store2.load()
    expect(await store2.writeProjectSettings('p1', { terminal: { shell: '/bin/bash' } })).toBe(true)
    const onDisk = JSON.parse(await fs.readFile(file, 'utf-8'))
    expect(onDisk.rev).toBe(2)
    expect(onDisk.terminal.shell).toBe('/bin/bash')
  })

  it('re-saving identical content neither bumps rev nor rewrites the bytes', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ cwd: projRoot })]))
    await store.writeProjectSettings('p1', { terminal: { shell: '/bin/zsh' } })
    const file = path.join(projRoot, '.nodeterm', 'settings.json')
    await store.readProjectSettings('p1') // the panel always reads before it saves
    const before = await fs.readFile(file, 'utf-8')
    expect(await store.writeProjectSettings('p1', { terminal: { shell: '/bin/zsh' } })).toBe(true)
    // A no-op save must not churn a git-tracked file: same bytes, same rev.
    expect(await fs.readFile(file, 'utf-8')).toBe(before)
    expect(JSON.parse(before).rev).toBe(1)
  })

  it('re-reads before every write, so a file conflicted since the last read is left alone', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ cwd: projRoot })]))
    await store.writeProjectSettings('p1', { terminal: { shell: '/bin/zsh' } })
    await store.readProjectSettings('p1') // warms the rev source
    const file = path.join(projRoot, '.nodeterm', 'settings.json')
    // …and then a git pull leaves conflict markers behind our back.
    const conflicted = '<<<<<<< a\n{}\n=======\n{}\n>>>>>>> b\n'
    await fs.writeFile(file, conflicted, 'utf-8')
    expect(await store.writeProjectSettings('p1', { terminal: { shell: '/bin/bash' } })).toBe(false)
    expect(await fs.readFile(file, 'utf-8')).toBe(conflicted)
  })

  it('refuses to write over a git-conflicted settings.json, leaving the bytes untouched', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ cwd: projRoot })]))
    const file = path.join(projRoot, '.nodeterm', 'settings.json')
    const conflicted = '<<<<<<< a\n{}\n=======\n{}\n>>>>>>> b\n'
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, conflicted, 'utf-8')
    expect(await store.writeProjectSettings('p1', { terminal: { shell: '/bin/zsh' } })).toBe(false)
    expect(await fs.readFile(file, 'utf-8')).toBe(conflicted)
  })

  it('local overlay persists across store instances without a canvas save', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ cwd: projRoot })]))
    expect(await updateLocal(store, 'p1', { ignoreShared: { setup: true } })).toBe(true)
    const store2 = new WorkspaceStore()
    await store2.load()
    const s = await store2.readProjectSettings('p1')
    expect(s?.local).toEqual({ ignoreShared: { setup: true } })
  })

  it('a canvas save does not drop the overlay (survives splitWorkspace round trip)', async () => {
    const store = new WorkspaceStore()
    const w = ws([project({ cwd: projRoot })])
    await store.save(w)
    expect(await updateLocal(store, 'p1', { terminal: { shell: '/bin/fish' } })).toBe(true)
    const view = await store.loadReconciled()
    const result = await store.saveReconciled({ clientId: view.clientId, operationId: randomUUID(), indexRevision: view.indexRevision,
      expected: Object.fromEntries(Object.entries(view.projects).map(([id, p]) => [id, p.revision])), workspace: view.workspace })
    expect(result.index.kind).toBe('committed') // actual enrolled canvas save retains local metadata
    const idx = JSON.parse(await fs.readFile(path.join(userData, 'workspace.json'), 'utf-8'))
    expect(idx.entries[0].localSettings).toEqual({ terminal: { shell: '/bin/fish' } })
  })

  it('clearing the overlay removes it from the index', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ cwd: projRoot })]))
    const idxPath = path.join(userData, 'workspace.json')
    expect(await updateLocal(store, 'p1', { terminal: { shell: '/bin/fish' } })).toBe(true)
    const set = JSON.parse(await fs.readFile(idxPath, 'utf-8'))
    expect(set.entries[0].localSettings).toEqual({ terminal: { shell: '/bin/fish' } })
    expect(await updateLocal(store, 'p1', undefined)).toBe(true)
    const idx = JSON.parse(await fs.readFile(idxPath, 'utf-8'))
    expect(idx.entries[0].localSettings).toBeUndefined()
    const s = await store.readProjectSettings('p1')
    expect(s?.local).toBeUndefined()
  })

  it('a git-conflicted settings.json reads as conflict with shared null', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ cwd: projRoot })]))
    await fs.mkdir(path.join(projRoot, '.nodeterm'), { recursive: true })
    await fs.writeFile(path.join(projRoot, '.nodeterm', 'settings.json'),
      '<<<<<<< a\n{}\n=======\n{}\n>>>>>>> b\n', 'utf-8')
    const s = await store.readProjectSettings('p1')
    expect(s?.conflict).toBe(true)
    expect(s?.shared).toBeNull()
  })

  it('an inline (cwd-less) project has no shared doc and cannot be written to', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ id: 'inline1', name: 'inline' })]))
    expect(await updateLocal(store, 'inline1', { terminal: { theme: 'dark' } })).toBe(true)
    const s = await store.readProjectSettings('inline1')
    expect(s?.shared).toBeNull()
    expect(s?.local).toEqual({ terminal: { theme: 'dark' } })
    expect(await store.writeProjectSettings('inline1', { terminal: { shell: '/bin/zsh' } })).toBe(false)
  })

  it('returns null for an unknown project id', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ cwd: projRoot })]))
    expect(await store.readProjectSettings('nope')).toBeNull()
    expect(await store.writeProjectSettings('nope', {})).toBe(false)
    expect((await store.updateLocalProjectSettings('nope', {})).kind).toBe('publication-refused')
  })

  it('a hostile localSettings shape in workspace.json is sanitized on load', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ cwd: projRoot })]))
    const idxPath = path.join(userData, 'workspace.json')
    const idx = JSON.parse(await fs.readFile(idxPath, 'utf-8'))
    // JSON.parse (not an object literal): only the parser creates `__proto__` as a real OWN
    // property — a literal would set the prototype and the key would never reach the file.
    idx.entries[0].localSettings = JSON.parse('{"agents":{"env":{"__proto__":"x","OK":"v"}},"bogus":1}')
    const rawIndex = JSON.stringify(idx)
    expect(rawIndex).toContain('__proto__') // the hostile key really is on disk
    await fs.writeFile(idxPath, rawIndex, 'utf-8')
    const store2 = new WorkspaceStore()
    await store2.load()
    const s = await store2.readProjectSettings('p1')
    expect(s?.local).toEqual({ agents: { env: { OK: 'v' } } })
  })

  it('a hostile settingsCache in workspace.json is rejected on load', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([
      project({ id: 'ssh1', name: 'remote', ssh: { server: { host: 'h', user: 'u' }, remoteCwd: '~/x' } })
    ]))
    const idxPath = path.join(userData, 'workspace.json')
    const idx = JSON.parse(await fs.readFile(idxPath, 'utf-8'))
    idx.entries[0].settingsCache = { version: 2, rev: 'nope', terminal: { shell: '/bin/evil' } }
    await fs.writeFile(idxPath, JSON.stringify(idx), 'utf-8')
    const store2 = new WorkspaceStore()
    await store2.load()
    const s = await store2.readProjectSettings('ssh1')
    expect(s?.shared).toBeNull()
  })
})

const remoteFs = new Map<string, string>()
const fakeIO = {
  read: async () => ({ status: 'absent' as const }),
  write: async () => true,
  readSettings: async (_id: string, ssh: { remoteCwd: string }) => {
    const c = remoteFs.get(ssh.remoteCwd + '/.nodeterm/settings.json')
    return c === undefined ? { status: 'absent' as const } : { status: 'ok' as const, content: c }
  },
  writeSettings: async (_id: string, ssh: { remoteCwd: string }, content: string) => {
    remoteFs.set(ssh.remoteCwd + '/.nodeterm/settings.json', content); return true
  }
}
const sshProject = () => project({ id: 'ps1', cwd: undefined, ssh: { server: { host: 'h', user: 'u' }, remoteCwd: '/srv/app' } })

describe('project settings — ssh leg', () => {
  beforeEach(() => remoteFs.clear())
  it('write lands in the cache AND on the remote; read adopts the higher remote rev', async () => {
    const store = new WorkspaceStore(fakeIO)
    await store.save(ws([sshProject()]))
    expect(await store.writeProjectSettings('ps1', { setup: { setupScript: 'make' } })).toBe(true)
    expect(remoteFs.get('/srv/app/.nodeterm/settings.json')).toContain('make')
    remoteFs.set('/srv/app/.nodeterm/settings.json', JSON.stringify(
      { version: 1, rev: 9, savedAt: 't', setup: { setupScript: 'newer-remote' } }))
    const s = await store.readProjectSettings('ps1')
    expect(s?.shared?.setup?.setupScript).toBe('newer-remote')
  })
  it('remote read failure serves the cache (offline)', async () => {
    const store = new WorkspaceStore({ ...fakeIO, readSettings: async () => ({ status: 'error' as const }) })
    await store.save(ws([sshProject()]))
    await store.writeProjectSettings('ps1', { setup: { setupScript: 'cached' } })
    const s = await store.readProjectSettings('ps1')
    expect(s?.shared?.setup?.setupScript).toBe('cached')
  })
  it('an absent remote file is healed from the cache on read', async () => {
    const store = new WorkspaceStore(fakeIO)
    await store.save(ws([sshProject()]))
    await store.writeProjectSettings('ps1', { setup: { setupScript: 'mine' } })
    remoteFs.clear()
    await store.readProjectSettings('ps1')
    expect(remoteFs.get('/srv/app/.nodeterm/settings.json')).toContain('mine')
  })
  it('settings cache survives a store reload via the index entry', async () => {
    const store = new WorkspaceStore(fakeIO)
    await store.save(ws([sshProject()]))
    await store.writeProjectSettings('ps1', { setup: { setupScript: 'persisted' } })
    const store2 = new WorkspaceStore({ ...fakeIO, readSettings: async () => ({ status: 'error' as const }) })
    await store2.load()
    const s = await store2.readProjectSettings('ps1')
    expect(s?.shared?.setup?.setupScript).toBe('persisted')
  })

  it('an offline edit (cache newer than the remote) is pushed back and wins the read', async () => {
    const store = new WorkspaceStore(fakeIO)
    await store.save(ws([sshProject()]))
    await store.writeProjectSettings('ps1', { setup: { setupScript: 'a' } }) // rev 1
    await store.writeProjectSettings('ps1', { setup: { setupScript: 'offline-edit' } }) // rev 2
    remoteFs.set('/srv/app/.nodeterm/settings.json', JSON.stringify(
      { version: 1, rev: 1, savedAt: 't', setup: { setupScript: 'stale-remote' } }))
    const s = await store.readProjectSettings('ps1')
    expect(s?.shared?.setup?.setupScript).toBe('offline-edit')
    expect(remoteFs.get('/srv/app/.nodeterm/settings.json')).toContain('offline-edit')
  })

  it('a conflict-marked remote file is reported as such and never overwritten', async () => {
    const store = new WorkspaceStore(fakeIO)
    await store.save(ws([sshProject()]))
    const conflicted = '<<<<<<< a\n{}\n=======\n{}\n>>>>>>> b\n'
    remoteFs.set('/srv/app/.nodeterm/settings.json', conflicted)
    const s = await store.readProjectSettings('ps1')
    expect(s?.conflict).toBe(true)
    expect(s?.shared).toBeNull()
    expect(remoteFs.get('/srv/app/.nodeterm/settings.json')).toBe(conflicted)
  })

  it('a remote write failure still keeps the edit (cache-first) and reports success', async () => {
    const store = new WorkspaceStore({ ...fakeIO, writeSettings: async () => false })
    await store.save(ws([sshProject()]))
    expect(await store.writeProjectSettings('ps1', { setup: { setupScript: 'kept' } })).toBe(true)
    const idx = JSON.parse(await fs.readFile(path.join(userData, 'workspace.json'), 'utf-8'))
    expect(idx.entries[0].settingsCache.setup.setupScript).toBe('kept')
  })

  it('a write landing mid-read is not downgraded by the older doc that read was already fetching', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    // The FIRST call is the cold write's own read-before-write (the host has no file yet); only the
    // read under test — the one racing the second write — waits on the gate.
    let coldPreflight = true
    const store = new WorkspaceStore({
      ...fakeIO,
      readSettings: async () => {
        if (coldPreflight) { coldPreflight = false; return { status: 'absent' as const } }
        await gate
        return { status: 'ok' as const, content: JSON.stringify(
          { version: 1, rev: 1, savedAt: 't', setup: { setupScript: 'remote-rev1' } }) }
      }
    })
    await store.save(ws([sshProject()]))
    await store.writeProjectSettings('ps1', { setup: { setupScript: 'v1' } }) // cache rev 1
    const reading = store.readProjectSettings('ps1') // in flight, host still answering rev 1
    await store.writeProjectSettings('ps1', { setup: { setupScript: 'v2' } }) // cache rev 2
    release()
    const s = await reading
    expect(s?.shared?.setup?.setupScript).toBe('v2') // NOT the rev-1 doc the read was carrying
    const idx = JSON.parse(await fs.readFile(path.join(userData, 'workspace.json'), 'utf-8'))
    expect(idx.entries[0].settingsCache.rev).toBe(2) // and no downgrade was persisted
  })

  it('refuses to write while the host file is conflict-marked, and resumes once it is resolved', async () => {
    const writes: string[] = []
    let remote = '<<<<<<< a\n{}\n=======\n{}\n>>>>>>> b\n'
    const store = new WorkspaceStore({
      ...fakeIO,
      readSettings: async () => ({ status: 'ok' as const, content: remote }),
      writeSettings: async (_id: string, _ssh: { remoteCwd: string }, content: string) => {
        writes.push(content); return true
      }
    })
    await store.save(ws([sshProject()]))
    expect((await store.readProjectSettings('ps1'))?.conflict).toBe(true)
    expect(await store.writeProjectSettings('ps1', { setup: { setupScript: 'nope' } })).toBe(false)
    expect(writes).toEqual([]) // nothing was pushed over the merge
    remote = JSON.stringify({ version: 1, rev: 3, savedAt: 't', setup: { setupScript: 'resolved' } })
    expect((await store.readProjectSettings('ps1'))?.shared?.setup?.setupScript).toBe('resolved')
    expect(await store.writeProjectSettings('ps1', { setup: { setupScript: 'after' } })).toBe(true)
    expect(writes.join('|')).toContain('after')
  })

  it('an adopted remote doc is persisted to the index and served after a reload', async () => {
    const store = new WorkspaceStore(fakeIO)
    await store.save(ws([sshProject()]))
    remoteFs.set('/srv/app/.nodeterm/settings.json', JSON.stringify(
      { version: 1, rev: 4, savedAt: 't', setup: { setupScript: 'from-host' } }))
    expect((await store.readProjectSettings('ps1'))?.shared?.setup?.setupScript).toBe('from-host')
    const store2 = new WorkspaceStore({ ...fakeIO, readSettings: async () => ({ status: 'error' as const }) })
    await store2.load()
    const s = await store2.readProjectSettings('ps1')
    expect(s?.shared?.setup?.setupScript).toBe('from-host')
    expect(s?.shared?.rev).toBe(4)
  })

  it('a cold store reads the host before its first ssh write, and refuses a conflict-marked file', async () => {
    const writes: string[] = []
    const conflicted = '<<<<<<< a\n{}\n=======\n{}\n>>>>>>> b\n'
    const store = new WorkspaceStore({
      ...fakeIO,
      readSettings: async () => ({ status: 'ok' as const, content: conflicted }),
      writeSettings: async (_id: string, _ssh: { remoteCwd: string }, content: string) => {
        writes.push(content); return true
      }
    })
    await store.save(ws([sshProject()]))
    // Nothing has been read this run, so the runtime conflict flag is cold — the write must look.
    expect(await store.writeProjectSettings('ps1', { setup: { setupScript: 'nope' } })).toBe(false)
    expect(writes).toEqual([])
  })

  it('an ssh project with no remote IO at all still reads and writes its cache', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([sshProject()]))
    expect(await store.writeProjectSettings('ps1', { setup: { setupScript: 'no-io' } })).toBe(true)
    const s = await store.readProjectSettings('ps1')
    expect(s?.shared?.setup?.setupScript).toBe('no-io')
  })
})

describe('project settings IPC registration', () => {
  it('registers the three channels and round-trips through platform handlers', async () => {
    // fakePlatform's `handle` already records into `fake.handlers` (a plain object keyed by
    // channel) — no monkey-patching needed, just read handlers back off it.
    const store = new WorkspaceStore()
    store.registerIpc()
    await store.save(ws([project({ cwd: projRoot })]))
    const handlers = fake.handlers
    expect(await handlers['project-settings:write-shared']('p1', { terminal: { shell: '/bin/zsh' } })).toBe(true)
    const snap = (await handlers['project-settings:read']('p1')) as { shared: { terminal?: { shell?: string } } | null }
    expect(snap.shared?.terminal?.shell).toBe('/bin/zsh')
    const base = await store.readAcknowledgedProjectSettings('p1')
    expect(await handlers['project-settings:update-local-reconciled']('p1', { ...base!.localBase, projectId: 'p1', operationId: randomUUID(),
      changes: [{ family: 'ignoreShared', key: 'setup', value: true }] })).toMatchObject({ kind: 'committed' })
    expect(await handlers['project-settings:read']('nope')).toBeNull()
  })
})

describe('project-settings:launch-info', () => {
  it('gates a shared launchCmd until recorded, and reports true for a family with nothing to gate', async () => {
    const store = new WorkspaceStore()
    const trust = new ProjectTrustStore()
    registerProjectLaunchInfoHandlers(fake, store, trust)
    await store.save(ws([project({ cwd: projRoot })]))
    await store.writeProjectSettings('p1', { agents: { launchCmd: 'npm run dev' } })

    const handler = fake.handlers['project-settings:launch-info']
    const before = (await handler('p1')) as ProjectLaunchInfo
    expect(before.resolved.agents.launchCmd).toEqual({ value: 'npm run dev', source: 'shared' })
    expect(before.trusted.agents).toBe(false) // shared content exists, not yet approved
    expect(before.trusted.shell).toBe(true) // no shared `terminal.shell` at all — nothing to gate

    const key = localTrustKey(projRoot)
    const content = projectTrustContent('agents', { agents: { launchCmd: 'npm run dev' } })!
    await trust.record(key, 'agents', hashTrustContent(content), '2026-08-19T00:00:00.000Z')

    const after = (await handler('p1')) as ProjectLaunchInfo
    expect(after.trusted.agents).toBe(true)
  })

  it('answers null for an unknown project id, same as project-settings:read', async () => {
    const store = new WorkspaceStore()
    const trust = new ProjectTrustStore()
    registerProjectLaunchInfoHandlers(fake, store, trust)
    await store.save(ws([project({ cwd: projRoot })]))
    expect(await fake.handlers['project-settings:launch-info']('nope')).toBeNull()
  })

  it('reports trusted.agents true when the SHARED doc has no launchCmd/env, even with a local agents overlay', async () => {
    const store = new WorkspaceStore()
    const trust = new ProjectTrustStore()
    registerProjectLaunchInfoHandlers(fake, store, trust)
    await store.save(ws([project({ cwd: projRoot })]))
    // A shared doc exists but never sets anything in the `agents` family — nothing executable to
    // gate — while this machine's own local overlay picks a launchCmd of its own (never gated: a
    // value the user typed locally is their own instruction, not hostile shared input).
    await store.writeProjectSettings('p1', { terminal: { shell: '/bin/zsh' } })
    expect(await updateLocal(store, 'p1', { agents: { launchCmd: 'npm run dev' } })).toBe(true)

    const info = (await fake.handlers['project-settings:launch-info']('p1')) as ProjectLaunchInfo
    expect(info.resolved.agents.launchCmd).toEqual({ value: 'npm run dev', source: 'local' })
    expect(info.trusted.agents).toBe(true)
  })

  it('a shared change invalidates the OLD approval — trusted flips back to false', async () => {
    const store = new WorkspaceStore()
    const trust = new ProjectTrustStore()
    registerProjectLaunchInfoHandlers(fake, store, trust)
    await store.save(ws([project({ cwd: projRoot })]))
    await store.writeProjectSettings('p1', { agents: { launchCmd: 'npm run dev' } })
    const key = localTrustKey(projRoot)
    const oldContent = projectTrustContent('agents', { agents: { launchCmd: 'npm run dev' } })!
    await trust.record(key, 'agents', hashTrustContent(oldContent), '2026-08-19T00:00:00.000Z')
    expect(((await fake.handlers['project-settings:launch-info']('p1')) as ProjectLaunchInfo).trusted.agents).toBe(true)

    await store.writeProjectSettings('p1', { agents: { launchCmd: 'npm run dev && rm -rf /' } })
    const after = (await fake.handlers['project-settings:launch-info']('p1')) as ProjectLaunchInfo
    expect(after.trusted.agents).toBe(false)
  })
})
