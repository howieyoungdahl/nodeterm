import { describe, it, expect } from 'vitest'
import { useProjects } from './projects'

describe('setProjectKanban', () => {
  it('sets the board on the target project and carries it through toWorkspace()', () => {
    useProjects.getState().hydrate({
      version: 2,
      activeProjectId: 'p1',
      projects: [{ id: 'p1', name: 'x', color: '#fff', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [] }]
    })
    const board = { columns: [{ id: 'c1', title: 'To Do', color: '#0a84ff' }], assignments: [] }
    useProjects.getState().setProjectKanban('p1', board)
    expect(useProjects.getState().getProject('p1')?.kanban).toEqual(board)
    expect(useProjects.getState().toWorkspace().projects[0].kanban).toEqual(board)
  })
})

it('retains priority choices, explicit clears and exact assignment order through hydration', () => {
  const board = { columns: [{ id: 'c', title: 'Work', color: '#fff' }], assignments: [{ nodeId: 'n2', columnId: 'c' }, { nodeId: 'n1', columnId: 'c' }],
    meta: [{ nodeId: 'n1', priority: 'high' as const, priorityManual: true as const }, { nodeId: 'n2', priorityManual: true as const }] }
  useProjects.getState().hydrate({ version: 2, activeProjectId: 'p', projects: [{ id: 'p', name: 'Synthetic', color: '#fff', nodes: [], viewport: { x: 0, y: 0, zoom: 1 } }] })
  useProjects.getState().setProjectKanban('p', board)
  const saved = JSON.parse(JSON.stringify(useProjects.getState().toWorkspace()))
  useProjects.getState().hydrate(saved)
  expect(useProjects.getState().getProject('p')?.kanban).toEqual(board)
})
