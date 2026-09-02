import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { startServer } from '../../src/server/index'
import type { Workspace } from '../../src/shared/types'

/**
 * The wiring test for durable creator ownership, from the outside.
 *
 * `node-ownership-store.test.ts` proves the store; this proves the SERVER uses it — that boot reads
 * `<dataDir>/node-ownership.json`, that the answers reach the code which authorizes mutations, and
 * that the boot workspace prunes it. Booting a server against a pre-written data dir IS the restart:
 * that is exactly what the second run of an upgrade sees.
 *
 * `/opsapi/nodes` is the observation point because its `ownerSession` field is a straight read of
 * `HeadlessNodeOwnership.ownerOf` through `ServerNodeOps` — no tmux, no agent, no control shim.
 */
describe('creator ownership survives a Server restart', () => {
  let dataDir = ''
  let base = ''
  let token = ''
  let close: (() => Promise<void>) | undefined

  const ledgerFile = (): string => path.join(dataDir, 'node-ownership.json')

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeterm-ownership-e2e-'))
    const workspace: Workspace = {
      version: 2,
      activeProjectId: 'ownership-project',
      projects: [
        {
          id: 'ownership-project',
          name: 'Ownership restart',
          color: '#0a84ff',
          cwd: dataDir,
          viewport: { x: 0, y: 0, zoom: 1 },
          nodes: [
            {
              id: 'source',
              kind: 'terminal',
              position: { x: 0, y: 0 },
              size: { width: 640, height: 440 },
              title: 'Director',
              color: '#d97757',
              group: null,
              agentId: 'claude'
            },
            {
              id: 'n-child',
              kind: 'terminal',
              position: { x: 700, y: 0 },
              size: { width: 640, height: 440 },
              title: 'Child it spawned',
              color: '#d97757',
              group: null,
              agentId: 'claude'
            }
          ],
          bridges: [],
          ropes: []
        }
      ]
    }
    fs.writeFileSync(path.join(dataDir, 'workspace.json'), JSON.stringify(workspace), 'utf8')
    // The ledger the PREVIOUS run left behind: one grant for a node that still exists, and one for
    // a node that has since been removed from the canvas.
    fs.writeFileSync(
      ledgerFile(),
      JSON.stringify({
        v: 1,
        owners: {
          'n-child': { sourceNodeId: 'source', projectId: 'ownership-project', recordedAt: 1 },
          'n-vanished': { sourceNodeId: 'source', projectId: 'ownership-project', recordedAt: 1 }
        }
      }),
      { encoding: 'utf8', mode: 0o600 }
    )

    const server = await startServer({
      port: 0,
      host: '127.0.0.1',
      dataDir,
      rendererDir: path.join(dataDir, 'no-renderer'),
      insecureHttp: false,
      passwordSeed: 'ownership-restart-e2e-password',
      installHooks: false,
      headless: false
    })
    close = server.close
    base = `http://127.0.0.1:${server.port}`
    token = fs.readFileSync(path.join(dataDir, 'ops-token'), 'utf8').trim()
  }, 30_000)

  afterAll(async () => {
    await close?.()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  it('answers ownership for a node the previous run recorded, and none for one it did not', async () => {
    const response = await fetch(`${base}/opsapi/nodes`, {
      headers: { authorization: `Bearer ${token}` }
    })
    expect(response.status).toBe(200)
    const { nodes } = (await response.json()) as {
      nodes: Array<{ id: string; ownerSession: string | null }>
    }
    const byId = new Map(nodes.map((n) => [n.id, n.ownerSession]))
    // The whole point: before this ledger was durable, `n-child` came back unowned and the
    // director that opened it could no longer message, resize or close it.
    expect(byId.get('n-child')).toBe('source')
    // A node nobody claimed stays unowned — restoring the ledger must not invent grants.
    expect(byId.get('source')).toBeNull()
  })

  it('prunes the grant for a node the persisted workspace no longer has, and rewrites 0600', async () => {
    // The read above is what armed the prune (it runs before any ownership ANSWER). Close flushes
    // the debounced rewrite, so the assertion reads the bytes a third boot would load.
    await close?.()
    close = undefined
    const doc = JSON.parse(fs.readFileSync(ledgerFile(), 'utf8')) as {
      v: number
      owners: Record<string, unknown>
    }
    expect(doc.v).toBe(1)
    expect(Object.keys(doc.owners)).toEqual(['n-child'])
    if (process.platform !== 'win32') {
      expect(fs.statSync(ledgerFile()).mode & 0o777).toBe(0o600)
    }
  })
})

/**
 * The FIELD configuration, which the suite above does not cover: canvas control ON.
 *
 * `config.canvasControl === true` is the only thing that gives `startServer` a `canvasControl` to
 * stop, and the live Server Edition unit sets `NODETERM_SERVER_CANVAS_CONTROL=1`. Without it the
 * shutdown path above never reaches `HeadlessNodeFactory.stop()`, which is exactly why a green
 * restart suite coexisted with a live restart that came back with `{"v":1,"owners":{}}` and every
 * `list` row reading `opened-by-you=no` (2026-09-02).
 */
describe('creator ownership survives a canvas-control shutdown', () => {
  let dataDir = ''
  let close: (() => Promise<void>) | undefined

  const ledgerFile = (): string => path.join(dataDir, 'node-ownership.json')

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeterm-ownership-shutdown-'))
    const workspace: Workspace = {
      version: 2,
      activeProjectId: 'ownership-project',
      projects: [
        {
          id: 'ownership-project',
          name: 'Ownership shutdown',
          color: '#0a84ff',
          cwd: dataDir,
          viewport: { x: 0, y: 0, zoom: 1 },
          nodes: [
            {
              id: 'source',
              kind: 'terminal',
              position: { x: 0, y: 0 },
              size: { width: 640, height: 440 },
              title: 'Director',
              color: '#d97757',
              group: null,
              agentId: 'claude'
            },
            {
              id: 'n-child',
              kind: 'terminal',
              position: { x: 700, y: 0 },
              size: { width: 640, height: 440 },
              title: 'Child it spawned',
              color: '#d97757',
              group: null,
              agentId: 'claude'
            }
          ],
          bridges: [],
          ropes: []
        }
      ]
    }
    fs.writeFileSync(path.join(dataDir, 'workspace.json'), JSON.stringify(workspace), 'utf8')
    fs.writeFileSync(
      ledgerFile(),
      JSON.stringify({
        v: 1,
        owners: {
          'n-child': { sourceNodeId: 'source', projectId: 'ownership-project', recordedAt: 1 }
        }
      }),
      { encoding: 'utf8', mode: 0o600 }
    )

    const server = await startServer({
      port: 0,
      host: '127.0.0.1',
      dataDir,
      rendererDir: path.join(dataDir, 'no-renderer'),
      insecureHttp: false,
      passwordSeed: 'ownership-shutdown-e2e-password',
      installHooks: false,
      headless: false,
      canvasControl: true
    })
    close = server.close
  }, 30_000)

  afterAll(async () => {
    await close?.()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  it('keeps the grant across a shutdown that stops canvas control and then flushes', async () => {
    await close?.()
    close = undefined
    const doc = JSON.parse(fs.readFileSync(ledgerFile(), 'utf8')) as {
      v: number
      owners: Record<string, unknown>
    }
    // Before the fix this read `{}`: `canvasControl.stop()` cleared the ledger and the flush that
    // follows it — the one meant to land the last grant — published the emptied map.
    expect(Object.keys(doc.owners)).toEqual(['n-child'])
    expect(doc.v).toBe(1)
  })
})
