// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { WorkspaceStore } from '../../src/core/workspace-store'
import { fakePlatform } from '../../src/core/platform-fake'
import { initPlatform, resetPlatformForTests } from '../../src/core/platform'
import { buildRealApi, type RpcClient } from '../../src/renderer/bridge/ws-bridge'
import { useProjectSettings, type ProjectSettingsHook } from '../../src/renderer/components/settings/useProjectSettings'
import type { NodeTerminalApi } from '../../src/shared/types'
import type { LocalSettingsRequest } from '../../src/shared/local-settings-reconciliation'
import { IPC } from '../../src/shared/ipc'
const h = vi.hoisted(() => ({ exposed: {} as Record<string, unknown>, invoke: vi.fn() }))
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld: (key: string, value: unknown) => { h.exposed[key] = value } },
  ipcRenderer: { invoke: h.invoke, on: vi.fn(), send: vi.fn(), removeListener: vi.fn() }, webUtils: { getPathForFile: vi.fn() } }))
import '../../src/preload/index'

;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
let dir: string, root: Root | undefined, host: HTMLElement, hook: ProjectSettingsHook
let browser: NodeTerminalApi['projectSettings'], calls: Array<{ channel: string; args: any[] }>
let reads: Promise<unknown>[]
beforeEach(async () => {
  sessionStorage.clear(); calls = []; reads = []; dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-local-consumer-'))
  const fake = fakePlatform({ userDataDir: dir }); initPlatform(fake)
  await fs.writeFile(path.join(dir, 'workspace.json'), JSON.stringify({ version: 3, activeProjectId: 'p1', future: 8,
    entries: [{ id: 'p1', dataFile: true, name: 'One', localSettings: { terminal: { theme: 'old' } } },
      { id: 'p2', dataFile: true, name: 'Two' }] }))
  new WorkspaceStore().registerIpc()
  const dispatch = async (channel: string, ...args: any[]) => {
    calls.push({ channel, args: JSON.parse(JSON.stringify(args)) })
    const result = Promise.resolve(fake.handlers[channel](...JSON.parse(JSON.stringify(args))))
    if (channel === IPC.projectSettingsRead) reads.push(result.catch(() => undefined))
    return JSON.parse(JSON.stringify(await result))
  }
  h.invoke.mockImplementation(dispatch)
  browser = buildRealApi({ request: dispatch } as RpcClient).projectSettings
  ;(window as any).nodeTerminal = { projectSettings: browser }
  host = document.createElement('div'); document.body.appendChild(host)
})
afterEach(async () => {
  if (root) await act(async () => root!.unmount()); root = undefined; host.remove()
  sessionStorage.clear(); resetPlatformForTests(); vi.restoreAllMocks()
  await fs.rm(dir, { recursive: true, force: true })
})
function Probe({ id = 'p1' }: { id?: string }) {
  hook = useProjectSettings(id)
  return createElement('div', null, hook.localError ?? 'ready')
}
async function mount(id = 'p1') {
  root ??= createRoot(host)
  await act(async () => { root!.render(createElement(Probe, { id })) })
  await act(async () => { await Promise.all(reads) })
  expect(hook.snapshot).not.toBe('loading')
}
const disk = () => fs.readFile(path.join(dir, 'workspace.json'), 'utf8')

it.each(['browser', 'desktop'])('%s bridge carries exact read binding, delta and typed result through registered core', async (shell) => {
  const api = shell === 'browser' ? browser : (h.exposed.nodeTerminal as NodeTerminalApi).projectSettings
  const snap = await api.read('p1')
  const request: LocalSettingsRequest = { ...snap!.localBase!, projectId: 'p1', operationId: 'toggle', changes: [{ family: 'ignoreShared', key: 'terminal', value: true }] }
  const result = await api.updateLocal('p1', request)
  expect(result.kind).toBe('committed'); expect(result.current?.local?.ignoreShared?.terminal).toBe(true)
  expect(calls).toEqual([{ channel: IPC.projectSettingsRead, args: ['p1'] }, { channel: IPC.projectSettingsUpdateLocalReconciled, args: ['p1', request] }])
  expect(JSON.parse(await disk()).future).toBe(8)
})

it('mounted hook retains actual lost ACK through remount, and retries the identical request without a second publication', async () => {
  await mount()
  const real = browser.updateLocal
  browser.updateLocal = vi.fn(async (id, request) => { const result = await real(id, request); browser.updateLocal = real; throw new Error(`lost ${result.kind} response`) })
  await act(async () => { expect(await hook.saveLocal((local) => ({ ...local, ignoreShared: { terminal: true } }))).toBe(false) })
  const before = await disk(), retained = sessionStorage.getItem('nodeterm.local-settings.intent.p1')
  expect(retained).toContain('operationId'); expect(host.textContent).toContain('retained')
  await act(async () => root!.unmount()); root = undefined; await mount()
  expect(calls.filter((call) => call.channel === IPC.projectSettingsUpdateLocalReconciled)).toHaveLength(1)
  await act(async () => { expect(await hook.retryLocal()).toBe(true) })
  const writes = calls.filter((call) => call.channel === IPC.projectSettingsUpdateLocalReconciled)
  expect(writes[1].args).toEqual(writes[0].args)
  expect(await disk()).toBe(before); expect(hook.localError).toBeNull()
  expect(sessionStorage.getItem('nodeterm.local-settings.intent.p1')).toBeNull()
})

it('partial response, rejected IPC and failed refresh retain the last good projection and pending request', async () => {
  await mount(); const first = hook.snapshot, real = browser.updateLocal
  browser.updateLocal = vi.fn(async (_id, request) => ({ kind: 'committed', operationId: request.operationId } as any))
  await act(async () => { expect(await hook.saveLocal((local) => ({ ...local, terminal: { theme: 'new' } }))).toBe(false) })
  const intent = sessionStorage.getItem('nodeterm.local-settings.intent.p1')
  browser.updateLocal = vi.fn(async () => { throw new Error('disconnected') })
  await act(async () => { expect(await hook.retryLocal()).toBe(false) })
  browser.read = vi.fn(async () => { throw new Error('busy') })
  await act(async () => { hook.reload() })
  expect(hook.snapshot).toEqual(first); expect(hook.localError).toContain('retained')
  expect(sessionStorage.getItem('nodeterm.local-settings.intent.p1')).toBe(intent)
  await act(async () => { expect(await hook.saveLocal(() => undefined)).toBe(false) })
  expect(sessionStorage.getItem('nodeterm.local-settings.intent.p1')).toBe(intent)
  browser.updateLocal = real
})

it('two rapid edits serialize on actual fresh acknowledgments and do not delete the first leaf', async () => {
  await mount()
  await act(async () => {
    const one = hook.saveLocal((local) => ({ ...local, terminal: { ...local?.terminal, fontFamily: 'monospace' } }))
    const two = hook.saveLocal((local) => ({ ...local, ignoreShared: { terminal: true } }))
    expect(await one).toBe(true); expect(await two).toBe(true)
  })
  expect(JSON.parse(await disk()).entries[0].localSettings).toEqual({ terminal: { theme: 'old', fontFamily: 'monospace' }, ignoreShared: { terminal: true } })
  const writes = calls.filter((call) => call.channel === IPC.projectSettingsUpdateLocalReconciled)
  expect(writes[0].args[1].indexRevision).not.toBe(writes[1].args[1].indexRevision)
  expect(writes[1].args[1].changes).toEqual([{ family: 'ignoreShared', key: 'terminal', value: true }])
})

it('switching projects never submits another project\'s retained edit', async () => {
  await mount(); const real = browser.updateLocal
  browser.updateLocal = vi.fn(async () => { throw new Error('lost') })
  await act(async () => { expect(await hook.saveLocal((local) => ({ ...local, ignoreShared: { terminal: true } }))).toBe(false) })
  const intent = sessionStorage.getItem('nodeterm.local-settings.intent.p1')
  browser.updateLocal = real
  await mount('p2')
  await act(async () => { expect(await hook.retryLocal()).toBe(false) })
  await act(async () => { expect(await hook.saveLocal(() => ({ ignoreShared: { terminal: true } }))).toBe(true) })
  expect(sessionStorage.getItem('nodeterm.local-settings.intent.p1')).toBe(intent)
  expect(JSON.parse(await disk()).entries[0].localSettings).toEqual({ terminal: { theme: 'old' } })
})
