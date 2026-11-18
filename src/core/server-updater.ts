import { execFileSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { renameAtomic, writeFileAtomic } from './fs-atomic'

export interface UpdateConfig {
  repo: string
  remote: string
  branch: string
  stateDir: string
  dataDir: string
  service: string
  opsUrl: string
}
interface Health {
  startedAt: number
  wsClientCount: number
  spawnHandler: { state: string; active: number; queued: number }
  deliveryQueueDepths: Record<string, number>
}
export interface UpdateRuntime {
  /** `timeoutMs` overrides the default limit (15 min for a build step, 30 s otherwise). */
  run(command: string, args: string[], cwd?: string, build?: boolean, timeoutMs?: number): string
  ops(route: string): Promise<unknown>
  sleep(ms: number): Promise<void>
  availableMemoryMb(): Promise<number>
  runningDirectory(): Promise<string>
  /** Clock for the build window; Date.now when absent. */
  now?(): number
}
interface Status { outcome: string; sha?: string; detail?: string; at?: string }

export function validateUpdateConfig(config: UpdateConfig): void {
  for (const key of ['repo', 'stateDir', 'dataDir'] as const) {
    if (!path.isAbsolute(config[key]) || path.resolve(config[key]) === path.parse(config[key]).root)
      throw new Error(`${key} must be an absolute, non-root directory`)
  }
  if (!/^[\w.-]+$/.test(config.remote) || config.remote.startsWith('-')) throw new Error('Invalid remote')
  if (!/^[\w./-]+$/.test(config.branch) || config.branch.startsWith('-') || config.branch.includes('..'))
    throw new Error('Invalid branch')
  if (!/^[\w.-]+\.service$/.test(config.service) || config.service.startsWith('-')) throw new Error('Invalid service')
  const url = new URL(config.opsUrl)
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/')
    throw new Error('Operator URL must be loopback HTTP with no credentials or path')
}

/** Builds must not inherit provider credentials from the shell that installed the updater. */
export function buildEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS'])
    if (source[key]) env[key] = source[key]
  // The updater builds on a host shared with every agent session, so its test step runs under
  // load. One scale on vitest's default test and hook timeouts (vitest.config.ts) keeps a test
  // that is merely slow there from failing as if it were wrong. Tests with their own explicit
  // timeouts are unchanged, and no test is skipped.
  return { ...env, NODE_OPTIONS: '--max-old-space-size=4096', npm_config_jobs: '2', NODETERM_TEST_TIMEOUT_SCALE: '4' }
}

/** Timed-out build attempts per commit before it is quarantined like any other failure. */
export const BUILD_TIMEOUT_ATTEMPTS = 3

/** The longest any one build step may run. A step that needs more than this is a failure. */
export const BUILD_STEP_LIMIT_MS = 15 * 60_000
/**
 * The part of one updater run that build steps may use. The systemd job is stopped at 20 min
 * (`TimeoutStartSec`, written by update-install and not refreshed by a deploy); activation already
 * refuses to start after 16 min. A step is never given time past this window, so systemd never
 * stops the job mid-step, which would lose the step's outcome and any timeout count.
 */
export const BUILD_WINDOW_MS = 16 * 60_000
/** Less than this left in the window: stop and continue on the next tick instead of starting. */
export const BUILD_MIN_START_MS = 2 * 60_000
/**
 * The test suite runs as this many vitest shards, each its own resumable step. On a loaded host
 * the whole suite took about two hours under the updater's CPU quota (2026-11-17), so no single
 * run could hold it; a shard fits one tick.
 */
export const TEST_SHARDS = 12

/** The build, in order. Each step is recorded when it passes and skipped on a later tick. */
export function buildSteps(shards = TEST_SHARDS): { name: string; command: string; args: string[] }[] {
  return [
    { name: 'ci', command: 'npm', args: ['ci', '--ignore-scripts'] },
    { name: 'patch-node-pty', command: 'node', args: ['scripts/patch-node-pty.mjs'] },
    { name: 'rebuild-node-pty', command: 'npm', args: ['rebuild', 'node-pty'] },
    { name: 'typecheck', command: 'npm', args: ['run', 'typecheck'] },
    ...Array.from({ length: shards }, (_, i) => ({
      name: `test-${i + 1}-of-${shards}`, command: 'npm',
      args: ['test', '--', '--maxWorkers=2', `--shard=${i + 1}/${shards}`]
    })),
    { name: 'build', command: 'npm', args: ['run', 'build'] },
    { name: 'server-build', command: 'npm', args: ['run', 'server:build'] },
    { name: 'updater-build', command: 'npm', args: ['run', '--if-present', 'updater:build'] }
  ]
}

export function systemUpdateRuntime(config: UpdateConfig): UpdateRuntime {
  return {
    run(command, args, cwd, build, timeoutMs) {
      return execFileSync(command, args, {
        cwd, encoding: 'utf8', timeout: timeoutMs ?? (build ? BUILD_STEP_LIMIT_MS : 30_000),
        maxBuffer: 32 * 1024 * 1024, env: buildEnvironment(process.env),
        ...(build ? { stdio: ['ignore', 'inherit', 'inherit'] as ['ignore', 'inherit', 'inherit'] } : {})
      }) ?? ''
    },
    async ops(route) {
      const token = (await fs.readFile(path.join(config.dataDir, 'ops-token'), 'utf8')).trim()
      const response = await fetch(`${config.opsUrl.replace(/\/$/, '')}/opsapi/${route}`, {
        headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000)
      })
      if (!response.ok) throw new Error(`Operator ${route}: HTTP ${response.status}`)
      return response.json()
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    async availableMemoryMb() {
      const memory = await fs.readFile('/proc/meminfo', 'utf8')
      const available = /^MemAvailable:\s+(\d+) kB$/m.exec(memory)
      if (!available) throw new Error('Cannot measure available build memory')
      return Number(available[1]) / 1024
    },
    async runningDirectory() {
      const pid = execFileSync('systemctl', ['--user', 'show', config.service, '-p', 'MainPID', '--value'], {
        encoding: 'utf8', timeout: 5000
      }).trim()
      if (!/^[1-9][0-9]*$/.test(pid)) throw new Error('No running server PID')
      return fs.realpath(`/proc/${pid}/cwd`)
    }
  }
}

/**
 * A restart is admissible when the server has no work in flight: no spawn running or queued and
 * every delivery queue drained. Connected browsers do NOT block it (operator decision, 2026-09-06): the
 * service runs with KillMode=process so tmux panes survive, and the renderer's reconnect overlay
 * reloads the page on the first successful reopen with the same saved layout. Waiting for zero
 * viewers meant waiting for the operator to stop working, which in practice was never: the staged
 * release deferred 238 times over a day while one tab stayed open. The cost of restarting under a
 * viewer is bounded by the renderer's autosave debounce (under a second of unsaved canvas edits).
 */
export function mayRestart(health: Health): boolean {
  return Number.isFinite(health.startedAt) &&
    health.spawnHandler?.state === 'idle' && health.spawnHandler.active === 0 &&
    health.spawnHandler.queued === 0 && !!health.deliveryQueueDepths &&
    Object.values(health.deliveryQueueDepths).every((depth) => depth === 0)
}

/** Exact pane ids AND shell pids: a replacement shell must not pass as the original session. */
export function survivingPanes(before: string, after: string): boolean {
  const current = new Set(after.trim().split('\n').filter(Boolean))
  return before.trim().split('\n').filter(Boolean).every((pane) => current.has(pane))
}

export class ServerUpdater {
  constructor(private config: UpdateConfig, private runtime: UpdateRuntime) {
    validateUpdateConfig(config)
  }
  private get current(): string { return path.join(this.config.stateDir, 'current') }
  private git(args: string[]): string { return this.runtime.run('git', ['-C', this.config.repo, ...args]).trim() }
  private async readStatus(file: string): Promise<Status | undefined> {
    try { return JSON.parse(await fs.readFile(path.join(this.config.stateDir, file), 'utf8')) }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
  }
  private async status(outcome: string, sha?: string, detail?: string): Promise<Status> {
    const status = { outcome, sha, detail, at: new Date().toISOString() }
    await writeFileAtomic(path.join(this.config.stateDir, 'status.json'), JSON.stringify(status, null, 2))
    console.log(JSON.stringify(status))
    return status
  }
  private panes(): string {
    return this.runtime.run('tmux', ['-L', 'node-terminal', 'list-panes', '-a', '-F',
      '#{session_name}\t#{pane_id}\t#{pane_pid}']).trim()
  }
  private async nodes(): Promise<string[]> {
    const result = await this.runtime.ops('nodes') as { nodes: Array<{ id: string }> }
    if (!Array.isArray(result.nodes) || result.nodes.some((node) => typeof node.id !== 'string'))
      throw new Error('Invalid canvas inventory')
    return result.nodes.map((node) => node.id)
  }
  private async pointTo(target: string): Promise<void> {
    const temporary = `${this.current}.${randomUUID()}.tmp`
    await fs.symlink(target, temporary)
    try { await renameAtomic(temporary, this.current) }
    finally { await fs.unlink(temporary).catch(() => {}) }
  }
  private async waitHealthy(previousStartedAt: number): Promise<void> {
    const deadline = Date.now() + 30_000
    for (let attempt = 0; attempt < 30 && Date.now() < deadline; attempt++) {
      try {
        const health = await this.runtime.ops('health') as Health
        if (Number.isFinite(health.startedAt) && health.startedAt !== previousStartedAt) return
      } catch { /* the new listener is not up yet */ }
      await this.runtime.sleep(1000)
    }
    throw new Error('New server did not become healthy')
  }
  private async verifyContinuity(panes: string, nodes: string[]): Promise<void> {
    if (!survivingPanes(panes, this.panes())) throw new Error('An original tmux pane is missing or replaced')
    const restored = new Set(await this.nodes())
    if (nodes.some((node) => !restored.has(node))) throw new Error('Saved canvas cards are missing')
  }
  private async snapshot(sha: string, panes: string, nodes: string[]): Promise<void> {
    const directory = path.join(this.config.stateDir, 'snapshots', `${sha}-${Date.now()}`)
    await fs.mkdir(directory, { recursive: true, mode: 0o700 })
    const workspace = await fs.readFile(path.join(this.config.dataDir, 'workspace.json'), 'utf8')
    await writeFileAtomic(path.join(directory, 'workspace.json'), workspace)
    const entries = (JSON.parse(workspace) as { entries: Array<{ id: string; cwd?: string; ssh?: unknown }> }).entries
    if (!Array.isArray(entries)) throw new Error('Unsupported workspace index; cannot back up canvas')
    for (const [i, entry] of entries.entries()) {
      if (!entry.cwd || entry.ssh) continue
      const file = path.join(entry.cwd, '.nodeterm', 'project.json')
      await writeFileAtomic(path.join(directory, `project-${i}.json`), await fs.readFile(file, 'utf8'))
    }
    await writeFileAtomic(path.join(directory, 'inventory.json'), JSON.stringify({ panes, nodes }))
  }
  private async prune(previous: string): Promise<void> {
    const root = path.join(this.config.stateDir, 'releases')
    const keep = new Set([previous, await fs.realpath(this.current)])
    const paneCwds = this.runtime.run('tmux', ['-L', 'node-terminal', 'list-panes', '-a', '-F', '#{pane_current_path}'])
      .trim().split('\n').filter(Boolean)
    const entries = await Promise.all((await fs.readdir(root)).filter((name) => /^[a-f0-9]{40}$/.test(name))
      .map(async (name) => ({ dir: path.join(root, name), mtime: (await fs.stat(path.join(root, name))).mtimeMs })))
    entries.sort((a, b) => b.mtime - a.mtime)
    // Keep three verified releases, plus any older one a terminal still uses as its cwd.
    for (const entry of entries.slice(3)) {
      if (keep.has(entry.dir) || paneCwds.some((cwd) => cwd === entry.dir || cwd.startsWith(entry.dir + path.sep))) continue
      if (await fs.realpath(entry.dir) !== entry.dir) continue
      try { await fs.access(path.join(entry.dir, '.updater-ready.json')) } catch { continue }
      const changes = this.runtime.run('git', ['-C', entry.dir, 'status', '--porcelain']).trim().split('\n')
      if (changes.some((change) => change && change !== '?? .updater-ready.json')) continue
      // Only our generated, clean SHA worktrees enter this path. The running and rollback trees
      // are excluded above; git removes their ignored build artifacts with the managed worktree.
      this.git(['worktree', 'remove', '--force', entry.dir])
    }
  }
  async update(apply: boolean, retry = false): Promise<Status> {
    const now = () => this.runtime.now?.() ?? Date.now()
    const started = now()
    await fs.mkdir(this.config.stateDir, { recursive: true, mode: 0o700 })
    let sha: string | undefined
    let phase = 'fetch'
    try {
      // FETCH_HEAD is shared with every agent worktree. A concurrent fetch must not redirect a
      // deployment to its unrelated feature branch, so this updater owns a private fetched ref.
      const ref = `refs/nodeterm-updater/${createHash('sha256').update(this.config.stateDir).digest('hex').slice(0, 16)}`
      this.git(['fetch', '--no-tags', this.config.remote, `refs/heads/${this.config.branch}:${ref}`])
      sha = this.git(['rev-parse', ref])
      if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Invalid fetched commit')
      const deployed = await this.readStatus('deployed.json')
      if (deployed?.sha === sha && await fs.realpath(this.current) === path.join(this.config.stateDir, 'releases', sha))
        return this.status('current', sha)
      const failed = await this.readStatus('failed.json')
      if (!retry && failed?.sha === sha) return this.status('blocked', sha, 'This commit failed; use --retry after resolving it')
      // A force-push is not a rollback instruction. Ship a revert commit instead.
      if (deployed?.sha) this.git(['merge-base', '--is-ancestor', deployed.sha, sha])
      const release = path.join(this.config.stateDir, 'releases', sha)
      const readyFile = path.join(release, '.updater-ready.json')
      let ready = false
      try { ready = JSON.parse(await fs.readFile(readyFile, 'utf8')).sha === sha }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      if (!ready) {
        if (await this.runtime.availableMemoryMb() < 6144)
          return this.status('deferred', sha, 'Waiting for at least 6 GiB available memory to build')
        phase = 'build'
        await this.status('building', sha)
        try { await fs.access(release) }
        catch { this.git(['worktree', 'add', '--detach', release, sha]) }
        if (this.runtime.run('git', ['-C', release, 'rev-parse', 'HEAD']).trim() !== sha)
          throw new Error('Release worktree points at a different commit')
        if (this.runtime.run('git', ['-C', release, 'status', '--porcelain', '--untracked-files=no']).trim())
          throw new Error('Release worktree has source edits; preserving them')
        // Resumable: each passed step is recorded for this commit, and a later tick continues from
        // the first step not recorded. The record lives in the state dir, not the release
        // worktree, so release pruning (which keeps any worktree with stray files) is unaffected.
        // --retry starts the commit over, so a damaged install is rebuilt rather than skipped.
        const progressFile = path.join(this.config.stateDir, 'build-progress.json')
        let done: string[] = []
        if (!retry) {
          try {
            const progress = JSON.parse(await fs.readFile(progressFile, 'utf8')) as { sha?: string; done?: unknown }
            if (progress.sha === sha && Array.isArray(progress.done)) done = progress.done.filter((d): d is string => typeof d === 'string')
          } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        }
        await writeFileAtomic(progressFile, JSON.stringify({ sha, done }))
        const steps = buildSteps()
        let first = true
        for (const step of steps) {
          if (done.includes(step.name)) continue
          const left = started + BUILD_WINDOW_MS - now()
          if (left < BUILD_MIN_START_MS)
            return this.status('deferred', sha, `Build continues on the next tick (${done.length} of ${steps.length} steps done)`)
          const limit = Math.min(BUILD_STEP_LIMIT_MS, left)
          try {
            this.runtime.run(step.command, step.args, release, true, limit)
          } catch (error) {
            // Only a step that other steps crowded out of this run is excused. The first step a run
            // starts had the whole window, so its timeout counts toward quarantine; a hung step is
            // always first on the tick after, so it cannot defer forever.
            if ((error as NodeJS.ErrnoException).code === 'ETIMEDOUT' && limit < BUILD_STEP_LIMIT_MS && !first)
              return this.status('deferred', sha, `Build step ${step.name} reached the end of this run; it restarts on the next tick (${done.length} of ${steps.length} steps done)`)
            throw error
          }
          first = false
          done = [...done, step.name]
          await writeFileAtomic(progressFile, JSON.stringify({ sha, done }))
        }
        await fs.access(path.join(release, 'out', 'server', 'main.cjs'))
        await fs.access(path.join(release, 'out', 'renderer', 'index.html'))
        await writeFileAtomic(readyFile, JSON.stringify({ sha, at: new Date().toISOString() }))
      }
      if (!apply) return this.status('staged', sha)
      // The systemd job has a 20-minute limit. Never enter activation near that deadline: leave
      // enough time for both restart/health windows and rollback, then apply on the next tick.
      if (now() - started > BUILD_WINDOW_MS)
        return this.status('staged', sha, 'Build completed; reserving activation for the next tick')
      phase = 'preflight'
      const health = await this.runtime.ops('health') as Health
      if (!mayRestart(health)) return this.status('deferred', sha, 'Server operations are still active (spawn in progress or deliveries queued)')
      if (this.runtime.run('systemctl', ['--user', 'show', this.config.service, '-p', 'KillMode', '--value']).trim() !== 'process')
        throw new Error('Service must use KillMode=process to preserve tmux')
      if (this.runtime.run('systemctl', ['--user', 'show', this.config.service, '-p', 'WorkingDirectory', '--value']).trim() !== this.current)
        throw new Error('Service is not configured for managed releases')
      const previous = await fs.realpath(this.current)
      const panes = this.panes()
      const nodes = await this.nodes()
      await this.snapshot(sha, panes, nodes)
      // Recheck after the filesystem reads. Unreadable health, new server activity or a server that
      // restarted underneath the snapshot defers; a browser connecting meanwhile does not.
      const finalHealth = await this.runtime.ops('health') as Health
      if (!mayRestart(finalHealth) || finalHealth.startedAt !== health.startedAt)
        return this.status('deferred', sha, 'Server activity changed during preflight')
      phase = 'deploy'
      await this.pointTo(release)
      try {
        this.runtime.run('systemctl', ['--user', 'restart', this.config.service])
        await this.waitHealthy(health.startedAt)
        if (await this.runtime.runningDirectory() !== release) throw new Error('Server did not start from the verified release')
        await this.verifyContinuity(panes, nodes)
      } catch (error) {
        await this.pointTo(previous)
        this.runtime.run('systemctl', ['--user', 'restart', this.config.service])
        await this.waitHealthy(health.startedAt)
        if (await this.runtime.runningDirectory() !== previous) throw new Error('Rollback did not start the previous release')
        await this.verifyContinuity(panes, nodes)
        throw new Error('Update failed; previous release restored', { cause: error })
      }
      await writeFileAtomic(path.join(this.config.stateDir, 'deployed.json'), JSON.stringify({ sha, previous }))
      // A verified release can update this worker too. The current run already loaded its code;
      // the next timer tick receives the newly tested bundle, never an unbuilt source script.
      try {
        const worker = await fs.readFile(path.join(release, 'out/server/updater.cjs'), 'utf8')
        await writeFileAtomic(path.join(this.config.stateDir, 'updater.cjs'), worker)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      await this.prune(previous).catch((error) => console.warn('Release cleanup deferred:', error))
      return this.status('deployed', sha)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      if (phase === 'fetch' || phase === 'preflight') return this.status('deferred', sha, detail)
      // A build step that ran out of time says the host was busy, not that the commit is bad.
      // Field 2026-11-17: `npm test` passed file after file on a loaded host and hit the 15 min step
      // limit; the commit was quarantined until someone ran --retry by hand. Retry on later ticks,
      // a bounded number of times, then quarantine as before.
      if (phase === 'build' && sha && (error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
        const file = path.join(this.config.stateDir, 'build-timeouts.json')
        const prior = await this.readStatus('build-timeouts.json') as unknown as { sha?: string; count?: number } | undefined
        const count = (prior?.sha === sha ? prior.count ?? 0 : 0) + 1
        if (count < BUILD_TIMEOUT_ATTEMPTS) {
          await writeFileAtomic(file, JSON.stringify({ sha, count }))
          return this.status('deferred', sha, `Build step timed out (${count} of ${BUILD_TIMEOUT_ATTEMPTS}); retrying on a later tick: ${detail}`)
        }
      }
      if (sha) await writeFileAtomic(path.join(this.config.stateDir, 'failed.json'), JSON.stringify({ sha, detail }))
      return this.status('failed', sha, detail)
    }
  }
}
