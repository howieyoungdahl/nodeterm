import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { buildSync } from 'esbuild'
import { ProjectCommitStore, revisionOf, type PublicationPhase } from './project-commit-store'
import { writeFileAtomic } from './fs-atomic'

let dir: string, file: string
const original = JSON.stringify({ version: 1, id: 'fixture', name: 'Base', rev: 1,
  nodes: [{ id: 'n1', title: 'Base', position: { x: 0, y: 0 } }], future: { retained: true } })
const edit = (raw: string, mutate: (doc: any) => void): string => {
  const doc = JSON.parse(raw); mutate(doc); return JSON.stringify(doc)
}
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-commit-'))
  file = path.join(dir, 'project.json'); await writeFileAtomic(file, original)
})
afterEach(async () => {
  const evidence = process.env.NODETERM_RECONCILIATION_EVIDENCE_DIR
  if (evidence) {
    await fs.mkdir(evidence, { recursive: true })
    await fs.cp(dir, path.join(evidence, path.basename(dir)), { recursive: true, force: false, errorOnExist: true })
  }
  await fs.rm(dir, { recursive: true, force: true })
})
const request = (base: string, proposed: string, operationId = 'op') =>
  ({ clientId: 'client', operationId, expectedRevision: base, proposed })

const creation = (operationId = 'create', proposed = original) => ({ clientId: 'client', operationId,
  expectedAbsence: true as const, indexRevision: revisionOf('fixture enrolled index'), proposed })

describe('typed empty-v3 bootstrap uses the exclusive retained publisher', () => {
  const bootstrap = (operationId = 'bootstrap') => ({ clientId: 'client', operationId,
    expectedAbsence: true as const, bootstrapToken: revisionOf('enrolled absence'), intent: '{"child":"first"}' })
  const fresh = async () => undefined

  it('constructs only empty v3 and never relaxes the ordinary project gate', async () => {
    const target = path.join(dir, 'workspace.json'), store = new ProjectCommitStore(target)
    const result = await store.bootstrapIndex(bootstrap(), fresh)
    expect(result.kind).toBe('committed')
    expect(JSON.parse(result.current!.raw)).toMatchObject({ version: 3, entries: [], activeProjectId: '' })
    expect(await store.known(result.current!.revision)).toBe(result.current!.raw)
    expect((await store.bootstrapIndex({ ...bootstrap(), intent: '{"child":"different"}' }, fresh)).kind).toBe('stale-base')
    expect((await new ProjectCommitStore(path.join(dir, 'ordinary.json')).create({ ...creation(), indexRevision: '' })).kind).toBe('stale-base')
    expect((await new ProjectCommitStore(path.join(dir, 'wrong-schema.json')).create(creation('new', '{"version":3,"entries":[]}'))).kind).toBe('conflict')
  })

  it('two concurrent coordinators keep exactly one virgin-history claim', async () => {
    const target = path.join(dir, 'workspace.json')
    let reached!: () => void, release!: () => void
    const paused = new Promise<void>((resolve) => { reached = resolve }), held = new Promise<void>((resolve) => { release = resolve })
    const writing = new ProjectCommitStore(target, async (phase) => { if (phase === 'journaled') { reached(); await held } }).bootstrapIndex(bootstrap(), fresh)
    await paused
    try {
      const loser = await new ProjectCommitStore(target).bootstrapIndex(bootstrap('loser'), fresh)
      expect(loser.kind).toBe('busy'); expect(await fs.readFile(loser.recovery, 'utf8')).toContain('loser')
    } finally { release() }
    const result = await writing
    expect(result.kind).toBe('committed'); expect(await fs.readFile(target, 'utf8')).toBe(result.current!.raw)
  })

  it.each(['before-publish', 'published'] as PublicationPhase[])('never overwrites an interposed index at %s', async (phase) => {
    const target = path.join(dir, 'workspace.json'), winner = '{"version":3,"entries":[],"external":"keep"}'
    const store = new ProjectCommitStore(target, async (at) => { if (at === phase) await fs.writeFile(target, winner) })
    const result = await store.bootstrapIndex(bootstrap(), fresh)
    expect(result.kind).toBe(phase === 'published' ? 'publication-unknown' : 'publication-refused')
    expect(await fs.readFile(target, 'utf8')).toBe(winner)
    expect(JSON.parse(await fs.readFile(path.join(result.recovery, 'candidate.json'), 'utf8')).entries).toEqual([])
    expect((await new ProjectCommitStore(target).bootstrapIndex(bootstrap(), fresh)).kind).toBe(result.kind)
  })

  it.each(['creation-prepared', 'journaled', 'published', 'receipted'] as PublicationPhase[])
  ('real disposable bootstrap writer kill at %s retains exact intent, lock, and receipt boundary', async (phase) => {
    const target = path.join(dir, 'workspace.json'), input = bootstrap()
    const bundle = buildSync({ entryPoints: [path.resolve('src/core/project-commit-store.ts')], bundle: true,
      platform: 'node', format: 'cjs', write: false }).outputFiles[0].text
    const code = bundle + `\nnew module.exports.ProjectCommitStore(${JSON.stringify(target)}, async phase => {
      if (phase === ${JSON.stringify(phase)}) { process.send('paused'); await new Promise(() => {}) }
    }).bootstrapIndex(${JSON.stringify(input)}, async () => undefined); setInterval(() => {}, 1000);`
    const child = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
    try {
      expect(await once(child, 'message')).toEqual(['paused', undefined])
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited
      const reopened = new ProjectCommitStore(target), result = await reopened.bootstrapIndex(input, fresh)
      expect(result.kind).toBe(phase === 'receipted' ? 'already-applied' : 'publication-unknown')
      expect((await reopened.bootstrapIndex(bootstrap('hidden-retry'), fresh)).kind).toBe('busy')
      expect((await fs.lstat(path.join(reopened.recovery, 'writer.lock'))).isDirectory()).toBe(true)
      const op = path.join(reopened.recovery, 'operations', revisionOf('client\0bootstrap'))
      expect(JSON.parse(await fs.readFile(path.join(op, 'request.json'), 'utf8'))).toEqual(input)
      if (phase === 'published' || phase === 'receipted') expect(JSON.parse(await fs.readFile(target, 'utf8')).entries).toEqual([])
      else await expect(fs.lstat(target)).rejects.toMatchObject({ code: 'ENOENT' })
      if (phase === 'receipted') expect(result.current!.raw).toBe(await fs.readFile(target, 'utf8'))
      else await expect(fs.lstat(path.join(op, 'receipt.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') }
  })
})

describe('exclusive first creation in the retained coordinator', () => {
  it('preserves unknown bytes in immutable history and returns only an exact durable receipt', async () => {
    const target = path.join(dir, 'new.json'), store = new ProjectCommitStore(target)
    const result = await store.create(creation())
    expect(result.kind).toBe('committed')
    expect(JSON.parse(result.current!.raw)).toMatchObject({ rev: 1, future: { retained: true }, nodes: [{ id: 'n1' }] })
    expect(await store.known(result.current!.revision)).toBe(result.current!.raw)
    expect((await new ProjectCommitStore(target).create(creation())).kind).toBe('already-applied')
    expect((await store.create(creation('create', edit(original, (d) => { d.name = 'changed' })))).kind).toBe('stale-base')
    expect(await fs.readFile(target, 'utf8')).toBe(result.current!.raw)
  })

  it('allows one of two stores to win creation without replacing either proposal', async () => {
    const target = path.join(dir, 'new.json')
    let reached!: () => void, release!: () => void
    const paused = new Promise<void>((resolve) => { reached = resolve })
    const held = new Promise<void>((resolve) => { release = resolve })
    const first = new ProjectCommitStore(target, async (phase) => { if (phase === 'journaled') { reached(); await held } })
    const writing = first.create(creation())
    await paused
    try {
      const losing = await new ProjectCommitStore(target).create(creation('loser', edit(original, (d) => { d.name = 'Loser retained' })))
      expect(losing.kind).toBe('busy')
      expect(await fs.readFile(losing.recovery, 'utf8')).toContain('Loser retained')
    } finally { release() }
    expect((await writing).kind).toBe('committed')
    expect(JSON.parse(await fs.readFile(target, 'utf8')).name).toBe('Base')
  })

  it.each(['before-publish', 'published'] as PublicationPhase[])('retains an interposed raw writer at creation %s', async (phase) => {
    const target = path.join(dir, 'new.json'), external = edit(original, (d) => { d.name = 'External winner' })
    const store = new ProjectCommitStore(target, async (at) => { if (at === phase) await fs.writeFile(target, external) })
    const result = await store.create(creation())
    expect(result.kind).toBe(phase === 'published' ? 'publication-unknown' : 'publication-refused')
    expect(await fs.readFile(target, 'utf8')).toBe(external)
    expect(JSON.parse(await fs.readFile(path.join(result.recovery, 'candidate.json'), 'utf8')).name).toBe('Base')
    expect((await new ProjectCommitStore(target).create(creation())).kind).toBe(result.kind)
    expect((await new ProjectCommitStore(target).create(creation('hidden-retry'))).kind).toBe('publication-refused')
  })

  it.each(['file', 'directory', 'symlink', 'history', 'lock'])('refuses non-virgin %s without replacing or clearing it', async (kind) => {
    const target = path.join(dir, 'new.json'), store = new ProjectCommitStore(target)
    if (kind === 'file' || kind === 'history') await fs.writeFile(target, original)
    if (kind === 'directory') await fs.mkdir(target)
    if (kind === 'symlink') await fs.symlink(file, target)
    if (kind === 'history') { await store.observe(); await fs.unlink(target) }
    if (kind === 'lock') await fs.mkdir(path.join(store.recovery, 'writer.lock'), { recursive: true })
    const result = await store.create(creation())
    expect(result.kind).toBe(kind === 'lock' ? 'busy' : 'publication-refused')
    if (kind === 'history') { expect(await store.known(revisionOf(original))).toBe(original); await expect(fs.lstat(target)).rejects.toMatchObject({ code: 'ENOENT' }) }
    if (kind === 'lock') expect((await fs.stat(path.join(store.recovery, 'writer.lock'))).isDirectory()).toBe(true)
    if (kind === 'symlink') expect((await fs.lstat(target)).isSymbolicLink()).toBe(true)
    if (kind === 'directory') expect((await fs.lstat(target)).isDirectory()).toBe(true)
    expect(await fs.readFile(file, 'utf8')).toBe(original)
  })

  it.each(['duplicate', 'parent', 'edge', 'historical'])('uses canonical identity/graph validation for %s creation', async (kind) => {
    const target = path.join(dir, 'new.json')
    const proposed = edit(original, (d) => {
      if (kind === 'duplicate') d.nodes.push(d.nodes[0])
      if (kind === 'parent') d.nodes[0].parentId = 'n1'
      if (kind === 'edge') d.bridges = [{ id: 'edge', source: 'n1', target: 'missing' }]
      if (kind === 'historical') d._reconciliation = { version: 1, deleted: { nodes: ['old'] } }
    })
    expect((await new ProjectCommitStore(target).create(creation('invalid', proposed))).kind).toBe('conflict')
    await expect(fs.lstat(target)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['published', 'receipted'] as PublicationPhase[])('distinguishes missing receipt from missing ACK at %s', async (phase) => {
    const target = path.join(dir, 'new.json')
    const store = new ProjectCommitStore(target, async (at) => { if (at === phase) throw new Error('fixture interruption') })
    expect((await store.create(creation())).kind).toBe('publication-unknown')
    const bytes = await fs.readFile(target, 'utf8')
    expect((await new ProjectCommitStore(target).create(creation())).kind).toBe(phase === 'receipted' ? 'already-applied' : 'publication-unknown')
    expect(await fs.readFile(target, 'utf8')).toBe(bytes)
  })

  it.each(['creation-prepared', 'journaled', 'published'] as PublicationPhase[])('retains a real killed creation writer at %s without replay', async (phase) => {
    const target = path.join(dir, 'new.json'), input = creation()
    const bundle = buildSync({ entryPoints: [path.resolve('src/core/project-commit-store.ts')], bundle: true,
      platform: 'node', format: 'cjs', write: false }).outputFiles[0].text
    const code = bundle + `\nnew module.exports.ProjectCommitStore(${JSON.stringify(target)}, async phase => {
      if (phase === ${JSON.stringify(phase)}) { process.send('paused'); await new Promise(() => {}) }
    }).create(${JSON.stringify(input)}); setInterval(() => {}, 1000);`
    const child = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
    try {
      expect(await once(child, 'message')).toEqual(['paused', undefined])
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited
      const reopened = new ProjectCommitStore(target)
      expect((await reopened.create(input)).kind).toBe('publication-unknown')
      expect((await reopened.create(creation('new-id'))).kind).toBe('busy')
      const op = path.join(reopened.recovery, 'operations', revisionOf('client\0create'))
      expect(await fs.readFile(path.join(op, 'request.json'), 'utf8')).toContain('expectedAbsence')
      if (phase !== 'creation-prepared') expect(await fs.readFile(path.join(op, 'candidate.json'), 'utf8')).toContain('Base')
      if (phase === 'published') expect(JSON.parse(await fs.readFile(target, 'utf8')).name).toBe('Base')
      else await expect(fs.lstat(target)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') }
  }, 15000)
})

describe('retained publication, using real disposable files', () => {
  it('merges independent edits from different loaded bases and retains exact unknown fields', async () => {
    const a = new ProjectCommitStore(file), b = new ProjectCommitStore(file)
    const old = await a.observe()
    const first = await b.commit(request(old.revision, edit(old.raw, (d) => { d.name = 'Other client' }), 'first'))
    expect(first.kind).toBe('committed')
    const latest = await b.observe()
    expect(latest.revision).not.toBe(old.revision)
    const result = await a.commit(request(old.revision, edit(old.raw, (d) => { d.nodes[0].position.x = 42 })))
    expect(result.kind).toBe('committed')
    expect(JSON.parse(result.current!.raw)).toMatchObject({ name: 'Other client', future: { retained: true }, nodes: [{ position: { x: 42 } }] })
    expect(await a.known(old.revision)).toBe(original)
  })

  it.each(['before-displace', 'before-publish'] as PublicationPhase[])('refuses a raw writer interposed at %s without replacing its bytes', async (phase) => {
    const external = edit(original, (d) => { d.name = 'External only copy' })
    const store = new ProjectCommitStore(file, async (at) => { if (at === phase) await writeFileAtomic(file, external) })
    const base = await store.observe()
    const result = await store.commit(request(base.revision, edit(base.raw, (d) => { d.name = 'Local' })))
    expect(result.kind).toBe('publication-refused')
    expect(await fs.readFile(file, 'utf8')).toBe(external)
    expect(await fs.readFile(path.join(result.recovery, 'request.json'), 'utf8')).toContain('Local')
    expect(await fs.readFile(path.join(result.recovery, 'displaced.json'), 'utf8')).toBe(phase === 'before-displace' ? external : original)
  })

  it('keeps late writes through an already-open descriptor in the displaced inode', async () => {
    const descriptor = await fs.open(file, 'r+')
    const external = edit(original, (d) => { d.name = 'Late raw FD' })
    try {
      const store = new ProjectCommitStore(file, async (at) => {
        if (at === 'published') { await descriptor.truncate(0); await descriptor.writeFile(external); await descriptor.sync() }
      })
      const base = await store.observe()
      const result = await store.commit(request(base.revision, edit(base.raw, (d) => { d.name = 'Local' })))
      expect(result.kind).toBe('committed')
      expect(await fs.readFile(path.join(result.recovery, 'displaced.json'), 'utf8')).toBe(external)
      expect(await store.known(base.revision)).toBe(original)
    } finally { await descriptor.close() }
  })

  it('replays a durable receipt after a lost acknowledgment and refuses operation-ID reuse', async () => {
    const store = new ProjectCommitStore(file, async (at) => { if (at === 'receipted') throw new Error('lost ack') })
    const base = await store.observe(), input = request(base.revision, edit(base.raw, (d) => { d.name = 'Saved' }))
    expect((await store.commit(input)).kind).toBe('publication-unknown')
    expect((await new ProjectCommitStore(file).commit(input)).kind).toBe('already-applied')
    expect((await store.commit({ ...input, proposed: original })).kind).toBe('stale-base')
    expect(JSON.parse(await fs.readFile(file, 'utf8')).name).toBe('Saved')
  })

  it('retains unknown-base proposals without touching the destination', async () => {
    const store = new ProjectCommitStore(file)
    const result = await store.commit(request('not-enrolled', '{"name":"never discard"}'))
    expect(result.kind).toBe('stale-base')
    expect(await fs.readFile(file, 'utf8')).toBe(original)
    expect(await fs.readFile(path.join(result.recovery, 'request.json'), 'utf8')).toContain('never discard')
  })

  it('retains deletion evidence across a new store, stale reconnect and raw old-file replay', async () => {
    const store = new ProjectCommitStore(file), base = await store.observe()
    expect((await store.commit(request(base.revision, edit(base.raw, (d) => { d.nodes = [] })))).kind).toBe('committed')
    const reopened = new ProjectCommitStore(file)
    expect((await reopened.retainedDeleted()).nodes).toEqual(['n1'])
    expect((await reopened.commit(request(base.revision, edit(base.raw, (d) => { d.nodes[0].title = 'stale edit' }), 'stale'))).kind).toBe('conflict')
    await writeFileAtomic(file, original)
    await expect(reopened.observe()).rejects.toThrow('E_DELETED_ID_REPLAY')
    expect(await reopened.known(revisionOf(original))).toBe(original)
  })

  it('refuses cyclic parents that are created only by merging two otherwise valid edits', async () => {
    await writeFileAtomic(file, edit(original, (d) => { d.nodes.push({ id: 'n2' }) }))
    const store = new ProjectCommitStore(file), base = await store.observe()
    expect((await store.commit(request(base.revision, edit(base.raw, (d) => { d.nodes[0].parentId = 'n2' }), 'one'))).kind).toBe('committed')
    expect(await store.commit(request(base.revision, edit(base.raw, (d) => { d.nodes[1].parentId = 'n1' }), 'two')))
      .toMatchObject({ kind: 'conflict', message: 'Merged parent graph is dangling or cyclic.' })
  })

  it('banks tombstones learned from a portable file even after its metadata is replaced', async () => {
    const store = new ProjectCommitStore(file)
    await writeFileAtomic(file, edit(original, (d) => {
      d.nodes = []; d._reconciliation = { version: 1, deleted: { nodes: ['n1'], bridges: [], ropes: [] } }
    }))
    await store.observe()
    await writeFileAtomic(file, original)
    await expect(new ProjectCommitStore(file).observe()).rejects.toThrow('E_DELETED_ID_REPLAY')
  })

  it.each(['journaled', 'displaced', 'published'] as PublicationPhase[])('survives a real writer-process kill at %s and never steals its lock', async (phase) => {
    const store = new ProjectCommitStore(file), base = await store.observe()
    const input = request(base.revision, edit(base.raw, (d) => { d.name = 'Child proposal' }))
    const bundle = buildSync({ entryPoints: [path.resolve('src/core/project-commit-store.ts')], bundle: true,
      platform: 'node', format: 'cjs', write: false }).outputFiles[0].text
    const code = bundle + `\nnew module.exports.ProjectCommitStore(${JSON.stringify(file)}, async phase => {
      if (phase === ${JSON.stringify(phase)}) { process.send('paused'); await new Promise(() => {}) }
    }).commit(${JSON.stringify(input)}); setInterval(() => {}, 1000);`
    const child = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
    try {
      await once(child, 'message')
      expect((await store.commit({ ...input, operationId: 'competing' })).kind).toBe('busy')
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited
      expect((await new ProjectCommitStore(file).commit(input)).kind).toBe('publication-unknown')
      expect((await new ProjectCommitStore(file).commit({ ...input, operationId: 'restart' })).kind).toBe('busy')
      const op = path.join(store.recovery, 'operations', revisionOf('client\0op'))
      expect(await fs.readFile(path.join(op, 'candidate.json'), 'utf8')).toContain('Child proposal')
      if (phase !== 'journaled') expect(await fs.readFile(path.join(op, 'displaced.json'), 'utf8')).toBe(original)
      if (phase === 'displaced') await expect(fs.access(file)).rejects.toThrow()
      else expect(await fs.readFile(file, 'utf8')).toContain(phase === 'published' ? 'Child proposal' : 'Base')
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') }
  }, 15000)
})
