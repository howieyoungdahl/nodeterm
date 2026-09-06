// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Workspace } from '@shared/types'
import { useWorkspaceRead, WorkspaceReadNotice } from './useWorkspaceRead'

let element: HTMLDivElement, root: Root
beforeEach(() => {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  element = document.createElement('div'); document.body.append(element); root = createRoot(element)
})
afterEach(async () => { await act(async () => root.unmount()); element.remove() })
const button = (): HTMLButtonElement => element.querySelector('button')!
const workspace: Workspace = { version: 2, activeProjectId: 'real-project', projects: [] }
function Mounted({ reader, hydrate }: { reader: { load(): Promise<Workspace> }; hydrate: (ws: Workspace) => void }) {
  const state = useWorkspaceRead(reader, hydrate)
  return <><WorkspaceReadNotice {...state} /><output>{state.loaded ? 'autosave allowed' : 'autosave disabled'}</output></>
}
describe('ordinary initial workspace read state', () => {
  it('shows a retryable read failure without hydrating or enabling autosave, then adopts one successful retry', async () => {
    const reader = { load: vi.fn().mockRejectedValueOnce(new Error('E_PUBLICATION_BUSY')).mockResolvedValueOnce(workspace) }
    const hydrate = vi.fn()
    await act(async () => root.render(<Mounted reader={reader} hydrate={hydrate} />))
    expect(element.querySelector('[role=alert]')?.textContent).toContain('E_PUBLICATION_BUSY')
    expect(element.textContent).toContain('autosave disabled')
    expect(hydrate).not.toHaveBeenCalled()
    expect(reader.load).toHaveBeenCalledTimes(1)
    expect(button().textContent).toBe('Retry workspace read')
    await act(async () => button().click())
    expect(hydrate).toHaveBeenCalledWith(workspace)
    expect(reader.load).toHaveBeenCalledTimes(2)
    expect(element.querySelector('[role=alert]')).toBeNull()
    expect(element.textContent).toContain('autosave allowed')
  })
  it('keeps an abandoned-lock error visible without polling or overlapping manual retries', async () => {
    let reject!: (reason: unknown) => void
    const reader = { load: vi.fn().mockRejectedValueOnce(new Error('E_PUBLICATION_BUSY'))
      .mockImplementationOnce(() => new Promise<Workspace>((_, no) => { reject = no })) }
    const hydrate = vi.fn()
    await act(async () => root.render(<Mounted reader={reader} hydrate={hydrate} />))
    await act(async () => button().click())
    expect(button().disabled).toBe(true)
    await act(async () => { reject(new Error('E_PUBLICATION_BUSY')) })
    expect(reader.load).toHaveBeenCalledTimes(2)
    expect(hydrate).not.toHaveBeenCalled()
    expect(element.querySelector('[role=alert]')?.textContent).toContain('E_PUBLICATION_BUSY')
  })
})
