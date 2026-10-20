import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { buildSync } from 'esbuild'
import { ProjectCommitStore, readPublicationFile, revisionOf, type PublicationPhase } from './project-commit-store'
import { recoverInterruptedPublication, recoverWorkspacePublications } from './workspace-publication-recovery'
import { workspaceWriterIdentity } from './workspace-writer-identity'

let dir: string, file: string, store: ProjectCommitStore, bundle: string
const raw = JSON.stringify({ version: 1, id: 'fixture', name: 'Saved canvas', nodes: [] }) + '\n'
const proposed = JSON.stringify({ version: 1, id: 'fixture', name: 'Interrupted proposal', nodes: [] }) + '\n'
const operation = revisionOf('recovery-test\0interrupted')
const lock = () => path.join(store.recovery, 'writer.lock')
const op = () => path.join(store.recovery, 'operations', operation)
beforeAll(() => {
  bundle = buildSync({ entryPoints: [path.resolve('src/core/project-commit-store.ts')], bundle: true,
    platform: 'node', format: 'cjs', write: false }).outputFiles[0].text
})
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-startup-recovery-'))
  file = path.join(dir, 'project.json'); store = new ProjectCommitStore(file)
  await fs.writeFile(file, raw)
})
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }) })

async function interrupt(phase: PublicationPhase, options: { live?: boolean; create?: boolean } = {}) {
  const request = options.create
    ? { clientId: 'recovery-test', operationId: 'interrupted', expectedAbsence: true, indexRevision: revisionOf('index'), proposed }
    : { clientId: 'recovery-test', operationId: 'interrupted', expectedRevision: (await store.observe()).revision, proposed }
  if (options.create) await fs.unlink(file)
  const code = bundle + `\nnew module.exports.ProjectCommitStore(${JSON.stringify(file)}, async phase => {
    if (phase === ${JSON.stringify(phase)}) {
      ${options.live ? 'setInterval(() => {}, 1000); process.send("locked"); await new Promise(() => {})' : 'process.exit(23)'}
    }
  }).${options.create ? 'create' : 'commit'}(${JSON.stringify(request)}, ${options.create ? 'async () => undefined' : 'undefined'});`
  const child = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  if (options.live) {
    // Keep a child alive in its publication phase, rather than relying on a quiet PID.
    const ready = once(child, 'message'), exited = once(child, 'exit').then(() => { throw new Error('writer exited before pause') })
    await Promise.race([ready, exited])
  } else {
    expect((await once(child, 'exit'))[0]).toBe(23)
    if (child.connected) child.disconnect()
  }
  return child
}

describe.skipIf(process.platform !== 'linux')('explicit Linux startup recovery', () => {
  it.each(['locked', 'journaled', 'displaced', 'before-publish', 'published', 'receipted'] as PublicationPhase[])
  ('recovers a terminated real writer at %s and allows a fresh save without acknowledging the interrupted one', async phase => {
    await interrupt(phase)
    const request = await fs.readFile(path.join(op(), 'request.json'), 'utf8')
    const receipt = await fs.readFile(path.join(op(), 'receipt.json'), 'utf8').catch(() => undefined)
    await expect(readPublicationFile(file)).rejects.toThrow('E_PUBLICATION_BUSY')
    expect(await recoverInterruptedPublication(file)).toMatchObject({ status: 'recovered' })
    expect(await fs.readFile(path.join(op(), 'request.json'), 'utf8')).toBe(request)
    expect(await fs.readFile(path.join(op(), 'receipt.json'), 'utf8').catch(() => undefined)).toBe(receipt)
    expect(await fs.readFile(path.join(op(), 'interrupted-writer.lock/owner.json'), 'utf8')).toContain('identity')
    const current = await readPublicationFile(file)
    expect(JSON.parse(current).name).toBe(['published', 'receipted'].includes(phase) ? 'Interrupted proposal' : 'Saved canvas')
    const base = await store.observe()
    const result = await store.commit({ clientId: 'recovery-test', operationId: 'fresh', expectedRevision: base.revision,
      proposed: JSON.stringify({ ...JSON.parse(base.raw), name: 'Fresh save' }) })
    expect(result.kind).toBe('committed')
    expect(JSON.parse(await readPublicationFile(file)).name).toBe('Fresh save')
    expect(await recoverInterruptedPublication(file)).toMatchObject({ status: 'none' })
  })

  it('keeps a live exact writer locked even during a startup recovery attempt', async () => {
    const child = await interrupt('locked', { live: true })
    try {
      expect(await recoverInterruptedPublication(file)).toMatchObject({ status: 'refused', reason: expect.stringContaining('live') })
      await expect(readPublicationFile(file)).rejects.toThrow('E_PUBLICATION_BUSY')
    } finally {
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited
      if (child.connected) child.disconnect()
    }
    expect(await recoverInterruptedPublication(file)).toMatchObject({ status: 'recovered' })
  })

  it.each(['legacy', 'foreign-host', 'foreign-namespace', 'missing-owner', 'invalid-owner'] as const)
  ('preserves %s lock evidence instead of guessing that the writer died', async kind => {
    await interrupt('locked')
    const ownerFile = path.join(lock(), 'owner.json'), owner = JSON.parse(await fs.readFile(ownerFile, 'utf8'))
    if (kind === 'legacy') delete owner.identity
    if (kind === 'foreign-host') owner.identity.host = 'f'.repeat(64)
    if (kind === 'foreign-namespace') owner.identity.namespace = 'pid:[99999999]'
    if (kind === 'missing-owner') await fs.unlink(ownerFile)
    else await fs.writeFile(ownerFile, kind === 'invalid-owner' ? '{' : JSON.stringify(owner))
    expect(await recoverInterruptedPublication(file)).toMatchObject({ status: 'refused' })
    expect((await fs.lstat(lock())).isDirectory()).toBe(true)
    expect(await fs.readFile(file, 'utf8')).toBe(raw)
  })

  it('recognizes a prior host boot without relying on a reused live PID', async () => {
    await interrupt('locked')
    const ownerFile = path.join(lock(), 'owner.json'), owner = JSON.parse(await fs.readFile(ownerFile, 'utf8'))
    owner.pid = process.pid; owner.identity = { ...await workspaceWriterIdentity(), boot: '00000000-0000-0000-0000-000000000000' }
    await fs.writeFile(ownerFile, JSON.stringify(owner))
    expect(await recoverInterruptedPublication(file)).toMatchObject({ status: 'recovered' })
  })

  it('recognizes PID reuse by process birth evidence', async () => {
    await interrupt('locked')
    const ownerFile = path.join(lock(), 'owner.json'), owner = JSON.parse(await fs.readFile(ownerFile, 'utf8'))
    owner.pid = process.pid; owner.identity = { ...await workspaceWriterIdentity(), start: '0' }
    await fs.writeFile(ownerFile, JSON.stringify(owner))
    expect(await recoverInterruptedPublication(file)).toMatchObject({ status: 'recovered' })
  })

  it.each(['external-winner', 'corrupt-current', 'corrupt-candidate', 'unknown-displaced', 'redirected-operation'] as const)
  ('refuses %s and preserves uncertain evidence', async kind => {
    await interrupt('displaced')
    if (kind === 'external-winner') await fs.writeFile(file, '{"external":"winner"}')
    if (kind === 'corrupt-current') await fs.writeFile(file, '{')
    if (kind === 'corrupt-candidate') await fs.writeFile(path.join(op(), 'candidate.json'), '{')
    if (kind === 'unknown-displaced') await fs.writeFile(path.join(op(), 'displaced.json'), '{"external":"unknown"}')
    if (kind === 'redirected-operation') {
      const target = op() + '-redirected'; await fs.rename(op(), target); await fs.symlink(target, op())
    }
    const before = await fs.readFile(file, 'utf8').catch(() => undefined)
    expect(await recoverInterruptedPublication(file)).toMatchObject({ status: 'refused' })
    expect(await fs.readFile(file, 'utf8').catch(() => undefined)).toBe(before)
    expect((await fs.lstat(lock())).isDirectory()).toBe(true)
  })

  it('retains only one lock archive when recovery races, and does not move a later writer', async () => {
    await interrupt('locked')
    const results = await Promise.all([recoverInterruptedPublication(file), recoverInterruptedPublication(file)])
    expect(results.filter(r => r.status === 'recovered')).toHaveLength(1)
    await fs.mkdir(lock())
    const later = JSON.stringify({ pid: process.pid, operation: revisionOf('later'), identity: await workspaceWriterIdentity() })
    await fs.writeFile(path.join(lock(), 'owner.json'), later)
    expect(await recoverInterruptedPublication(file)).toMatchObject({ status: 'refused' })
    expect(await fs.readFile(path.join(lock(), 'owner.json'), 'utf8')).toBe(later)
  })

  it('keeps first-creation absence fenced and recovers an actually published creation', async () => {
    await interrupt('creation-prepared', { create: true })
    expect(await recoverInterruptedPublication(file)).toMatchObject({ status: 'refused' })
    await expect(fs.lstat(file)).rejects.toMatchObject({ code: 'ENOENT' })
    // A separate fresh destination tests the published-creation boundary.
    file = path.join(dir, 'created.json'); store = new ProjectCommitStore(file)
    await fs.writeFile(file, raw)
    await interrupt('published', { create: true })
    expect(await recoverInterruptedPublication(file)).toMatchObject({ status: 'recovered' })
    expect(JSON.parse(await readPublicationFile(file)).name).toBe('Interrupted proposal')
  })

  it('recovers the index before discovering local refs, skips SSH and leaves ordinary reads conservative', async () => {
    const indexFile = path.join(dir, 'workspace.json'), projectDir = path.join(dir, 'folder')
    await fs.mkdir(path.join(projectDir, '.nodeterm'), { recursive: true })
    file = path.join(projectDir, '.nodeterm/project.json'); store = new ProjectCommitStore(file)
    await fs.writeFile(file, raw); await interrupt('locked')
    const projectFile = file
    const indexRaw = JSON.stringify({ version: 3, entries: [{ id: 'p', cwd: projectDir },
      { id: 'remote', cwd: '/not-a-local-project', ssh: { host: 'example' } }] })
    await fs.writeFile(indexFile, indexRaw)
    file = indexFile; store = new ProjectCommitStore(file)
    // Build an actual interrupted index operation with unchanged index intent.
    const base = await store.observe(), request = { clientId: 'recovery-test', operationId: 'interrupted', expectedRevision: base.revision, proposed: indexRaw }
    const child = spawn(process.execPath, ['-e', bundle + `\nnew module.exports.ProjectCommitStore(${JSON.stringify(file)}, async p => { if(p==='locked')process.exit(23) }).commit(${JSON.stringify(request)});`])
    expect((await once(child, 'exit'))[0]).toBe(23)
    const result = await recoverWorkspacePublications(dir)
    expect(result).toEqual([{ file: indexFile, status: 'recovered' }, { file: projectFile, status: 'recovered' }])
    expect(await readPublicationFile(indexFile)).toBe(indexRaw)
    expect(await readPublicationFile(projectFile)).toBe(raw)
  })
})
