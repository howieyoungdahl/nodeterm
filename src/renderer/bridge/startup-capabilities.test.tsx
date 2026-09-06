// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { buildStubApi } from './stubs'
import type { NodeTerminalApi } from '@shared/types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

beforeEach(() => {
  vi.resetModules()
  window.nodeTerminal = buildStubApi() as NodeTerminalApi
})
afterEach(() => { vi.restoreAllMocks() })

describe('browser startup capability reads', () => {
  it('keeps real browser routes refusing while hydration records unavailable, not entitlement', async () => {
    await expect(window.nodeTerminal.license.getStatus()).rejects.toMatchObject({ code: 'E_UNSUPPORTED' })
    await expect(window.nodeTerminal.ssh.list()).rejects.toMatchObject({ code: 'E_UNSUPPORTED' })
    const { useEntitlement } = await import('../state/entitlement')
    const { useSshServers } = await import('../state/sshServers')
    await expect(useEntitlement.getState().hydrate()).resolves.toBeUndefined()
    await expect(useSshServers.getState().hydrate()).resolves.toBeUndefined()
    expect(useEntitlement.getState()).toMatchObject({ isPremium: false, seats: 0, detail: null,
      readError: 'License management is unavailable in this browser build.' })
    expect(useSshServers.getState()).toMatchObject({ servers: [],
      readError: 'Saved SSH server management is unavailable in this browser build.' })
  })

  it('preserves last good data on read failure and clears the warning only after a successful read', async () => {
    const { useEntitlement } = await import('../state/entitlement')
    const { useSshServers } = await import('../state/sshServers')
    const status = { tier: 'pro', active: true, seats: 3, expiresAt: null, error: null }
    const servers = [{ id: 'saved', label: 'Existing', user: 'dev', host: 'host.example', port: 22 }]
    const license = vi.spyOn(window.nodeTerminal.license, 'getStatus').mockResolvedValue(status)
    const ssh = vi.spyOn(window.nodeTerminal.ssh, 'list').mockResolvedValue(servers)
    await useEntitlement.getState().hydrate(); await useSshServers.getState().hydrate()
    license.mockRejectedValue(new Error('transport closed'))
    ssh.mockRejectedValue(new Error('transport closed'))
    await useEntitlement.getState().hydrate(); await useSshServers.getState().hydrate()
    expect(useEntitlement.getState().status).toEqual(status)
    expect(useEntitlement.getState().readError).toContain('has not been verified')
    expect(useSshServers.getState().servers).toEqual(servers)
    expect(useSshServers.getState().readError).toBe('Saved SSH servers could not be read.')
    license.mockResolvedValue(status); ssh.mockResolvedValue(servers)
    await useEntitlement.getState().hydrate(); await useSshServers.getState().hydrate()
    expect(useEntitlement.getState().readError).toBeNull()
    expect(useSshServers.getState().readError).toBeNull()
  })

  it('renders unavailable without purchase, activation or add-server actions', async () => {
    const { useEntitlement } = await import('../state/entitlement')
    const { useSshServers } = await import('../state/sshServers')
    await useEntitlement.getState().hydrate(); await useSshServers.getState().hydrate()
    const { LicenseSection } = await import('../components/settings/sections/LicenseSection')
    const { RemotePicker } = await import('../components/RemotePicker')
    const host = document.createElement('div'); document.body.appendChild(host)
    const root = createRoot(host)
    try {
      await act(async () => root.render(<><LicenseSection isActive /><RemotePicker x={0} y={0}
        onPick={vi.fn()} onManage={vi.fn()} onClose={vi.fn()} /></>))
      expect(document.body.textContent).toContain('License management is unavailable')
      expect(document.body.textContent).toContain('Saved SSH server management is unavailable')
      expect(document.body.textContent).not.toContain('Add SSH server')
      expect(document.body.textContent).not.toContain('Pro — active')
      expect(document.body.querySelector('input')).toBeNull()
      expect(document.body.querySelector('button')).toBeNull()
    } finally { await act(async () => root.unmount()); host.remove() }
  })
})
