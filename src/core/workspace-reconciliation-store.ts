import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import type { Project, Workspace } from '../shared/types'
import type { WorkspaceRevisionView, WorkspaceRevisionRequest, WorkspaceRevisionOutcome, ProjectRevisionOutcome } from '../shared/workspace-reconciliation'
import { reconcileProjectDocuments, type ProjectDocument } from '../shared/project-reconciliation'
import { projectEntityView } from '../shared/project-view'
import { ProjectCommitStore, revisionOf, isPublicationReadError, type FileRevision, type FileCommitResult } from './project-commit-store'
import { fileToProject, projectToFile, splitWorkspace, inlineProjectFileRelPath, isInlineProjectFileId,
  type IndexEntryV3, type ProjectFileV1 } from './workspace-files'

interface BoundView { file: string; snapshot: FileRevision; project: Project; entry: IndexEntryV3 }
interface BoundClient {
  projects: Map<string, Map<string, BoundView>>
  indexes: Map<string, { snapshot: FileRevision; workspace: Workspace }>
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
    const client = this.clients.get(id) ?? { projects: new Map(), indexes: new Map() }
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
    }
    return { clientId: id, workspace, projects, indexRevision, unsupported }
  }

  async save(request: WorkspaceRevisionRequest): Promise<WorkspaceRevisionOutcome> {
    const client = await this.client(request.clientId)
    const outcomes: WorkspaceRevisionOutcome['projects'] = {}
    for (const project of request.workspace.projects) {
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
    const indexBase = client?.indexes.get(request.indexRevision)
    if (!indexBase || Object.values(outcomes).some((item) => item.kind !== 'committed' && item.kind !== 'already-applied')) {
      return { projects: outcomes, index: { kind: 'stale-base', recovery: await this.preserveRefusal(request.workspace),
        message: 'Workspace metadata was not written while a project or index base remains unresolved.' } }
    }
    try {
      const knownIndex = (ws: Workspace): ProjectDocument => object(splitWorkspace(ws, () => 0, 'view').index)
      const proposed = overlay(indexBase.snapshot.raw, knownIndex(indexBase.workspace), knownIndex(request.workspace), indexKeys)
      const result = await new ProjectCommitStore(this.driver.indexPath, undefined, indexKeys).commit({
        clientId: request.clientId, operationId: `${request.operationId}:index`, expectedRevision: request.indexRevision, proposed
      })
      if (result.current) {
        client!.indexes.set(result.current.revision, { snapshot: result.current, workspace: structuredClone(request.workspace) })
        await this.enroll(request.clientId, { kind: 'index', bound: client!.indexes.get(result.current.revision) })
      }
      return { projects: outcomes, index: { kind: result.kind, revision: result.current?.revision, recovery: result.recovery, message: result.message } }
    } catch (error) {
      return { projects: outcomes, index: { kind: 'unavailable', recovery: await this.preserveRefusal(request.workspace), message: String(error) } }
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
