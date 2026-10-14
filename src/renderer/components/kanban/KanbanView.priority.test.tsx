// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { KanbanView, type KanbanSession } from './KanbanView'
import { useViewMode } from '../../state/viewMode'
import { useGitHubIssues } from '../../state/githubIssues'
import type { GitHubIssueCardView } from '@shared/github-issues'
import { useProjects } from '../../state/projects'
import { defaultTaskPlanning } from '@shared/task-planning'
import { setCardPriority } from '../../lib/kanban'
import type { ProjectKanban } from '@shared/types'

vi.mock('../../session/session', () => ({ useSession: () => ({ api: { githubIssues: {} } }) }))
vi.mock('./GitHubIssueCard', () => ({ GitHubIssueCard: ({ issue }: { issue: GitHubIssueCardView }) => <article className="provider-test">{issue.title}</article> }))
vi.mock('./CardModal', () => ({ CardModal: () => null }))
vi.mock('./CardMetaBar', () => ({ PRIORITIES: ['low', 'medium', 'high', 'urgent'].map(id => ({ id, label: id, color: '#fff' })) }))
vi.mock('./GitHubIssueSummaryModal', () => ({ GitHubIssueSummaryModal: () => null }))
vi.mock('../AccountChip', () => ({ AccountChip: () => null, useAccountChip: () => null }))
vi.mock('../ContextMeter', () => ({ ContextMeter: () => null }))
vi.mock('../../nodes/NodeStatusBadge', () => ({ NodeStatusBadge: () => null }))
vi.mock('../TaskPlanningBadge', () => ({ TaskPlanningBadge: () => null }))
vi.mock('../OrganizationBadge', () => ({ OrganizationBadge: () => null }))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const host = document.createElement('div')
document.body.append(host)
const root = createRoot(host)
afterEach(() => act(() => root.render(null)))
const session = (id: string): KanbanSession => ({ id, title: id, kind: 'sticky', color: '#fff', spawn: {} })
const noop = vi.fn()
const props = { onOpenNode: noop, onCreateNode: noop, onRenameNode: noop, onEditSticky: noop,
  onDeleteNode: noop, onModalNodeChange: noop, onBrowserNav: noop }
const titles = () => [...host.querySelectorAll('.kanban-card__title')].map(el => el.textContent)
const choose = (mode: string) => act(() => { const select = host.querySelector<HTMLSelectElement>('[aria-label="Card order"]')!; select.value = mode; select.dispatchEvent(new Event('change', { bubbles: true })) })
it('derives visible session priority order and restores exact manual order without board writes', () => {
  useProjects.setState({ activeProjectId: 'synthetic' })
  useViewMode.setState({ kanbanSortByProject: {} })
  const sessions = [session('low'), session('high'), session('none')]
  const board: ProjectKanban = { columns: [{ id: 'c', title: 'Work', color: '#fff' }], assignments: sessions.map(s => ({ nodeId: s.id, columnId: 'c' })), meta: [{ nodeId: 'low', priority: 'low' }, { nodeId: 'high', priority: 'high' }] }
  const original = JSON.stringify(board), onChange = vi.fn()
  act(() => root.render(<KanbanView {...props} sessions={sessions} board={board} onChange={onChange} />))
  expect(titles()).toEqual(['low', 'high', 'none'])
  choose('priority')
  expect(titles()).toEqual(['high', 'low', 'none'])
  expect([...host.querySelectorAll('.kanban-card--session')].every(el => el.getAttribute('draggable') === 'false')).toBe(true)
  act(() => root.render(<KanbanView {...props} sessions={sessions} board={setCardPriority(board, 'none', 'urgent')} onChange={onChange} />))
  expect(titles()).toEqual(['none', 'high', 'low'])
  choose('manual')
  expect(titles()).toEqual(['low', 'high', 'none'])
  expect(onChange).not.toHaveBeenCalled()
  expect(JSON.stringify(board)).toBe(original)
})
it('sorts after support folding and category filtering, without promoting a parent', () => {
  useProjects.setState({ activeProjectId: 'synthetic' })
  useViewMode.setState({ kanbanSortByProject: { synthetic: 'priority' } })
  const parent = { ...session('parent'), taskPlanning: defaultTaskPlanning('parent-task-1234', 'implementation') }
  const child = { ...session('child'), taskPlanning: { ...defaultTaskPlanning('child-task-1234', 'research'), relationship: 'support' as const, parentTaskId: 'parent-task-1234' } }
  const pinned = { ...session('pinned'), pinned: true, taskPlanning: child.taskPlanning }
  const board: ProjectKanban = { columns: [], assignments: [], meta: [{ nodeId: 'child', priority: 'urgent' }, { nodeId: 'pinned', priority: 'high' }] }
  act(() => root.render(<KanbanView {...props} sessions={[parent, child, pinned, session('unrelated')]} board={board} onChange={noop} />))
  expect(titles()).toEqual(['pinned', 'parent', 'unrelated'])
  expect(host.textContent).toContain('1 urgent')
  act(() => { const select = host.querySelector<HTMLSelectElement>('[aria-label="Work category"]')!; select.value = 'research'; select.dispatchEvent(new Event('change', { bubbles: true })) })
  expect(titles()).toEqual(['pinned', 'parent'])
})

it('keeps provider lane and pagination order while changing only session order', () => {
  useProjects.setState({ activeProjectId: 'provider-synthetic' })
  useViewMode.setState({ kanbanSortByProject: {} })
  const issue = (id: number): GitHubIssueCardView => ({ id, number: id, title: `issue-${id}`, body: '', state: 'open', stateReason: null, htmlUrl: 'https://example.test', apiUrl: 'https://example.test', labels: [], assignees: [], createdAt: '2026-10-13', updatedAt: '2026-10-13', locked: false, columnId: null, conflict: null })
  useGitHubIssues.setState({ connect: async () => () => {}, projects: { 'provider-synthetic': {
    pages: { ungrouped: { items: [issue(8), issue(2)], counts: { ungrouped: 7 }, partial: false, readOnly: false, nextCursor: 'cursor' } },
    columns: [], moving: {}, loading: false, labelFilter: [], issueStatus: {}, generation: 1, loadGeneration: 1
  } } })
  const board: ProjectKanban = { columns: [], assignments: [], github: { repository: 'synthetic/repository', columnMappings: [] }, meta: [{ nodeId: 'second', priority: 'urgent' }] }
  act(() => root.render(<KanbanView {...props} sessions={[session('first'), session('second')]} board={board} onChange={noop} />))
  const laneOrder = () => [...host.querySelectorAll('.kanban-col__cards .kanban-card__title, .kanban-col__cards .provider-test')].map(el => el.textContent)
  expect(laneOrder()).toEqual(['first', 'second', 'issue-8', 'issue-2'])
  choose('priority')
  expect(laneOrder()).toEqual(['second', 'first', 'issue-8', 'issue-2'])
  expect(host.textContent).toContain('Show more issues')
  choose('manual')
  expect(laneOrder()).toEqual(['first', 'second', 'issue-8', 'issue-2'])
})
