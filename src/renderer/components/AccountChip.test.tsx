// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import type { ClaudeAccount, ObservedClaudeAccount } from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/types'
import { AccountChip, useAccountChip } from './AccountChip'
import { useAgentStatus } from '../state/agentStatus'
import { useSettings } from '../state/settings'

const SYSTEM: ObservedClaudeAccount = { configDir: '/home/me/.claude', accountId: null, known: true }
const CLAUDE_2: ObservedClaudeAccount = {
  configDir: '/home/me/.claude-2',
  accountId: null,
  known: false
}

/** The wiring under test: the hook resolves settings + the live status table, the component paints
 *  the result. Rendering them together is the only way to pin the SUBSCRIPTIONS, which is where a
 *  chip that never appears (or never updates) actually comes from. */
function Probe({
  accountId,
  observed
}: {
  accountId?: string
  observed?: ObservedClaudeAccount
}): React.JSX.Element | null {
  return <AccountChip chip={useAccountChip(accountId, observed)} />
}

function render(props: { accountId?: string; observed?: ObservedClaudeAccount }): {
  host: HTMLElement
  root: Root
} {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  act(() => {
    root.render(<Probe {...props} />)
  })
  return { host, root }
}

const chipEl = (host: HTMLElement): HTMLElement | null => host.querySelector('.node-account-chip')

const accounts: ClaudeAccount[] = [
  { id: 'a1', label: 'work@example.com', email: 'work@example.com', createdAt: 0 },
  { id: 'a2', label: 'second', configDir: '/home/me/.claude-2', createdAt: 0 }
]

beforeEach(() => {
  document.body.innerHTML = ''
  useAgentStatus.setState({ byId: {} })
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, claudeAccounts: accounts } })
  // `useSystemAccount.ensure()` fires as soon as a chip could be shown.
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = {
    usage: { fetch: async () => ({ email: 'me@example.com' }) }
  }
})

afterEach(() => {
  useAgentStatus.setState({ byId: {} })
  useSettings.setState({ settings: DEFAULT_SETTINGS })
})

describe('AccountChip (D6 visibility through the live stores)', () => {
  it('renders nothing for a system pane while it is the only identity in play', () => {
    useAgentStatus.setState({ byId: { n1: { unread: false, account: SYSTEM } } })
    const { host, root } = render({ observed: SYSTEM })
    expect(chipEl(host)).toBeNull()
    root.unmount()
  })

  it('renders nothing at all for a pane whose account is unknown', () => {
    const { host, root } = render({})
    expect(chipEl(host)).toBeNull()
    root.unmount()
  })

  it('chips the system pane once a second identity shows up on the canvas', () => {
    // The real case: `~/.claude` in one pane and `~/.claude-2` in another. Two panes on two logins
    // must never look alike, so BOTH get a chip.
    useAgentStatus.setState({
      byId: { n1: { unread: false, account: SYSTEM }, n2: { unread: false, account: CLAUDE_2 } }
    })
    const { host, root } = render({ observed: SYSTEM })
    expect(chipEl(host)?.className).toContain('node-account-chip--system')
    root.unmount()
  })

  it('names an unlinked dir by its folder, dashed, and says where to link it', () => {
    useAgentStatus.setState({ byId: { n2: { unread: false, account: CLAUDE_2 } } })
    const { host, root } = render({ observed: CLAUDE_2 })
    expect(chipEl(host)?.textContent).toBe('.claude-2')
    expect(chipEl(host)?.className).toContain('node-account-chip--unlinked')
    expect(chipEl(host)?.getAttribute('title')).toContain('Settings → Accounts')
    root.unmount()
  })

  it('chips a managed node whatever else is running', () => {
    const { host, root } = render({ accountId: 'a1' })
    expect(chipEl(host)?.textContent).toBe('work')
    expect(chipEl(host)?.className).toContain('node-account-chip--managed')
    root.unmount()
  })

  it('marks an account with a linked config dir as linked, not managed', () => {
    const { host, root } = render({ accountId: 'a2' })
    expect(chipEl(host)?.className).toContain('node-account-chip--linked')
    root.unmount()
  })

  it('follows the node’s own account over the observed one', () => {
    // Launch identity wins: the env is what it is, whatever a later observation says.
    const { host, root } = render({ accountId: 'a1', observed: CLAUDE_2 })
    expect(chipEl(host)?.textContent).toBe('work')
    root.unmount()
  })
})
