import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { constants as fsConstants, promises as fs } from 'node:fs'
import type { Project, Workspace } from '../shared/types'
import type { WorkspaceRevisionView, WorkspaceRevisionRequest, WorkspaceRevisionOutcome, ProjectRevisionOutcome } from '../shared/workspace-reconciliation'
import { reconcileProjectDocuments, type ProjectDocument } from '../shared/project-reconciliation'
import { projectEntityView } from '../shared/project-view'
import { LocalSettingsStore } from './local-settings-store'
import { ProjectCommitStore, revisionOf, readPublicationFile, isPublicationReadError, type FileRevision, type FileCommitResult } from './project-commit-store'
import { fileToProject, projectToFile, splitWorkspace, inlineProjectFileRelPath, isInlineProjectFileId,
  type IndexEntryV3, type ProjectFileV1 } from './workspace-files'

interface BoundView { file: string; snapshot: FileRevision; project: Project; entry: IndexEntryV3 }
interface BoundClient {
  projects: Map<string, Map<string, BoundView>>
  indexes: Map<string, { snapshot: FileRevision; workspace: Workspace }>
  bootstrap?: { kind: 'empty-v3'; token: string }
}
interface WorkspaceDriver {
  indexPath: string
  load(indexRaw?: string): Promise<{ workspace: Workspace; entries: IndexEntryV3[] }>
  published(id: string, raw: string): Promise<void>
}
const object = (value: unknown): ProjectDocument => JSON.parse(JSON.stringify(value)) as ProjectDocument
const indexKeys = new Set(['entries'])
function knownFile(project: Project, raw: string): ProjectDocument {
  const file = JSON.parse(raw) as ProjectFileV1
  const value = object(projectToFile(project, file.rev, file.savedAt, file.id))
  // The file's legacy framing viewport is derived, not another user's camera edit.
  delete value.viewport
  return projectEntityView(value)
}
function overlay(raw: string, before: ProjectDocument, after: ProjectDocument, keys?: ReadonlySet<string>): string {
  const result = reconcileProjectDocuments(before, after, JSON.parse(raw), new Set(), keys)
  if (result.kind !== 'merged') throw new Error('Typed view cannot be reconciled with its retained raw base')
  return JSON.stringify(result.document)
}

/** Host-owned enrollment binds each opaque client ID to the exact raw revisions and typed views
 * it received. Merely knowing the latest global revision never enrolls an older caller. */
export class WorkspaceReconciliationStore {
  private clients = new Map<string, BoundClient>()
  constructor(private driver: WorkspaceDriver) {}

  localSettings(): LocalSettingsStore {
    return new LocalSettingsStore(this.driver.indexPath, (id) => this.clientDir(id), (id, value) => this.enroll(id, value))
  }

  private clientDir(id: string): string {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('E_UNKNOWN_RECONCILIATION_CLIENT')
    return path.join(path.dirname(this.driver.indexPath), 'reconciliation-clients', id)
  }

  private async client(id: string): Promise<BoundClient | undefined> {
    const cached = this.clients.get(id)
    if (cached) return cached
    const client: BoundClient = { projects: new Map(), indexes: new Map() }
    try {
      const dir = this.clientDir(id)
      for (const file of await fs.readdir(dir)) {
        const value = JSON.parse(await fs.readFile(path.join(dir, file), 'utf8'))
        if (value.kind === 'project') {
          const bound = value.bound as BoundView
          if (revisionOf(bound.snapshot.raw) !== bound.snapshot.revision) throw new Error('Invalid enrollment snapshot')
          const views = client.projects.get(value.id) ?? new Map()
          views.set(bound.snapshot.revision, bound); client.projects.set(value.id, views)
        } else if (value.kind === 'index') client.indexes.set(value.bound.snapshot.revision, value.bound)
        else if (value.kind === 'bootstrap-absence' && value.indexPath === this.driver.indexPath &&
          value.bootstrap?.kind === 'empty-v3' && /^[a-f0-9]{64}$/.test(value.bootstrap.token)) client.bootstrap = value.bootstrap
      }
    } catch { return undefined }
    this.clients.set(id, client)
    return client
  }

  private async enroll(id: string, value: unknown): Promise<void> {
    const dir = this.clientDir(id)
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })
    const handle = await fs.open(path.join(dir, `${randomUUID()}.json`), 'wx', 0o600)
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync() } finally { await handle.close() }
    for (const parent of [dir, path.dirname(dir), path.dirname(path.dirname(dir))]) {
      const handle = await fs.open(parent, 'r')
      try { await handle.sync() } finally { await handle.close() }
    }
  }

  async load(clientId?: string): Promise<WorkspaceRevisionView> {
    if (clientId && !await this.client(clientId)) throw new Error('E_UNKNOWN_RECONCILIATION_CLIENT')
    const id = clientId ?? randomUUID()
    const client: BoundClient = this.clients.get(id) ?? { projects: new Map(), indexes: new Map() }
    this.clients.set(id, client)
    let indexSnapshot: FileRevision | undefined
    try { indexSnapshot = await new ProjectCommitStore(this.driver.indexPath, undefined, indexKeys).observe() }
    catch (error) {
      // Only genuine first-run absence can hydrate an empty workspace. Failed or
      // displaced managed reads must not enroll/default an empty caller view.
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error
    }
    const { workspace, entries } = await this.driver.load(indexSnapshot?.raw)
    const projects: WorkspaceRevisionView['projects'] = {}
    const unsupported: string[] = []
    for (const project of workspace.projects) {
      const entry = entries.find((item) => item.id === project.id)
      if (!entry || project.ssh || project.remote) { unsupported.push(project.id); continue }
      const file = entry.cwd ? path.join(entry.cwd, '.nodeterm', 'project.json') :
        entry.dataFile && isInlineProjectFileId(entry.id) ? path.join(path.dirname(this.driver.indexPath), inlineProjectFileRelPath(entry.id)) : undefined
      if (!file) { unsupported.push(project.id); continue }
      try {
        const snapshot = await new ProjectCommitStore(file).observe()
        const exact = fileToProject(JSON.parse(snapshot.raw), entry)
        const views = client.projects.get(project.id) ?? new Map()
        views.set(snapshot.revision, { file, snapshot, project: structuredClone(exact), entry: structuredClone(entry) })
        await this.enroll(id, { kind: 'project', id: project.id, bound: views.get(snapshot.revision) })
        client.projects.set(project.id, views)
        projects[project.id] = { revision: snapshot.revision, project: exact }
        Object.assign(project, exact)
        delete project.unavailable
      } catch (error) {
        if (isPublicationReadError(error)) throw error
        // A stale raw client can restore an old file after deletion. Do not turn those IDs into
        // live cards merely because fileToProject can parse them. Other incoming cards survive.
        try {
          const deleted = await new ProjectCommitStore(file).retainedDeleted()
          project.nodes = project.nodes.filter((node) => !deleted.nodes.includes(node.id))
        } catch { project.nodes = [] }
        project.unavailable = true
        unsupported.push(project.id)
      }
    }
    const indexRevision = indexSnapshot?.revision ?? ''
    const selected = indexSnapshot && JSON.parse(indexSnapshot.raw).activeProjectId
    if (typeof selected === 'string' && workspace.projects.some((project) => project.id === selected && !project.unavailable))
      workspace.activeProjectId = selected
    if (indexSnapshot) {
      const snapshot = indexSnapshot
      client.indexes.set(indexRevision, { snapshot, workspace: structuredClone(workspace) })
      await this.enroll(id, { kind: 'index', bound: client.indexes.get(indexRevision) })
    } else if (!workspace.projects.length && !await this.freshWorkspaceScope()) {
      if (!client.bootstrap) {
        client.bootstrap = { kind: 'empty-v3', token: revisionOf(randomUUID()) }
        await this.enroll(id, { kind: 'bootstrap-absence', indexPath: this.driver.indexPath, bootstrap: client.bootstrap })
      }
      // A read enrolls absence only. It never creates workspace.json or a default index.
      if (!await this.freshWorkspaceScope()) return { clientId: id, workspace, projects, indexRevision, unsupported, bootstrap: client.bootstrap }
    }
    return { clientId: id, workspace, projects, indexRevision, unsupported }
  }

  async save(request: WorkspaceRevisionRequest): Promise<WorkspaceRevisionOutcome> {
    if (request.bootstrap !== undefined) return this.bootstrapAndSave(request)
    const client = await this.client(request.clientId)
    const indexBase = client?.indexes.get(request.indexRevision)
    const outcomes: WorkspaceRevisionOutcome['projects'] = {}
    if (request.createInline !== undefined && !Array.isArray(request.createInline))
      return { projects: outcomes, index: { kind: 'publication-refused', recovery: await this.preserveRefusal(request), message: 'Invalid explicit inline creation intent.' } }
    const creating = new Set(request.createInline ?? [])
    if (creating.size) {
      const ids = request.workspace.projects.map((project) => project.id)
      const entries = indexBase && JSON.parse(indexBase.snapshot.raw).entries as IndexEntryV3[] | undefined
      const invalid = creating.size !== 1 || creating.size !== request.createInline!.length ||
        new Set(ids).size !== ids.length || !indexBase || JSON.parse(indexBase.snapshot.raw).version !== 3 ||
        !Array.isArray(entries) || [...creating].some((id) => typeof id !== 'string' || !ids.includes(id) || !isInlineProjectFileId(id) ||
          entries.some((entry) => entry.id === id) || indexBase.workspace.projects.some((project) => project.id === id))
      if (invalid) return { projects: outcomes, index: { kind: 'publication-refused', recovery: await this.preserveRefusal(request),
        message: 'Inline creation requires exactly one unique new identity and this caller\'s enrolled local v3 index; batches/bootstrap/adoption/migration are unsupported.' } }
      // The existing durable caller-enrollment store also retains immutable workspace intent.
      // Bind the WHOLE request: changing a project ID must not create a second effect on retry.
      const intent = path.join(this.clientDir(request.clientId), `creation-${revisionOf(request.operationId)}.json`)
      const raw = JSON.stringify({ kind: 'creation-intent', request })
      try {
        let handle
        try { handle = await fs.open(intent, 'wx', 0o600) }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || await fs.readFile(intent, 'utf8') !== raw) throw new Error('Creation operation identity is unresolved or reused with different input.')
        }
        if (handle) {
          try { await handle.writeFile(raw); await handle.sync() } finally { await handle.close() }
          const parent = await fs.open(path.dirname(intent), 'r')
          try { await parent.sync() } finally { await parent.close() }
        }
      } catch (error) { return { projects: outcomes, index: { kind: 'publication-refused', recovery: await this.preserveRefusal(request), message: String(error) } } }
    }
    for (const project of request.workspace.projects) {
      if (creating.has(project.id)) {
        try {
          if (project.cwd !== undefined || project.ssh !== undefined || project.remote !== undefined || project.unavailable)
            throw new Error('Only new local inline files are supported; folder, SSH, relay and unavailable projects require their own adapter.')
          const file = path.join(path.dirname(this.driver.indexPath), inlineProjectFileRelPath(project.id))
          const entry = splitWorkspace({ version: 2, activeProjectId: project.id, projects: [project] }, () => 0, 'creation').index.entries[0]
          const raw = await new ProjectCommitStore(file).create({ clientId: request.clientId,
            operationId: `${request.operationId}:${project.id}`, expectedAbsence: true, indexRevision: request.indexRevision,
            proposed: JSON.stringify(projectToFile(project, 0, 'creation', project.id)) }, async () => {
            return this.creationScope(project.id)
          })
          if ((raw.kind === 'committed' || raw.kind === 'already-applied') && raw.current) {
            const bound = { file, entry, snapshot: raw.current, project }
            if (!client!.projects.has(project.id)) client!.projects.set(project.id, new Map())
            outcomes[project.id] = await this.projectResult(request.clientId, client!, project.id, bound, raw)
          } else outcomes[project.id] = raw as ProjectRevisionOutcome
        } catch (error) { outcomes[project.id] = { kind: 'publication-refused', recovery: await this.preserveRefusal(project), message: String(error) } }
        continue
      }
      const bound = client?.projects.get(project.id)?.get(request.expected[project.id])
      if (!bound) {
        outcomes[project.id] = { kind: 'stale-base', recovery: await this.preserveRefusal(project),
          message: 'This caller has no acknowledged base for this project. Reload and reconcile the retained proposal.' }
        continue
      }
      if (project.cwd !== bound.project.cwd || JSON.stringify(project.ssh) !== JSON.stringify(bound.project.ssh)) {
        outcomes[project.id] = { kind: 'publication-refused', recovery: await this.preserveRefusal(project),
          message: 'Project relocation requires an explicit destination-enrollment adapter; the existing binding was not changed.' }
        continue
      }
      try {
        const proposed = overlay(bound.snapshot.raw, knownFile(bound.project, bound.snapshot.raw), knownFile(project, bound.snapshot.raw))
        const store = new ProjectCommitStore(bound.file)
        const raw = await store.commit({ clientId: request.clientId, operationId: `${request.operationId}:${project.id}`,
          expectedRevision: bound.snapshot.revision, proposed })
        outcomes[project.id] = await this.projectResult(request.clientId, client!, project.id, bound, raw)
        if ((raw.kind === 'committed' || raw.kind === 'already-applied') && raw.current)
          await this.driver.published(project.id, raw.current.raw)
      } catch (error) { outcomes[project.id] = { kind: 'unavailable', recovery: await this.preserveRefusal(project), message: String(error) } }
    }
    if (!indexBase || Object.values(outcomes).some((item) => item.kind !== 'committed' && item.kind !== 'already-applied')) {
      return { projects: outcomes, index: { kind: 'stale-base', recovery: await this.preserveRefusal(request.workspace),
        message: 'Workspace metadata was not written while a project or index base remains unresolved.' } }
    }
    try {
      const knownIndex = (ws: Workspace): ProjectDocument => object(splitWorkspace(ws, () => 0, 'view').index)
      const proposed = overlay(indexBase.snapshot.raw, knownIndex(indexBase.workspace), knownIndex(request.workspace), indexKeys)
      const result = await new ProjectCommitStore(this.driver.indexPath, undefined, indexKeys).commit({
        clientId: request.clientId, operationId: `${request.operationId}:index`, expectedRevision: request.indexRevision, proposed
      }, creating.size ? { mergeRetainedBase: true, check: (current) => {
        for (const id of creating) {
          const refusal = this.indexCreationRefusal(JSON.parse(current.raw), id)
          if (refusal) return refusal
        }
      } } : undefined)
      if (creating.size && (result.kind === 'committed' || result.kind === 'already-applied')) {
        const entries = result.current && JSON.parse(result.current.raw).entries as IndexEntryV3[] | undefined
        if (!Array.isArray(entries) || [...creating].some((id) => {
          const matches = entries.filter((entry) => entry.id === id)
          return matches.length !== 1 || !matches[0].dataFile || !!matches[0].cwd || !!matches[0].ssh
        })) return { projects: outcomes, index: { kind: 'publication-unknown', recovery: result.recovery,
          message: 'Index receipt does not register the exact created inline identity; file and intent remain retained.' } }
      }
      if (result.current) {
        client!.indexes.set(result.current.revision, { snapshot: result.current, workspace: structuredClone(request.workspace) })
        await this.enroll(request.clientId, { kind: 'index', bound: client!.indexes.get(result.current.revision) })
      }
      return { projects: outcomes, index: { kind: result.kind, revision: result.current?.revision, recovery: result.recovery, message: result.message } }
    } catch (error) {
      return { projects: outcomes, index: { kind: 'unavailable', recovery: await this.preserveRefusal(request.workspace), message: String(error) } }
    }
  }

  /** Workspace-owned evidence only: settings/auth are unrelated to workspace virginity.
   * Bounded proof, no glob deletion, latest-cache admission or abandoned-lock adoption. */
  private async freshWorkspaceScope(owner?: { operation: string; clientId: string; token: string }): Promise<string | undefined> {
    const root = path.dirname(this.driver.indexPath)
    let count = 0, bytes = 0, enrolled = false
    const entries = async (dir: string): Promise<string[]> => {
      if (!(await fs.lstat(dir)).isDirectory()) throw new Error('Workspace evidence directory is redirected.')
      const found: string[] = []
      for await (const entry of await fs.opendir(dir)) {
        if (++count > 4096) throw new Error('Fresh workspace evidence exceeds 4096 entries.')
        found.push(entry.name)
      }
      return found
    }
    const record = async (file: string): Promise<any> => {
      const remaining = 32 * 1024 * 1024 - bytes, named = await fs.lstat(file)
      if (!named.isFile()) throw new Error('Fresh workspace evidence is redirected.')
      const handle = await fs.open(file, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
      try {
        const before = await handle.stat(), chunks: Buffer[] = []
        if (!before.isFile() || before.dev !== named.dev || before.ino !== named.ino)
          throw new Error('Fresh workspace evidence changed identity.')
        if (before.size > remaining) throw new Error('Fresh workspace evidence exceeds 32 MiB.')
        let read = 0
        // Actual bytes, not a pre-stat estimate: one bounded sentinel detects growth.
        while (read <= remaining) {
          const chunk = Buffer.alloc(Math.min(64 * 1024, remaining + 1 - read))
          const { bytesRead } = await handle.read(chunk, 0, chunk.length, null)
          if (!bytesRead) break
          read += bytesRead
          if (read > remaining) throw new Error('Fresh workspace evidence exceeds 32 MiB during read.')
          chunks.push(chunk.subarray(0, bytesRead))
        }
        bytes += read
        const after = await handle.stat(), current = await fs.lstat(file)
        if (!current.isFile() || current.dev !== before.dev || current.ino !== before.ino ||
          after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs ||
          current.size !== after.size || current.mtimeMs !== after.mtimeMs || current.ctimeMs !== after.ctimeMs)
          throw new Error('Fresh workspace evidence changed during read.')
        return JSON.parse(Buffer.concat(chunks, read).toString('utf8'))
      } finally { await handle.close() }
    }
    try {
      for (const name of await entries(root)) {
        if (/^workspace(?:[.-]|$)/.test(name) || name === 'inline-projects' || name === 'reconciliation-refusals')
          return `Prior workspace state exists: ${name}. Bootstrap cannot adopt or reset it.`
        if (name === '.recovery') {
          const recovered = await entries(path.join(root, name))
          if (!owner || recovered.some((item) => item !== path.basename(this.driver.indexPath)))
            return 'Retained workspace recovery state prevents first-run bootstrap.'
          const recovery = path.join(root, name, path.basename(this.driver.indexPath))
          for (const item of await entries(recovery)) {
            if (item === 'operations') {
              if ((await entries(path.join(recovery, item))).some((op) => op !== owner.operation))
                return 'Another operation is retained in the bootstrap coordinator.'
            } else if (item === 'writer.lock') {
              const lockOwner = await record(path.join(recovery, item, 'owner.json'))
              if (lockOwner.operation !== owner.operation || lockOwner.pid !== process.pid) return 'Bootstrap writer ownership changed.'
            } else if (item !== 'refusals') return 'Prior index history prevents bootstrap.'
          }
        }
        if (name === 'reconciliation-clients') {
          const clients = path.join(root, name)
          for (const id of await entries(clients)) {
            if (!/^[a-f0-9-]{36}$/.test(id)) return 'Unrecognized retained workspace client.'
            for (const file of await entries(path.join(clients, id))) {
              const value = await record(path.join(clients, id, file))
              if (value.kind !== 'bootstrap-absence' || value.indexPath !== this.driver.indexPath ||
                value.bootstrap?.kind !== 'empty-v3' || !/^[a-f0-9]{64}$/.test(value.bootstrap.token))
                return 'Prior or unresolved workspace client intent prevents bootstrap.'
              if (owner && id === owner.clientId && value.bootstrap.token === owner.token) enrolled = true
            }
          }
        }
      }
      if (owner && !enrolled) return 'Exact durable absence enrollment is unavailable; cached eligibility is not authority.'
    } catch (error) { return `Fresh workspace evidence unavailable: ${String(error)}` }
  }

  private async bootstrapAndSave(request: WorkspaceRevisionRequest): Promise<WorkspaceRevisionOutcome> {
    const refuse = async (message: string): Promise<WorkspaceRevisionOutcome> => ({ projects: {},
      index: { kind: 'publication-refused', recovery: await this.preserveRefusal(request), message } })
    const client = await this.client(request.clientId), project = request.workspace.projects[0]
    if (!client?.bootstrap || request.bootstrap?.kind !== 'empty-v3' || request.bootstrap.token !== client.bootstrap.token ||
      request.indexRevision !== '' || Object.keys(request.expected).length || request.workspace.projects.length !== 1 ||
      !Array.isArray(request.createInline) || request.createInline.length !== 1 || request.createInline[0] !== project?.id ||
      !isInlineProjectFileId(project.id) || project.cwd !== undefined || project.ssh !== undefined ||
      project.remote !== undefined || project.unavailable || request.workspace.activeProjectId !== project.id)
      return refuse('Bootstrap requires this caller\'s enrolled virgin absence and exactly one explicit new local inline project.')
    const operationId = `${request.operationId}:bootstrap`
    const result = await new ProjectCommitStore(this.driver.indexPath, undefined, indexKeys).bootstrapIndex({
      clientId: request.clientId, operationId, expectedAbsence: true, bootstrapToken: client.bootstrap.token,
      intent: JSON.stringify(request)
    }, () => this.freshWorkspaceScope({ operation: revisionOf(`${request.clientId}\0${operationId}`),
      clientId: request.clientId, token: client.bootstrap!.token }))
    const bootstrap = { kind: result.kind, revision: result.current?.revision, recovery: result.recovery, message: result.message }
    if ((result.kind !== 'committed' && result.kind !== 'already-applied') || !result.current)
      return { projects: {}, bootstrap, index: { kind: result.kind === 'publication-unknown' ? 'publication-unknown' : 'stale-base',
        recovery: result.recovery, message: 'Empty-index bootstrap is unresolved; no child or final index was published by this request.' } }
    const raw = JSON.parse(result.current.raw)
    if (raw.version !== 3 || raw.activeProjectId !== '' || !Array.isArray(raw.entries) || raw.entries.length)
      return { ...await refuse('Bootstrap receipt is not the exact empty-v3 constructor.'), bootstrap }
    const bound = { snapshot: result.current, workspace: { version: 2 as const, activeProjectId: '', projects: [] } }
    client.indexes.set(result.current.revision, bound)
    await this.enroll(request.clientId, { kind: 'index', bound })
    // Only the exact own receipt supplies the base. Current disk/latest caches cannot grant it.
    const { bootstrap: _bootstrap, ...original } = request
    return { ...await this.save({ ...original, operationId: `${request.operationId}:inline`, indexRevision: result.current.revision }), bootstrap }
  }

  private indexCreationRefusal(index: { version?: number; entries?: IndexEntryV3[]; _reconciliation?: { deleted?: { entries?: unknown } } }, id: string): string | undefined {
    if (index.version !== 3 || !Array.isArray(index.entries)) return 'Creation requires an available local v3 index.'
    const deleted = index._reconciliation?.deleted?.entries
    if (deleted !== undefined && (!Array.isArray(deleted) || deleted.includes(id))) return 'Creation identity has retained index deletion evidence.'
    if (index.entries.some((entry) => entry.id === id)) return 'Creation identity is already registered or retained in index history.'
  }

  /** Virgin file absence does not erase prior index membership (including pre-file entries).
   * Bounded read of the EXISTING immutable version store; no new registry or history pruning. */
  private async creationScope(id: string): Promise<string | undefined> {
    const current = JSON.parse(await readPublicationFile(this.driver.indexPath))
    const refusal = this.indexCreationRefusal(current, id)
    if (refusal) return refusal
    const store = new ProjectCommitStore(this.driver.indexPath, undefined, indexKeys)
    const versions = path.join(store.recovery, 'versions')
    const files = await fs.readdir(versions)
    if (files.length > 4096) return 'Creation index history exceeds the bounded 4096-version proof; no history was pruned.'
    let bytes = 0
    for (const file of files) {
      if (!/^[a-f0-9]{64}\.json$/.test(file)) return 'Creation index history is unverifiable.'
      const stat = await fs.lstat(path.join(versions, file))
      bytes += stat.size
      if (!stat.isFile() || bytes > 32 * 1024 * 1024) return 'Creation index history exceeds the bounded 32 MiB proof or is not regular.'
      const raw = await store.known(file.slice(0, -5))
      if (!raw) return 'Creation index history is unavailable or corrupt.'
      const retained = this.indexCreationRefusal(JSON.parse(raw), id)
      if (retained) return retained
    }
  }

  private async projectResult(clientId: string, client: BoundClient, id: string, bound: BoundView, raw: FileCommitResult): Promise<ProjectRevisionOutcome> {
    if (!raw.current) return raw as ProjectRevisionOutcome
    try {
      const project = fileToProject(JSON.parse(raw.current.raw), bound.entry)
      client.projects.get(id)!.set(raw.current.revision, { ...bound, snapshot: raw.current, project: structuredClone(project) })
      await this.enroll(clientId, { kind: 'project', id, bound: client.projects.get(id)!.get(raw.current.revision) })
      return { ...raw, current: { revision: raw.current.revision, project } }
    } catch { return { ...raw, kind: 'unavailable', current: undefined } }
  }

  /** Organizer shares enrollment, immutable history, writer lock and receipts with ordinary saves. */
  async organizerBase(clientId: string, projectId: string, revision: string): Promise<Project | undefined> {
    const bound = (await this.client(clientId))?.projects.get(projectId)?.get(revision)
    return bound ? structuredClone(bound.project) : undefined
  }

  async commitOrganizer(clientId: string, projectId: string, revision: string, operationId: string,
    proposed: Project, check: () => string | undefined): Promise<ProjectRevisionOutcome> {
    const client = await this.client(clientId)
    const bound = client?.projects.get(projectId)?.get(revision)
    if (!bound) return { kind: 'stale-base', recovery: await this.preserveRefusal(proposed), message: 'unknown-enrollment' }
    const raw = overlay(bound.snapshot.raw, knownFile(bound.project, bound.snapshot.raw), knownFile(proposed, bound.snapshot.raw))
    const result = await new ProjectCommitStore(bound.file).commit({ clientId, operationId: `organizer:${operationId}`,
      expectedRevision: revision, proposed: raw }, { check })
    const outcome = await this.projectResult(clientId, client!, projectId, bound, result)
    if ((result.kind === 'committed' || result.kind === 'already-applied') && result.current)
      await this.driver.published(projectId, result.current.raw)
    return outcome
  }

  async settleOrganizer(clientId: string, projectId: string, revision: string, operationId: string): Promise<ProjectRevisionOutcome | undefined> {
    const client = await this.client(clientId), bound = client?.projects.get(projectId)?.get(revision)
    if (!client || !bound) return undefined
    const receipt = await new ProjectCommitStore(bound.file).receipt(clientId, `organizer:${operationId}`)
    return receipt ? this.projectResult(clientId, client, projectId, bound, receipt) : undefined
  }

  async preserveRefusal(value: unknown): Promise<string> {
    const dir = path.join(path.dirname(this.driver.indexPath), 'reconciliation-refusals')
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })
    const file = path.join(dir, `${randomUUID()}.json`)
    const handle = await fs.open(file, 'wx', 0o600)
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync() } finally { await handle.close() }
    for (const parent of [dir, path.dirname(dir)]) {
      const handle = await fs.open(parent, 'r')
      try { await handle.sync() } finally { await handle.close() }
    }
    return file
  }
}
