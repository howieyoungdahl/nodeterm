import http from 'node:http'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createOpsApiHandler, isLoopbackPeer } from './ops-api'
import { SpawnHandlerState } from './spawn-handler-state'

describe('/opsapi', () => {
  let server: http.Server
  let base = ''
  let now = 1_000
  let spawn: SpawnHandlerState

  beforeEach(async () => {
    spawn = new SpawnHandlerState({ now: () => now, wedgeAfterMs: 100 })
    const handler = createOpsApiHandler({
      token: 'ops-secret',
      nodes: async () => [],
      sweep: async (dryRun) => ({ dryRun, affectedIds: ['dead-a'], scanned: 2 }),
      remove: async (id, force) => ({ ok: true, removedIds: [id], forced: force }),
      health: () => ({
        startedAt: 500,
        uptimeMs: now - 500,
        wsClientCount: 2,
        canvasControlEnabled: true,
        spawnHandler: spawn.snapshot(),
        deliveryQueueDepths: { 'node-b': 3 },
        projects: [{ id: 'p1', nodeCount: 2 }]
      })
    })
    server = http.createServer((req, res) => void handler(req, res))
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  })

  afterEach(async () => new Promise<void>((resolve) => server.close(() => resolve())))

  const auth = { authorization: 'Bearer ops-secret' }

  it('recognizes only real loopback TCP peers', () => {
    expect(isLoopbackPeer('127.0.0.1')).toBe(true)
    expect(isLoopbackPeer('127.23.4.5')).toBe(true)
    expect(isLoopbackPeer('::ffff:127.0.0.1')).toBe(true)
    expect(isLoopbackPeer('::1')).toBe(true)
    expect(isLoopbackPeer('10.0.0.1')).toBe(false)
    expect(isLoopbackPeer('::ffff:10.0.0.1')).toBe(false)
    expect(isLoopbackPeer(undefined)).toBe(false)
  })

  it('requires its bearer token and does not accept the browser session cookie', async () => {
    expect((await fetch(`${base}/opsapi/nodes`)).status).toBe(401)
    expect(
      (await fetch(`${base}/opsapi/nodes`, { headers: { cookie: 'nt_session=anything' } })).status
    ).toBe(401)
    expect(
      (await fetch(`${base}/opsapi/nodes`, { headers: { authorization: 'Bearer wrong' } })).status
    ).toBe(401)
    expect((await fetch(`${base}/opsapi/nodes`, { headers: auth })).status).toBe(200)
  })

  it('validates the sweep payload and returns affected ids', async () => {
    const bad = await fetch(`${base}/opsapi/sweep`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: '{}'
    })
    expect(bad.status).toBe(400)

    const good = await fetch(`${base}/opsapi/sweep`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ dryRun: true })
    })
    expect(good.status).toBe(200)
    expect(await good.json()).toEqual({ dryRun: true, affectedIds: ['dead-a'], scanned: 2 })
  })

  it('passes the explicit force gate to one-card deletion', async () => {
    const plain = await fetch(`${base}/opsapi/nodes/live-a`, { method: 'DELETE', headers: auth })
    expect(await plain.json()).toMatchObject({ removedIds: ['live-a'], forced: false })
    const force = await fetch(`${base}/opsapi/nodes/live-b?force=1`, {
      method: 'DELETE',
      headers: auth
    })
    expect(await force.json()).toMatchObject({ removedIds: ['live-b'], forced: true })
  })

  it('health exposes an artificially wedged spawn handler', async () => {
    const ticket = spawn.enqueue('open-agent')
    ticket.start()
    now += 101
    const res = await fetch(`${base}/opsapi/health`, { headers: auth })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      wsClientCount: 2,
      canvasControlEnabled: true,
      spawnHandler: { state: 'wedged', operation: 'open-agent', activeForMs: 101 },
      deliveryQueueDepths: { 'node-b': 3 },
      projects: [{ id: 'p1', nodeCount: 2 }]
    })
  })
})
