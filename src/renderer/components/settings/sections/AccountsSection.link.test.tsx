// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import { AccountsSection } from './AccountsSection'
import { useAgentStatus } from '../../../state/agentStatus'
import { useSettings } from '../../../state/settings'
import { DEFAULT_SETTINGS, type ClaudeAccount, type ObservedClaudeAccount } from '@shared/types'

const CLAUDE_2 = '/home/me/.claude-2'
const observed = (over: Partial<ObservedClaudeAccount> = {}): ObservedClaudeAccount => ({
  configDir: CLAUDE_2,
  accountId: null,
  known: false,
  ...over
})

/** The one call this suite is about; each test swaps in its own behaviour. The default stands in
 *  for core: it expands `~` and answers with the NORMALIZED path, which is what gets stored. */
let link = vi.fn(async (configDir: string) => ({
  id: 'linked-1',
  configDir: configDir.replace('~', '/home/me'),
  email: 'second@example.com' as string | null
}))
let selectFolder = vi.fn(async () => null as string | null)

function renderSection(accounts: ClaudeAccount[] = []): { host: HTMLElement; root: Root } {
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, claudeAccounts: accounts } })
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  act(() => {
    root.render(<AccountsSection isActive />)
  })
  return { host, root }
}

const byLabel = (host: HTMLElement, label: string): HTMLButtonElement | undefined =>
  Array.from(host.querySelectorAll('button')).find((b) => b.getAttribute('aria-label') === label) as
    | HTMLButtonElement
    | undefined

const pathInput = (host: HTMLElement): HTMLInputElement =>
  host.querySelector('input[placeholder="~/.claude-2"]') as HTMLInputElement

/** Type into a controlled React input (the native setter, or React never sees the change). */
function type(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!
  act(() => {
    setter.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const linkedAccounts = (): ClaudeAccount[] => useSettings.getState().settings.claudeAccounts

beforeEach(() => {
  // Every `applyAccounts` schedules the settings store's 300 ms coalesced save, and that timer
  // reaches for `window` when it fires. Under real timers it can land AFTER vitest tore this
  // file's jsdom down — an unhandled "window is not defined" that fails the whole run, including
  // whatever file happened to share the worker. Faking only setTimeout keeps the timer from ever
  // firing while leaving React's microtask scheduling alone.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  document.body.innerHTML = ''
  useAgentStatus.setState({ byId: {} })
  link = vi.fn(async (configDir: string) => ({
    id: 'linked-1',
    configDir: configDir.replace('~', '/home/me'),
    email: 'second@example.com' as string | null
  }))
  selectFolder = vi.fn(async () => null as string | null)
  // The section also mounts the Codex panel, which hydrates the SSH server list and the system
  // identities on mount — stubbed so those effects resolve instead of throwing on an absent bridge
  // member (a throw takes the whole section down with it, this row included). `settings.save`
  // catches the coalesced 300 ms write every `update()` schedules.
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = {
    usage: { fetch: async () => null },
    ssh: { list: async () => [] },
    codexAccounts: { systemIdentity: async () => null, identity: async () => null },
    claudeAccounts: { link: (dir: string) => link(dir) },
    dialog: { selectFolder: () => selectFolder() },
    settings: { save: async () => {} }
  }
})

afterEach(() => {
  vi.useRealTimers()
  useSettings.setState({ settings: DEFAULT_SETTINGS })
  useAgentStatus.setState({ byId: {} })
})

describe('AccountsSection — link an existing config dir', () => {
  it('links the typed path and adopts the captured email as the label', async () => {
    const { host, root } = renderSection()
    type(pathInput(host), '~/.claude-2')
    await act(async () => {
      byLabel(host, 'Link config dir')!.click()
    })
    // `~` expansion belongs to core (it owns the files' machine), so the raw text is what we send.
    expect(link).toHaveBeenCalledWith('~/.claude-2')
    expect(linkedAccounts()).toHaveLength(1)
    expect(linkedAccounts()[0]).toMatchObject({
      id: 'linked-1',
      label: 'second@example.com',
      email: 'second@example.com',
      // The NORMALIZED path core answered with, not the typed text — the jail matches on this one.
      configDir: CLAUDE_2
    })
    root.unmount()
  })

  it('names a not-yet-signed-in dir by its folder rather than leaving it blank', async () => {
    link = vi.fn(async (configDir: string) => ({ id: 'linked-2', configDir, email: null }))
    const { host, root } = renderSection()
    type(pathInput(host), CLAUDE_2)
    await act(async () => {
      byLabel(host, 'Link config dir')!.click()
    })
    expect(linkedAccounts()[0]).toMatchObject({ label: '.claude-2', configDir: CLAUDE_2 })
    expect(linkedAccounts()[0].email).toBeUndefined()
    root.unmount()
  })

  it('shows the refusal core gave, not a generic failure', async () => {
    // `link` refuses for specific, fixable reasons ("that is the system account", "already
    // linked"); replacing them with "could not link" would leave the user with nothing to do.
    link = vi.fn(async () => {
      throw new Error('That is the system account (~/.claude)')
    })
    const { host, root } = renderSection()
    type(pathInput(host), '~/.claude')
    await act(async () => {
      byLabel(host, 'Link config dir')!.click()
    })
    expect(host.textContent).toContain('That is the system account (~/.claude)')
    expect(linkedAccounts()).toHaveLength(0)
    root.unmount()
  })

  it('fills the path from the folder picker', async () => {
    selectFolder = vi.fn(async () => CLAUDE_2)
    const { host, root } = renderSection()
    await act(async () => {
      Array.from(host.querySelectorAll('button'))
        .find((b) => b.textContent === 'Browse…')!
        .click()
    })
    expect(pathInput(host).value).toBe(CLAUDE_2)
    root.unmount()
  })

  it('hides Browse on a surface whose bridge has no folder picker', async () => {
    // Same fail-closed shape the Add buttons use: E_UNSUPPORTED is a fact about the SURFACE, and
    // typing the path still works — Browse is a convenience, never the only way in.
    selectFolder = vi.fn(async () => {
      throw Object.assign(new Error('unsupported'), { code: 'E_UNSUPPORTED' })
    })
    const { host, root } = renderSection()
    await act(async () => {
      Array.from(host.querySelectorAll('button'))
        .find((b) => b.textContent === 'Browse…')!
        .click()
    })
    expect(Array.from(host.querySelectorAll('button')).some((b) => b.textContent === 'Browse…')).toBe(false)
    root.unmount()
  })
})

describe('AccountsSection — detected config dirs', () => {
  it('lists a dir seen running that has no account, and links it in one click', async () => {
    useAgentStatus.setState({ byId: { n1: { unread: false, account: observed() } } })
    const { host, root } = renderSection()
    expect(host.textContent).toContain('Detected config dirs')
    await act(async () => {
      byLabel(host, `Link ${CLAUDE_2}`)!.click()
    })
    expect(link).toHaveBeenCalledWith(CLAUDE_2)
    expect(linkedAccounts()[0]).toMatchObject({ configDir: CLAUDE_2 })
    root.unmount()
  })

  it('renders nothing when every observed dir is already known', () => {
    useAgentStatus.setState({
      byId: {
        n1: { unread: false, account: observed({ known: true, accountId: null }) }, // the system one
        n2: { unread: false, account: observed({ configDir: '/x/.claude-9' }) }
      }
    })
    // …and an already-linked dir is not offered a second time.
    const { host, root } = renderSection([
      { id: 'a9', label: 'nine', configDir: '/x/.claude-9', createdAt: 0 }
    ])
    expect(host.textContent).not.toContain('Detected config dirs')
    root.unmount()
  })
})

describe('AccountsSection — a linked account is unlinked, never deleted', () => {
  const linked: ClaudeAccount = {
    id: 'a1',
    label: 'second',
    email: 'second@example.com',
    configDir: CLAUDE_2,
    createdAt: 0
  }

  it('shows the Linked provenance pill with the path in its tooltip', () => {
    const { host, root } = renderSection([linked])
    const pill = Array.from(host.querySelectorAll('span')).find((el) => el.textContent === 'Linked')
    expect(pill).toBeTruthy()
    expect(pill!.getAttribute('title')).toContain(CLAUDE_2)
    root.unmount()
  })

  it('offers Unlink — and says the folder is kept', () => {
    const { host, root } = renderSection([linked])
    expect(byLabel(host, 'Unlink account')).toBeTruthy()
    expect(byLabel(host, 'Remove account')).toBeUndefined()
    act(() => {
      byLabel(host, 'Unlink account')!.click()
    })
    // The confirm must not promise a deletion that core will not do (it refuses to rm anything
    // outside its own managed dirs) — that wording is what stops people unlinking at all.
    expect(document.body.textContent).toContain(`the folder ${CLAUDE_2} keeps its login`)
    expect(document.body.textContent).not.toContain('will be deleted')
    root.unmount()
  })

  it('keeps the destructive wording for a MANAGED account', () => {
    const { host, root } = renderSection([{ id: 'm1', label: 'managed', createdAt: 0 }])
    act(() => {
      byLabel(host, 'Remove account')!.click()
    })
    expect(document.body.textContent).toContain('will be deleted')
    root.unmount()
  })
})
