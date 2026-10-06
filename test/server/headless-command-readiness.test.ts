import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { startServer } from '../../src/server/index'
import { TMUX_SOCKET, sessionName } from '../../src/core/tmux-naming'

// Delay the real tmux child, not its completion callback. A returned node-pty
// object is not proof that tmux has created the named backend yet.
vi.mock('node-pty', async (importOriginal) => {
  const real = await importOriginal<typeof import('node-pty')>()
  return { ...real, spawn: (file: string, args: string[], options: import('node-pty').IPtyForkOptions) =>
    real.spawn('/bin/sh', ['-c', 'sleep 0.25; exec "$@"', 'delayed-tmux', file, ...args], options) }
})
vi.mock('../../src/core/session-name-sweep', () => ({ startSessionNameSweep: () => () => {},
  displayNodeTitle: (node: { title: string }) => node.title }))

it.skipIf(process.platform !== 'linux')('delivers the initial command once after a delayed real headless tmux spawn', async () => {
  expect(TMUX_SOCKET).toBe(`nt-vitest-${process.pid}`)
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-headless-ready-'))
  let close: (() => Promise<void>) | undefined, id: string | undefined
  try {
    await fs.writeFile(path.join(dir, 'settings.json'), JSON.stringify({ defaultShell: '/bin/sh', tmuxEnabled: true }))
    await fs.writeFile(path.join(dir, 'workspace.json'), JSON.stringify({ version: 2, activeProjectId: 'ready',
      projects: [{ id: 'ready', name: 'Ready fixture', cwd: dir, color: '#888',
        viewport: { x: 0, y: 0, zoom: 1 }, nodes: [] }] }))
    const server = await startServer({ port: 0, host: '127.0.0.1', dataDir: dir,
      rendererDir: path.join(dir, 'no-renderer'), passwordSeed: 'synthetic-ready-only',
      installHooks: false, headless: false, canvasControl: false, deadCardReapMinutes: 0, insecureHttp: false })
    close = server.close
    const token = (await fs.readFile(path.join(dir, 'ops-token'), 'utf8')).trim()
    const creationId = randomUUID(), output = path.join(dir, 'delivered.txt')
    const response = await fetch(`http://127.0.0.1:${server.port}/opsapi/nodes`, {
      method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'ready', idempotencyKey: creationId,
        creation: { version: 1, taskId: 'readiness-regression', creationId, declaredOwner: 'Fixture' },
        organization: { owner: 'Fixture', projectId: 'ready', workstream: 'readiness', functionalRole: 'ops' },
        cmd: `printf 'delivered\\n' >> '${output}'` })
    })
    const body = await response.json(); id = body.id
    expect(response.status, JSON.stringify(body)).toBe(201)
    await expect.poll(() => fs.readFile(output, 'utf8'), { timeout: 5000 }).toBe('delivered\n')
    const ledger = JSON.parse(await fs.readFile(path.join(dir, 'kanban-organization.json'), 'utf8'))
    expect(ledger.creations[creationId]).toMatchObject({ nodeId: id, stage: 'finished', outcome: 'success' })
  } finally {
    await close?.()
    // Only this newly-created private fixture; never repeat its creation POST.
    if (id) { try { execFileSync('tmux', ['-L', TMUX_SOCKET, 'kill-session', '-t', '=' + sessionName(id)], { timeout: 4000, stdio: 'ignore' }) } catch { /* not ready yet */ } }
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}, 15000)
