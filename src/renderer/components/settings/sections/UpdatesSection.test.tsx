// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { E_UNSUPPORTED } from '@shared/rpc'
import { buildStubApi } from '../../../bridge/stubs'
import { UpdatesSection } from './UpdatesSection'

let root: Root, host: HTMLDivElement, mounted: boolean
const checking = vi.fn()
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function bridge(getVersion: () => Promise<string>, check: () => unknown = vi.fn()) {
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = { updates: { getVersion, check } }
}
const render = async () => { await act(async () => root.render(<UpdatesSection isActive />)) }
const button = () => host.querySelector<HTMLButtonElement>('button')!
const text = () => host.textContent ?? ''
const click = async () => { await act(async () => button().click()) }
beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div'); document.body.append(host); root = createRoot(host); mounted = true
  checking.mockClear(); window.addEventListener('nodeterm:update-checking', checking)
})
afterEach(async () => {
  if (mounted) await act(async () => root.unmount())
  host.remove(); window.removeEventListener('nodeterm:update-checking', checking)
  vi.restoreAllMocks()
})

describe('UpdatesSection capability and invocation settlement', () => {
  it('handles the real browser version refusal without faking a version or invoking its no-op check', async () => {
    const updates = buildStubApi().updates, check = vi.fn(updates.check)
    bridge(updates.getVersion, check); await render()
    expect(text()).toContain('Version and update checks are unavailable here.')
    expect(text()).not.toContain('0.0.0'); expect(text()).not.toContain('…')
    expect(button().disabled).toBe(true); await click()
    expect(check).not.toHaveBeenCalled(); expect(checking).not.toHaveBeenCalled()
  })
  it.each(['reject', 'throw'])('shows a generic version %s visibly and disables check', async kind => {
    bridge(() => { if (kind === 'throw') throw new Error('private detail'); return Promise.reject(new Error('private detail')) })
    await render()
    expect(text()).toContain('Could not read the current version.')
    expect(text()).not.toContain('private detail'); expect(button().disabled).toBe(true)
  })
  it('keeps checks disabled until the supported Desktop version read settles', async () => {
    const read = deferred<string>(), check = vi.fn()
    bridge(() => read.promise, check); await render(); expect(button().disabled).toBe(true)
    await click(); expect(check).not.toHaveBeenCalled()
    await act(async () => read.resolve('0.3.4-fixture'))
    expect(text()).toContain('0.3.4-fixture'); expect(button().disabled).toBe(false)
    await click(); expect(check).toHaveBeenCalledOnce(); expect(checking).toHaveBeenCalledOnce()
  })
  it.each(['reject', 'throw'])('catches check %s with no phantom checking event, then allows a successful invocation', async kind => {
    const check = vi.fn().mockImplementationOnce(() => {
      if (kind === 'throw') throw new Error('private check detail')
      return Promise.reject(new Error('private check detail'))
    }).mockReturnValueOnce(undefined)
    bridge(async () => '0.3.4-fixture', check); await render(); await click()
    expect(text()).toContain('Update check request failed. No update status is confirmed.')
    expect(text()).not.toContain('private check detail'); expect(text()).toContain('0.3.4-fixture')
    expect(checking).not.toHaveBeenCalled(); expect(button().disabled).toBe(false)
    await click(); expect(check).toHaveBeenCalledTimes(2); expect(checking).toHaveBeenCalledOnce()
    expect(text()).not.toContain('Update check request failed')
  })
  it('disables unsupported checks even when a real version read was available', async () => {
    const check = vi.fn().mockRejectedValue(Object.assign(new Error('unsupported'), { code: E_UNSUPPORTED }))
    bridge(async () => '0.3.4-fixture', check); await render(); await click()
    expect(text()).toContain('Update checks are unavailable here.'); expect(button().disabled).toBe(true)
    expect(checking).not.toHaveBeenCalled(); await click(); expect(check).toHaveBeenCalledOnce()
  })
  it('serializes a pending invocation and emits no checking event before successful settlement', async () => {
    const pending = deferred<void>(), check = vi.fn(() => pending.promise)
    bridge(async () => '0.3.4-fixture', check); await render(); await click(); await click()
    expect(check).toHaveBeenCalledOnce(); expect(button().disabled).toBe(true); expect(checking).not.toHaveBeenCalled()
    await act(async () => pending.resolve())
    expect(button().disabled).toBe(false); expect(checking).toHaveBeenCalledOnce()
  })
  it.each(['success', 'error'])('discards late version %s after a replacement bridge read', async kind => {
    const old = deferred<string>()
    bridge(() => old.promise); await render()
    bridge(async () => 'new-version'); await render()
    await act(async () => { if (kind === 'success') old.resolve('old-version'); else old.reject(new Error('late')) })
    expect(text()).toContain('new-version'); expect(text()).not.toContain('old-version')
    expect(text()).not.toContain('Could not read'); expect(button().disabled).toBe(false)
  })
  it.each(['success', 'error'])('consumes version %s after unmount without changing the new mounted section', async kind => {
    const old = deferred<string>()
    bridge(() => old.promise); await render(); await act(async () => root.unmount()); mounted = false
    root = createRoot(host); mounted = true; bridge(async () => 'new-mount'); await render()
    await act(async () => { if (kind === 'success') old.resolve('old-mount'); else old.reject(new Error('late')) })
    expect(text()).toContain('new-mount'); expect(text()).not.toContain('old-mount')
    expect(checking).not.toHaveBeenCalled()
  })
  it.each(['success', 'error'])('consumes check %s after unmount without emitting an updater event', async kind => {
    const pending = deferred<void>()
    bridge(async () => '0.3.4-fixture', () => pending.promise); await render(); await click()
    await act(async () => root.unmount()); mounted = false
    await act(async () => { if (kind === 'success') pending.resolve(); else pending.reject(new Error('late')) })
    expect(checking).not.toHaveBeenCalled()
  })
})
