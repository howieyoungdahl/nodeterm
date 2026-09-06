import { describe, it, expect } from 'vitest'
import { registerCanvasLayoutIpc } from '../../src/core/canvas-layout/service'
import { LayoutLeaseStore } from '../../src/core/canvas-layout/lease'
import { fakePlatform } from '../../src/core/platform-fake'
import { initPlatform, resetPlatformForTests } from '../../src/core/platform'
import { buildAgentApi, type RpcClient } from '../../src/renderer/bridge/ws-bridge'
import { rmSync } from 'node:fs'
import type { LayoutPlanRequest } from '../../src/shared/canvas-layout'
function request(over: Partial<LayoutPlanRequest> = {}): LayoutPlanRequest {
  return {
    projectId: 'p1',
    trigger: 'organize',
    nodes: [],
    sizes: { compact: { width: 440, height: 320 }, normal: { width: 640, height: 440 } },
    holder: 'ui-a',
    ...over
  }
}

function lease(): LayoutLeaseStore {
  let file: string | null = null
  return new LayoutLeaseStore({
    read: () => file,
    write: async (text) => {
      file = text
    },
    now: () => 1_000
  })
}

const ON = { settings: () => ({ enabled: true }) }

  it('the browser IPC release cannot cancel a newer token for the same holder', async () => {
    const fake = fakePlatform(), shared = lease()
    initPlatform(fake)
    try {
      registerCanvasLayoutIpc({ ...ON, lease: shared })
      const api = buildAgentApi({ request: async (channel: string, ...args: unknown[]) =>
        fake.handlers[channel](...JSON.parse(JSON.stringify(args))) } as RpcClient).canvasLayout
      // Acquire fixture grants directly; the public plan route now requires coordinator and
      // trusted evidence. This test isolates the actual release transport, not planning authority.
      const first = await shared.acquire('p1', 'ui-a'), second = await shared.acquire('p1', 'ui-a')
      if (!first.ok || !second.ok) throw new Error('Fixture lease acquisition failed')
      const old = { leaseToken: first.lease.token }, newer = { leaseToken: second.lease.token }
      expect(await api.release('p1', 'ui-a', old.leaseToken)).toBe(false)
      expect(await api.release('p1', 'ui-a')).toBe(false)
      expect(shared.holder('p1')?.token).toBe(newer.leaseToken)
      expect(await api.release('p1', 'ui-a', newer.leaseToken)).toBe(true)
      expect(shared.holder('p1')).toBeNull()
    } finally {
      resetPlatformForTests()
      rmSync(fake.userDataDir, { recursive: true, force: true })
    }
  })
