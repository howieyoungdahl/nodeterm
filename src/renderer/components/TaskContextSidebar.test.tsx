// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { TaskContextSidebar, readTaskPrefs } from './TaskContextSidebar'
import { SessionsSidebar, type SessionsSidebarProps } from './SessionsSidebar'
import { SessionContext } from '../session/session'
import { useProjects } from '../state/projects'
import type { ContextPage, ContextRow } from '@shared/remote-nav/context-page'
import type { TaskContextApi, TaskContextQuery } from '@shared/remote-nav/task-context'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const roots: Root[] = []
afterEach(async () => { await act(async () => roots.splice(0).forEach((r) => r.unmount())); document.body.replaceChildren(); vi.useRealTimers(); window.localStorage.clear() })
function storage() {
  const items = new Map<string, string>()
  return { getItem: (k: string) => items.get(k) ?? null, setItem: (k: string, v: string) => { items.set(k, v) } }
}
function page(ids = ['task-000'], generation = 1, continuation: Record<string, unknown> | null = null): ContextPage {
  return { ok: true, code: 'ok', operation: 'summary', scope: { project_id: 'project-a' }, queriedAt: 1000,
    sources: [{ file: '/synthetic/ledger', generation, published_at: 990 }], records: ids.map((task_id): ContextRow => ({
      task_id, project_id: 'project-a', node: `node-${task_id}`, stage: 'building', observation_class: 'IDLE',
      needs_attention: true, human_summary: { text: 'Next step: Verify fixture output' },
      observation: { observedAt: 990, ageS: 10, stale: false, reasons: [] }
    })), uncertainty: [], truncated: !!continuation, continuation, controlGranted: false }
}
function api(read: (q: TaskContextQuery) => Promise<ContextPage> = async () => page()): TaskContextApi {
  return { read: vi.fn(read), focus: vi.fn(async () => ({ ok: false, code: 'focus_authority_unavailable', controlGranted: false as const })) }
}
async function mount(element: React.ReactNode) {
  const host = document.createElement('div'); document.body.append(host)
  const root = createRoot(host); roots.push(root)
  await act(async () => root.render(element))
  return { host, root }
}
async function click(host: HTMLElement, label: string) {
  const button = [...host.querySelectorAll('button')].find((b) => b.textContent === label)
  expect(button, label).toBeTruthy()
  await act(async () => button!.click())
}
async function select(host: HTMLElement, label: string, value: string) {
  const el = host.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!
  await act(async () => { el.value = value; el.dispatchEvent(new Event('change', { bubbles: true })) })
}

describe('mounted task sidebar', () => {
  it('keeps task actions and requested next steps ahead of an unchanged long recorded summary', async () => {
    const summary = `${'Recorded evidence with its qualification.\n\n'.repeat(40)}Next: Verify fixture output; the director acts.`
    const summaryPage = page(), detailPage = page()
    if (summaryPage.ok) summaryPage.records[0].human_summary = { text: summary }
    if (detailPage.ok) detailPage.records[0].fields = { next_action: { text: 'Verify fixture output' } }
    const reader = api(async (q) => q.operation === 'task' ? detailPage : summaryPage)
    const { host } = await mount(<TaskContextSidebar api={reader} projectId="project-a" storage={storage()} />)
    const recorded = host.querySelector('pre')!
    const action = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Task details and workers')!
    expect(action.compareDocumentPosition(recorded) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(recorded.textContent).toBe(summary)
    expect(reader.read).toHaveBeenCalledTimes(1)
    await click(host, 'Task details and workers')
    const next = [...host.querySelectorAll('p')].find((p) => p.textContent === 'Next step: Verify fixture output')!
    expect(next.compareDocumentPosition(recorded) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(recorded.textContent).toBe(summary)
    expect(reader.focus).not.toHaveBeenCalled()
  })
  it('loads task workers and their blockers explicitly without granting focus', async () => {
    const detailPage = page()
    if (detailPage.ok) detailPage.records[0].fields = { next_action: { text: 'Verify fixture output' },
      workers: [{ node: 'worker-000', state: 'BUSY', blockers: ['Synthetic blocker'] }] }
    const reader = api(async (q) => q.operation === 'task' ? detailPage : page())
    const { host } = await mount(<TaskContextSidebar api={reader} projectId="project-a" storage={storage()} />)
    expect(host.textContent).not.toContain('worker-000')
    await click(host, 'Task details and workers')
    expect(host.textContent).toContain('worker-000')
    expect(host.textContent).toContain('Synthetic blocker')
    expect(reader.focus).not.toHaveBeenCalled()
  })
  it('keeps two clients view/sort/collapse independent, with zero session-control calls', async () => {
    const a = storage(), b = storage(), first = api(), second = api()
    const one = await mount(<TaskContextSidebar api={first} projectId="project-a" storage={a} />)
    const two = await mount(<TaskContextSidebar api={second} projectId="project-a" storage={b} />)
    await select(one.host, 'Task view', 'all')
    await select(one.host, 'Sort tasks', 'freshness')
    await act(async () => one.host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click())
    expect(readTaskPrefs(a)).toMatchObject({ view: 'all', sort: { key: 'freshness' }, collapseWorkers: false })
    expect(readTaskPrefs(b)).toMatchObject({ view: 'needs_attention', sort: { key: 'attention' }, collapseWorkers: true })
    expect(two.host.querySelector<HTMLSelectElement>('select[aria-label="Task view"]')!.value).toBe('needs_attention')
    expect(first.read).toHaveBeenCalledTimes(1)
    expect(first.focus).not.toHaveBeenCalled()
    expect(second.focus).not.toHaveBeenCalled()
  })
  it('retains an empty continuation page, then resets generation and scope without stale rows', async () => {
    const reader = api(async (q) => q.scope.project_id === 'project-b' ? { ...page(['task-b']), scope: q.scope } :
      q.cursor ? { ok: false, code: 'reset_required', controlGranted: false } : page([], 1, { offset: 100 }))
    const { host, root } = await mount(<TaskContextSidebar api={reader} projectId="project-a" storage={storage()} />)
    expect(host.textContent).toContain('More context available')
    await click(host, 'Next page')
    expect(host.textContent).toContain('reset_required')
    expect(host.querySelectorAll('article')).toHaveLength(0)
    expect(reader.read).toHaveBeenLastCalledWith(expect.objectContaining({ previousSources: [{ file: '/synthetic/ledger', generation: 1, published_at: 990 }], cursor: { offset: 100 } }))
    await act(async () => root.render(<TaskContextSidebar api={reader} projectId="project-b" storage={storage()} />))
    expect(host.textContent).toContain('task-b')
    expect(reader.read).toHaveBeenLastCalledWith({ operation: 'summary', scope: { project_id: 'project-b' }, limit: 25 })
  })
  it('ages absolute observations while mounted and never gains focus from a fresh query time', async () => {
    vi.useFakeTimers(); vi.setSystemTime(1000000)
    const reader = api()
    const { host } = await mount(<TaskContextSidebar api={reader} projectId="project-a" storage={storage()} />)
    expect(host.textContent).toContain('Observed 10s ago')
    await act(async () => vi.advanceTimersByTime(330000))
    expect(host.textContent).toContain('Stale')
    await click(host, 'Refresh tasks')
    expect(host.textContent).toContain('Observed 340s ago')
    const focus = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Focus existing session')!
    expect(focus.disabled).toBe(true)
    expect(reader.focus).not.toHaveBeenCalled()
  })
  it('ignores an old in-flight page after switching projects; a disconnected host stays visible', async () => {
    let finish!: (page: ContextPage) => void
    const reader = api((q) => q.scope.project_id === 'project-a' ? new Promise((resolve) => { finish = resolve }) : Promise.reject(new Error('disconnected')))
    const { host, root } = await mount(<TaskContextSidebar api={reader} projectId="project-a" storage={storage()} />)
    await act(async () => root.render(<TaskContextSidebar api={reader} projectId="project-b" storage={storage()} />))
    await act(async () => finish(page(['old-project-task'])))
    expect(host.textContent).toContain('source_unavailable')
    expect(host.textContent).not.toContain('old-project-task')
  })
  it('finds task 319 by exact scope in a 320-task source; reports focus as unavailable', async () => {
    const reader = api(async (q) => q.scope.task_id ? page([q.scope.task_id]) : page(['task-000'], 1, { offset: 1 }))
    const { host } = await mount(<TaskContextSidebar api={reader} projectId="project-a" storage={storage()} />)
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Find task by exact ID"]')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'task-319')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click(host, 'Find task')
    expect(host.textContent).toContain('task-319')
    expect(host.textContent).toContain('Next step: Verify fixture output')
    expect(host.textContent).toContain('Focus unavailable: current target authority is missing.')
    expect(reader.focus).not.toHaveBeenCalled()
  })
  it('mounts inside the ordinary SessionsSidebar and Tasks/filter/collapse never call Canvas controls', async () => {
    useProjects.setState({ projects: [], activeProjectId: '' })
    const reader = api()
    const controls = vi.fn()
    const props = new Proxy({ open: true, pinned: true, liveActiveNodes: [] }, { get: (obj, key) => key in obj ? obj[key as keyof typeof obj] : controls }) as unknown as SessionsSidebarProps
    const session = { id: 'synthetic', source: 'server', label: 'Synthetic', status: 'connected', api: { taskContext: reader, git: { status: vi.fn() } } } as never
    const { host } = await mount(<SessionContext.Provider value={session}><SessionsSidebar {...props} /></SessionContext.Provider>)
    await click(host, 'Tasks')
    expect(host.textContent).toContain('Select a project to read task context.')
    expect(reader.read).not.toHaveBeenCalled()
    await act(async () => useProjects.setState({ activeProjectId: 'project-a' }))
    expect(host.textContent).toContain('task-000')
    expect(reader.read).toHaveBeenCalledTimes(1)
    expect(reader.read).toHaveBeenCalledWith({ operation: 'summary', scope: { project_id: 'project-a' }, limit: 25 })
    await select(host, 'Task view', 'active')
    await act(async () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click())
    expect(controls).not.toHaveBeenCalled()
    expect(reader.focus).not.toHaveBeenCalled()
  })
})
