import { promises as fs, mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ServerUpdater, buildEnvironment, mayRestart, survivingPanes, validateUpdateConfig,
  type UpdateConfig, type UpdateRuntime } from '../../src/core/server-updater'
import { updaterUnits } from '../../src/server/update-install'

const SHA = 'a'.repeat(40)
const healthy = { startedAt: 100, wsClientCount: 0,
  spawnHandler: { state: 'idle', active: 0, queued: 0 }, deliveryQueueDepths: {} }
let root: string
let config: UpdateConfig
let runtime: UpdateRuntime
let commands: string[][]
let restarts: number
let viewers: number
let healthReads: number
let failBuild: boolean
let failStartup: boolean
let losePane: boolean
let loseCard: boolean
let newViewer: boolean
let memory: number

beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-updater-'))
  config = { repo: path.join(root, 'repo'), remote: 'fork', branch: 'integration/server',
    stateDir: path.join(root, 'updates'), dataDir: path.join(root, 'data'),
    service: 'nodeterm-server.service', opsUrl: 'http://127.0.0.1:8443' }
  for (const dir of [config.repo, config.stateDir, config.dataDir]) await fs.mkdir(dir)
  const live = path.join(root, 'old-live')
  await fs.mkdir(live)
  await fs.symlink(live, path.join(config.stateDir, 'current'))
  await fs.mkdir(path.join(config.repo, '.nodeterm'))
  await fs.writeFile(path.join(config.repo, '.nodeterm/project.json'), JSON.stringify({ nodes: [{ id: 'term-a' }] }))
  await fs.writeFile(path.join(config.dataDir, 'workspace.json'), JSON.stringify({ entries: [{ id: 'p', cwd: config.repo }] }))
  commands = []; restarts = 0; viewers = 0; healthReads = 0; memory = 9000
  failBuild = false; failStartup = false; losePane = false; loseCard = false; newViewer = false
  runtime = {
    run(command, args, cwd) {
      commands.push([command, ...args])
      if (command === 'git') {
        if (args.includes('rev-parse')) return SHA
        if (args.includes('add')) mkdirSync(args.at(-2) === '--detach' ? args.at(-1)! : args.at(-2)!, { recursive: true })
        return ''
      }
      if (command === 'npm') {
        if (failBuild) throw new Error('test gate failed')
        if (args.includes('server:build')) {
          for (const file of ['out/server/main.cjs', 'out/renderer/index.html']) {
            mkdirSync(path.dirname(path.join(cwd!, file)), { recursive: true })
            writeFileSync(path.join(cwd!, file), 'built')
          }
        }
        return ''
      }
      if (command === 'systemctl') {
        if (args.includes('restart')) restarts++
        if (args.includes('WorkingDirectory')) return path.join(config.stateDir, 'current')
        return args.includes('show') ? 'process' : ''
      }
      if (command === 'tmux') {
        if (args.at(-1) === '#{pane_current_path}') return config.repo
        return losePane && restarts === 1 ? 'nt-term-a\t%1\t999' : 'nt-term-a\t%1\t123'
      }
      return ''
    },
    async ops(route) {
      if (route === 'nodes') return { nodes: loseCard && restarts === 1 ? [] : [{ id: 'term-a' }] }
      healthReads++
      if (failStartup && restarts === 1) throw new Error('connection refused')
      return { ...healthy, startedAt: 100 + restarts,
        wsClientCount: viewers || (newViewer && healthReads === 2 ? 1 : 0) }
    },
    sleep: async () => {}, availableMemoryMb: async () => memory,
    runningDirectory: () => fs.realpath(path.join(config.stateDir, 'current'))
  }
})
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(root, { recursive: true, force: true })
})
const updater = () => new ServerUpdater(config, runtime)
const current = () => fs.realpath(path.join(config.stateDir, 'current'))

describe('verified browser-server updates', () => {
  it('builds the fetched commit, backs up canvas data, and preserves pane identities on activation', async () => {
    expect((await updater().update(true)).outcome).toBe('deployed')
    expect(restarts).toBe(1)
    expect(await current()).toBe(path.join(config.stateDir, 'releases', SHA))
    expect(commands.filter((c) => c[0] === 'npm').map((c) => c.slice(1))).toEqual([
      ['ci', '--ignore-scripts'], ['rebuild', 'node-pty'], ['run', 'typecheck'],
      ['test', '--', '--maxWorkers=2'], ['run', 'build'], ['run', 'server:build'], ['run', '--if-present', 'updater:build']
    ])
    const snapshots = await fs.readdir(path.join(config.stateDir, 'snapshots'))
    const saved = path.join(config.stateDir, 'snapshots', snapshots[0])
    expect(JSON.parse(await fs.readFile(path.join(saved, 'project-0.json'), 'utf8')).nodes[0].id).toBe('term-a')
    expect((await updater().update(true)).outcome).toBe('current')
    expect(restarts).toBe(1)
  })

  it('stages while a browser is open, then deploys the same verified artifact without rebuilding', async () => {
    viewers = 1
    expect((await updater().update(true)).outcome).toBe('deferred')
    expect(restarts).toBe(0)
    expect(await current()).toBe(path.join(root, 'old-live'))
    const builds = commands.filter((c) => c[0] === 'npm').length
    viewers = 0
    expect((await updater().update(true)).outcome).toBe('deployed')
    expect(commands.filter((c) => c[0] === 'npm')).toHaveLength(builds)
  })

  it('stage-only mode never contacts or restarts the live server', async () => {
    expect((await updater().update(false)).outcome).toBe('staged')
    expect(healthReads).toBe(0)
    expect(restarts).toBe(0)
  })

  it('defers if a browser connects during the backup reads', async () => {
    newViewer = true
    expect((await updater().update(true)).outcome).toBe('deferred')
    expect(restarts).toBe(0)
    expect(await current()).toBe(path.join(root, 'old-live'))
  })

  it('quarantines a failed build until explicitly retried', async () => {
    failBuild = true
    expect((await updater().update(true)).outcome).toBe('failed')
    expect(restarts).toBe(0)
    failBuild = false
    expect((await updater().update(true)).outcome).toBe('blocked')
    expect((await updater().update(true, true)).outcome).toBe('deployed')
  })

  it.each(['startup', 'pane', 'card'])('rolls back and verifies the old release after failed %s continuity', async (failure) => {
    failStartup = failure === 'startup'; losePane = failure === 'pane'; loseCard = failure === 'card'
    const result = await updater().update(true)
    expect(result).toMatchObject({ outcome: 'failed', detail: 'Update failed; previous release restored' })
    expect(restarts).toBe(2)
    expect(await current()).toBe(path.join(root, 'old-live'))
    await expect(fs.access(path.join(config.stateDir, 'deployed.json'))).rejects.toThrow()
  })

  it('defers an unreadable operator check without treating it as an empty canvas', async () => {
    runtime.ops = async () => { throw new Error('operator unavailable') }
    expect((await updater().update(true)).outcome).toBe('deferred')
    expect(restarts).toBe(0)
    await expect(fs.access(path.join(config.stateDir, 'failed.json'))).rejects.toThrow()
  })

  it('does not build under memory pressure', async () => {
    memory = 2048
    expect((await updater().update(true)).outcome).toBe('deferred')
    expect(commands.some((c) => c[0] === 'npm')).toBe(false)
  })

  it('rejects cgroup-killing live service configuration before changing the release', async () => {
    const run = runtime.run
    runtime.run = (cmd, args, cwd, build) => cmd === 'systemctl' && args.includes('show')
      ? 'control-group' : run(cmd, args, cwd, build)
    expect((await updater().update(true)).outcome).toBe('deferred')
    expect(restarts).toBe(0)
    expect(await current()).toBe(path.join(root, 'old-live'))
  })
  it('does not call an unrelated restarted build a successful deployment', async () => {
    runtime.runningDirectory = async () => path.join(root, 'old-live')
    expect(await updater().update(true)).toMatchObject({ outcome: 'failed', detail: 'Update failed; previous release restored' })
    expect(restarts).toBe(2)
    expect(await current()).toBe(path.join(root, 'old-live'))
  })
})

describe('updater boundaries', () => {
  it('keeps credentials and provider/node identity out of build environments', () => {
    expect(buildEnvironment({ PATH: '/usr/bin', HOME: '/fixture', PROD_DB_URL: 'secret',
      NODETERM_NODE_ID: 'live-node', NODETERM_DATA_DIR: '/live', OPENAI_API_KEY: 'secret' }))
      .toEqual({ PATH: '/usr/bin', HOME: '/fixture', NODE_OPTIONS: '--max-old-space-size=4096', npm_config_jobs: '2' })
  })
  it('requires known idle health and original pane pids', () => {
    expect(mayRestart(healthy)).toBe(true)
    expect(mayRestart({ ...healthy, wsClientCount: 1 })).toBe(false)
    expect(mayRestart({ ...healthy, spawnHandler: { state: 'idle', active: 0, queued: 1 } })).toBe(false)
    expect(mayRestart({ ...healthy, deliveryQueueDepths: { busy: 1 } })).toBe(false)
    expect(survivingPanes('a\t%1\t123', 'a\t%1\t456')).toBe(false)
    expect(survivingPanes('a\t%1\t123', 'a\t%1\t123\nb\t%2\t456')).toBe(true)
  })
  it('rejects external operator URLs, remote flags, and filesystem roots', () => {
    for (const change of [{ opsUrl: 'https://example.com' }, { remote: '--upload-pack=evil' },
      { opsUrl: 'http://user:secret@localhost' }, { stateDir: '/' }, { branch: '../main' }])
      expect(() => validateUpdateConfig({ ...config, ...change })).toThrow()
  })
  it('generates bounded, serialized systemd jobs without restarting in the timer definition', () => {
    const units = updaterUnits(config, '/usr/bin/node')
    expect(units.service).toContain('/usr/bin/flock -n')
    expect(units.service).toContain('MemoryMax=6G')
    expect(units.service).toContain('TimeoutStartSec=20min')
    expect(units.override).toContain('KillMode=process')
    expect(units.override).toContain(`WorkingDirectory=${path.join(config.stateDir, 'current')}\n`)
    const spaced = updaterUnits({ ...config, stateDir: '/tmp/update fixtures%name' }, '/usr/bin/node')
    expect(spaced.override).toContain('WorkingDirectory=/tmp/update fixtures%%name/current\n')
    expect(spaced.override).toContain('"/tmp/update fixtures%%name/current/out/server/main.cjs"')
    expect(units.timer).toContain('OnUnitInactiveSec=5min')
  })
})
