// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import type { Project } from '@shared/types'
import type { ProjectSettingsSnapshot } from '@shared/project-settings'
import { useProjects } from '../../../state/projects'
import { useSettings } from '../../../state/settings'
import { registerWorkspaceDirty } from '../../../state/workspaceDirty'
import { SettingsSearchContext } from '../context'
import { ProjectSettingsSection } from './ProjectSettingsSection'
import { mergeSharedDoc, useProjectSettings, type ProjectSettingsHook } from '../useProjectSettings'
import type { ProjectSetupEvent } from '@shared/project-settings'
import { useProjectSetup } from '../../../state/projectSetup'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function project(over: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'Alpha',
    color: '#0a84ff',
    cwd: '/repo/alpha',
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [],
    ...over
  }
}

const BASE = { clientId: 'fixture-client', indexRevision: 'a'.repeat(64) }
const EMPTY_SNAPSHOT: ProjectSettingsSnapshot = { shared: null, localBase: BASE, local: undefined }

describe('ProjectSettingsSection', () => {
  let root: Root
  let host: HTMLElement
  let read: ReturnType<typeof vi.fn>
  let writeShared: ReturnType<typeof vi.fn>
  let updateLocal: ReturnType<typeof vi.fn>
  /** Canvas's `markDirty`, registered through the same seam the app uses. */
  let dirty: ReturnType<typeof vi.fn<() => void>>
  let unregisterDirty: () => void

  const mount = async (node: React.JSX.Element, query = ''): Promise<void> => {
    root = createRoot(host)
    await act(async () => {
      root.render(<SettingsSearchContext.Provider value={query}>{node}</SettingsSearchContext.Provider>)
    })
  }

  const mountSection = async (
    p: Project = project(),
    { isActive = true, query = '' }: { isActive?: boolean; query?: string } = {}
  ): Promise<void> => {
    useProjects.setState({ projects: [p], activeProjectId: p.id })
    await mount(<ProjectSettingsSection projectId={p.id} isActive={isActive} />, query)
  }

  const typeInto = async (el: HTMLInputElement, value: string): Promise<void> => {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
      setter.call(el, value)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  const nameInput = (): HTMLInputElement => host.querySelector<HTMLInputElement>('#project-name-p1')!

  /** A real blur fires `focusout`, which is what React's `onBlur` listens for. */
  const blur = async (el: HTMLElement): Promise<void> => {
    await act(async () => {
      el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    })
  }

  beforeEach(() => {
    sessionStorage.clear()
    host = document.createElement('div')
    document.body.appendChild(host)
    read = vi.fn(async () => EMPTY_SNAPSHOT)
    writeShared = vi.fn(async () => true)
    updateLocal = vi.fn(async (_id, request) => ({ kind: 'committed', operationId: request.operationId, receiptRevision: 'b'.repeat(64), current: { projectId: 'p1', ...BASE, local: Object.fromEntries(request.changes.filter((c: any) => !c.remove).map((c: any) => [c.family, { [c.key]: c.value }])) } }))
    dirty = vi.fn<() => void>()
    unregisterDirty = registerWorkspaceDirty(dirty)
    ;(window as unknown as { nodeTerminal: any }).nodeTerminal = {
      projectSettings: { read, writeShared, updateLocal },
      workspace: { save: vi.fn() }
    }
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    unregisterDirty()
    useProjects.setState({ projects: [], activeProjectId: '' })
  })

  it('titles the section with the project and shows its folder', async () => {
    await mountSection()
    expect(host.textContent).toContain('Alpha')
    expect(host.textContent).toContain('/repo/alpha')
    expect(nameInput().value).toBe('Alpha')
    expect(read).toHaveBeenCalledWith('p1')
  })

  it('shows an SSH project as user@host:path', async () => {
    await mountSection(
      project({ ssh: { server: { host: 'box', user: 'enes' } as never, remoteCwd: '/srv/app' } })
    )
    expect(host.textContent).toContain('enes@box:/srv/app')
  })

  it('renames the project on BLUR only, then rings the workspace-save seam', async () => {
    await mountSection()
    await typeInto(nameInput(), 'Beta')
    // Still un-renamed while typing: each save is a disk write, so the commit waits for blur.
    expect(useProjects.getState().getProject('p1')?.name).toBe('Alpha')
    expect(dirty).not.toHaveBeenCalled()
    await blur(nameInput())
    expect(useProjects.getState().getProject('p1')?.name).toBe('Beta')
    // The seam (state/workspaceDirty) rings Canvas's markDirty, so the write inherits the canvas
    // commit and the conflict gate; a raw workspace.save from here would bypass both.
    expect(dirty).toHaveBeenCalledTimes(1)
  })

  it('ignores a blank rename instead of writing an unnamed project', async () => {
    await mountSection()
    await typeInto(nameInput(), '   ')
    await blur(nameInput())
    expect(useProjects.getState().getProject('p1')?.name).toBe('Alpha')
    expect(dirty).not.toHaveBeenCalled()
  })

  it('picks a color and persists it', async () => {
    await mountSection()
    const swatch = host.querySelector<HTMLButtonElement>('button[data-project-color="#32d74b"]')!
    await act(async () => {
      swatch.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(useProjects.getState().getProject('p1')?.color).toBe('#32d74b')
    expect(dirty).toHaveBeenCalledTimes(1)
  })

  it('picks a lucide icon and persists it (Task 4 icon picker)', async () => {
    await mountSection()
    const btn = host.querySelector<HTMLButtonElement>('[data-lucide-id="rocket"]')!
    await act(async () => {
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(useProjects.getState().getProject('p1')?.icon).toEqual({ type: 'lucide', name: 'rocket' })
    expect(dirty).toHaveBeenCalledTimes(1)
  })

  it('resets a set icon back to undefined via the picker Reset', async () => {
    await mountSection(project({ icon: { type: 'emoji', emoji: '🚀' } }))
    const reset = host.querySelector<HTMLButtonElement>('[aria-label="Remove icon"]')!
    expect(reset.disabled).toBe(false)
    await act(async () => {
      reset.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(useProjects.getState().getProject('p1')?.icon).toBeUndefined()
    expect(dirty).toHaveBeenCalledTimes(1)
  })

  it('sets the default permission mode and clears it back to the global default', async () => {
    await mountSection()
    const select = host.querySelector<HTMLSelectElement>('#project-permission-mode-p1')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
      setter.call(select, 'plan')
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(useProjects.getState().getProject('p1')?.defaultPermissionMode).toBe('plan')
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
      setter.call(select, '')
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(useProjects.getState().getProject('p1')?.defaultPermissionMode).toBeUndefined()
    expect(dirty).toHaveBeenCalledTimes(2)
  })

  it('shows the conflict banner when the shared file is git-conflicted', async () => {
    read = vi.fn(async () => ({ shared: null, localBase: BASE, local: undefined, conflict: true }) as ProjectSettingsSnapshot)
    ;(window as unknown as { nodeTerminal: any }).nodeTerminal.projectSettings.read = read
    await mountSection()
    expect(host.textContent).toContain('conflict')
    expect(host.textContent).toContain('.nodeterm/settings.json')
  })

  it('offers no editors at all for a relay (remote) project', async () => {
    await mountSection(project({ remote: true }))
    expect(host.textContent).toContain('Alpha')
    expect(host.querySelectorAll('input, select, textarea, button')).toHaveLength(0)
    // A relay tab's project settings live on the OTHER machine — never read ours for it.
    expect(read).not.toHaveBeenCalled()
  })

  it('offers no editors for an unavailable project', async () => {
    await mountSection(project({ unavailable: true }))
    expect(host.querySelectorAll('input, select, textarea, button')).toHaveLength(0)
    expect(read).not.toHaveBeenCalled()
  })

  it('reads nothing for a section that is neither active nor matched by the search', async () => {
    await mountSection(project(), { isActive: false })
    expect(host.textContent).toBe('')
    expect(read).not.toHaveBeenCalled()
  })

  it('renders (and reads) when a search query matches the project name', async () => {
    await mountSection(project(), { isActive: false, query: 'alph' })
    expect(host.textContent).toContain('Alpha')
    expect(read).toHaveBeenCalledWith('p1')
  })

  // --- Task 4: family editors --------------------------------------------------------------

  const typeIntoTextarea = async (el: HTMLTextAreaElement, value: string): Promise<void> => {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(el, value)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  const click = async (el: HTMLElement): Promise<void> => {
    await act(async () => {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
  }

  it('commits a local override row via saveLocal, carrying only that family/field', async () => {
    await mountSection()
    const local = host.querySelector<HTMLInputElement>('#project-terminal-shell-local-p1')!
    await typeInto(local, '/bin/zsh')
    await blur(local)
    expect(updateLocal).toHaveBeenCalledWith('p1', expect.objectContaining({ ...BASE, projectId: 'p1', changes: [{ family: 'terminal', key: 'shell', value: '/bin/zsh' }] }))
  })

  it('settles an IPC rejection visibly and retains the typed edit and operation for explicit retry', async () => {
    updateLocal.mockRejectedValue(new Error('disconnected'))
    await mountSection()
    const local = host.querySelector<HTMLInputElement>('#project-terminal-shell-local-p1')!
    await typeInto(local, '/bin/zsh'); await blur(local)
    expect(host.textContent).toContain('Could not save this override')
    expect(host.textContent).toContain('Retry retained local edit')
    expect(local.value).toBe('/bin/zsh')
    const retained = JSON.parse(sessionStorage.getItem('nodeterm.local-settings.intent.p1')!)
    expect(retained.request).toEqual(updateLocal.mock.calls[0][1])
    expect(retained.request.changes).toEqual([{ family: 'terminal', key: 'shell', value: '/bin/zsh' }])
    updateLocal.mockImplementation(async (_id, request) => ({ kind: 'already-applied', operationId: request.operationId,
      receiptRevision: 'b'.repeat(64), current: { ...BASE, projectId: 'p1', local: { terminal: { shell: '/bin/zsh' } } } }))
    const retry = [...host.querySelectorAll('button')].find((button) => button.textContent === 'Retry retained local edit')!
    await click(retry)
    expect(updateLocal.mock.calls[1][1]).toEqual(retained.request)
    expect(host.textContent).not.toContain('Could not save this override')
    expect(host.textContent).not.toContain('Retry retained local edit')
  })

  it('toggles a family ignoreShared Switch via saveLocal, merged with any existing local doc', async () => {
    await mountSection()
    const toggle = host.querySelector<HTMLButtonElement>(
      '[aria-label="Ignore shared setup settings on this machine"]'
    )!
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    await click(toggle)
    expect(updateLocal).toHaveBeenCalledWith('p1', expect.objectContaining({ changes: [{ family: 'ignoreShared', key: 'setup', value: true }] }))
  })

  it('flips the shared row\'s provenance note to "Overridden on this machine" when a local value wins', async () => {
    read = vi.fn(async () => ({
      shared: { version: 1, rev: 1, savedAt: 't', terminal: { shell: '/bin/bash' } },
      localBase: BASE, local: { terminal: { shell: '/bin/zsh' } }
    }))
    ;(window as unknown as { nodeTerminal: any }).nodeTerminal.projectSettings.read = read
    await mountSection()
    expect(host.textContent).toContain('Overridden on this machine')
    expect(host.textContent).toContain('Active')
    const shared = host.querySelector<HTMLInputElement>('#project-terminal-shell-p1')!
    const local = host.querySelector<HTMLInputElement>('#project-terminal-shell-local-p1')!
    expect(shared.value).toBe('/bin/bash')
    expect(local.value).toBe('/bin/zsh')
  })

  it('surfaces a rejected env line in the warn note as the draft is typed', async () => {
    await mountSection()
    const env = host.querySelector<HTMLTextAreaElement>('#project-agents-env-p1')!
    await typeIntoTextarea(env, 'bad key=1')
    expect(host.textContent).toContain('bad key=1')
    expect(host.textContent).toContain('Ignored')
  })

  it('does not disable the local editor or ignoreShared switch while the shared file is conflicted', async () => {
    read = vi.fn(async () => ({ shared: null, localBase: BASE, local: undefined, conflict: true }) as ProjectSettingsSnapshot)
    ;(window as unknown as { nodeTerminal: any }).nodeTerminal.projectSettings.read = read
    await mountSection()
    const sharedShell = host.querySelector<HTMLInputElement>('#project-terminal-shell-p1')!
    const localShell = host.querySelector<HTMLInputElement>('#project-terminal-shell-local-p1')!
    const toggle = host.querySelector<HTMLButtonElement>(
      '[aria-label="Ignore shared setup settings on this machine"]'
    )!
    expect(sharedShell.disabled).toBe(true)
    expect(localShell.disabled).toBe(false)
    expect(toggle.disabled).toBe(false)
  })

  it('disables every family editor (shared, local, and ignoreShared) while the read is in flight, and a blur landing in that window produces no write', async () => {
    let release: (v: ProjectSettingsSnapshot) => void = () => {}
    read = vi.fn(() => new Promise<ProjectSettingsSnapshot>((r) => (release = r)))
    ;(window as unknown as { nodeTerminal: any }).nodeTerminal.projectSettings.read = read
    await mountSection()
    const sharedShell = host.querySelector<HTMLInputElement>('#project-terminal-shell-p1')!
    const localShell = host.querySelector<HTMLInputElement>('#project-terminal-shell-local-p1')!
    const toggle = host.querySelector<HTMLButtonElement>(
      '[aria-label="Ignore shared setup settings on this machine"]'
    )!
    expect(sharedShell.disabled).toBe(true)
    expect(localShell.disabled).toBe(true)
    expect(toggle.disabled).toBe(true)
    // Bypass the DOM `disabled` attribute the way a stray/synthetic event could — the guard that
    // matters is the one inside the commit handler, not just the attribute.
    await typeInto(localShell, '/bin/zsh')
    await blur(localShell)
    expect(updateLocal).not.toHaveBeenCalled()
    await act(async () => {
      release(EMPTY_SNAPSHOT)
    })
    expect(sharedShell.disabled).toBe(false)
    expect(localShell.disabled).toBe(false)
    expect(toggle.disabled).toBe(false)
  })

  it('preserves an existing local family when a different local field is committed', async () => {
    read = vi.fn(async () => ({ shared: null, localBase: BASE, local: { agents: { launchCmd: 'x' } } }) as ProjectSettingsSnapshot)
    ;(window as unknown as { nodeTerminal: any }).nodeTerminal.projectSettings.read = read
    await mountSection()
    const local = host.querySelector<HTMLInputElement>('#project-terminal-shell-local-p1')!
    await typeInto(local, '/bin/zsh')
    await blur(local)
    expect(updateLocal).toHaveBeenCalledWith('p1', expect.objectContaining({ changes: [{ family: 'terminal', key: 'shell', value: '/bin/zsh' }] }))
  })

  it('merges a shared textarea blur into the whole shared doc, preserving other families', async () => {
    read = vi.fn(async () => ({
      shared: { version: 1, rev: 1, savedAt: 't', agents: { launchCmd: 'y' } },
      localBase: BASE, local: undefined
    }) as ProjectSettingsSnapshot)
    ;(window as unknown as { nodeTerminal: any }).nodeTerminal.projectSettings.read = read
    await mountSection()
    const setupScript = host.querySelector<HTMLTextAreaElement>('#project-setup-setupScript-p1')!
    await typeIntoTextarea(setupScript, 'echo hi')
    await blur(setupScript)
    expect(writeShared).toHaveBeenCalledWith('p1', {
      agents: { launchCmd: 'y' },
      setup: { setupScript: 'echo hi' }
    })
  })

  it('commits parsed KEY=VALUE pairs from the shared env textarea on blur', async () => {
    await mountSection()
    const env = host.querySelector<HTMLTextAreaElement>('#project-agents-env-p1')!
    await typeIntoTextarea(env, 'A=1\nB=2')
    await blur(env)
    expect(writeShared).toHaveBeenCalledWith('p1', { agents: { env: { A: '1', B: '2' } } })
  })

  it('surfaces a REFUSED shared write as a warn note, re-reads the file, and clears the note on the next save that lands', async () => {
    // A dropped `false` is silent data loss: the row snaps back to the stored value with no
    // explanation, which is indistinguishable from the app ignoring the edit.
    writeShared.mockResolvedValue(false)
    await mountSection()
    expect(read).toHaveBeenCalledTimes(1)
    const shell = host.querySelector<HTMLInputElement>('#project-terminal-shell-p1')!
    await typeInto(shell, '/bin/fish')
    await blur(shell)
    expect(writeShared).toHaveBeenCalledTimes(1)
    expect(host.textContent).toContain('Could not save')
    // A refusal is usually the FILE's answer (it went conflicted, or the folder went away, between
    // our read and our write), so the pane re-reads instead of describing a file it no longer knows.
    expect(read).toHaveBeenCalledTimes(2)
    writeShared.mockResolvedValue(true)
    await blur(shell)
    expect(writeShared).toHaveBeenCalledTimes(2)
    expect(host.textContent).not.toContain('Could not save')
  })

  it('surfaces a refused LOCAL write too, without re-reading (nothing about the shared file changed)', async () => {
    updateLocal.mockResolvedValue(false)
    await mountSection()
    const local = host.querySelector<HTMLInputElement>('#project-terminal-shell-local-p1')!
    await typeInto(local, '/bin/zsh')
    await blur(local)
    expect(host.textContent).toContain('Could not save this override on this machine')
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('renders the shared family rows read-only for a folderless inline project, with the reason', async () => {
    // An inline canvas tab has no `cwd` and no `ssh`, so there is nowhere to put a
    // `.nodeterm/settings.json`: the store refuses every shared write for it. Editors that can only
    // ever fail must not be offered.
    await mountSection(project({ cwd: '' }))
    expect(host.textContent).toContain('no folder')
    const familyControls = [
      ...host.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea')
    ].filter((el) => /^project-(setup|agents|worktree|terminal)-/.test(el.id))
    const sharedRows = familyControls.filter((el) => !el.id.includes('-local-'))
    expect(sharedRows.length).toBeGreaterThan(0)
    expect(sharedRows.every((el) => el.disabled)).toBe(true)
    // Bypassing the attribute (a synthetic event) must not write either.
    const shell = host.querySelector<HTMLInputElement>('#project-terminal-shell-p1')!
    await typeInto(shell, '/bin/fish')
    await blur(shell)
    expect(writeShared).not.toHaveBeenCalled()
    // The identity rows still work: name/color/defaults live in project.json, not in the folder.
    expect(nameInput().disabled).toBe(false)
    await typeInto(nameInput(), 'Beta')
    await blur(nameInput())
    expect(useProjects.getState().getProject('p1')?.name).toBe('Beta')
    // And so does the machine-local overlay, which lives in this machine's workspace index.
    const local = host.querySelector<HTMLInputElement>('#project-terminal-shell-local-p1')!
    expect(local.disabled).toBe(false)
    await typeInto(local, '/bin/zsh')
    await blur(local)
    expect(updateLocal).toHaveBeenCalledWith('p1', expect.objectContaining({ ...BASE, projectId: 'p1', changes: [{ family: 'terminal', key: 'shell', value: '/bin/zsh' }] }))
  })

  it('gives every local row an accessible name of its own, so it never duplicates its shared twin', async () => {
    await mountSection()
    expect(
      host.querySelector<HTMLInputElement>('#project-terminal-shell-local-p1')!.getAttribute('aria-label')
    ).toBe('Shell (this machine)')
    expect(
      host.querySelector<HTMLTextAreaElement>('#project-agents-env-local-p1')!.getAttribute('aria-label')
    ).toBe('Environment variables (this machine)')
    // The shared twin keeps its `<label>` as its name — the two must not read alike.
    expect(
      host.querySelector<HTMLInputElement>('#project-terminal-shell-p1')!.getAttribute('aria-label')
    ).toBeNull()
  })

  it('shows an unknown default account as itself and switches to one this machine has', async () => {
    const prior = useSettings.getState().settings
    onTestFinished(() => useSettings.setState({ settings: prior }))
    useSettings.setState({
      settings: { ...prior, claudeAccounts: [{ id: 'acc-1', label: 'Work', createdAt: 0 }] }
    })
    await mountSection(project({ defaultAccountId: 'acc-gone' }))
    const select = host.querySelector<HTMLSelectElement>('#project-account-p1')!
    // A default naming an account this machine does not have (a teammate's pick, or one since
    // removed) must READ as itself, not silently as the system account.
    expect(host.textContent).toContain('acc-gone (not on this machine)')
    expect(select.value).toBe('acc-gone')
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!
      setter.call(select, 'acc-1')
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    expect(useProjects.getState().getProject('p1')?.defaultAccountId).toBe('acc-1')
    expect(dirty).toHaveBeenCalledTimes(1)
  })

  // --- Task 5: search integration ------------------------------------------------------------

  const pane = (): HTMLElement | null => host.querySelector('[data-settings-section="project-p1"]')

  it('renders the WHOLE pane, rows and families included, when the query is the project name', async () => {
    // Searching a project by NAME is navigation: it names the pane, not a field inside it, so
    // every row renders instead of the pane collapsing to the (zero) rows that match "Alpha".
    await mountSection(project(), { isActive: false, query: 'Alpha' })
    expect(pane()).not.toBeNull()
    expect(nameInput()).not.toBeNull()
    expect(host.querySelector('#project-permission-mode-p1')).not.toBeNull()
    expect(host.querySelector('#project-terminal-shell-p1')).not.toBeNull()
    expect(host.querySelector('#project-setup-setupScript-p1')).not.toBeNull()
    expect(host.querySelector('#project-worktree-basePath-local-p1')).not.toBeNull()
  })

  it('filters to the matching identity row on a field-term query', async () => {
    await mountSection(project(), { isActive: false, query: 'approval' })
    expect(pane()).not.toBeNull()
    expect(host.querySelector('#project-permission-mode-p1')).not.toBeNull()
    expect(host.querySelector('#project-name-p1')).toBeNull()
    expect(host.querySelector('#project-terminal-shell-p1')).toBeNull()
  })

  it('filters to the matching family on a family-term query', async () => {
    await mountSection(project(), { isActive: false, query: 'worktree' })
    expect(pane()).not.toBeNull()
    expect(host.querySelector('#project-worktree-basePath-p1')).not.toBeNull()
    expect(host.querySelector('#project-terminal-shell-p1')).toBeNull()
    expect(host.querySelector('#project-name-p1')).toBeNull()
  })

  it('does not match every family field on the non-discriminating query "project"', async () => {
    // Every field in this pane is a project setting, so "project" told the search nothing while
    // pulling in all four families of every open project. The identity rows still match — the
    // "Project name" row is titled with the word.
    // (A field whose own description genuinely says "project" — the setup scripts, the default
    // agent — still matches, and should: that is prose about the field, not a blanket keyword.)
    await mountSection(project(), { isActive: false, query: 'project' })
    expect(host.querySelector('#project-name-p1')).not.toBeNull()
    expect(host.querySelector('#project-terminal-shell-p1')).toBeNull()
    expect(host.querySelector('#project-terminal-fontFamily-p1')).toBeNull()
    expect(host.querySelector('#project-agents-launchCmd-p1')).toBeNull()
    expect(host.querySelector('#project-worktree-basePath-local-p1')).toBeNull()
  })

  it('renders nothing (and reads nothing) for a query matching neither the name nor any row', async () => {
    await mountSection(project(), { isActive: false, query: 'zzzznomatch' })
    expect(host.textContent).toBe('')
    expect(read).not.toHaveBeenCalled()
  })

  it('keeps the two visibility gates in agreement: no pane is ever mounted without being shown', async () => {
    // The outer gate in ProjectSettingsSection duplicates SettingsSection's predicate (so an
    // invisible SSH pane never mounts the reading hook). If the two ever disagree, one of these
    // two symptoms appears: a read fired for a pane that renders nothing (outer open, inner shut),
    // or a nav row pointing at a pane that renders nothing.
    for (const [query, isActive] of [
      ['', true],
      ['', false],
      ['Alpha', false],
      ['approval', false],
      ['worktree', false],
      ['zzzznomatch', true]
    ] as [string, boolean][]) {
      read.mockClear()
      await mountSection(project(), { isActive, query })
      const shown = pane() !== null
      expect({ query, mounted: read.mock.calls.length > 0 }).toEqual({ query, mounted: shown })
      act(() => root.unmount())
    }
    // afterEach unmounts once more; give it a live root.
    await mountSection()
  })
})

describe('useProjectSettings', () => {
  let root: Root
  let host: HTMLElement
  let hook: ProjectSettingsHook
  let read: ReturnType<typeof vi.fn>
  let writeShared: ReturnType<typeof vi.fn>
  let updateLocal: ReturnType<typeof vi.fn>

  function Probe({ projectId }: { projectId: string }): React.JSX.Element {
    hook = useProjectSettings(projectId)
    return <div>{hook.snapshot === 'loading' ? 'loading' : JSON.stringify(hook.resolved)}</div>
  }

  const mount = async (): Promise<void> => {
    root = createRoot(host)
    await act(async () => {
      root.render(<Probe projectId="p1" />)
    })
  }

  beforeEach(() => {
    sessionStorage.clear()
    host = document.createElement('div')
    document.body.appendChild(host)
    read = vi.fn(async () => ({
      shared: { version: 1, rev: 3, savedAt: 't', terminal: { shell: '/bin/bash', theme: 'dark' } },
      localBase: BASE, local: undefined
    }))
    writeShared = vi.fn(async () => true)
    updateLocal = vi.fn(async (_id, request) => ({ kind: 'committed', operationId: request.operationId, receiptRevision: 'b'.repeat(64), current: { projectId: 'p1', ...BASE, local: Object.fromEntries(request.changes.filter((c: any) => !c.remove).map((c: any) => [c.family, { [c.key]: c.value }])) } }))
    ;(window as unknown as { nodeTerminal: any }).nodeTerminal = {
      projectSettings: { read, writeShared, updateLocal },
      workspace: { save: vi.fn() }
    }
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  it('resolves local over shared with provenance', async () => {
    read.mockResolvedValue({
      shared: { version: 1, rev: 3, savedAt: 't', terminal: { shell: '/bin/bash', theme: 'dark' } },
      localBase: BASE, local: { terminal: { theme: 'light' } }
    })
    await mount()
    expect(hook.resolved.terminal.shell).toEqual({ value: '/bin/bash', source: 'shared' })
    expect(hook.resolved.terminal.theme).toEqual({ value: 'light', source: 'local' })
  })

  it('reports empty families while the read is still in flight', async () => {
    let release: (v: ProjectSettingsSnapshot) => void = () => {}
    read.mockReturnValue(new Promise<ProjectSettingsSnapshot>((r) => (release = r)))
    root = createRoot(host)
    act(() => {
      root.render(<Probe projectId="p1" />)
    })
    expect(hook.snapshot).toBe('loading')
    expect(hook.resolved).toEqual({ setup: {}, worktree: {}, agents: {}, terminal: {} })
    await act(async () => {
      release(EMPTY_SNAPSHOT)
    })
  })

  it('writes the WHOLE document (merging the edited field) and re-reads after a save', async () => {
    await mount()
    expect(read).toHaveBeenCalledTimes(1)
    let ok = false
    await act(async () => {
      ok = await hook.saveShared({ terminal: { shell: '/bin/fish' } })
    })
    expect(ok).toBe(true)
    // The sibling field survives, and version/rev/savedAt are stripped — the store owns those.
    expect(writeShared).toHaveBeenCalledTimes(1)
    expect(writeShared).toHaveBeenCalledWith('p1', { terminal: { shell: '/bin/fish', theme: 'dark' } })
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('keeps a save that is still being re-read as the merge base for the next one', async () => {
    // Blur A saves the shell; blur B arrives BEFORE A's re-read lands. Merging into the pre-A
    // document would make B's whole-document write silently delete A's shell.
    const first: ProjectSettingsSnapshot = {
      shared: { version: 1, rev: 1, savedAt: 't', terminal: { shell: '/bin/bash' } },
      localBase: BASE, local: undefined
    }
    let gate: (v: ProjectSettingsSnapshot) => void = () => {}
    read.mockResolvedValueOnce(first).mockReturnValue(
      new Promise<ProjectSettingsSnapshot>((r) => (gate = r))
    )
    await mount()
    await act(async () => {
      await hook.saveShared({ terminal: { shell: '/bin/fish' } })
    })
    expect(hook.snapshot).not.toBe('loading') // retain the last acknowledged view while refreshing
    await act(async () => {
      await hook.saveShared({ setup: { waitForSetup: true } })
    })
    expect(writeShared).toHaveBeenLastCalledWith('p1', {
      terminal: { shell: '/bin/fish' },
      setup: { waitForSetup: true }
    })
    await act(async () => {
      gate(first)
    })
  })

  it('drops a field cleared to undefined, and the family with it', async () => {
    read.mockResolvedValue({
      shared: { version: 1, rev: 1, savedAt: 't', terminal: { shell: '/bin/bash' } },
      localBase: BASE, local: undefined
    })
    await mount()
    await act(async () => {
      await hook.saveShared({ terminal: { shell: undefined } })
    })
    expect(writeShared).toHaveBeenCalledWith('p1', {})
  })

  it('does not re-read when the write is refused', async () => {
    writeShared.mockResolvedValue(false)
    await mount()
    let ok = true
    await act(async () => {
      ok = await hook.saveShared({ terminal: { shell: '/bin/fish' } })
    })
    expect(ok).toBe(false)
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('sends only local leaves and consumes the acknowledged fresh projection', async () => {
    await mount()
    await act(async () => {
      await hook.saveLocal(() => ({ terminal: { shell: '/bin/zsh' }, ignoreShared: { agents: true } }))
    })
    expect(updateLocal).toHaveBeenCalledWith('p1', expect.objectContaining({ changes: [
      { family: 'terminal', key: 'shell', value: '/bin/zsh' },
      { family: 'ignoreShared', key: 'agents', value: true }
    ] }))
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('keeps a local save that is still being re-read as the merge base for the next local save', async () => {
    // Same hazard as the shared-doc race above, on the local overlay: local edit A (terminal)
    // saves; local edit B (worktree) arrives before A's re-read lands. Merging B into the pre-A
    // local doc would make B's whole-document write silently drop A's edit.
    const first: ProjectSettingsSnapshot = {
      shared: { version: 1, rev: 1, savedAt: 't', terminal: { shell: '/bin/bash' } },
      localBase: BASE, local: { agents: { launchCmd: 'x' } }
    }
    let gate: (v: ProjectSettingsSnapshot) => void = () => {}
    read.mockResolvedValueOnce(first).mockReturnValue(
      new Promise<ProjectSettingsSnapshot>((r) => (gate = r))
    )
    await mount()
    await act(async () => {
      await hook.saveLocal((current) => ({ ...current, terminal: { shell: '/bin/zsh' } }))
    })
    expect(hook.snapshot).not.toBe('loading') // retain the last acknowledged view while refreshing
    await act(async () => {
      await hook.saveLocal((current) => ({ ...current, worktree: { basePath: '/tmp/wt' } }))
    })
    expect(updateLocal).toHaveBeenLastCalledWith('p1', expect.objectContaining({ changes: [{ family: 'worktree', key: 'basePath', value: '/tmp/wt' }] }))
    await act(async () => {
      gate(first)
    })
  })

  it('degrades a failed read to "nothing readable" instead of throwing', async () => {
    read.mockRejectedValue(new Error('boom'))
    await mount()
    expect(hook.snapshot).toBeNull()
    expect(hook.resolved.terminal.shell).toBeUndefined()
  })

  it('re-reads on reload()', async () => {
    await mount()
    await act(async () => {
      hook.reload()
    })
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('refuses BOTH savers while the first read is still in flight, without writing anything', async () => {
    // Defence in depth below the editors' own `ready` gate. Every write here is a WHOLE-document
    // write; with nothing read and nothing pending, the merge base would be `{}`/`undefined`, so
    // committing would delete whatever the files already hold.
    let release: (v: ProjectSettingsSnapshot) => void = () => {}
    read.mockReturnValue(new Promise<ProjectSettingsSnapshot>((r) => (release = r)))
    root = createRoot(host)
    act(() => {
      root.render(<Probe projectId="p1" />)
    })
    expect(hook.snapshot).toBe('loading')
    let ok = true
    let okLocal = true
    await act(async () => {
      ok = await hook.saveShared({ terminal: { shell: '/bin/fish' } })
      okLocal = await hook.saveLocal(() => ({ terminal: { shell: '/bin/zsh' } }))
    })
    expect(ok).toBe(false)
    expect(okLocal).toBe(false)
    expect(writeShared).not.toHaveBeenCalled()
    expect(updateLocal).not.toHaveBeenCalled()
    await act(async () => {
      release(EMPTY_SNAPSHOT)
    })
  })

  it('refuses BOTH savers after a FAILED read, which is equally "no document to merge into"', async () => {
    read.mockRejectedValue(new Error('boom'))
    await mount()
    expect(hook.snapshot).toBeNull()
    let ok = true
    let okLocal = true
    await act(async () => {
      ok = await hook.saveShared({ terminal: { shell: '/bin/fish' } })
      okLocal = await hook.saveLocal(() => ({ terminal: { shell: '/bin/zsh' } }))
    })
    expect(ok).toBe(false)
    expect(okLocal).toBe(false)
    expect(writeShared).not.toHaveBeenCalled()
    expect(updateLocal).not.toHaveBeenCalled()
  })
})

describe('mergeSharedDoc', () => {
  it('merges field-by-field so an editor never blanks a field it does not own', () => {
    expect(
      mergeSharedDoc({ terminal: { shell: '/bin/bash', theme: 'dark' } }, { terminal: { theme: 'light' } })
    ).toEqual({ terminal: { shell: '/bin/bash', theme: 'light' } })
  })

  it('clears a WHOLE family set to undefined, and drops a family its last cleared field empties', () => {
    // The advertised family-level clear: `{ terminal: undefined }` removes the family outright,
    // while clearing its last field removes it as a side effect — an unset setting adds no bytes
    // to a file the whole team reads.
    const current = { terminal: { shell: '/bin/bash' }, setup: { waitForSetup: true } }
    expect(mergeSharedDoc(current, { terminal: undefined })).toEqual({ setup: { waitForSetup: true } })
    expect(mergeSharedDoc(current, { terminal: { shell: undefined } })).toEqual({
      setup: { waitForSetup: true }
    })
  })
})

/**
 * The setup family's RUN controls (Task 4). These buttons are the manual half of the trust gate:
 * the service still decides whether the script may run (and raises the consent dialog), so what is
 * pinned here is the renderer's side — the right call, the right ORDER (subscribe before run, or
 * the first chunks are lost), an honest disabled state, and the live output.
 */
describe('ProjectSettingsSection — setup run controls', () => {
  let root: Root
  let host: HTMLElement
  let runSetup: ReturnType<typeof vi.fn>
  let cancel: ReturnType<typeof vi.fn>
  let onEvent: ReturnType<typeof vi.fn>
  let emit: (ev: ProjectSetupEvent) => void
  let off: ReturnType<typeof vi.fn>

  const snapshotWith = (setup: Record<string, unknown>): ProjectSettingsSnapshot => ({
    shared: { version: 1, rev: 1, savedAt: '2026-08-19T00:00:00.000Z', setup },
    localBase: BASE, local: undefined
  })

  const mountPanel = async (
    snapshot: ProjectSettingsSnapshot,
    p: Project = project()
  ): Promise<void> => {
    ;(window as unknown as { nodeTerminal: any }).nodeTerminal.projectSettings.read = vi.fn(
      async () => snapshot
    )
    useProjects.setState({ projects: [p], activeProjectId: p.id })
    root = createRoot(host)
    await act(async () => {
      root.render(
        <SettingsSearchContext.Provider value="">
          <ProjectSettingsSection projectId={p.id} isActive />
        </SettingsSearchContext.Provider>
      )
    })
  }

  const button = (label: string): HTMLButtonElement => {
    const el = [...host.querySelectorAll('button')].find((b) => b.textContent === label)
    expect(el, `button "${label}"`).toBeTruthy()
    return el as HTMLButtonElement
  }

  const hasButton = (label: string): boolean =>
    [...host.querySelectorAll('button')].some((b) => b.textContent === label)

  const log = (): HTMLElement | null => host.querySelector('[role="log"]')

  beforeEach(() => {
    sessionStorage.clear()
    host = document.createElement('div')
    document.body.appendChild(host)
    useProjectSetup.setState({ byRunKey: {}, projectRunKey: {}, groupRunKey: {} })
    runSetup = vi.fn(async () => ({ status: 'started', runKey: 'rk-setup', runId: 'run-a', waitForSetup: false }))
    cancel = vi.fn(async () => true)
    off = vi.fn()
    onEvent = vi.fn((_projectId: string, cb: (ev: ProjectSetupEvent) => void) => {
      emit = cb
      return off
    })
    ;(window as unknown as { nodeTerminal: any }).nodeTerminal = {
      projectSettings: { read: vi.fn(async () => EMPTY_SNAPSHOT), writeShared: vi.fn(async () => true), updateLocal: vi.fn(async () => true) },
      projectSetup: { run: runSetup, cancel, onEvent, consent: vi.fn(), onConsentRequest: vi.fn(), onConsentDismiss: vi.fn() },
      workspace: { save: vi.fn() }
    }
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
    useProjects.setState({ projects: [], activeProjectId: '' })
    useProjectSetup.setState({ byRunKey: {}, projectRunKey: {}, groupRunKey: {} })
  })

  it('runs the setup script for this project, SUBSCRIBING to the event channel first', async () => {
    await mountPanel(snapshotWith({ setupScript: 'make bootstrap' }))
    await act(async () => {
      button('Run setup').click()
    })
    expect(runSetup).toHaveBeenCalledWith('p1', 'setup', undefined)
    expect(onEvent).toHaveBeenCalledWith('p1', expect.any(Function))
    // T1: main can emit the first chunks before the `run` invoke resolves, so a subscription
    // opened after the ack would miss the head of the output.
    expect(onEvent.mock.invocationCallOrder[0]).toBeLessThan(runSetup.mock.invocationCallOrder[0])
  })

  it('runs the archive script from its own button', async () => {
    await mountPanel(snapshotWith({ archiveScript: 'rm -rf node_modules' }))
    await act(async () => {
      button('Run archive').click()
    })
    expect(runSetup).toHaveBeenCalledWith('p1', 'archive', undefined)
  })

  it('disables the button whose script is not set', async () => {
    await mountPanel(snapshotWith({ setupScript: 'make' }))
    expect(button('Run setup').disabled).toBe(false)
    expect(button('Run archive').disabled).toBe(true)
  })

  it('uses the EFFECTIVE value: a machine-local script enables the button with none shared', async () => {
    await mountPanel({ shared: null, localBase: BASE, local: { setup: { setupScript: 'local-only.sh' } } })
    expect(button('Run setup').disabled).toBe(false)
  })

  it('disables both for a project with nowhere to run — no folder and no server', async () => {
    await mountPanel(snapshotWith({ setupScript: 'make', archiveScript: 'clean' }), project({ cwd: undefined }))
    expect(button('Run setup').disabled).toBe(true)
    expect(button('Run archive').disabled).toBe(true)
  })

  it('shows the live output in a log box and disables the buttons while the run is going', async () => {
    await mountPanel(snapshotWith({ setupScript: 'make', archiveScript: 'clean' }))
    expect(log()).toBeNull()
    await act(async () => {
      button('Run setup').click()
    })
    act(() => emit({ runKey: 'rk-setup', runId: 'run-a', kind: 'setup', seq: 1, state: 'running', chunk: 'compiling…\n' }))
    expect(log()!.textContent).toContain('compiling…')
    expect(button('Run setup').disabled).toBe(true)
    expect(button('Run archive').disabled).toBe(true)
    expect(hasButton('Cancel')).toBe(true)
  })

  it('cancels the live run by its runKey', async () => {
    await mountPanel(snapshotWith({ setupScript: 'make' }))
    await act(async () => {
      button('Run setup').click()
    })
    act(() => emit({ runKey: 'rk-setup', runId: 'run-a', kind: 'setup', seq: 1, state: 'running', chunk: 'x' }))
    await act(async () => {
      button('Cancel').click()
    })
    expect(cancel).toHaveBeenCalledWith('rk-setup')
  })

  it('reports the exit code when the run ends, and re-enables the buttons', async () => {
    await mountPanel(snapshotWith({ setupScript: 'make' }))
    await act(async () => {
      button('Run setup').click()
    })
    act(() => emit({ runKey: 'rk-setup', runId: 'run-a', kind: 'setup', seq: 1, state: 'running', chunk: 'boom\n' }))
    act(() => emit({ runKey: 'rk-setup', runId: 'run-a', kind: 'setup', seq: 2, state: 'failed', exitCode: 2 }))
    expect(host.textContent).toContain('2')
    expect(host.textContent?.toLowerCase()).toContain('failed')
    expect(button('Run setup').disabled).toBe(false)
    expect(hasButton('Cancel')).toBe(false)
  })

  it('explains a REFUSED run instead of looking like nothing happened', async () => {
    runSetup.mockResolvedValue({ status: 'skipped', reason: 'declined' })
    await mountPanel(snapshotWith({ setupScript: 'make' }))
    await act(async () => {
      button('Run setup').click()
    })
    expect(host.textContent?.toLowerCase()).toContain('skipped')
    expect(button('Run setup').disabled).toBe(false)
  })

  it('C1: a SECOND run of the same script (same runKey, new runId) resets the box and re-disables the buttons', async () => {
    await mountPanel(snapshotWith({ setupScript: 'make' }))
    await act(async () => {
      button('Run setup').click()
    })
    act(() => emit({ runKey: 'rk-setup', runId: 'run-a', kind: 'setup', seq: 1, state: 'running', chunk: 'first run\n' }))
    act(() => emit({ runKey: 'rk-setup', runId: 'run-a', kind: 'setup', seq: 2, state: 'failed', exitCode: 1 }))
    expect(button('Run setup').disabled).toBe(false)
    expect(host.textContent).toContain('Failed (exit 1)')

    // Run it again. `runKey` is DETERMINISTIC (kind + location), so the second run re-uses it and
    // its `seq` restarts at 1 — the exact shape that used to be swallowed as stale, leaving the
    // failed badge standing over a live script.
    runSetup.mockResolvedValue({ status: 'started', runKey: 'rk-setup', runId: 'run-b', waitForSetup: false })
    await act(async () => {
      button('Run setup').click()
    })
    // Between the ack and the first event the lane still holds run A: it must not be shown.
    expect(button('Run setup').disabled).toBe(true)
    expect(host.textContent).not.toContain('Failed (exit 1)')

    act(() => emit({ runKey: 'rk-setup', runId: 'run-b', kind: 'setup', seq: 1, state: 'running', chunk: 'second run\n' }))
    expect(log()!.textContent).toContain('second run')
    expect(log()!.textContent).not.toContain('first run')
    expect(button('Run setup').disabled).toBe(true)
    act(() => emit({ runKey: 'rk-setup', runId: 'run-b', kind: 'setup', seq: 2, state: 'done', exitCode: 0 }))
    expect(host.textContent).toContain('Finished (exit 0)')
    expect(button('Run setup').disabled).toBe(false)
  })

  it('I3: an event stream for a runKey this panel never claimed does not surface here', async () => {
    await mountPanel(snapshotWith({ setupScript: 'make' }))
    await act(async () => {
      button('Run setup').click()
    })
    // A worktree's run for the same project, on the same channel: it carries no lane
    // discriminator, and only the ATTACHMENT (this panel claimed 'rk-setup') keeps it out.
    act(() => emit({ runKey: 'rk-worktree', runId: 'run-w', kind: 'setup', seq: 1, state: 'running', chunk: 'someone else\n' }))
    expect(log()).toBeNull()
    act(() => emit({ runKey: 'rk-setup', runId: 'run-a', kind: 'setup', seq: 1, state: 'running', chunk: 'mine\n' }))
    expect(log()!.textContent).toContain('mine')
    expect(log()!.textContent).not.toContain('someone else')
  })

  it('attaches the ACKED runKey to this project’s lane', async () => {
    await mountPanel(snapshotWith({ setupScript: 'make' }))
    await act(async () => {
      button('Run setup').click()
    })
    expect(useProjectSetup.getState().projectRunKey.p1).toBe('rk-setup')
  })

  it('drops the subscription when the pane goes away', async () => {
    await mountPanel(snapshotWith({ setupScript: 'make' }))
    await act(async () => {
      button('Run setup').click()
    })
    act(() => root.unmount())
    expect(off).toHaveBeenCalledTimes(1)
    root = createRoot(host)
  })
})
