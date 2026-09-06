// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, onTestFinished, vi } from 'vitest'
import { DEFAULT_SETTINGS, type Project } from '@shared/types'
import { useProjects } from '../../../state/projects'
import { useSettings } from '../../../state/settings'
import { registerWorkspaceDirty } from '../../../state/workspaceDirty'
import { AppearanceSection } from './AppearanceSection'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('clears the final project border through the real editor without dropping layout rules or local preferences', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
  onTestFinished(() => { vi.unstubAllGlobals() })
  const host = document.createElement('div')
  const root = createRoot(host)
  onTestFinished(() => act(() => root.unmount()))
  const local = { effectsOff: true, reducedMotion: true, windowEdge: { color: '#abc' } }
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, appearance: local } })
  const rules = {
    version: 7, spawn: { size: 'compact' as const }, tray: { collapsed: true },
    future: { exclusions: ['primary'] }, appearance: { project: { color: '#123456' } }
  }
  const project: Project = {
    id: 'p1', name: 'Fixture', color: '#abc', nodes: [],
    viewport: { x: 0, y: 0, zoom: 1 }, layoutRules: rules
  }
  useProjects.setState({ projects: [project], activeProjectId: project.id })
  const dirty = vi.fn()
  onTestFinished(registerWorkspaceDirty(dirty))
  await act(async () => root.render(<AppearanceSection isActive />))
  const clear = host.querySelector<HTMLButtonElement>('[aria-label="Project border: none"]')
  expect(clear).not.toBeNull()
  await act(async () => clear!.click())
  expect(useProjects.getState().projects[0].layoutRules).toEqual({
    version: 7, spawn: { size: 'compact' }, tray: { collapsed: true }, future: { exclusions: ['primary'] }
  })
  expect(useSettings.getState().settings.appearance).toEqual(local)
  expect(dirty).toHaveBeenCalledTimes(1)
})
