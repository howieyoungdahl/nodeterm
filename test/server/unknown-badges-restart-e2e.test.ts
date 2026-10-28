import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { startServer } from '../../src/server/index'
import type { Workspace } from '../../src/shared/types'

/**
 * UNKNOWN badges after a restart, from the outside (W-0596).
 *
 * Booting a real Server against a pre-written data dir is the restart an updater activation causes.
 * Before the fix, a node whose last state was asserted more than 6 h ago lost its mirror entry on
 * load, so every surface (badge seed, `/opsapi/nodes`, canvas inventory) answered "no status", and a
 * session-start idle fact did not survive at all. `/opsapi/nodes` is the observation point for
 * presence; the flushed `agent-status.json` is the one for what the next boot will load.
 */
describe('agent status survives a Server restart past six hours', () => {
  let dataDir = ''
  let base = ''
  let token = ''
  let close: (() => Promise<void>) | undefined
  const HOUR = 60 * 60_000
  const bootAt = Date.now()

  const terminal = (id: string, x: number): Workspace['projects'][number]['nodes'][number] => ({
    id,
    kind: 'terminal',
    position: { x, y: 0 },
    size: { width: 640, height: 440 },
    title: id,
    color: '#d97757',
    group: null,
    agentId: 'claude'
  })

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeterm-unknown-badges-e2e-'))
    const workspace: Workspace = {
      version: 2,
      activeProjectId: 'badges-project',
      projects: [
        {
          id: 'badges-project',
          name: 'Unknown badges restart',
          color: '#0a84ff',
          cwd: dataDir,
          viewport: { x: 0, y: 0, zoom: 1 },
          nodes: [
            terminal('n-done-7h', 0),
            terminal('n-blocked-7h', 700),
            terminal('n-idle-7h', 1400),
            terminal('n-done-8d', 2100)
          ],
          bridges: [],
          ropes: []
        }
      ]
    }
    fs.writeFileSync(path.join(dataDir, 'workspace.json'), JSON.stringify(workspace), 'utf8')
    fs.writeFileSync(
      path.join(dataDir, 'agent-status.json'),
      JSON.stringify({
        v: 1,
        updatedAt: bootAt - 7 * HOUR,
        nodes: {
          'n-done-7h': { state: 'done', agentId: 'claude', sessionId: 's-done', updatedAt: bootAt - 7 * HOUR },
          'n-blocked-7h': { state: 'blocked', agentId: 'claude', sessionId: 's-blocked', updatedAt: bootAt - 7 * HOUR },
          'n-idle-7h': { agentId: 'claude', sessionId: 's-idle', idleSince: bootAt - 7 * HOUR, updatedAt: bootAt - 7 * HOUR },
          'n-done-8d': { state: 'done', agentId: 'claude', sessionId: 's-old', updatedAt: bootAt - 8 * 24 * HOUR }
        }
      }),
      'utf8'
    )

    const server = await startServer({
      port: 0,
      host: '127.0.0.1',
      dataDir,
      rendererDir: path.join(dataDir, 'no-renderer'),
      insecureHttp: false,
      passwordSeed: 'unknown-badges-e2e-password',
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

  it('still reports status for nodes last heard from seven hours ago, and not for one past retention', async () => {
    const response = await fetch(`${base}/opsapi/nodes`, {
      headers: { authorization: `Bearer ${token}` }
    })
    expect(response.status).toBe(200)
    const { nodes } = (await response.json()) as {
      nodes: Array<{ id: string; agentStatus: string | null }>
    }
    const byId = new Map(nodes.map((n) => [n.id, n.agentStatus]))
    expect(byId.get('n-done-7h')).toBe('idle')
    expect(byId.get('n-blocked-7h')).toBe('blocked')
    expect(byId.get('n-idle-7h')).toBe('idle')
    expect(byId.get('n-done-8d')).toBeNull()
  })

  it('writes the retained states and the idle fact back for the next boot', async () => {
    await close?.()
    close = undefined
    const doc = JSON.parse(fs.readFileSync(path.join(dataDir, 'agent-status.json'), 'utf8')) as {
      nodes: Record<string, { state?: string; idleSince?: number }>
    }
    expect(doc.nodes['n-done-7h']?.state).toBe('done')
    expect(doc.nodes['n-blocked-7h']?.state).toBe('blocked')
    expect(doc.nodes['n-idle-7h']?.state).toBeUndefined()
    expect(doc.nodes['n-idle-7h']?.idleSince).toBe(bootAt - 7 * HOUR)
    // No assertion on `n-done-8d` here: a boot with no hook events does not rewrite the file, and
    // the test above already proves the entry was dropped from memory.
  })
})
