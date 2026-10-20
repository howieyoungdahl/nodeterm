import { expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { buildSync } from 'esbuild'
import { startServer } from '../../src/server'
import { ProjectCommitStore, revisionOf } from '../../src/core/project-commit-store'

it.skipIf(process.platform !== 'linux')('boots a disposable Server after a writer dies with its canvas displaced', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-server-restart-'))
  let server: Awaited<ReturnType<typeof startServer>> | undefined
  try {
    const cwd = path.join(dir, 'project'), file = path.join(cwd, '.nodeterm/project.json')
    await fs.mkdir(path.dirname(file), { recursive: true })
    const raw = JSON.stringify({ version: 1, id: 'legacy', name: 'Saved canvas', color: '#0a84ff', nodes: [{
      id: 'term-restart-proof', kind: 'terminal', title: 'Retained card', color: '#0a84ff', group: null,
      position: { x: 10, y: 20 }, size: { width: 640, height: 440 }
    }] }) + '\n'
    await fs.writeFile(file, raw)
    await fs.writeFile(path.join(dir, 'workspace.json'), JSON.stringify({ version: 3, activeProjectId: 'p',
      entries: [{ id: 'p', name: 'Saved canvas', color: '#0a84ff', cwd, viewport: { x: 0, y: 0, zoom: 1 } }] }))
    const store = new ProjectCommitStore(file), observed = await store.observe()
    const request = { clientId: 'server-recovery', operationId: 'interrupted', expectedRevision: observed.revision,
      proposed: JSON.stringify({ ...JSON.parse(raw), name: 'Unacknowledged proposal' }) }
    const bundle = buildSync({ entryPoints: [path.resolve('src/core/project-commit-store.ts')],
      bundle: true, platform: 'node', format: 'cjs', write: false }).outputFiles[0].text
    const child = spawn(process.execPath, ['-e', bundle + `\nnew module.exports.ProjectCommitStore(${JSON.stringify(file)},
      async phase => { if(phase === 'displaced')process.exit(23) }).commit(${JSON.stringify(request)});`])
    expect((await once(child, 'exit'))[0]).toBe(23)
    await expect(fs.lstat(file)).rejects.toMatchObject({ code: 'ENOENT' })
    server = await startServer({ port: 0, host: '127.0.0.1', dataDir: dir, rendererDir: path.join(dir, 'renderer'),
      headless: false, insecureHttp: false, passwordSeed: randomBytes(24).toString('hex'),
      installHooks: false, canvasControl: false, deadCardReapMinutes: 0 })
    const token = (await fs.readFile(path.join(dir, 'ops-token'), 'utf8')).trim()
    const response = await fetch(`http://127.0.0.1:${server.port}/opsapi/nodes`, { headers: { authorization: `Bearer ${token}` } })
    expect(response.status).toBe(200)
    const inventory = await response.json() as { nodes: { id: string }[] }
    expect(inventory.nodes.map(n => n.id)).toEqual(['term-restart-proof'])
    expect(await fs.readFile(file, 'utf8')).toBe(raw)
    const op = path.join(store.recovery, 'operations', revisionOf('server-recovery\0interrupted'))
    expect(await fs.readFile(path.join(op, 'request.json'), 'utf8')).toBe(JSON.stringify(request))
    await expect(fs.lstat(path.join(op, 'receipt.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await fs.lstat(path.join(op, 'interrupted-writer.lock/owner.json'))).isFile()).toBe(true)
  } finally {
    await server?.close()
    await fs.rm(dir, { recursive: true, force: true })
  }
}, 20000)
