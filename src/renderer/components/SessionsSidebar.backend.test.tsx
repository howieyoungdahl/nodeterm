// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CanvasNodeState, NodeTerminalApi, Project } from '@shared/types'
import { PANE_RECHECK_MS } from '@shared/node-status'
import { SessionsSidebar, type SessionsSidebarProps } from './SessionsSidebar'
import { useProjects } from '../state/projects'
import { useAgentStatus } from '../state/agentStatus'
import { useSettings } from '../state/settings'

const runtime = vi.hoisted(() => ({ api: {} as NodeTerminalApi, foreignApi: {} as NodeTerminalApi }))
vi.mock('../session/session', () => ({
  useSession: () => ({ api: runtime.api, source: 'local' }),
  sessionForProject: (id: string) => ({ api: id === 'foreign' ? runtime.foreignApi : runtime.api })
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const node = (id: string, extras: Partial<CanvasNodeState> = {}): CanvasNodeState => ({
  id, title: id, kind: 'terminal', color: '#123', group: null,
  position: { x: 0, y: 0 }, size: { width: 640, height: 440 }, ...extras
})
const project = (id: string, nodes: CanvasNodeState[], extras: Partial<Project> = {}): Project => ({
  id, name: id, color: '#123', nodes, viewport: { x: 0, y: 0, zoom: 1 }, ...extras
})
const props: SessionsSidebarProps = {
  open: true, pinned: false, liveActiveNodes: null, onTogglePin: vi.fn(), onClose: vi.fn(),
  onFocusNode: vi.fn(), onCloseSession: vi.fn(), onRenameSession: vi.fn(), onAiNameSession: vi.fn(),
  onRowContextMenu: vi.fn(), onProjectContextMenu: vi.fn(), onSwitchProject: vi.fn(), onAddToProject: vi.fn(),
  onMoveToGroup: vi.fn(), onAiNameGroup: vi.fn(), onReorder: vi.fn(), onReorderGroup: vi.fn(), onReorderProject: vi.fn()
}
let host: HTMLDivElement
let root: Root
let probe: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(1_800_000_000_000)
  probe = vi.fn(async (ids: string[]) => Object.fromEntries(ids.map((id) => [id, 'dead'])))
  runtime.api = { nodePaneEvidence: probe } as unknown as NodeTerminalApi
  runtime.foreignApi = {} as NodeTerminalApi
  useAgentStatus.setState({ byId: {} })
  useProjects.setState({ projects: [project('local', [node('hookless')])], activeProjectId: 'local' })
  useSettings.setState((s) => ({ settings: { ...s.settings, sidebarGrouping: 'project', sidebarAutoCollapse: false } }))
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.useRealTimers()
})
const render = async (overrides: Partial<SessionsSidebarProps> = {}): Promise<void> => {
  await act(async () => root.render(<SessionsSidebar {...props} {...overrides} />))
}

describe('sidebar backend observations through the mounted UI', () => {
  it.each(['project', 'status'] as const)('shows confirmed absence in %s mode without changing hooks or workspace', async (sidebarGrouping) => {
    useSettings.setState((s) => ({ settings: { ...s.settings, sidebarGrouping } }))
    const projectsBefore = structuredClone(useProjects.getState().projects)
    const statusesBefore = structuredClone(useAgentStatus.getState().byId)
    await render()
    expect(host.textContent).toContain('Task unobserved · backend stopped')
    expect(probe).toHaveBeenCalledExactlyOnceWith(['hookless'])
    expect(useProjects.getState().projects).toEqual(projectsBefore)
    expect(useAgentStatus.getState().byId).toEqual(statusesBefore)
  })

  it('never asks the local core about SSH projects, SSH nodes, foreign cores or known hook states', async () => {
    useProjects.setState({ projects: [
      project('local', [node('hookless'), node('ssh-node', { ssh: { host: 'example.invalid', user: 'test' } }), node('working'), node('blocked'), node('done')]),
      project('ssh', [node('ssh-project')], { ssh: { server: { host: 'example.invalid', user: 'test' }, remoteCwd: '/fixture' } }),
      project('foreign', [node('foreign-node')])
    ] })
    useAgentStatus.setState({ byId: { working: { state: 'working', unread: false }, blocked: { state: 'blocked', unread: false }, done: { state: 'done', unread: false } } })
    await render()
    expect(probe).toHaveBeenCalledExactlyOnceWith(['hookless'])
    expect(host.textContent?.match(/Task unobserved · backend unverified/g)).toHaveLength(3)
    expect(host.textContent?.match(/Task unobserved · backend stopped/g)).toHaveLength(1)
  })

  it('makes no probes while closed and discards a pending reply after closing', async () => {
    await render({ open: false })
    expect(probe).not.toHaveBeenCalled()
    let resolve!: (answer: unknown) => void
    probe.mockImplementationOnce(() => new Promise((r) => { resolve = r }))
    await render()
    await render({ open: false })
    await act(async () => resolve({ hookless: 'dead' }))
    expect(host.textContent).toBe('')
    probe.mockResolvedValue({ hookless: 'unknown' })
    await render()
    expect(host.textContent).toContain('Task unobserved · backend unverified')
    expect(host.textContent).not.toContain('backend stopped')
  })

  it('does not overwrite a hook state that arrives during a probe', async () => {
    let resolve!: (answer: unknown) => void
    probe.mockImplementationOnce(() => new Promise((r) => { resolve = r }))
    await render()
    await act(async () => {
      useAgentStatus.setState({ byId: { hookless: { state: 'blocked', unread: false } } })
      resolve({ hookless: 'dead' })
    })
    expect(host.textContent).not.toContain('backend stopped')
    expect(useAgentStatus.getState().byId.hookless.state).toBe('blocked')
  })

  it('expires an old stopped observation while the replacement probe is pending', async () => {
    await render()
    probe.mockImplementationOnce(() => new Promise(() => {}))
    await act(async () => { await vi.advanceTimersByTimeAsync(PANE_RECHECK_MS) })
    expect(host.textContent).toContain('Task unobserved · backend unverified')
    expect(host.textContent).not.toContain('backend stopped')
  })

  it('does not reuse a different API core\'s stopped cache', async () => {
    await render()
    runtime.api = { nodePaneEvidence: vi.fn(() => new Promise(() => {})) } as unknown as NodeTerminalApi
    await render()
    expect(host.textContent).toContain('Task unobserved · backend unverified')
    expect(host.textContent).not.toContain('backend stopped')
  })
})
