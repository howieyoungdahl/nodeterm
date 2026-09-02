import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { fakePlatform } from './platform-fake'
import { initPlatform, resetPlatformForTests } from './platform'
import { WorkspaceStore, type WorkspaceBackendGuards } from './workspace-store'
import type { CanvasNodeState, Project, Workspace } from '../shared/types'

/**
 * The 2026-09-01 loss, pinned.
 *
 * `workspace:save` is a WHOLE-workspace, last-writer-wins write and local projects have no conflict
 * machinery, so a client republishing a stale node list deletes every card created since its
 * snapshot — silently, from a file whose panes are all still running. These tests drive a real temp
 * workspace (real index, real `<cwd>/.nodeterm/project.json`) through exactly that shape.
 */

let userData: string
let projRoot: string
let sshRoot: string

const node = (id: string, over: Partial<CanvasNodeState> = {}): CanvasNodeState => ({
  id,
  kind: 'terminal',
  position: { x: 0, y: 0 },
  size: { width: 640, height: 440 },
  title: id,
  color: '#0a84ff',
  group: null,
  ...over
})

const project = (over: Partial<Project> = {}): Project => ({
  id: 'p1',
  name: 'foo',
  color: '#7aa2f7',
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes: [node('term-1'), node('term-2')],
  ...over
})

const ws = (projects: Project[]): Workspace => ({
  version: 2,
  activeProjectId: projects[0]?.id ?? '',
  projects
})

const readNodes = async (root: string): Promise<string[]> => {
  const raw = await fs.readFile(path.join(root, '.nodeterm/project.json'), 'utf-8')
  return (JSON.parse(raw) as { nodes: CanvasNodeState[] }).nodes.map((n) => n.id)
}

const guards = (over: Partial<WorkspaceBackendGuards> = {}): WorkspaceBackendGuards => ({
  hasLiveBackend: () => false,
  wasDeleted: () => false,
  ...over
})

beforeEach(async () => {
  userData = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-rescue-ud-'))
  projRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-rescue-proj-'))
  sshRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-rescue-ssh-'))
  initPlatform(fakePlatform({ userDataDir: userData }))
})

afterEach(async () => {
  resetPlatformForTests()
  vi.restoreAllMocks()
  await fs.rm(userData, { recursive: true, force: true })
  await fs.rm(projRoot, { recursive: true, force: true })
  await fs.rm(sshRoot, { recursive: true, force: true })
})

describe('local save rescue', () => {
  it('keeps a node the save omitted while its backend is still live', async () => {
    const store = new WorkspaceStore(undefined, guards({ hasLiveBackend: (id) => id === 'term-2' }))
    await store.save(ws([project({ cwd: projRoot })]))
    expect(await readNodes(projRoot)).toEqual(['term-1', 'term-2'])

    // The stale client republishes its snapshot: term-2 never existed as far as it knows.
    await store.save(ws([project({ cwd: projRoot, nodes: [node('term-1')] })]))
    expect(await readNodes(projRoot)).toEqual(['term-1', 'term-2'])
  })

  it('drops a node the save omitted after the user deleted it here', async () => {
    // Live backend AND a deletion: the deletion wins, always. tmux kill-session and the probe race,
    // so "still answering has-session" must never resurrect a terminal its owner closed.
    const store = new WorkspaceStore(
      undefined,
      guards({ hasLiveBackend: () => true, wasDeleted: (id) => id === 'term-2' })
    )
    await store.save(ws([project({ cwd: projRoot })]))
    await store.save(ws([project({ cwd: projRoot, nodes: [node('term-1')] })]))
    expect(await readNodes(projRoot)).toEqual(['term-1'])
  })

  it('drops a node the save omitted when nothing is behind it', async () => {
    const store = new WorkspaceStore(undefined, guards())
    await store.save(ws([project({ cwd: projRoot })]))
    await store.save(ws([project({ cwd: projRoot, nodes: [node('term-1')] })]))
    expect(await readNodes(projRoot)).toEqual(['term-1'])
  })

  it('defaults to no rescue at all, so an unwired shell saves exactly what it was handed', async () => {
    const store = new WorkspaceStore()
    await store.save(ws([project({ cwd: projRoot })]))
    await store.save(ws([project({ cwd: projRoot, nodes: [node('term-1')] })]))
    expect(await readNodes(projRoot)).toEqual(['term-1'])
  })

  it('writes the rescued node to disk when the save also changed something else', async () => {
    // The skip-if-identical path is not the only one: a save that BOTH renames the project and
    // drops a live node has to land the rename with the node still in it.
    const store = new WorkspaceStore(undefined, guards({ hasLiveBackend: () => true }))
    await store.save(ws([project({ cwd: projRoot })]))
    await store.save(ws([project({ cwd: projRoot, name: 'renamed', nodes: [node('term-1')] })]))
    const raw = JSON.parse(
      await fs.readFile(path.join(projRoot, '.nodeterm/project.json'), 'utf-8')
    ) as { name: string; rev: number; nodes: CanvasNodeState[] }
    expect(raw.name).toBe('renamed')
    expect(raw.rev).toBe(2)
    expect(raw.nodes.map((n) => n.id)).toEqual(['term-1', 'term-2'])
  })

  it('logs one line per save naming the rescued ids and the client that omitted them', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const store = new WorkspaceStore(undefined, guards({ hasLiveBackend: () => true }))
    await store.save(ws([project({ cwd: projRoot })]))
    warn.mockClear()

    await store.save(ws([project({ cwd: projRoot, nodes: [] })]), { client: 'ui:7' })
    const lines = warn.mock.calls.map((call) => String(call[0])).filter((l) => l.includes('[workspace] rescued'))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('rescued 2 node(s) with live backends that a save omitted')
    expect(lines[0]).toContain('term-1, term-2')
    expect(lines[0]).toContain('(client ui:7)')
  })

  it('carries the calling UI id into that log line through the IPC registration', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const fake = fakePlatform({ userDataDir: userData })
    initPlatform(fake)
    const store = new WorkspaceStore(undefined, guards({ hasLiveBackend: () => true }))
    store.registerIpc()
    // handleWithSender puts the sender id first — that is the whole point of the registration
    // change: with N browser tabs on one Server, the log has to name WHICH one truncated the list.
    await fake.handlers['workspace:save'](3, ws([project({ cwd: projRoot })]))
    await fake.handlers['workspace:save'](3, ws([project({ cwd: projRoot, nodes: [node('term-1')] })]))
    expect(warn.mock.calls.map((c) => String(c[0])).join('\n')).toContain('(client ui:3)')
  })

  it('never asks about an ssh project: that side has its own rescue', async () => {
    const asked: string[] = []
    const store = new WorkspaceStore(
      undefined,
      guards({
        hasLiveBackend: (id) => {
          asked.push(id)
          return true
        }
      })
    )
    const ssh: NonNullable<Project['ssh']> = {
      server: { host: 'h', user: 'u' },
      remoteCwd: sshRoot
    }
    const remote = (nodes: CanvasNodeState[]): Project =>
      project({ id: 'p-ssh', cwd: undefined, ssh, nodes })

    await store.save(ws([remote([node('ssh-1'), node('ssh-2')])]))
    await store.save(ws([remote([node('ssh-1')])]))
    expect(asked).toEqual([])

    const index = JSON.parse(await fs.readFile(path.join(userData, 'workspace.json'), 'utf-8'))
    expect(index.entries[0].cache.nodes.map((n: CanvasNodeState) => n.id)).toEqual(['ssh-1'])
  })
})
