// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { defaultTaskPlanning } from '@shared/task-planning'
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
