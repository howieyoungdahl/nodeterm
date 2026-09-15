// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type { ClaudeUsage } from '@shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const settingsState = {
  settings: {
    claudeAccounts: [] as unknown[],
    externalUsageProfiles: [] as unknown[],
    collapsedUsageSections: [] as string[],
    hiddenUsageProviders: [] as string[],
    usagePercentMode: 'used' as const,
    systemAccountLabel: ''
  },
  update: vi.fn()
}

vi.mock('../state/settings', () => ({ useSettings: (sel: (s: unknown) => unknown) => sel(settingsState) }))
vi.mock('../state/projects', () => ({
  useProjects: (sel: (s: unknown) => unknown) =>
    sel({ activeProjectId: 'p1', projects: [{ id: 'p1' }] })
}))
vi.mock('../state/sshConn', () => ({ useSshConn: (sel: (s: unknown) => unknown) => sel({ byProject: {} }) }))
vi.mock('../state/workspace', () => ({
  systemAccountDisplay: (_label: string, email?: string | null) => email ?? 'System account'
}))

const { UsageIndicator } = await import('./UsageIndicator')

const usage: ClaudeUsage = {
  // Back-compat mirrors of the two limits below; the panel reads `limits`, but the type keeps
  // these so older callers compile.
  session: { leftPercent: 7, resetsAt: null },
  weekly: { leftPercent: 61, resetsAt: null },
  limits: [
    {
      kind: 'session',
      group: 'session',
      usedPercent: 93,
      severity: null,
      resetsAt: null,
      windowMinutes: 300,
      scopeLabel: null,
      isActive: false
    },
    {
      kind: 'weekly_all',
      group: 'weekly',
      usedPercent: 39,
      severity: null,
      resetsAt: null,
      windowMinutes: 10_080,
      scopeLabel: null,
      isActive: false
    }
  ],
  email: 'system@example.com',
  updatedAt: Date.now(),
  status: 'ok'
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  settingsState.settings.collapsedUsageSections = []
  // One managed account, so the panel renders the per-account shape (system row + account rows).
  // Without one, Claude's limits render bare — see the external-only case below.
  settingsState.settings.claudeAccounts = [
    { id: 'acc-1', label: 'Second account', email: 'second@example.com', createdAt: 0 }
  ]
  settingsState.update.mockClear()
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = {
    usage: {
      fetch: vi.fn(async () => usage),
      onUpdate: () => () => {},
      providers: vi.fn(async () => []),
      remote: vi.fn(async () => [])
    }
  }
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

/** Open the popover (the pill's click path — hover is not available to a test). */
async function open(): Promise<void> {
  await act(async () => {
    root.render(<UsageIndicator />)
  })
  const pill = container.querySelector('.usage-pill') as HTMLButtonElement
  await act(async () => {
    pill.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

describe('UsageIndicator sections', () => {
  const heads = (): HTMLButtonElement[] =>
    [...container.querySelectorAll('.usage-section__head')] as HTMLButtonElement[]
  const click = async (el: Element): Promise<void> => {
    await act(async () => {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
  }

  it('gives every account a disclosure control over its own rows', async () => {
    await open()
    // Two accounts, two limits each — and each pair behind its own chevron.
    expect(heads()).toHaveLength(2)
    expect(container.querySelectorAll('.usage-row')).toHaveLength(4)
    expect(heads()[0].getAttribute('aria-expanded')).toBe('true')
  })

  it('collapses a section and persists the choice', async () => {
    await open()
    await click(heads()[0])
    // Written to settings rather than held in component state, so it survives a reload. The
    // key is namespaced — a bare account id could collide with a provider's.
    expect(settingsState.update).toHaveBeenCalledWith({ collapsedUsageSections: ['claude:system'] })
  })

  it('shows the reading it is hiding while collapsed', async () => {
    // A collapsed section must not hide an exhausted window behind a chevron.
    settingsState.settings.collapsedUsageSections = ['claude:system']
    await open()
    expect(heads()[0].getAttribute('aria-expanded')).toBe('false')
    expect(container.querySelector('.usage-section__summary')?.textContent).toBe('93% 5h')
    // Only the collapsed section is folded; the other account keeps its rows.
    expect(container.querySelectorAll('.usage-row')).toHaveLength(2)
  })

  it('expands again on a second click', async () => {
    settingsState.settings.collapsedUsageSections = ['claude:system']
    await open()
    await click(heads()[0])
    expect(settingsState.update).toHaveBeenCalledWith({ collapsedUsageSections: [] })
  })

  it('renders an external profile as a read-only row', async () => {
    settingsState.settings.externalUsageProfiles = [
      { provider: 'claude', dir: '/home/tester/.claude-2', label: 'Second profile' }
    ]
    await open()
    const labels = [...container.querySelectorAll('.usage-section__label')].map((n) => n.textContent)
    expect(labels).toContain('Second profile')
    // Marked as a profile, and — crucially — offering no "use for new sessions", because this
    // directory is not a home nodeterm minted and cannot launch into.
    expect(container.querySelector('.usage-account__host')?.textContent).toBe('profile')
    expect(container.querySelector('.usage-account__use')).toBeNull()
  })

  it('renders an external profile even with NO managed accounts', async () => {
    // This is the shape a user whose Claude only lives in a second profile actually has. The
    // external rows must not be nested inside the managed-account branch, or they vanish for
    // exactly the person who needs them.
    settingsState.settings.claudeAccounts = []
    settingsState.settings.externalUsageProfiles = [
      { provider: 'claude', dir: '/home/tester/.claude-2', label: 'Second profile' }
    ]
    await open()
    const labels = [...container.querySelectorAll('.usage-section__label')].map((n) => n.textContent)
    expect(labels).toContain('Second profile')
  })

  it('still renders the pill when an external profile is the only source', async () => {
    // Otherwise there is nothing to click, and no way to reach the panel holding the numbers.
    settingsState.settings.claudeAccounts = []
    settingsState.settings.externalUsageProfiles = [
      { provider: 'claude', dir: '/home/tester/.claude-2', label: 'Second profile' }
    ]
    ;(window as unknown as { nodeTerminal: { usage: { fetch: unknown } } }).nodeTerminal.usage.fetch =
      vi.fn(async () => ({ ...usage, status: 'unavailable', limits: [] }))
    await act(async () => {
      root.render(<UsageIndicator />)
    })
    expect(container.querySelector('.usage-pill')).not.toBeNull()
  })
})
