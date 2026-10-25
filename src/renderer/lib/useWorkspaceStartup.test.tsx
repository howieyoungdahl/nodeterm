// @vitest-environment jsdom
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useWorkspaceStartup, WorkspaceStartupGate } from './useWorkspaceStartup'
import { WelcomeScreen } from '../components/WelcomeScreen'
import type { Workspace } from '@shared/types'

let root: Root, container: HTMLDivElement
const empty: Workspace = { version: 2, activeProjectId: '', projects: [] }
const populated: Workspace = { ...empty, activeProjectId: 'fixture', projects: [{ id: 'fixture', name: 'Fixture',
  color: '#888', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [] }] }
function Harness({ load, save }: { load: () => Promise<Workspace>; save: () => void }) {
  const [workspace, setWorkspace] = useState(empty)
  const startup = useWorkspaceStartup(load, value => { setWorkspace(value); save() })
  return <WorkspaceStartupGate {...startup}>{workspace.projects.length ? <div>Fixture canvas</div> :
    <WelcomeScreen onNewProject={() => {}} onOpenFolder={() => {}} onCloneRepo={() => {}}
      onConnectSsh={() => {}} closedProjects={[]} onReopen={() => {}} onDeleteClosed={() => {}} />}
  </WorkspaceStartupGate>
}
beforeEach(() => {
  vi.useFakeTimers(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.useRealTimers(); vi.unstubAllGlobals() })

it('shows loading throughout a slow read, then the canvas, never the welcome screen', async () => {
  let resolve!: (value: Workspace) => void
  const load = vi.fn(() => new Promise<Workspace>(done => { resolve = done })), save = vi.fn()
  await act(async () => root.render(<Harness load={load} save={save} />))
  expect(container.textContent).toContain('Loading workspace')
  expect(container.textContent).not.toContain('Start a project')
  await act(async () => { await vi.advanceTimersByTimeAsync(30000) })
  expect(container.textContent).toContain('Loading workspace'); expect(save).not.toHaveBeenCalled()
  await act(async () => resolve(populated))
  expect(container.textContent).toContain('Fixture canvas'); expect(save).toHaveBeenCalledOnce()
})

it('retries a publication-busy load without hydrating or saving an empty workspace', async () => {
  const load = vi.fn<() => Promise<Workspace>>().mockRejectedValueOnce(new Error('E_PUBLICATION_BUSY')).mockResolvedValue(populated)
  const save = vi.fn()
  await act(async () => root.render(<Harness load={load} save={save} />))
  expect(save).not.toHaveBeenCalled(); expect(container.textContent).toContain('Loading workspace')
  await act(async () => { await vi.advanceTimersByTimeAsync(500) })
  expect(load).toHaveBeenCalledTimes(2); expect(container.textContent).toContain('Fixture canvas')
})

it('offers manual retry after bounded failures', async () => {
  const load = vi.fn<() => Promise<Workspace>>().mockRejectedValue(new Error('unreadable')), save = vi.fn()
  await act(async () => root.render(<Harness load={load} save={save} />))
  await act(async () => { await vi.advanceTimersByTimeAsync(60000) })
  expect(load).toHaveBeenCalledTimes(6); expect(container.textContent).toContain('Retry loading')
  expect(save).not.toHaveBeenCalled(); expect(container.textContent).not.toContain('Start a project')
  load.mockResolvedValue(populated)
  await act(async () => container.querySelector('button')!.click())
  expect(container.textContent).toContain('Fixture canvas')
})

it('ignores a successful read that completes after teardown', async () => {
  let resolve!: (value: Workspace) => void
  const load = () => new Promise<Workspace>(done => { resolve = done }), save = vi.fn()
  await act(async () => root.render(<Harness load={load} save={save} />))
  await act(async () => root.render(<div>Unmounted canvas</div>))
  await act(async () => resolve(populated))
  expect(save).not.toHaveBeenCalled()
  expect(container.textContent).toBe('Unmounted canvas')
})

it('keeps the welcome screen for a genuinely absent workspace', async () => {
  await act(async () => root.render(<Harness load={async () => empty} save={() => {}} />))
  expect(container.textContent).toContain('Start a project')
  expect(container.textContent).not.toContain('Loading workspace')
})
