import http from 'node:http'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { OpsAdoptResult, OpsCreateInput, OpsCreateResult, OpsUpdateInput, OpsUpdateResult } from './node-ops'
import { createOpsApiHandler, isLoopbackPeer } from './ops-api'
import { SpawnHandlerState } from './spawn-handler-state'

describe('/opsapi', () => {
  let server: http.Server
  let base = ''
  let now = 1_000
  let spawn: SpawnHandlerState
  let adoptResult: OpsAdoptResult
  let adoptCalls = 0
  let sweepForce: boolean | undefined
  let createCalls: OpsCreateInput[]
  let createResult: OpsCreateResult
  let updateCalls: Array<{ nodeId: string; input: OpsUpdateInput; force: boolean }>
  let updateResult: OpsUpdateResult

  beforeEach(async () => {
    adoptCalls = 0
    sweepForce = undefined
    adoptResult = { adopted: [], skipped: [], live: true }
    createCalls = []
    createResult = { ok: true, id: 'term-abc', projectId: 'p1', title: 'Operator term-abc', tmuxSession: 'nt-term-abc' }
    updateCalls = []
    updateResult = { ok: true, id: 'term-abc', title: 'renamed', size: { width: 640, height: 440 } }
    spawn = new SpawnHandlerState({ now: () => now, wedgeAfterMs: 100 })
    const handler = createOpsApiHandler({
      token: 'ops-secret',
      nodes: async () => [],
      sweep: async (dryRun, force) => {
        sweepForce = force
        return { dryRun, affectedIds: ['dead-a'], scanned: 2 }
      },
      remove: async (id, force) => ({ ok: true, removedIds: [id], forced: force }),
      adoptOrphans: async () => {
        adoptCalls += 1
        return adoptResult
      },
      createNode: async (input) => {
        createCalls.push(input)
        return createResult
      },
      updateNode: async (nodeId, input, force) => {
        updateCalls.push({ nodeId, input, force })
        return updateResult
      },
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

  it('defaults the sweep force gate to false and passes an explicit one through', async () => {
    const plain = await fetch(`${base}/opsapi/sweep`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ dryRun: false })
    })
    expect(plain.status).toBe(200)
    expect(sweepForce).toBe(false)

    const forced = await fetch(`${base}/opsapi/sweep`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ dryRun: false, force: true })
    })
    expect(forced.status).toBe(200)
    expect(sweepForce).toBe(true)

    const bad = await fetch(`${base}/opsapi/sweep`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ dryRun: false, force: '1' })
    })
    expect(bad.status).toBe(400)
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

  it('adopts orphans on POST only, under the same bearer as the sweep', async () => {
    adoptResult = {
      adopted: [
        {
          id: 'term-abc',
          projectId: 'p1',
          projectName: 'repo',
          title: 'Terminal (recovered)',
          sessionName: 'nt-term-abc'
        }
      ],
      skipped: [{ id: 'term-x', sessionName: 'nt-term-x', cwd: '/elsewhere', reason: 'unmatched-cwd' }],
      live: true
    }
    expect((await fetch(`${base}/opsapi/adopt-orphans`, { method: 'POST' })).status).toBe(401)
    expect(adoptCalls).toBe(0)

    const wrongMethod = await fetch(`${base}/opsapi/adopt-orphans`, { headers: auth })
    expect(wrongMethod.status).toBe(405)
    expect(wrongMethod.headers.get('allow')).toBe('POST')
    expect(adoptCalls).toBe(0)

    const res = await fetch(`${base}/opsapi/adopt-orphans`, { method: 'POST', headers: auth })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ...adoptResult })
    expect(adoptCalls).toBe(1)
  })

  // A caller that sees `live:false` must be told to reload, or it reports a repair the operator
  // cannot see and goes looking for a second bug.
  it('tells the caller to reload when no live insertion happened', async () => {
    adoptResult = {
      adopted: [
        { id: 'term-abc', projectId: 'p1', projectName: 'repo', title: 'T', sessionName: 'nt-term-abc' }
      ],
      skipped: [],
      live: false
    }
    const res = await fetch(`${base}/opsapi/adopt-orphans`, { method: 'POST', headers: auth })
    expect(await res.json()).toMatchObject({ note: expect.stringContaining('reload') })
  })

  it('requires auth and application/json for node creation', async () => {
    expect(
      (
        await fetch(`${base}/opsapi/nodes`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}'
        })
      ).status
    ).toBe(401)
    expect(createCalls).toHaveLength(0)

    expect(
      (await fetch(`${base}/opsapi/nodes`, { method: 'POST', headers: auth, body: '{}' })).status
    ).toBe(415)
  })

  it('rejects an unknown field, an out-of-range size, a relative cwd and NUL bytes', async () => {
    const post = (body: unknown) =>
      fetch(`${base}/opsapi/nodes`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify(body)
      })

    expect((await post({ nope: 1 })).status).toBe(400)
    expect((await post({ width: 1 })).status).toBe(400)
    expect((await post({ width: 99999 })).status).toBe(400)
    expect((await post({ width: 300.5 })).status).toBe(400)
    expect((await post({ cwd: 'relative/path' })).status).toBe(400)
    expect((await post({ title: `bad${'\u0000'}title` })).status).toBe(400)
    expect((await post({ title: 'x'.repeat(500) })).status).toBe(400)
    expect(createCalls).toHaveLength(0)
  })

  it('passes a valid create body through and returns 201 with the created shape', async () => {
    const res = await fetch(`${base}/opsapi/nodes`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId: 'p1',
        cmd: 'echo hi',
        cwd: '/tmp',
        title: 'My Terminal',
        width: 700,
        height: 500
      })
    })
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({
      id: 'term-abc',
      projectId: 'p1',
      title: 'Operator term-abc',
      tmuxSession: 'nt-term-abc'
    })
    expect(createCalls).toEqual([
      { projectId: 'p1', cmd: 'echo hi', cwd: '/tmp', title: 'My Terminal', width: 700, height: 500 }
    ])
  })

  it('maps a create failure to its status/error shape', async () => {
    createResult = { ok: false, status: 400, error: 'unknown_project_id: no project "nope"' }
    const res = await fetch(`${base}/opsapi/nodes`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'nope' })
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'unknown_project_id: no project "nope"' })
  })

  it('forwards the persisted id/tmuxSession on a 502 create failure', async () => {
    createResult = {
      ok: false,
      status: 502,
      error: 'pty_command_failed: node term-abc was persisted...',
      id: 'term-abc',
      tmuxSession: 'nt-term-abc'
    }
    const res = await fetch(`${base}/opsapi/nodes`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({})
    })
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({
      error: 'pty_command_failed: node term-abc was persisted...',
      id: 'term-abc',
      tmuxSession: 'nt-term-abc'
    })
  })

  it('requires a bearer token on POST and PATCH, and rejects a wrong one', async () => {
    const noAuth = await fetch(`${base}/opsapi/nodes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}'
    })
    expect(noAuth.status).toBe(401)
    const wrongAuth = await fetch(`${base}/opsapi/nodes`, {
      method: 'POST',
      headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' },
      body: '{}'
    })
    expect(wrongAuth.status).toBe(401)
    expect(createCalls).toHaveLength(0)

    const patchNoAuth = await fetch(`${base}/opsapi/nodes/term-abc`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'x' })
    })
    expect(patchNoAuth.status).toBe(401)
    const patchWrongAuth = await fetch(`${base}/opsapi/nodes/term-abc`, {
      method: 'PATCH',
      headers: { authorization: 'Bearer wrong', 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'x' })
    })
    expect(patchWrongAuth.status).toBe(401)
    expect(updateCalls).toHaveLength(0)
  })

  it('PATCH renames/resizes and forwards the force query flag', async () => {
    const res = await fetch(`${base}/opsapi/nodes/term-abc?force=1`, {
      method: 'PATCH',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'renamed', width: 700 })
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(updateResult)
    expect(updateCalls).toEqual([
      { nodeId: 'term-abc', input: { title: 'renamed', width: 700 }, force: true }
    ])

    await fetch(`${base}/opsapi/nodes/term-abc`, {
      method: 'PATCH',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'renamed again' })
    })
    expect(updateCalls[1]).toMatchObject({ force: false })
  })

  it('PATCH rejects an empty body and maps a force-required refusal', async () => {
    const empty = await fetch(`${base}/opsapi/nodes/term-abc`, {
      method: 'PATCH',
      headers: { ...auth, 'content-type': 'application/json' },
      body: '{}'
    })
    expect(empty.status).toBe(400)

    updateResult = { ok: false, status: 403, error: 'force_required: node was not created by the operator plane; retry with ?force=1' }
    const refused = await fetch(`${base}/opsapi/nodes/term-abc`, {
      method: 'PATCH',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'nope' })
    })
    expect(refused.status).toBe(403)
  })

  it('allows GET/POST on the collection and DELETE/PATCH on one node, refusing anything else', async () => {
    const badCollection = await fetch(`${base}/opsapi/nodes`, { method: 'PUT', headers: auth })
    expect(badCollection.status).toBe(405)
    expect(badCollection.headers.get('allow')).toBe('GET, POST')

    const badItem = await fetch(`${base}/opsapi/nodes/term-abc`, { method: 'PUT', headers: auth })
    expect(badItem.status).toBe(405)
    expect(badItem.headers.get('allow')).toBe('DELETE, PATCH')
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
