import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { startServer } from '../../src/server/index'

describe('server operator API wiring', () => {
  let dataDir = ''
  let base = ''
  let token = ''
  let cookie = ''
  let close: (() => Promise<void>) | undefined

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeterm-ops-e2e-'))
    const server = await startServer({
      port: 0,
      host: '127.0.0.1',
      dataDir,
      rendererDir: path.join(dataDir, 'no-renderer'),
      insecureHttp: false,
      passwordSeed: 'ops-e2e-browser-password',
      installHooks: false,
      headless: false
    })
    close = server.close
    base = `http://127.0.0.1:${server.port}`
    token = fs.readFileSync(path.join(dataDir, 'ops-token'), 'utf8').trim()
    const login = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'password=ops-e2e-browser-password',
      redirect: 'manual'
    })
    cookie = login.headers.get('set-cookie')!.split(';')[0]
  }, 30_000)

  afterAll(async () => {
    await close?.()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  it('creates the 0600 token and keeps browser login outside the operator principal', async () => {
    expect(token).toBeTruthy()
    expect(fs.statSync(path.join(dataDir, 'ops-token')).mode & 0o777).toBe(0o600)
    expect((await fetch(`${base}/opsapi/nodes`, { headers: { cookie } })).status).toBe(401)

    const inventory = await fetch(`${base}/opsapi/nodes`, {
      headers: { authorization: `Bearer ${token}` }
    })
    expect(inventory.status).toBe(200)
    expect(await inventory.json()).toEqual({ nodes: [] })
  })

  it('serves health independently of the spawn handler it observes', async () => {
    const health = await fetch(`${base}/opsapi/health`, {
      headers: { authorization: `Bearer ${token}` }
    })
    expect(health.status).toBe(200)
    expect(await health.json()).toMatchObject({
      wsClientCount: 0,
      canvasControlEnabled: false,
      spawnHandler: { state: 'idle', queued: 0 },
      deliveryQueueDepths: {},
      projects: []
    })
  })
})
