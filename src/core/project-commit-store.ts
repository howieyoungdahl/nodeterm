import { promises as fs } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { renameAtomic } from './fs-atomic'
import { reconcileProjectDocuments, type ProjectDocument, type ProjectMerge } from '../shared/project-reconciliation'

export interface FileRevision { revision: string; raw: string }
export interface FileCommitRequest {
  clientId: string
  operationId: string
  expectedRevision: string
  proposed: string
}
export interface FileCreateRequest {
  clientId: string
  operationId: string
  expectedAbsence: true
  /** Caller-enrolled workspace index revision, retained as part of the immutable intent. */
  indexRevision: string
  proposed: string
}
export interface IndexBootstrapRequest {
  clientId: string
  operationId: string
  expectedAbsence: true
  bootstrapToken: string
  /** Immutable logical workspace request binds every subsequent phase, including child ID. */
  intent: string
}
export interface FileCommitResult {
  kind: 'committed' | 'already-applied' | 'conflict' | 'stale-base' | 'busy' |
    'publication-refused' | 'publication-unknown' | 'unavailable'
  recovery: string
  current?: FileRevision
  merge?: ProjectMerge
  message?: string
}
export type PublicationPhase = 'creation-prepared' | 'journaled' | 'before-displace' | 'displaced' | 'before-publish' | 'published' | 'receipted'
export const revisionOf = (raw: string): string => createHash('sha256').update(raw).digest('hex')
const errorCode = (error: unknown): string => (error as NodeJS.ErrnoException)?.code ?? ''
export class PublicationReadError extends Error {
  constructor(readonly code: 'E_PUBLICATION_BUSY' | 'E_PUBLICATION_UNAVAILABLE') {
    super(`${code}: Workspace publication is not readable yet. Retry the read; retained writer locks require explicit recovery.`)
  }
}
export const isPublicationReadError = (error: unknown): error is PublicationReadError => error instanceof PublicationReadError

/** Readers never interpret a coordinator's displaced slot as absence. A successful old
 * snapshot is legal; a read overlapping an unfinished publication is not. No lock is
 * acquired, stolen or cleared here, and retries do not infer writer liveness. */
async function publicationRead<T>(file: string, read: () => Promise<T>): Promise<T> {
  const recovery = path.join(path.dirname(file), '.recovery', path.basename(file))
  const unlocked = async (): Promise<void> => {
    try { await fs.lstat(path.join(recovery, 'writer.lock')) }
    catch (error) { if (errorCode(error) === 'ENOENT') return; throw error }
    throw new PublicationReadError('E_PUBLICATION_BUSY')
  }
  for (let attempt = 0; ; attempt++) {
    try {
      await unlocked()
      let value: T
      try { value = await read() }
      catch (error) {
        await unlocked()
        if (errorCode(error) === 'ENOENT') {
          try { await fs.lstat(recovery) }
          catch (missing) { if (errorCode(missing) === 'ENOENT') throw error; throw missing }
          throw new PublicationReadError('E_PUBLICATION_UNAVAILABLE')
        }
        throw error
      }
      await unlocked()
      return value
    } catch (error) {
      if (!(error instanceof PublicationReadError) || error.code !== 'E_PUBLICATION_BUSY' || attempt >= 4) throw error
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  }
}
export const readPublicationFile = (file: string): Promise<string> => publicationRead(file, () => fs.readFile(file, 'utf8'))
const jsonObject = (raw: string): ProjectDocument => {
  const value = JSON.parse(raw)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object')
  return value
}
const collections = ['nodes', 'bridges', 'ropes'] as const
type Tombstones = Record<typeof collections[number], string[]>
function tombstones(document: ProjectDocument): Tombstones {
  const meta = document._reconciliation as { deleted?: Partial<Tombstones> } | undefined
  return Object.fromEntries(collections.map((key) => [key,
    Array.isArray(meta?.deleted?.[key]) ? meta!.deleted![key]!.filter((id) => typeof id === 'string') : []
  ])) as Tombstones
}
function ids(document: ProjectDocument, key: string): string[] {
  const values = document[key]
  if (!Array.isArray(values)) return []
  return values.flatMap((value) => value && typeof value === 'object' && !Array.isArray(value) &&
    typeof value.id === 'string' ? [value.id] : [])
}
function content(document: ProjectDocument): ProjectDocument {
  const { rev: _rev, savedAt: _saved, _reconciliation: _meta, ...rest } = document
  return rest
}

/** Shared by updates and first creation; a syntactic merge need not be a valid graph. */
function graphRefusal(document: ProjectDocument): string | undefined {
  const nodes = Array.isArray(document.nodes) ? document.nodes as ProjectDocument[] : []
  const nodeIds = new Set(nodes.map((node) => node.id))
  const parents = new Map(nodes.map((node) => [node.id, node.parentId]))
  for (const node of nodes) {
    const seen = new Set([node.id])
    let parent = node.parentId
    while (parent) {
      if (!nodeIds.has(parent) || seen.has(parent)) return 'Merged parent graph is dangling or cyclic.'
      seen.add(parent); parent = parents.get(parent) ?? null
    }
  }
  for (const key of ['bridges', 'ropes']) {
    const edges = document[key]
    if (Array.isArray(edges) && edges.some((edge) => edge && typeof edge === 'object' && !Array.isArray(edge) &&
      (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)))) return 'Merged edge graph has a missing endpoint.'
  }
}

/** Cooperative cross-process coordinator. It NEVER replaces a publication destination with the
 * candidate. The displaced inode is retained, then fs.link creates the destination exclusively.
 * A raw writer winning either race keeps its bytes. Unsupported links/locked files refuse safely.
 * Locks are never stolen on age/PID guesses; abandoned locks require explicit recovery. */
export class ProjectCommitStore {
  readonly recovery: string
  constructor(readonly file: string, private phase?: (phase: PublicationPhase) => Promise<void>,
    private keyedLists?: ReadonlySet<string>) {
    this.recovery = path.join(path.dirname(file), '.recovery', path.basename(file))
  }

  private async durable(file: string, raw: string): Promise<void> {
    await this.directory(path.dirname(file))
    let handle
    try { handle = await fs.open(file, 'wx', 0o600) }
    catch (error) {
      if (errorCode(error) !== 'EEXIST' || await fs.readFile(file, 'utf8') !== raw) throw error
      return
    }
    try { await handle.writeFile(raw); await handle.sync() } finally { await handle.close() }
    await this.syncDirectory(path.dirname(file))
  }

  private async directory(dir: string): Promise<void> {
    try { await fs.mkdir(dir, { mode: 0o700 }); await this.syncDirectory(path.dirname(dir)) }
    catch (error) {
      if (errorCode(error) === 'ENOENT') { await this.directory(path.dirname(dir)); await this.directory(dir) }
      else if (errorCode(error) !== 'EEXIST') throw error
    }
  }

  private async syncDirectory(dir: string): Promise<void> {
    // Windows does not provide directory fsync through this API. Refuse durable-commit claims
    // there until a platform adapter supplies that guarantee; read/recovery stays available.
    const handle = await fs.open(dir, 'r')
    try { await handle.sync() } finally { await handle.close() }
  }

  async observe(): Promise<FileRevision> {
    return publicationRead(this.file, () => this.observeUnlocked())
  }

  private async observeUnlocked(): Promise<FileRevision> {
    if (!(await fs.lstat(this.file)).isFile()) throw new Error('E_REGULAR_FILE_REQUIRED')
    const raw = await fs.readFile(this.file, 'utf8')
    jsonObject(raw)
    const revision = revisionOf(raw)
    await this.durable(path.join(this.recovery, 'versions', `${revision}.json`), raw)
    const metadata = jsonObject(raw)._reconciliation
    if (metadata !== undefined && (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || metadata.version !== 1))
      throw new Error('E_UNSUPPORTED_RECONCILIATION_METADATA: exact bytes retained without rewriting')
    const deleted = await this.retainedDeleted()
    // Import portable evidence before returning a base. A later raw old-file replacement may
    // erase its embedded metadata, but cannot erase what this host already learned.
    const portable = tombstones(jsonObject(raw))
    for (const key of collections) for (const id of portable[key]) {
      await this.durable(path.join(this.recovery, 'tombstones', key, `${revisionOf(id)}.json`), JSON.stringify({ id }))
      if (!deleted[key].includes(id)) deleted[key].push(id)
    }
    if (collections.some((key) => ids(jsonObject(raw), key).some((id) => deleted[key].includes(id))))
      throw new Error('E_DELETED_ID_REPLAY: incoming bytes are retained but cannot become a new base')
    return { revision, raw }
  }

  async retainedDeleted(): Promise<Tombstones> {
    const deleted: Tombstones = { nodes: [], bridges: [], ropes: [] }
    for (const key of collections) {
      const dir = path.join(this.recovery, 'tombstones', key)
      let files: string[]
      try { files = await fs.readdir(dir) } catch (error) { if (errorCode(error) === 'ENOENT') continue; throw error }
      for (const file of files) {
        const value = JSON.parse(await fs.readFile(path.join(dir, file), 'utf8'))
        if (typeof value.id !== 'string' || file !== `${revisionOf(value.id)}.json`) throw new Error('Invalid tombstone evidence')
        deleted[key].push(value.id)
      }
    }
    return deleted
  }

  async known(revision: string): Promise<string | undefined> {
    if (!/^[a-f0-9]{64}$/.test(revision)) return undefined
    try {
      const raw = await fs.readFile(path.join(this.recovery, 'versions', `${revision}.json`), 'utf8')
      return revisionOf(raw) === revision ? raw : undefined
    } catch { return undefined }
  }

  async receipt(clientId: string, operationId: string): Promise<FileCommitResult | undefined> {
    const op = path.join(this.recovery, 'operations', revisionOf(`${clientId}\0${operationId}`))
    try { return JSON.parse(await fs.readFile(path.join(op, 'receipt.json'), 'utf8')) as FileCommitResult }
    catch { return undefined }
  }

  /** Create only a virgin destination. The existing recovery directory is the retained
   * history fence, not permission to reset a missing file. No destination is displaced. */
  async create(request: FileCreateRequest, checkScope?: () => Promise<string | undefined>): Promise<FileCommitResult> {
    return this.createVirgin(request, checkScope)
  }

  /** Distinct host-only empty-v3 constructor; ordinary project creation still requires a real index base. */
  async bootstrapIndex(request: IndexBootstrapRequest, checkScope: () => Promise<string | undefined>): Promise<FileCommitResult> {
    if (typeof checkScope !== 'function') return { kind: 'publication-refused', recovery: this.recovery, message: 'Fresh workspace scope is required.' }
    return this.createVirgin(request, checkScope, true)
  }

  private async createVirgin(request: FileCreateRequest | IndexBootstrapRequest,
    checkScope?: () => Promise<string | undefined>, bootstrap = false): Promise<FileCommitResult> {
    const op = path.join(this.recovery, 'operations', revisionOf(`${request.clientId}\0${request.operationId}`))
    const requestRaw = JSON.stringify(request)
    const result = (kind: FileCommitResult['kind'], extra: Partial<FileCommitResult> = {}): FileCommitResult =>
      ({ kind, recovery: op, ...extra })
    for (const parent of [path.dirname(this.file), path.dirname(this.recovery), this.recovery]) {
      try { if (!(await fs.lstat(parent)).isDirectory()) return result('publication-refused', { message: 'Creation history and parents must be real directories.' }) }
      catch (error) { if (errorCode(error) !== 'ENOENT') return result('unavailable', { message: String(error) }) }
    }
    // Read-back is allowed even with a retained crash lock. Never replay a journaled effect.
    try {
      const prior = await fs.readFile(path.join(op, 'request.json'), 'utf8')
      if (prior !== requestRaw) return result('stale-base', { message: 'Operation ID was reused with different input.' })
      const receipt = await this.receipt(request.clientId, request.operationId)
      return receipt ? { ...receipt, kind: receipt.kind === 'committed' ? 'already-applied' : receipt.kind } :
        result('publication-unknown', { message: 'An interrupted creation needs recovery; it was not replayed.' })
    } catch (error) { if (errorCode(error) !== 'ENOENT') return result('unavailable', { message: String(error) }) }
    // A host-derived leaf is not a license to follow a redirected inline/recovery directory.
    for (const parent of [path.dirname(this.file), path.dirname(this.recovery)]) {
      try { if (!(await fs.lstat(parent)).isDirectory()) return result('publication-refused', { message: 'Creation parent must be a real directory.' }) }
      catch (error) { if (errorCode(error) !== 'ENOENT') return result('unavailable', { message: String(error) }) }
    }
    await this.directory(path.dirname(this.recovery))
    try { await fs.mkdir(this.recovery, { mode: 0o700 }); await this.syncDirectory(path.dirname(this.recovery)) }
    catch (error) {
      if (errorCode(error) !== 'EEXIST') return result('unavailable', { message: String(error) })
      if (!(await fs.lstat(this.recovery)).isDirectory()) return result('publication-refused', { message: 'Creation history is not a real directory.' })
      const refused = path.join(this.recovery, 'refusals', `${revisionOf(requestRaw)}.json`)
      await this.durable(refused, requestRaw)
      let busy = false
      try { await fs.lstat(path.join(this.recovery, 'writer.lock')); busy = true } catch { /* history still refuses */ }
      return result(busy ? 'busy' : 'publication-refused', { recovery: refused,
        message: 'Creation requires virgin absence; retained history or another creation already owns this destination.' })
    }
    const lock = path.join(this.recovery, 'writer.lock')
    await fs.mkdir(lock)
    let published = false
    try {
      await this.durable(path.join(op, 'request.json'), requestRaw)
      await this.durable(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, operation: path.basename(op) }))
      await this.phase?.('creation-prepared')
      const projectRequest = request as FileCreateRequest, indexRequest = request as IndexBootstrapRequest
      if (request.expectedAbsence !== true || !/^[a-f0-9]{64}$/.test(bootstrap ? indexRequest.bootstrapToken : projectRequest.indexRevision) ||
        (bootstrap && typeof indexRequest.intent !== 'string'))
        return await this.finish(op, result('stale-base', { message: 'Explicit absence and enrolled index revision are required.' }))
      try {
        await fs.lstat(this.file)
        return await this.finish(op, result('publication-refused', { message: 'Creation destination already exists; it was not replaced.' }))
      } catch (error) { if (errorCode(error) !== 'ENOENT') throw error }
      await this.durable(path.join(op, 'absence.json'), JSON.stringify({ file: this.file, absent: true,
        ...(bootstrap ? { bootstrapToken: indexRequest.bootstrapToken } : { indexRevision: projectRequest.indexRevision }) }))
      const proposed = bootstrap ? { version: 3, activeProjectId: '', entries: [] } : jsonObject(projectRequest.proposed)
      if (!bootstrap && (proposed.version !== 1 || typeof proposed.id !== 'string' || !Array.isArray(proposed.nodes) || proposed._reconciliation !== undefined))
        return await this.finish(op, result('conflict', { message: 'Creation requires a new version-1 project, not historical reconciliation metadata.' }))
      const validated = reconcileProjectDocuments(proposed, proposed, proposed)
      const invalid = graphRefusal(validated.document)
      if (validated.kind === 'conflict' || invalid)
        return await this.finish(op, result('conflict', { merge: validated, message: invalid }))
      const candidate = JSON.stringify({ ...validated.document, rev: 1, savedAt: new Date().toISOString(),
        _reconciliation: { version: 1, deleted: { nodes: [], bridges: [], ropes: [] } } }, null, 2) + '\n'
      await this.durable(path.join(op, 'candidate.json'), candidate)
      await this.phase?.('journaled')
      const publication = path.join(op, 'publication.json')
      await this.durable(publication, candidate)
      await this.phase?.('before-publish')
      if (checkScope) {
        let refusal: string | undefined
        try { refusal = await checkScope() } catch (error) { refusal = `Creation index scope unavailable: ${String(error)}` }
        if (refusal) return await this.finish(op, result('publication-refused', { message: refusal }))
      }
      try { await fs.link(publication, this.file) }
      catch (error) { return await this.finish(op, result('publication-refused', { message: `Exclusive creation refused (${errorCode(error)}); no destination was overwritten.` })) }
      published = true
      await this.syncDirectory(path.dirname(this.file))
      await this.phase?.('published')
      const observed = await fs.readFile(this.file, 'utf8')
      if (observed !== candidate) {
        await this.durable(path.join(this.recovery, 'versions', `${revisionOf(observed)}.json`), observed)
        return await this.finish(op, result('publication-unknown', { message: 'Destination changed after creation; candidate and competing bytes retained.' }))
      }
      const current = { revision: revisionOf(candidate), raw: candidate }
      await this.durable(path.join(this.recovery, 'versions', `${current.revision}.json`), candidate)
      const receipt = await this.finish(op, result('committed', { current }))
      await this.phase?.('receipted')
      return receipt
    } catch (error) {
      return result(published ? 'publication-unknown' : 'unavailable', { message: String(error) })
    } finally {
      // Only this creation's own lock. A killed process retains it and never loses history.
      await fs.rm(lock, { recursive: true, force: true })
    }
  }

  async commit(request: FileCommitRequest, conditional?: {
    /** Trusted coordinator guard, not request data. Runs under writer.lock and before publication. */
    check(current: FileRevision): string | undefined
    /** Creation's index delta keeps the normal retained-base merge; organizer CAS stays exact. */
    mergeRetainedBase?: boolean
  }): Promise<FileCommitResult> {
    const op = path.join(this.recovery, 'operations', revisionOf(`${request.clientId}\0${request.operationId}`))
    const requestRaw = JSON.stringify(request)
    const result = (kind: FileCommitResult['kind'], extra: Partial<FileCommitResult> = {}): FileCommitResult =>
      ({ kind, recovery: op, ...extra })
    await this.directory(op)
    try {
      const prior = await fs.readFile(path.join(op, 'request.json'), 'utf8')
      if (prior !== requestRaw) return result('stale-base', { message: 'Operation ID was reused with different input.' })
      try {
        const receipt = JSON.parse(await fs.readFile(path.join(op, 'receipt.json'), 'utf8')) as FileCommitResult
        return { ...receipt, kind: receipt.kind === 'committed' ? 'already-applied' : receipt.kind }
      } catch { return result('publication-unknown', { message: 'An interrupted operation needs recovery; it was not replayed.' }) }
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') return result('unavailable')
    }
    const lock = path.join(this.recovery, 'writer.lock')
    try { await fs.mkdir(lock) }
    catch { return result('busy', { message: 'Another or interrupted writer holds the coordinator lock.' }) }
    let displaced = false
    let published = false
    const displacedFile = path.join(op, 'displaced.json')
    try {
      // Preserve the submitted bytes even when its base is unknown or its revision has expired.
      await this.durable(path.join(op, 'request.json'), requestRaw)
      await this.durable(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, operation: path.basename(op) }))
      const baseRaw = await this.known(request.expectedRevision)
      if (!baseRaw) return await this.finish(op, result('stale-base', { message: 'The exact acknowledged base is not retained.' }))
      const current = await this.observeUnlocked()
      if (conditional && !conditional.mergeRetainedBase && current.revision !== request.expectedRevision)
        return await this.finish(op, result('publication-refused', { current, message: 'stale-revision' }))
      const check = (): void => {
        const refusal = conditional?.check(current)
        if (refusal) throw new Error(`E_CONDITIONAL_REFUSAL: ${refusal}`)
      }
      check()
      const base = jsonObject(baseRaw), local = jsonObject(request.proposed), incoming = jsonObject(current.raw)
      if (base.id !== incoming.id || base.id !== local.id)
        return await this.finish(op, result('conflict', { current, message: 'Project file identity changed; explicit re-enrollment is required.' }))
      const deleted = tombstones(incoming)
      const retained = await this.retainedDeleted()
      for (const key of collections) deleted[key] = [...new Set([...deleted[key], ...retained[key]])]
      const merged = reconcileProjectDocuments(content(base), content(local), content(incoming), new Set(deleted.nodes), this.keyedLists)
      for (const key of ['bridges', 'ropes'] as const) {
        for (const id of ids(merged.document, key).filter((id) => deleted[key].includes(id))) {
          merged.kind = 'conflict'
          merged.conflicts.push({ path: [key, id], kind: 'deleted-node', base: { present: false },
            local: { present: true, value: local[key] }, incoming: { present: true, value: incoming[key] ?? [] } })
        }
      }
      if (merged.kind === 'conflict') return await this.finish(op, result('conflict', { current, merge: merged }))
      const invalid = graphRefusal(merged.document)
      if (invalid) return await this.finish(op, result('conflict', { current, message: invalid }))
      for (const key of collections) {
        const retained = new Set(ids(merged.document, key))
        deleted[key] = [...new Set([...deleted[key], ...ids(base, key).filter((id) => !retained.has(id)),
          ...ids(incoming, key).filter((id) => !retained.has(id))])]
      }
      const metadata = incoming._reconciliation as ProjectDocument | undefined
      const previousDeleted = metadata?.deleted && typeof metadata.deleted === 'object' && !Array.isArray(metadata.deleted)
        ? metadata.deleted : {}
      const candidate = JSON.stringify({ ...merged.document, rev: Math.max(Number(incoming.rev) || 0, Number(base.rev) || 0) + 1,
        savedAt: new Date().toISOString(), _reconciliation: { ...metadata, version: 1, deleted: { ...previousDeleted, ...deleted } } }, null, 2) + '\n'
      await this.durable(path.join(op, 'candidate.json'), candidate)
      await this.phase?.('journaled')
      await this.phase?.('before-displace')
      check()
      // Unlike replace-by-rename, this moves whichever inode actually occupies the destination
      // into retained recovery. An external write after observe() is captured by this operation.
      await renameAtomic(this.file, displacedFile)
      displaced = true
      await this.syncDirectory(path.dirname(this.file))
      await this.syncDirectory(op)
      await this.phase?.('displaced')
      if (!(await fs.lstat(displacedFile)).isFile()) throw new Error('E_REGULAR_FILE_REQUIRED')
      const displacedRaw = await fs.readFile(displacedFile, 'utf8')
      await this.durable(path.join(this.recovery, 'versions', `${revisionOf(displacedRaw)}.json`), displacedRaw)
      if (displacedRaw !== current.raw) {
        await this.restore(displacedFile)
        return await this.finish(op, result('publication-refused', {
          current: { revision: revisionOf(displacedRaw), raw: displacedRaw },
          message: 'An external write arrived before publication. Its file and your proposal are retained.'
        }))
      }
      await this.phase?.('before-publish')
      // Do not hard-link the immutable candidate itself: an in-place editor would mutate history.
      const publication = path.join(op, 'publication.json')
      await this.durable(publication, candidate)
      check()
      try { await fs.link(publication, this.file) }
      catch (error) {
        await this.restore(displacedFile)
        return await this.finish(op, result('publication-refused', { message:
          `Exclusive publication refused (${errorCode(error)}). The destination was not overwritten.` }))
      }
      published = true
      await this.syncDirectory(path.dirname(this.file))
      await this.phase?.('published')
      check()
      const observed = await fs.readFile(this.file, 'utf8')
      if (observed !== candidate) {
        await this.durable(path.join(this.recovery, 'versions', `${revisionOf(observed)}.json`), observed)
        return await this.finish(op, result('publication-unknown', { message:
          'The destination changed after publication. The operation and displaced file remain recoverable.' }))
      }
      const committed = { revision: revisionOf(candidate), raw: candidate }
      for (const key of collections) for (const id of deleted[key])
        await this.durable(path.join(this.recovery, 'tombstones', key, `${revisionOf(id)}.json`), JSON.stringify({ id }))
      await this.durable(path.join(this.recovery, 'versions', `${committed.revision}.json`), candidate)
      const receipt = await this.finish(op, result('committed', { current: committed }))
      await this.phase?.('receipted')
      return receipt
    } catch (error) {
      if (displaced && !published) await this.restore(displacedFile)
      if (error instanceof Error && error.message.startsWith('E_CONDITIONAL_REFUSAL:'))
        return await this.finish(op, result(published ? 'publication-unknown' : 'publication-refused', { message: error.message }))
      return result(published ? 'publication-unknown' : 'unavailable', { message: String(error) })
    } finally {
      // This call created this exact lock. A crash leaves it present and every new writer refuses.
      await fs.rm(lock, { recursive: true, force: true })
    }
  }

  private async restore(displaced: string): Promise<void> {
    try { await fs.link(displaced, this.file); await this.syncDirectory(path.dirname(this.file)) }
    catch { /* Never replace a destination another writer created. Recovery remains at displaced. */ }
  }

  private async finish(op: string, result: FileCommitResult): Promise<FileCommitResult> {
    await this.durable(path.join(op, 'receipt.json'), JSON.stringify(result))
    return result
  }
}
