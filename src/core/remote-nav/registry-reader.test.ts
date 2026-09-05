import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import {
  REGISTRY_ENV_VAR,
  VIEW_PREFS_FILENAME,
  readTaskRegistry,
  readViewPrefs,
  viewPrefsPathFor,
  writeViewPrefs
} from './registry-reader'
import { DEFAULT_VIEW_PREFS, NAV_TMUX_SOCKET, navSessionName } from '../../shared/remote-nav/model'
import { TMUX_SOCKET, sessionName } from '../tmux-naming'
import { FIXTURE_BASE_EPOCH, generateFixture } from '../../shared/remote-nav/fixture'

const { registry } = generateFixture({ nodeCount: 40, taskCount: 9, projectCount: 3, unregisteredCount: 2 })
const NOW_MS = FIXTURE_BASE_EPOCH * 1000
const ABS = '/state/registry.json'

const env = (value?: string): NodeJS.ProcessEnv => (value === undefined ? {} : { [REGISTRY_ENV_VAR]: value })

describe('the tmux names the model prints are the app’s own', () => {
  // The model declares them locally so it carries no runtime imports and the CLI can load it from
  // source (see its header). This is the drift guard for that decision, and it lives here because
  // `src/shared` must not reach into `src/core`.
  it('the socket name matches', () => {
    expect(NAV_TMUX_SOCKET).toBe(TMUX_SOCKET)
  })

  it('the per-node session name matches, including its sanitizing', () => {
    for (const id of ['term-mtnp91fa-ec023cee', 'a b;c', '', 'weird/name']) {
      expect(navSessionName(id)).toBe(sessionName(id))
    }
  })
})

describe('readTaskRegistry — five answers, none of them an empty list', () => {
  it('an unset variable is "not configured", not "no tasks"', async () => {
    const read = await readTaskRegistry({ env: env(), now: () => NOW_MS })
    expect(read.ok).toBe(false)
    expect(read.ok === false && read.kind).toBe('no-registry-configured')
  })

  it('a blank variable is the same as an unset one', async () => {
    const read = await readTaskRegistry({ env: env('   '), now: () => NOW_MS })
    expect(read.ok === false && read.kind).toBe('no-registry-configured')
  })

  it('a relative path is refused with its own reason, and nothing is read', async () => {
    let reads = 0
    const read = await readTaskRegistry({
      env: env('state/registry.json'),
      readFile: async () => {
        reads++
        return '{}'
      },
      now: () => NOW_MS
    })
    expect(read.ok === false && read.kind).toBe('no-registry-configured')
    expect(read.message).toMatch(/must be absolute/)
    expect(reads).toBe(0)
  })

  it('ENOENT is missing', async () => {
    const read = await readTaskRegistry({
      env: env(ABS),
      readFile: async () => {
        throw Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' })
      },
      now: () => NOW_MS
    })
    expect(read.ok === false && read.kind).toBe('registry-missing')
  })

  it('every other read error is UNREADABLE, because a failed read is not evidence of absence', async () => {
    for (const code of ['EACCES', 'EISDIR', 'EIO', undefined]) {
      const read = await readTaskRegistry({
        env: env(ABS),
        readFile: async () => {
          throw Object.assign(new Error(`${code ?? 'boom'}: nope`), code ? { code } : {})
        },
        now: () => NOW_MS
      })
      expect(read.ok === false && read.kind, String(code)).toBe('registry-unreadable')
    }
  })

  it('bad JSON is unparseable and carries the parser’s own detail', async () => {
    const read = await readTaskRegistry({
      env: env(ABS),
      readFile: async () => '{ "tasks": [',
      now: () => NOW_MS
    })
    expect(read.ok === false && read.kind).toBe('registry-unparseable')
    expect(read.ok === false && read.kind === 'registry-unparseable' && read.detail.length).toBeGreaterThan(0)
  })

  it('reads a good registry and passes its provenance through untouched', async () => {
    const text = JSON.stringify(registry)
    const read = await readTaskRegistry({ env: env(ABS), readFile: async () => text, now: () => NOW_MS })
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.path).toBe(ABS)
    expect(read.registry.generated_at).toBe(registry.generated_at)
    expect(read.registry.generated_at_epoch).toBe(registry.generated_at_epoch)
    expect(read.registry.source.generation).toBe(registry.source.generation)
    expect(read.registry.host_boot_epoch).toBe(registry.host_boot_epoch)
    expect(read.staleness.generatedBeforeHostBoot).toBe(false)
    // Verbatim means verbatim: what came out is what went in.
    expect(JSON.parse(JSON.stringify(read.registry))).toEqual(JSON.parse(text))
  })

  it('flags a registry generated before the host booted without discarding it', async () => {
    const text = JSON.stringify({ ...registry, host_boot_epoch: FIXTURE_BASE_EPOCH + 3600 })
    const read = await readTaskRegistry({ env: env(ABS), readFile: async () => text, now: () => NOW_MS })
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.staleness.generatedBeforeHostBoot).toBe(true)
    expect(read.registry.tasks.length).toBeGreaterThan(0)
  })

  it('never throws, whatever the reader does', async () => {
    await expect(
      readTaskRegistry({
        env: env(ABS),
        readFile: async () => {
          throw 'a string, not an Error'
        },
        now: () => NOW_MS
      })
    ).resolves.toMatchObject({ ok: false })
  })
})

describe('view-prefs.json lives beside the registry and is written atomically', () => {
  let dir: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'remote-nav-reader-'))
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('is a sibling of the registry file, not of a cwd', () => {
    expect(viewPrefsPathFor('/state/registry.json')).toBe(path.join('/state', VIEW_PREFS_FILENAME))
  })

  it('round-trips through the real filesystem', async () => {
    const registryPath = path.join(dir, 'registry.json')
    const prefs = { version: 1 as const, view: 'active' as const, sort: { key: 'stage' as const, direction: 'desc' as const }, collapseWorkers: false }
    const result = await writeViewPrefs(registryPath, prefs)
    expect(result.persisted).toBe(true)
    expect(result.path).toBe(path.join(dir, VIEW_PREFS_FILENAME))
    expect(await readViewPrefs(registryPath)).toEqual(prefs)
  })

  it('leaves no temp litter behind', async () => {
    const registryPath = path.join(dir, 'registry.json')
    await writeViewPrefs(registryPath, DEFAULT_VIEW_PREFS)
    expect((await fs.readdir(dir)).filter((f) => f.includes('.tmp'))).toEqual([])
  })

  it('falls back to the defaults for a missing or corrupt file, because a layout is not a fact', async () => {
    const registryPath = path.join(dir, 'registry.json')
    expect(await readViewPrefs(registryPath)).toEqual(DEFAULT_VIEW_PREFS)
    await fs.writeFile(path.join(dir, VIEW_PREFS_FILENAME), 'not json at all')
    expect(await readViewPrefs(registryPath)).toEqual(DEFAULT_VIEW_PREFS)
  })

  it('re-validates a hand-edited file rather than trusting its shape', async () => {
    const registryPath = path.join(dir, 'registry.json')
    await fs.writeFile(
      path.join(dir, VIEW_PREFS_FILENAME),
      JSON.stringify({ view: 'constructor', sort: { key: 'toString', direction: 'sideways' }, collapseWorkers: 'yes' })
    )
    expect(await readViewPrefs(registryPath)).toEqual(DEFAULT_VIEW_PREFS)
  })

  it('reports a failed save as not persisted instead of throwing', async () => {
    const result = await writeViewPrefs(path.join(dir, 'registry.json'), DEFAULT_VIEW_PREFS, {
      writeFile: async () => {
        throw new Error('disk full')
      }
    })
    expect(result.persisted).toBe(false)
    expect(result.error).toContain('disk full')
  })

  it('writes through writeFileAtomic, so a reader never sees a half-written file', async () => {
    // Guarded structurally by `src/core/fs-atomic.guard.test.ts` (a bare fs.rename is banned);
    // asserted behaviourally here: the published file is always complete, valid JSON.
    const registryPath = path.join(dir, 'registry.json')
    await Promise.all([
      writeViewPrefs(registryPath, { ...DEFAULT_VIEW_PREFS, view: 'active' }),
      writeViewPrefs(registryPath, { ...DEFAULT_VIEW_PREFS, view: 'inactive' }),
      writeViewPrefs(registryPath, { ...DEFAULT_VIEW_PREFS, view: 'primary' })
    ])
    const text = await fs.readFile(path.join(dir, VIEW_PREFS_FILENAME), 'utf-8')
    expect(() => JSON.parse(text)).not.toThrow()
    expect(['active', 'inactive', 'primary']).toContain(JSON.parse(text).view)
  })
})
