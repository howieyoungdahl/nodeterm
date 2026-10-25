import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { RecoveryRetention } from './project-recovery-retention'
import { ProjectCommitStore, readPublicationFile, revisionOf } from './project-commit-store'

let root: string, file: string, recovery: string
const now = Date.now(), old = new Date(now - 30 * 86400000)
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-retention-'))
  file = path.join(root, 'project.json')
  recovery = path.join(root, '.recovery', 'project.json')
  await fs.writeFile(file, '{"nodes":[],"rev":1}')
  await fs.mkdir(path.join(recovery, 'versions'), { recursive: true })
})
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }) })
async function version(raw: string, date = old) {
  const target = path.join(recovery, 'versions', `${revisionOf(raw)}.json`)
  await fs.writeFile(target, raw); await fs.utimes(target, date, date)
  return target
}
async function operation(id: string, kind?: string) {
  const dir = path.join(recovery, 'operations', revisionOf(id))
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'request.json'), '{}')
  if (kind) await fs.writeFile(path.join(dir, 'receipt.json'), JSON.stringify({ kind }))
  const date = new Date(now - 60 * 86400000)
  await fs.utimes(dir, date, date)
  return dir
}
const policy = { days: 7, minVersions: 2, batchSize: 64 }

it('prunes expired history while keeping recent, floor, current, pending and deletion evidence', async () => {
  const current = await version(await fs.readFile(file, 'utf8'))
  const expired = await version('{"rev":0}')
  const floor = await version('{"rev":2}', new Date(now - 20 * 86400000))
  const recent = await version('{"rev":3}', new Date(now))
  const complete = await operation('complete', 'committed')
  const pending = await operation('pending'), unknown = await operation('unknown', 'publication-unknown')
  const protectedFile = path.join(recovery, 'tombstones', 'nodes', 'evidence.json')
  await fs.mkdir(path.dirname(protectedFile), { recursive: true }); await fs.writeFile(protectedFile, 'evidence')
  expect((await new RecoveryRetention(file, policy, () => now).pass()).removed).toBe(2)
  for (const kept of [current, floor, recent, pending, unknown, protectedFile]) await expect(fs.lstat(kept)).resolves.toBeDefined()
  for (const removed of [expired, complete]) await expect(fs.lstat(removed)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('bounds each pass, respects publication locks and resumes after interruption', async () => {
  await version(await fs.readFile(file, 'utf8'), new Date(now))
  for (let i = 0; i < 5; i++) await version(JSON.stringify({ rev: i + 10 }))
  const runner = new RecoveryRetention(file, { ...policy, minVersions: 1, batchSize: 2 }, () => now)
  await fs.mkdir(path.join(recovery, 'writer.lock'))
  expect((await runner.pass()).removed).toBe(0)
  await fs.rmdir(path.join(recovery, 'writer.lock'))
  expect((await runner.pass()).removed).toBe(2)
  // A killed process has no prune lock or journal to recover.
  const resumed = new RecoveryRetention(file, { ...policy, minVersions: 1, batchSize: 2 }, () => now)
  expect((await resumed.pass()).removed).toBe(2)
  expect((await resumed.pass()).removed).toBe(1)
  expect(await readPublicationFile(file)).toBe(await fs.readFile(file, 'utf8'))
})

it('preserves a version made current after the plan was created', async () => {
  await version(await fs.readFile(file, 'utf8'), new Date(now))
  const later = '{"nodes":[],"rev":20}', held = await version(later)
  await version('{"rev":10}', new Date(old.getTime() - 1000))
  const runner = new RecoveryRetention(file, { ...policy, minVersions: 1, batchSize: 1 }, () => now)
  await runner.pass()
  await fs.writeFile(file, later)
  await runner.pass()
  await expect(fs.readFile(held, 'utf8')).resolves.toBe(later)
})

it.skipIf(process.platform === 'win32')('does not traverse a redirected history directory', async () => {
  const external = path.join(root, 'external')
  await fs.mkdir(external)
  const victim = path.join(external, `${revisionOf('victim')}.json`)
  await fs.writeFile(victim, 'victim')
  await fs.rm(path.join(recovery, 'versions'), { recursive: true })
  await fs.symlink(external, path.join(recovery, 'versions'))
  expect((await new RecoveryRetention(file, policy).pass()).removed).toBe(0)
  expect(await fs.readFile(victim, 'utf8')).toBe('victim')
})

it.skipIf(process.platform === 'win32')('rechecks a cached plan after its parent directory is redirected', async () => {
  await version(await fs.readFile(file, 'utf8'), new Date(now))
  await version('{"rev":10}', new Date(old.getTime() - 1000))
  const victim = await version('{"rev":11}')
  const runner = new RecoveryRetention(file, { ...policy, minVersions: 1, batchSize: 1 }, () => now)
  await runner.pass()
  const external = path.join(root, 'old-versions')
  // Atomic publication is irrelevant to this adversarial fixture's deliberate redirect.
  await fs.cp(path.join(recovery, 'versions'), external, { recursive: true })
  await fs.rm(path.join(recovery, 'versions'), { recursive: true })
  await fs.symlink(external, path.join(recovery, 'versions'))
  await runner.pass()
  expect(await fs.readFile(path.join(external, path.basename(victim)), 'utf8')).toBe('{"rev":11}')
})

it('keeps an interrupted operation readable if a prune fails halfway through', async () => {
  await version(await fs.readFile(file, 'utf8'), new Date(now))
  const dir = await operation('interrupted-prune', 'committed')
  await fs.writeFile(path.join(dir, 'candidate.json'), '{}'); await fs.utimes(dir, old, old)
  const unlink = fs.unlink
  vi.spyOn(fs, 'unlink').mockImplementation(async target => {
    if (String(target).endsWith('request.json')) throw new Error('simulated power interruption')
    return unlink(target)
  })
  await expect(new RecoveryRetention(file, policy, () => now).pass()).rejects.toThrow('simulated power interruption')
  vi.restoreAllMocks()
  expect(JSON.parse(await fs.readFile(path.join(dir, 'receipt.json'), 'utf8')).kind).toBe('committed')
  expect(await readPublicationFile(file)).toContain('"nodes":[]')
})

it.skipIf(process.platform === 'win32')('allows a publication while an expired-version removal is paused', async () => {
  const raw = await fs.readFile(file, 'utf8')
  await version(raw, new Date(now))
  const expired = await version('{"nodes":[],"rev":0}')
  let reached!: () => void, release!: () => void
  const paused = new Promise<void>(resolve => { reached = resolve })
  const resume = new Promise<void>(resolve => { release = resolve })
  const unlink = fs.unlink
  vi.spyOn(fs, 'unlink').mockImplementation(async target => {
    if (String(target) === expired) { reached(); await resume }
    return unlink(target)
  })
  const pruning = new RecoveryRetention(file, { ...policy, minVersions: 1 }, () => now).pass()
  await paused
  try {
    const committed = await new ProjectCommitStore(file).commit({ clientId: 'fixture', operationId: 'during-prune',
      expectedRevision: revisionOf(raw), proposed: '{"nodes":[],"rev":1,"name":"Saved during prune"}' })
    expect(committed.kind).toBe('committed')
    expect(await fs.readFile(file, 'utf8')).toBe(committed.current!.raw)
    await expect(fs.readFile(path.join(recovery, 'versions', `${committed.current!.revision}.json`), 'utf8')).resolves.toBe(committed.current!.raw)
  } finally { release(); await pruning }
})
