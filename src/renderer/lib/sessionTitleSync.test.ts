import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useProjects } from '../state/projects'
import { canAutoSyncSessionTitle, syncSessionTitle } from './sessionTitleSync'

beforeEach(() => {
  useProjects.getState().hydrate({ version: 2, activeProjectId: 'p', projects: [{
    id: 'p', name: 'Synthetic', color: '#fff', nodes: [], viewport: { x: 0, y: 0, zoom: 1 },
    kanban: { columns: [{ id: 'd', title: 'Directors', color: '#fff' }, { id: 'w', title: 'Work', color: '#fff' }],
      assignments: [{ nodeId: 'n', columnId: 'w' }] }
  }] })
})
const allowed = () => canAutoSyncSessionTitle('p', 'n', true)
const move = (columnId: string) => {
  const board = useProjects.getState().getProject('p')!.kanban!
  useProjects.getState().setProjectKanban('p', { ...board, assignments: [{ nodeId: 'n', columnId }] })
}
describe('automatic session title publication', () => {
  it('updates an ordinary auto-tracking card', async () => {
    const apply = vi.fn()
    await syncSessionTitle(allowed, async () => 'Exact session name', apply)
    expect(apply).toHaveBeenCalledWith('Exact session name')
  })
  it('does not read or rename a Directors card', async () => {
    move('d')
    const read = vi.fn(async () => 'Replacement')
    const apply = vi.fn()
    await syncSessionTitle(allowed, read, apply)
    expect(read).not.toHaveBeenCalled()
    expect(apply).not.toHaveBeenCalled()
  })
  it('rechecks the actual store after a pending read', async () => {
    let resolve!: (name: string) => void
    const apply = vi.fn()
    const pending = syncSessionTitle(allowed, () => new Promise<string>((done) => { resolve = done }), apply)
    move('d')
    resolve('Replacement')
    await pending
    expect(apply).not.toHaveBeenCalled()
  })
  it('preserves the title if the owning project becomes unknown during the read', async () => {
    const apply = vi.fn()
    await syncSessionTitle(allowed, async () => {
      useProjects.setState({ projects: [] })
      return 'Replacement'
    }, apply)
    expect(apply).not.toHaveBeenCalled()
  })
  it('does not publish into a newly active project', async () => {
    const apply = vi.fn()
    await syncSessionTitle(allowed, async () => {
      useProjects.setState({ activeProjectId: 'other' })
      return 'Replacement'
    }, apply)
    expect(apply).not.toHaveBeenCalled()
  })
  it('protects a manual title chosen during a pending read', async () => {
    let auto = true
    const apply = vi.fn()
    await syncSessionTitle(() => canAutoSyncSessionTitle('p', 'n', auto), async () => { auto = false; return 'Replacement' }, apply)
    expect(apply).not.toHaveBeenCalled()
  })
  it('fails closed for unknown project, board, or assignment column', () => {
    expect(canAutoSyncSessionTitle('missing', 'n', true)).toBe(false)
    useProjects.setState({ projects: useProjects.getState().projects.map((p) => ({ ...p, kanban: undefined, loadedKanban: undefined })) })
    expect(allowed()).toBe(false)
    useProjects.getState().setProjectKanban('p', { columns: [], assignments: [{ nodeId: 'n', columnId: 'missing' }] })
    expect(allowed()).toBe(false)
  })
  it('allows a loaded absent board and protects explicit manual titles', () => {
    useProjects.setState({ projects: useProjects.getState().projects.map((p) => ({ ...p, kanban: undefined, loadedKanban: null })) })
    expect(allowed()).toBe(true)
    expect(canAutoSyncSessionTitle('p', 'n', false)).toBe(false)
  })
})
