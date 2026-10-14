import { beforeEach, expect, it } from 'vitest'
import type { Project, WorkspaceApi, WorkspaceSaveAck } from '@shared/types'
import { useProjects } from '../state/projects'
import * as persistence from './workspacePersistence'
import { mergeWorkspacePublication } from './workspacePublication'
const a = 'a'.repeat(64), b = 'b'.repeat(64), c = 'c'.repeat(64)
const project = (): Project => ({ id: 'p', name: 'P', color: '#888', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [] })
beforeEach(() => useProjects.getState().hydrate({ version: 2, activeProjectId: 'p', revision: a, projects: [project()] }))
function fixture() {
  let listener: (p: Project) => void = () => {}
  let resolve!: (ack: WorkspaceSaveAck) => void, reject!: (error: Error) => void, started!: () => void
  const start = new Promise<void>(r => { started = r })
  const api = { save: () => { started(); return new Promise<WorkspaceSaveAck>((yes, no) => { resolve = yes; reject = no }) },
    onServerChange: (cb: (p: Project) => void) => { listener = cb; return () => { listener = () => {} } } } as WorkspaceApi
  const conflicts: string[] = [], delivered: Project[] = [], observed: Project[] = []
  const handle = (p: Project) => {
    delivered.push(p)
    const state = useProjects.getState()
    const result = mergeWorkspacePublication(state.revision, state.projects, p.workspaceChange)
    if (result.kind === 'adopt') useProjects.setState({ projects: result.projects, revision: result.revision })
    if (result.kind === 'conflict') { conflicts.push(result.reason); return { kind: 'conflict' as const } }
    if (result.kind === 'duplicate') return { kind: 'duplicate' as const, revision: state.revision! }
    return { kind: 'adopt' as const, before: p.workspaceChange!.before, after: result.revision }
  }
  // The fallback runs the served callback ordering for baseline mutation evidence.
  const unsubscribe = persistence.subscribeWorkspacePublications
    ? persistence.subscribeWorkspacePublications(api, handle, p => observed.push(p)) : api.onServerChange(handle)
  const incoming = (before = b, after = c): Project => {
    const base = project(), next = { ...project(), name: 'Published' }
    return { ...next, workspaceChange: { before, after, changes: [{ before: base, after: next }] } }
  }
  return { api, start, resolve: () => resolve({ revision: b, projectRevisions: { p: b } }),
    reject: () => reject(new Error('save failed')), emit: (p = incoming()) => listener(p), incoming,
    conflicts, delivered, observed, unsubscribe }
}
it('adopts publication before save RPC ACK without a false chain conflict', async () => {
  const f = fixture(), saving = persistence.saveWorkspace(f.api)
  await f.start
  f.emit()
  expect(f.delivered).toEqual([])
  expect(f.observed).toHaveLength(1) // stamped canvas delta can already recognize its full publication
  f.resolve(); await saving
  expect(f.conflicts).toEqual([])
  expect(useProjects.getState().revision).toBe(c)
  expect(useProjects.getState().projects[0].name).toBe('Published')
})
it('refuses genuinely missed publications after ACK instead of bridging a gap', async () => {
  const f = fixture(), saving = persistence.saveWorkspace(f.api)
  await f.start; f.emit(f.incoming('d'.repeat(64))); f.resolve(); await saving
  expect(f.conflicts).toEqual(['revision-chain-broken'])
  expect(useProjects.getState().revision).toBe(b)
})
it('a failed save drains through strict revision guards without granting the unacknowledged revision', async () => {
  const f = fixture(), saving = persistence.saveWorkspace(f.api)
  const failure = expect(saving).rejects.toThrow('save failed')
  await f.start; f.emit(); f.reject(); await failure
  expect(f.conflicts).toEqual(['revision-chain-broken'])
  expect(useProjects.getState().revision).toBe(a)
})
it('cancels buffered deliveries on unsubscribe', async () => {
  const f = fixture(), saving = persistence.saveWorkspace(f.api)
  await f.start; f.emit(); f.unsubscribe(); f.resolve(); await saving
  expect(f.delivered).toEqual([])
  expect(useProjects.getState().revision).toBe(b)
})
it('keeps pending saves scoped to the same WorkspaceApi', async () => {
  const f = fixture(), other = fixture(), saving = persistence.saveWorkspace(f.api)
  await f.start; other.emit(other.incoming(a, c))
  expect(other.delivered).toHaveLength(1)
  f.resolve(); await saving
  expect(useProjects.getState().revision).toBe(c)
  expect(useProjects.getState().projects[0].name).toBe('Published')
})
it('bounds buffering and refuses overflow rather than silently accepting missing content', async () => {
  const f = fixture(), saving = persistence.saveWorkspace(f.api)
  await f.start
  for (let i = 0; i < 65; i++) f.emit()
  expect(f.delivered).toHaveLength(1)
  expect(f.conflicts).toEqual(['revision-acknowledgment-missing'])
  f.resolve(); await saving
  expect(f.delivered).toHaveLength(65)
})
it('retains true local overlap while the save ACK is pending', async () => {
  const f = fixture(), saving = persistence.saveWorkspace(f.api)
  await f.start
  useProjects.setState({ projects: [{ ...project(), name: 'Unsaved local name' }] })
  f.emit(); f.resolve(); await saving
  expect(f.conflicts).toEqual(['overlapping-content'])
  expect(useProjects.getState().projects[0].name).toBe('Unsaved local name')
})

function staleFixture(options: { localOverlap?: boolean; gap?: boolean; retryFails?: boolean; malformedAck?: boolean;
  overflow?: boolean; installationFails?: boolean; noEvidence?: boolean } = {}) {
  let listener: (p: Project) => void = () => {}
  const snapshots: import('@shared/types').Workspace[] = [], conflicts: string[] = []
  const api = {
    save: async (snapshot: import('@shared/types').Workspace) => {
      snapshots.push(snapshot)
      if (snapshots.length === 1) {
        const base = project(), incoming = { ...project(), name: 'Published' }
        const publication = { ...incoming, workspaceChange: { before: options.gap ? 'd'.repeat(64) : a,
          after: b, changes: [{ before: base, after: incoming }] } }
        for (let i = 0; i < (options.overflow ? 65 : 1); i++) listener(publication)
        if (options.malformedAck) return undefined
        throw new Error('workspace_conflict: storage changed; reload before saving')
      }
      if (options.retryFails) throw new Error('workspace_conflict: storage changed again')
      return { revision: c, projectRevisions: { p: c } }
    },
    onServerChange: (cb: (p: Project) => void) => { listener = cb; return () => { listener = () => {} } }
  } as WorkspaceApi
  useProjects.setState({ projects: [{ ...project(), color: '#local', ...(options.localOverlap ? { name: 'Local title' } : {}) }] })
  const handle = (p: Project) => {
    const state = useProjects.getState()
    const merged = mergeWorkspacePublication(state.revision, state.projects, p.workspaceChange)
    if (merged.kind === 'conflict') { conflicts.push(merged.reason); return { kind: 'conflict' as const } }
    if (merged.kind === 'duplicate') return { kind: 'duplicate' as const, revision: state.revision! }
    if (options.installationFails) throw new Error('content installation failed')
    useProjects.setState({ projects: merged.projects, revision: merged.revision })
    if (options.noEvidence) return
    return { kind: 'adopt' as const, before: p.workspaceChange!.before, after: merged.revision }
  }
  const unsubscribe = persistence.subscribeWorkspacePublications
    ? persistence.subscribeWorkspacePublications(api, handle) : api.onServerChange(handle)
  return { api, snapshots, conflicts, unsubscribe }
}
it('retries one stale rejection only after a safely installed contiguous publication preserves disjoint local edits', async () => {
  const f = staleFixture()
  await persistence.saveWorkspace(f.api)
  expect(f.conflicts).toEqual([])
  expect(f.snapshots).toHaveLength(2)
  expect(f.snapshots[1]).toMatchObject({ revision: b, projects: [{ name: 'Published', color: '#local' }] })
  expect(useProjects.getState().revision).toBe(c)
  f.unsubscribe()
})
it.each([{ localOverlap: true }, { gap: true }, { overflow: true }, { malformedAck: true },
  { installationFails: true }, { noEvidence: true }])('refuses stale recovery without safe installation evidence: %j', async options => {
  const f = staleFixture(options)
  await expect(persistence.saveWorkspace(f.api)).rejects.toThrow()
  expect(f.snapshots).toHaveLength(1)
  if (options.localOverlap) expect(useProjects.getState().projects[0].name).toBe('Local title')
  f.unsubscribe()
})
it('reports retry failure and never makes a third save attempt', async () => {
  const f = staleFixture({ retryFails: true })
  await expect(persistence.saveWorkspace(f.api)).rejects.toThrow('storage changed again')
  expect(f.snapshots).toHaveLength(2)
  expect(useProjects.getState().projects[0]).toMatchObject({ name: 'Published', color: '#local' })
  f.unsubscribe()
})
