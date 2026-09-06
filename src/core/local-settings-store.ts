import { promises as fs, opendirSync, lstatSync, openSync, fstatSync, readSync, closeSync, constants } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { ProjectCommitStore, revisionOf, type FileRevision } from './project-commit-store'
import { sanitizeProjectLocalSettings } from '../shared/project-settings'
import { sameProjectJson } from '../shared/project-reconciliation'
import { validateLocalSettingsChanges, type LocalSettingsRequest, type LocalSettingsOutcome, type LocalSettingsView } from '../shared/local-settings-reconciliation'

interface Bound { kind: 'local-settings'; snapshot: FileRevision; projectId: string; history: string[] }
const indexKeys = new Set(['entries'])
const object = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value)
function entry(raw: string, id: string): Record<string, any> {
  const index = JSON.parse(raw)
  if (index.version !== 3 || !Array.isArray(index.entries)) throw new Error('Local settings require an available v3 index')
  const found = index.entries.filter((item: unknown) => object(item) && item.id === id)
  const deleted = index._reconciliation?.deleted?.entries
  if (found.length !== 1 || (deleted !== undefined && (!Array.isArray(deleted) || deleted.includes(id))))
    throw new Error('Local-settings target is absent, ambiguous or tombstoned')
  if (found[0].remote || found[0].unavailable) throw new Error('Local-settings target scope is unsupported')
  return found[0]
}
const identity = (value: Record<string, any>) => [value.id, value.cwd ?? null, value.ssh ?? null, value.dataFile ?? null, value.remote ?? null]

/** Bounded evidence reads, not a hostile-writer filesystem sandbox. Refuse redirects/change;
 * inspect the opened descriptor and cap actual consumption, including a +1 growth sentinel. */
export function readLocalSettingsEvidence(file: string, cap: number): string {
  const stat = lstatSync(file), fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = fstatSync(fd)
    if (!stat.isFile() || !opened.isFile() || opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size > cap)
      throw new Error('Local-settings evidence changed, redirected or exceeded its byte bound')
    const buffer = Buffer.alloc(Math.min(cap + 1, 64 * 1024)), parts: Buffer[] = []
    let count = 0, n: number
    do {
      n = readSync(fd, buffer, 0, Math.min(buffer.length, cap - count + 1), null)
      count += n
      if (count > cap) throw new Error('Local-settings evidence grew beyond its byte bound')
      if (n) parts.push(Buffer.from(buffer.subarray(0, n)))
    } while (n)
    const end = fstatSync(fd), named = lstatSync(file)
    if (end.size !== opened.size || end.mtimeMs !== opened.mtimeMs || end.ctimeMs !== opened.ctimeMs ||
        named.ino !== opened.ino || named.dev !== opened.dev || !named.isFile())
      throw new Error('Local-settings evidence changed during the bounded read')
    return Buffer.concat(parts).toString('utf8')
  } finally { closeSync(fd) }
}

/** An index-only adapter, sharing the coordinator's enrollment directory, immutable versions,
 * writer lock and receipts. Opaque read enrollment is cooperative binding, not agent authority. */
export class LocalSettingsStore {
  constructor(private file: string, private clientDir: (id: string) => string,
    private enroll: (id: string, value: unknown) => Promise<void>) {}
  private store() { return new ProjectCommitStore(this.file, undefined, indexKeys) }

  private realDirectory(dir: string): void {
    const root = path.dirname(this.file)
    for (let current = dir; ; current = path.dirname(current)) {
      if (!lstatSync(current).isDirectory()) throw new Error('Local-settings evidence directory is redirected or unavailable')
      if (current === root) return
      if (current === path.dirname(current)) throw new Error('Local-settings evidence escaped its host directory')
    }
  }
  private files(dir: string): string[] {
    this.realDirectory(dir)
    const before = lstatSync(dir), handle = opendirSync(dir), files: string[] = []
    try {
      for (let next = handle.readSync(); next; next = handle.readSync()) {
        if (files.length === 4096) throw new Error('Local-settings evidence exceeds 4096 entries')
        files.push(next.name)
      }
    } finally { handle.closeSync() }
    this.realDirectory(dir)
    const after = lstatSync(dir)
    if (before.ino !== after.ino || before.dev !== after.dev || before.mtimeMs !== after.mtimeMs)
      throw new Error('Local-settings evidence directory changed during enumeration')
    return files
  }
  private evidence(file: string, cap = 32 * 1024 * 1024): string {
    this.realDirectory(path.dirname(file))
    const raw = readLocalSettingsEvidence(file, cap)
    this.realDirectory(path.dirname(file))
    return raw
  }

  // Synchronous by design: the existing conditional publication guard runs under writer.lock.
  // Capture the set BEFORE the read; every subsequently retained observation must preserve scope.
  // Thus an ABA cannot hide behind today's identical raw hash. Missing/pruned history refuses.
  private history(): Map<string, string> {
    const dir = path.join(this.store().recovery, 'versions')
    let files: string[]
    try { files = this.files(dir) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // Only absent history is allowed initially; existing parents may not redirect it.
        for (let parent = path.dirname(dir); parent !== path.dirname(this.file); parent = path.dirname(parent)) {
          try { this.realDirectory(parent) } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
        }
        return new Map()
      }
      throw error
    }
    let bytes = 0
    const result = new Map<string, string>()
    for (const file of files) {
      if (!/^[a-f0-9]{64}\.json$/.test(file))
        throw new Error('Local-settings history is unverifiable or exceeds 32 MiB')
      const raw = this.evidence(path.join(dir, file), 32 * 1024 * 1024 - bytes)
      bytes += Buffer.byteLength(raw)
      const revision = file.slice(0, -5)
      if (revisionOf(raw) !== revision) throw new Error('Local-settings history is corrupt')
      result.set(revision, raw)
    }
    return result
  }
  private scope(bound: Bound, current: FileRevision): string | undefined {
    try {
      const expected = identity(entry(bound.snapshot.raw, bound.projectId)), history = this.history()
      if (bound.history.some((revision) => !history.has(revision))) throw new Error('Local-settings lineage was pruned')
      const check = (raw: string) => {
        if (!sameProjectJson(expected, identity(entry(raw, bound.projectId)))) throw new Error('Local-settings target was relocated or reused')
      }
      check(current.raw)
      for (const [revision, raw] of history) if (!bound.history.includes(revision)) check(raw)
    } catch (error) { return String(error) }
  }
  async read(projectId: string): Promise<(LocalSettingsView & { entry: Record<string, any> }) | null> {
    const history = [...this.history().keys()], store = this.store(), snapshot = await store.observe()
    const index = JSON.parse(snapshot.raw)
    if (Array.isArray(index.entries) && !index.entries.some((item: any) => item?.id === projectId)) return null
    const target = entry(snapshot.raw, projectId), bound: Bound = { kind: 'local-settings', snapshot, projectId, history }
    const refusal = this.scope(bound, snapshot)
    if (refusal) throw new Error(refusal)
    if ((await store.observe()).revision !== snapshot.revision) throw new Error('Local-settings read changed; retry')
    const clientId = randomUUID()
    await this.enroll(clientId, bound)
    return { clientId, indexRevision: snapshot.revision, projectId, local: sanitizeProjectLocalSettings(target.localSettings), entry: target }
  }
  private async bound(request: LocalSettingsRequest): Promise<Bound> {
    const dir = this.clientDir(request.clientId), files = this.files(dir)
    let bytes = 0
    for (const file of files) {
      if (!/^[a-f0-9-]{36}\.json$/.test(file)) continue
      const raw = this.evidence(path.join(dir, file), 32 * 1024 * 1024 - bytes)
      bytes += Buffer.byteLength(raw)
      const value = JSON.parse(raw) as Bound
      if (value.kind === 'local-settings' && value.projectId === request.projectId && value.snapshot.revision === request.indexRevision &&
          revisionOf(value.snapshot.raw) === request.indexRevision && Array.isArray(value.history)) return value
    }
    throw new Error('No exact caller-enrolled local-settings base')
  }
  async update(projectId: string, input: unknown): Promise<LocalSettingsOutcome> {
    const operationId = object(input) && typeof input.operationId === 'string' ? input.operationId : ''
    const failure = (kind: LocalSettingsOutcome['kind'], message: string): LocalSettingsOutcome => ({ kind, operationId, message })
    let attempted = false
    try {
      if (!object(input) || input.projectId !== projectId || !operationId || operationId.length > 200 ||
          !/^[a-f0-9]{64}$/.test(input.indexRevision) || Object.keys(input).some((key) =>
            !['clientId', 'indexRevision', 'projectId', 'operationId', 'changes'].includes(key))) throw new Error('Expected exact local-settings request')
      validateLocalSettingsChanges(input.changes)
      const request = input as LocalSettingsRequest, bound = await this.bound(request)
      const index = JSON.parse(bound.snapshot.raw), target = entry(bound.snapshot.raw, projectId)
      const local = target.localSettings === undefined ? {} : structuredClone(target.localSettings)
      if (!object(local)) throw new Error('Malformed retained local-settings object')
      for (const change of request.changes) {
        if (local[change.family] !== undefined && !object(local[change.family])) throw new Error('Malformed retained local-settings family')
        const family = local[change.family] ??= {}
        if (change.envKey !== undefined) {
          if (family.env !== undefined && !object(family.env)) throw new Error('Malformed retained environment')
          const env = family.env ??= {}
          if (change.remove) delete env[change.envKey]
          else Object.defineProperty(env, change.envKey, { value: change.value, enumerable: true, configurable: true, writable: true })
          if (!Object.keys(env).length) delete family.env
        } else if (change.remove) delete family[change.key]
        else family[change.key] = structuredClone(change.value)
        if (!Object.keys(family).length) delete local[change.family]
      }
      const proposedEntry = index.entries.find((item: any) => item.id === projectId)
      if (Object.keys(local).length) proposedEntry.localSettings = local
      else delete proposedEntry.localSettings
      // Immutable intent lives beside this caller's existing enrollment, including wire delta.
      const intent = path.join(this.clientDir(request.clientId), `local-${revisionOf(operationId)}.json`), raw = JSON.stringify(request)
      let handle
      try { handle = await fs.open(intent, 'wx', 0o600) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || this.evidence(intent, 1024 * 1024) !== raw) throw new Error('Local-settings operation was reused or is unresolved') }
      if (handle) {
        try { await handle.writeFile(raw); await handle.sync() } finally { await handle.close() }
        const dir = await fs.open(path.dirname(intent), 'r'); try { await dir.sync() } finally { await dir.close() }
      }
      const store = this.store()
      attempted = true
      const result = await store.commit({ clientId: request.clientId, operationId: `local-settings:${operationId}`,
        expectedRevision: request.indexRevision, proposed: JSON.stringify(index) },
      { mergeRetainedBase: true, check: (current) => this.scope(bound, current) })
      const recovery = path.join(store.recovery, 'operations', revisionOf(`${request.clientId}\0local-settings:${operationId}`))
      const outcome: LocalSettingsOutcome = { kind: result.kind, operationId, recovery, message: result.message }
      if (result.kind === 'committed' || result.kind === 'already-applied') {
        // A partial/malformed receipt is not proof. Verify its exact retained candidate first.
        const receipt = result.current
        const candidate = this.evidence(path.join(recovery, 'candidate.json'))
        if (result.recovery !== recovery || !receipt || revisionOf(receipt.raw) !== receipt.revision || receipt.raw !== candidate ||
            this.evidence(path.join(store.recovery, 'versions', `${receipt.revision}.json`)) !== receipt.raw)
          return { ...outcome, kind: 'publication-unknown', message: 'Local-settings receipt is incomplete; no replay' }
        outcome.receiptRevision = receipt.revision
        try {
          const fresh = await this.read(projectId)
          if (fresh) {
            const raw = await store.known(fresh.indexRevision)
            if (!raw || this.scope(bound, { revision: fresh.indexRevision, raw })) throw new Error('Receipt target lineage no longer matches')
            const { entry: _entry, ...current } = fresh; outcome.current = current
          }
        } catch { /* Durable success may outlive a readable current target. Never return old local values. */ }
      }
      return outcome
    } catch (error) { return failure(attempted ? 'publication-unknown' : 'publication-refused', String(error)) }
  }
}
