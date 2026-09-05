import { execFileSync } from 'node:child_process'
import { promises as fs, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { startServer } from '../../src/server/index'
import { WorkspaceStore } from '../../src/core/workspace-store'
import { fakePlatform } from '../../src/core/platform-fake'
import { initPlatform, resetPlatformForTests } from '../../src/core/platform'

it.skipIf(process.platform !== 'linux' || !existsSync('/usr/bin/tmux'))('a disposable server restart preserves the original tmux process, screen and saved cards', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-upgrade-'))
  const socketDir = path.join(root, 'socket')
  const dataDir = path.join(root, 'data')
  const projectDir = path.join(root, 'project')
  for (const dir of [socketDir, dataDir, projectDir]) await fs.mkdir(dir, { mode: 0o700 })
  // Same socket NAME as production, but a private socket directory. No real tmux is reachable.
  vi.stubEnv('TMUX_TMPDIR', socketDir)
  vi.stubEnv('NODETERM_SESSION_REAP_DISABLED', '1')
  const tmux = (...args: string[]) => execFileSync('/usr/bin/tmux', ['-L', 'node-terminal', ...args], {
    encoding: 'utf8', env: { ...process.env, TMUX_TMPDIR: socketDir }, timeout: 10_000
  }).trim()
  let server: Awaited<ReturnType<typeof startServer>> | undefined
  try {
    tmux('new-session', '-d', '-s', 'nt-upgrade-fixture', 'bash -c "printf UPDATER_SCREEN_MARKER; exec sleep 600"')
    initPlatform(fakePlatform({ userDataDir: dataDir }))
    await new WorkspaceStore().save({ version: 2, activeProjectId: 'project', projects: [{
      id: 'project', name: 'fixture', color: '#0a84ff', cwd: projectDir,
      viewport: { x: 12, y: 34, zoom: 0.8 }, nodes: [{ id: 'upgrade-fixture', kind: 'terminal',
        title: 'Keep this title', position: { x: 111, y: 222 }, size: { width: 640, height: 440 },
        color: '#0a84ff', group: null }]
    }] })
    const boot = () => startServer({ port: 0, host: '127.0.0.1', dataDir,
      rendererDir: path.join(root, 'renderer'), insecureHttp: false, headless: false,
      passwordSeed: 'disposable-updater-fixture', installHooks: false, deadCardReapMinutes: 0 })
    server = await boot()
    const before = tmux('list-panes', '-a', '-F', '#{session_name}\t#{pane_id}\t#{pane_pid}')
    const screen = tmux('capture-pane', '-p', '-t', 'nt-upgrade-fixture')
    expect(screen).toContain('UPDATER_SCREEN_MARKER')
    const saved = await fs.readFile(path.join(projectDir, '.nodeterm/project.json'), 'utf8')
    await server.close()
    server = undefined
    server = await boot()
    expect(tmux('list-panes', '-a', '-F', '#{session_name}\t#{pane_id}\t#{pane_pid}')).toBe(before)
    expect(tmux('capture-pane', '-p', '-t', 'nt-upgrade-fixture')).toBe(screen)
    expect(await fs.readFile(path.join(projectDir, '.nodeterm/project.json'), 'utf8')).toBe(saved)
    const token = (await fs.readFile(path.join(dataDir, 'ops-token'), 'utf8')).trim()
    const response = await fetch(`http://127.0.0.1:${server.port}/opsapi/nodes`, {
      headers: { Authorization: `Bearer ${token}` }
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ nodes: [{ id: 'upgrade-fixture', paneState: 'alive', title: 'Keep this title' }] })
  } finally {
    await server?.close()
    try { tmux('kill-server') } catch { /* only this fixture's private socket */ }
    vi.unstubAllEnvs()
    resetPlatformForTests()
    await fs.rm(root, { recursive: true, force: true })
  }
}, 30_000)
