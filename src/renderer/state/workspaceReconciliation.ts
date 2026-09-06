import type { Project, Workspace, WorkspaceApi } from '@shared/types'
import type { ProjectConflict, ProjectDocument, ProjectJson, ProjectValue } from '@shared/project-reconciliation'
import { reconcileProjectDocuments } from '@shared/project-reconciliation'
import { projectEntityView } from '@shared/project-view'
import { applyLocalNodeExec, localNodeExec, stripSharedNodeExec } from '@shared/node-exec'
import type { ProjectRevisionView, WorkspaceRevisionRequest, WorkspaceRevisionView } from '@shared/workspace-reconciliation'

const localKeys = new Set(['viewport', 'breadcrumbs', 'capabilityAck', 'closedSessions', 'closedAt', 'closed',
  'defaultAccountId', 'unavailable', 'remote', 'cwd', 'ssh'])
const shared = (project: Project): ProjectDocument => projectEntityView(JSON.parse(JSON.stringify({
  ...Object.fromEntries(Object.entries(project).filter(([key]) => !localKeys.has(key))),
  nodes: stripSharedNodeExec(project.nodes)
})))
const pathKey = (path: string[]): string => JSON.stringify(path)
function at(value: ProjectJson, path: string[]): ProjectValue {
  let current = value
  for (const key of path) {
    if (Array.isArray(current)) {
      const item = current.find((item) => item && typeof item === 'object' && !Array.isArray(item) && item.id === key)
      if (item === undefined) return { present: false }
      current = item
    } else if (current && typeof current === 'object' && Object.hasOwn(current, key)) current = current[key]
    else return { present: false }
  }
  return { present: true, value: current }
}
function setAt(value: ProjectJson, path: string[], selected: ProjectValue): ProjectJson {
  if (!path.length) return selected.present ? structuredClone(selected.value) : null
  const [key, ...rest] = path
  if (Array.isArray(value)) {
    const index = value.findIndex((item) => item && typeof item === 'object' && !Array.isArray(item) && item.id === key)
    if (!rest.length) {
      const next = [...value]
      if (index >= 0) { if (selected.present) next[index] = structuredClone(selected.value); else next.splice(index, 1) }
      else if (selected.present) next.push(structuredClone(selected.value))
      return next
    }
    return value.map((item, i) => i === index ? setAt(item, rest, selected) : item)
  }
  if (!value || typeof value !== 'object') throw new Error('Conflict parent no longer exists')
  const next = Object.fromEntries(Object.entries(value))
  if (!rest.length && !selected.present) delete next[key]
  else Object.defineProperty(next, key, { value: rest.length ? setAt(next[key], rest, selected) :
    selected.present ? structuredClone(selected.value) : null, enumerable: true, writable: true, configurable: true })
  return next
}

/** Per-renderer acknowledged bases and pending intents, separate from React Flow's live nodes.
 * A tab selection has no operation on this object and cannot resolve another project's conflict. */
export class WorkspaceReconciliationClient {
  private view?: WorkspaceRevisionView
  private bases = new Map<string, ProjectRevisionView>()
  private pending?: WorkspaceRevisionRequest
  private refreshOwed = false
  private epoch = 0
  private refreshSequence = 0
  private inFlight?: Promise<{ workspace: Workspace; saved: boolean }>
  readonly conflicts = new Map<string, ProjectConflict[]>()
  error: string | null = null
  constructor(private api: WorkspaceApi) {}

  async load(): Promise<Workspace> {
    if (!this.api.loadReconciled) throw new Error('This host does not support revision-bound saves.')
    this.view = await this.api.loadReconciled()
    this.bases = new Map(Object.entries(this.view.projects))
    if (this.view.unsupported.length) this.error = 'Some projects are read-only because their revision or publication adapter is unavailable.'
    return this.view.workspace
  }

  private merge(id: string, before: Project, local: Project, incoming: Project): Project {
    const result = reconcileProjectDocuments(shared(before), shared(local), shared(incoming))
    const unresolved = new Map(result.conflicts.map((item) => [pathKey(item.path), item]))
    // Advancing an observed base does not decide a previously parked field. It clears only
    // after both sides agree or the user chooses that specific field.
    for (const old of this.conflicts.get(id) ?? []) {
      const ours = at(shared(local), old.path), theirs = at(shared(incoming), old.path)
      if (JSON.stringify(ours) !== JSON.stringify(theirs) && !unresolved.has(pathKey(old.path)))
        unresolved.set(pathKey(old.path), { ...old, local: ours, incoming: theirs })
    }
    if (unresolved.size) this.conflicts.set(id, [...unresolved.values()])
    else this.conflicts.delete(id)
    const merged = { ...local, ...result.document } as unknown as Project
    merged.nodes = applyLocalNodeExec(merged.nodes, localNodeExec(local.nodes))
    return merged
  }

  async refresh(current: () => Workspace, retry = true): Promise<Workspace> {
    if (!this.view || !this.api.loadReconciled) return current()
    const epoch = this.epoch, sequence = ++this.refreshSequence
    const incoming = await this.api.loadReconciled(this.view.clientId)
    if (sequence !== this.refreshSequence) return current()
    if (epoch !== this.epoch) {
      this.refreshOwed = true
      // One bounded fresh read if the save already settled; never roll an ack backward with
      // a response whose read started before that operation.
      return !this.pending && retry ? this.refresh(current, false) : current()
    }
    const workspace = current()
    const projects = workspace.projects.map((local) => {
      const next = incoming.projects[local.id], before = this.bases.get(local.id)
      if (!next || !before) return local
      if (this.pending) {
        this.refreshOwed = true
        const known = new Set([...before.project.nodes, ...local.nodes].map((node) => node.id))
        return { ...local, nodes: [...local.nodes, ...next.project.nodes.filter((node) => !known.has(node.id))] }
      }
      const merged = this.merge(local.id, before.project, local, next.project)
      this.bases.set(local.id, structuredClone(next))
      return merged
    })
    if (incoming.unsupported.length) this.error = 'Incoming state is unavailable or contains a deleted identity. Your working copy is retained.'
    return { ...workspace, projects }
  }

  async save(workspace: Workspace, current: () => Workspace): Promise<{ workspace: Workspace; saved: boolean }> {
    if (this.inFlight) return this.inFlight
    const run = this.saveNow(workspace, current)
    this.inFlight = run
    try { return await run } finally { if (this.inFlight === run) this.inFlight = undefined }
  }

  private async saveNow(workspace: Workspace, current: () => Workspace): Promise<{ workspace: Workspace; saved: boolean }> {
    if (!this.view || !this.api.saveReconciled) throw new Error('A caller-bound workspace load is required before saving.')
    const request = this.pending ?? { clientId: this.view.clientId, operationId: crypto.randomUUID(),
      expected: Object.fromEntries([...this.bases].map(([id, base]) => [id, this.conflicts.has(id) ? '' : base.revision])),
      indexRevision: this.view.indexRevision, workspace: structuredClone(workspace) }
    this.pending = request
    this.epoch++
    let outcome
    try { outcome = await this.api.saveReconciled(request) }
    catch (error) { this.error = `Save acknowledgment unavailable. The same operation will be retried. ${String(error)}`; throw error }
    this.epoch++
    let latest = current()
    let saved = outcome.index.kind === 'committed' || outcome.index.kind === 'already-applied'
    let unknown = false
    this.error = null
    latest = { ...latest, projects: latest.projects.map((local) => {
      const result = outcome.projects[local.id]
      if (!result) return local
      if (result.kind === 'committed' || result.kind === 'already-applied') {
        this.refreshOwed ||= result.kind === 'already-applied'
        const proposed = request.workspace.projects.find((project) => project.id === local.id)
        if (!proposed || !result.current) { saved = false; return local }
        const merged = this.merge(local.id, proposed, local, result.current.project)
        this.bases.set(local.id, structuredClone(result.current))
        return merged
      }
      saved = false
      unknown ||= result.kind === 'publication-unknown'
      this.error = `${result.message ?? result.kind}. Recovery: ${result.recovery}`
      const before = this.bases.get(local.id)
      if (result.current && before && !this.conflicts.has(local.id)) {
        const merged = this.merge(local.id, before.project, local, result.current.project)
        this.bases.set(local.id, structuredClone(result.current))
        // The typed project deliberately omits raw tombstone metadata. Preserve the host's
        // deletion veto as an explicit field decision instead of rediscovering the same refusal.
        const deletions = result.merge?.conflicts.filter((item) => item.kind === 'deleted-node') ?? []
        if (deletions.length) {
          const fields = new Map((this.conflicts.get(local.id) ?? []).map((item) => [pathKey(item.path), item]))
          for (const item of deletions) fields.set(pathKey(item.path), item)
          this.conflicts.set(local.id, [...fields.values()])
        }
        return merged
      }
      return local
    }) }
    if (outcome.index.revision && (outcome.index.kind === 'committed' || outcome.index.kind === 'already-applied'))
      this.view.indexRevision = outcome.index.revision
    else if (!this.error) this.error = outcome.index.message ?? 'Workspace metadata remains unsaved.'
    if (!unknown) this.pending = undefined
    if (this.refreshOwed && !this.pending) {
      this.refreshOwed = false
      const held = latest
      latest = await this.refresh(() => held)
    }
    return { workspace: latest, saved: saved && !this.conflicts.size }
  }

  resolve(workspace: Workspace, id: string, conflict: ProjectConflict, side: 'local' | 'incoming'): Workspace {
    const existing = this.conflicts.get(id) ?? []
    if (!existing.some((item) => pathKey(item.path) === pathKey(conflict.path))) return workspace
    const projects = workspace.projects.map((project) => {
      if (project.id !== id) return project
      let selected = side === 'local' ? conflict.local : conflict.incoming
      if (conflict.kind === 'deleted-node') selected = { present: false }
      if (conflict.kind === 'order') {
        const list = at(shared(project), conflict.path)
        if (!list.present || !Array.isArray(list.value) || !selected.present || !Array.isArray(selected.value)) return project
        const order = selected.value
        const nodes = list.value
        selected = { present: true, value: [...nodes].sort((a, b) => {
          const rank = (item: ProjectJson): number => {
            const id = item && typeof item === 'object' && !Array.isArray(item) ? item.id : null
            const index = order.indexOf(id)
            return index < 0 ? order.length : index
          }
          return rank(a) - rank(b)
        }) }
      }
      const merged = { ...project, ...setAt(shared(project), conflict.path, selected) as ProjectDocument } as unknown as Project
      merged.nodes = applyLocalNodeExec(merged.nodes, localNodeExec(project.nodes))
      return merged
    })
    const remaining = existing.filter((item) => pathKey(item.path) !== pathKey(conflict.path))
    if (remaining.length) this.conflicts.set(id, remaining); else this.conflicts.delete(id)
    this.error = null
    return { ...workspace, projects }
  }
}
