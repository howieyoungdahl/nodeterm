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
