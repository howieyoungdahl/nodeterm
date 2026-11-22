// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { defaultTaskPlanning } from '@shared/task-planning'
import { useProjects } from '../../state/projects'
import { useExternalBoard } from '../../state/externalTaskBoard'
import { SessionCard } from './SessionCard'
import type { KanbanSession } from './KanbanView'

vi.mock('../AccountChip', () => ({ AccountChip: () => null, useAccountChip: () => null }))
vi.mock('../ContextMeter', () => ({ ContextMeter: () => null }))
vi.mock('../../nodes/NodeStatusBadge', () => ({ NodeStatusBadge: () => null }))
const host = document.createElement('div')
document.body.append(host)
const root = createRoot(host)
afterEach(() => act(() => root.render(null)))
it('keeps supporting sessions collapsed, warns about urgency and opens the same child after expansion', () => {
  const parent: KanbanSession = { id: 'parent', title: 'Independent work', kind: 'terminal', color: '#fff', spawn: {},
    taskPlanning: defaultTaskPlanning('parent-task-1234', 'implementation') }
  const child: KanbanSession = { ...parent, id: 'child', title: 'Exact support session',
    taskPlanning: { ...defaultTaskPlanning('child-task-1234', 'research'), relationship: 'support', parentTaskId: 'parent-task-1234' } }
  const onOpen = vi.fn(), onToggle = vi.fn()
  const props = { session: parent, supportingSessions: [child], urgentSupportingCount: 1, onOpen,
    onToggleSupport: onToggle, onDragStart: vi.fn(), onDragEnd: vi.fn(), onDropAt: vi.fn(), onContext: vi.fn() }
  act(() => root.render(<SessionCard {...props} />))
  expect(host.textContent).not.toContain(child.title)
  const toggle = host.querySelector('button[aria-expanded]')!
  expect(toggle.getAttribute('aria-expanded')).toBe('false')
  expect(toggle.textContent).toContain('1 urgent')
  act(() => toggle.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  expect(onToggle).toHaveBeenCalledWith('parent')
  expect(onOpen).not.toHaveBeenCalled()
  act(() => root.render(<SessionCard {...props} supportsExpanded />))
  const childButton = [...host.querySelectorAll('button')].find(button => button.textContent === child.title)!
  act(() => childButton.dispatchEvent(new MouseEvent('click', { bubbles: true })))
  expect(onOpen).toHaveBeenCalledExactlyOnceWith('child')
})

it('shows the linked workflow and urgency and clears the badge if the task becomes unverified', () => {
  const session: KanbanSession = { id: 'one', title: 'Work session', kind: 'terminal', color: '#fff', spawn: {},
    taskPlanning: defaultTaskPlanning('example-task-1234') }
  const task = { nodeId: 'one', task: 'example-12', workflow: 'Product', stage: 'In progress',
    urgency: 'Now', reason: 'Due tomorrow', priority: 'P2' }
  const original = useExternalBoard.getState()
  const projectState = useProjects.getState()
  try {
    act(() => {
      useProjects.setState({activeProjectId:'project', projects:[{...projectState.projects[0],id:'project',
        nodes:[{id:'one',kind:'terminal',position:{x:0,y:0},size:{width:600,height:400},color:'#fff',
          group:null,title:'Work session'}]}]})
      useExternalBoard.setState({ project: 'project', url: 'https://board.example', available: true, tasks: new Map([['one', task]]) })
      root.render(<SessionCard session={session} onOpen={vi.fn()} onContext={vi.fn()}
        onDragStart={vi.fn()} onDragEnd={vi.fn()} onDropAt={vi.fn()} />)
    })
    expect([...host.querySelectorAll('.task-planning-chip')].map(e => e.textContent?.trim())).toEqual(['Product', 'In progress'])
    expect(host.querySelector('.task-planning-timing')?.textContent).toBe('Now')
    expect(host.querySelector('.task-planning-timing')?.getAttribute('title')).toBe('Due tomorrow')
    expect(host.querySelector('.task-planning-rank')?.textContent).toBe('P2')
    act(() => useExternalBoard.setState({ tasks: new Map() }))
    expect(host.textContent).toContain('No verified task link')
    expect(host.textContent).not.toMatch(/needs classification|medium/i)
  } finally {
    act(() => { useExternalBoard.setState(original); useProjects.setState(projectState) })
  }
})
