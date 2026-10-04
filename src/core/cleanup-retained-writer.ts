import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { ProjectCommitStore, readPublicationFile, revisionOf, type PublicationPhase } from './project-commit-store'
import { cleanupHash, CleanupError } from './session-cleanup'
import type { Project, Workspace } from '../shared/types'
import { publicationPlatform } from './workspace-publication-platform'

interface Enrollment { workspace: Workspace; raw: [string, string][]; revision: string; projectRevisions: Record<string, string> }
const stripped = (p: Project) => {
  const copy = structuredClone(p)
  for (const n of copy.nodes) delete n.cleanupArchiveId
  // Enrollment is durable JSON. An omitted optional property and an undefined optional
  // property describe the same persisted content; deleting a populated field still differs.
  return JSON.parse(JSON.stringify(copy))
}

/** Narrow reconciliation adapter over PR30's actual retained publisher. The only admitted edits
 * are archive markers; foreign raw content never passes through projectToFile or a typed model.
 * Host-private enrollment binds the caller to exact raw index and sibling versions. */
export class CleanupRetainedWriter {
  constructor(private readonly indexPath: string, private readonly load: () => Promise<Workspace>,
    private readonly serialize: <T>(work: () => Promise<T>) => Promise<T>,
    private readonly revision: () => Promise<string>, private readonly published: (file: string, raw: string) => void,
    private readonly phase?: (phase: PublicationPhase, file: string) => Promise<void>,
    private readonly loadPublished: () => Promise<Workspace> = load) {}

  private clientFile(id: string): string {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new CleanupError('cleanup_unknown_enrollment')
    return path.join(path.dirname(this.indexPath), 'cleanup-enrollments', `${id}.json`)
  }
  private async retain(id: string, held: Enrollment): Promise<void> {
    const file = this.clientFile(id), dir = path.dirname(file)
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })
    const handle = await fs.open(file, 'wx', 0o600)
    try { await handle.writeFile(JSON.stringify(held)); await handle.sync() } finally { await handle.close() }
    for (const parent of [dir, path.dirname(dir)]) {
      const handle = await fs.open(parent, 'r')
      try { await handle.sync() } finally { await handle.close() }
    }
  }
  private readonly advances = new Map<string, Enrollment>()
  private async client(id: string): Promise<Enrollment | undefined> {
    const cached = this.advances.get(id)
    if (cached) return cached
    try {
      const held = JSON.parse(await fs.readFile(this.clientFile(id), 'utf8')) as Enrollment
      if (!Array.isArray(held.raw) || !held.workspace || !held.revision || !held.projectRevisions) return
      // Exact file versions must still be retained by the same publisher.
      for (const [file, raw] of held.raw) if (await new ProjectCommitStore(file).known(revisionOf(raw)) !== raw) return
      return held
    } catch { return }
  }
  private async raw(retain = false): Promise<Map<string, string>> {
    const read = async (file: string) => retain ? (await new ProjectCommitStore(file).observe()).raw : readPublicationFile(file)
    const bytes = await read(this.indexPath), index = JSON.parse(bytes)
    if (index.version !== 3 || !Array.isArray(index.entries)) throw new CleanupError('cleanup_index_contract_required')
    const result = new Map([[this.indexPath, bytes]])
    for (const entry of index.entries) if (entry.cwd && !entry.ssh) {
      if (typeof entry.cwd !== 'string' || !path.isAbsolute(entry.cwd)) throw new CleanupError('cleanup_invalid_project_path')
      const file = path.join(entry.cwd, '.nodeterm', 'project.json')
      result.set(file, await read(file))
    }
    return result
  }
  async enroll() {
    // Refuse before creating enrollment/recovery evidence on this unsupported platform.
    // Ordinary untouched Windows canvases keep their explicitly fenced save path.
    if (publicationPlatform.nativePlatform() === 'win32') throw new CleanupError('cleanup_retained_platform_unsupported')
    const workspace = await this.load(), raw = await this.raw(true)
    if (!workspace.revision || workspace.revision !== await this.revision()) throw new CleanupError('cleanup_revision_changed')
    const clientId = randomUUID()
    const projectRevisions = Object.fromEntries(workspace.projects.map(project => [project.id, cleanupHash({ raw: [...raw], project })]))
    await this.retain(clientId, { workspace: structuredClone(workspace), raw: [...raw], revision: workspace.revision, projectRevisions })
    return { clientId, projects: Object.fromEntries(workspace.projects.map(project =>
      [project.id, { revision: projectRevisions[project.id], project }])) }
  }
  commitOrganizer(clientId: string, projectId: string, revision: string, operationId: string,
    proposed: Project, check: () => string | undefined) {
    return this.serialize(async () => {
      const held = await this.client(clientId), original = held?.workspace.projects.find(p => p.id === projectId)
      const refuse = (kind: string) => ({ kind, recovery: held ? this.clientFile(clientId) : 'unknown-enrollment' })
      if (!held || !original || original.ssh || original.remote || original.unavailable ||
        revision !== held.projectRevisions[projectId]) return refuse('base-not-retained')
      if (!isDeepStrictEqual(stripped(original), stripped(proposed))) return refuse('non-marker-change')
      const baseRaw = new Map(held.raw)
      if (held.revision !== await this.revision() || !isDeepStrictEqual(baseRaw, await this.raw())) return refuse('conflict')
      const index = JSON.parse(baseRaw.get(this.indexPath)!)
      const entries = index.entries.filter((e: { id: string }) => e.id === projectId)
      if (entries.length !== 1) return refuse('ambiguous-project')
      const entry = entries[0], file = entry.cwd ? path.join(entry.cwd, '.nodeterm', 'project.json') : this.indexPath
      const raw = JSON.parse(baseRaw.get(file)!), target = entry.cwd ? raw : raw.entries.find((e: { id: string }) => e.id === projectId)?.project
      if (!target || !Array.isArray(target.nodes) || target.nodes.length !== original.nodes.length ||
        new Set(target.nodes.map((n: { id: string }) => n.id)).size !== target.nodes.length) return refuse('invalid-raw-target')
      for (const node of target.nodes) {
        const next = proposed.nodes.find(n => n.id === node.id)
        if (!next) return refuse('invalid-raw-target')
        if (next.cleanupArchiveId === undefined) delete node.cleanupArchiveId
        else node.cleanupArchiveId = next.cleanupArchiveId
      }
      const reason = check()
      if (reason) return refuse(reason)
      const before = held.revision
      const result = await new ProjectCommitStore(file, this.phase ? at => this.phase!(at, file) : undefined,
        file === this.indexPath ? new Set(['entries']) : undefined,
        new Set(held.workspace.projects.flatMap(p => p.nodes.map(n => n.id)))).commit({
        clientId, operationId, expectedRevision: revisionOf(baseRaw.get(file)!), proposed: JSON.stringify(raw) }, {
        check: async () => {
          const refusal = check()
          if (refusal) return refusal
          // The publisher's own target lock is expected. All OTHER files must still match the
          // enrolled scope, including index/sibling publications. Never enroll fresh bytes here.
          for (const [sibling, raw] of baseRaw) if (sibling !== file && await readPublicationFile(sibling) !== raw) return 'workspace-scope-changed'
        }
      })
      if (!['committed', 'already-applied'].includes(result.kind) || !result.current) return result
      const expected = new Map(baseRaw); expected.set(file, result.current.raw)
      if (!isDeepStrictEqual(expected, await this.raw())) return { ...result, kind: 'partial-publication' }
      this.published(file, result.current.raw)
      // Adopt the same normalized projection ordinary readers use, including inline project
      // optional fields. Verify its complete raw scope before acknowledging the revision.
      const adopted = await this.loadPublished(), after = adopted.projects.find(p => p.id === projectId)
      if (!after || !adopted.revision || adopted.revision !== await this.revision() ||
        !isDeepStrictEqual(expected, await this.raw())) return { ...result, kind: 'partial-publication' }
      held.raw = [...expected]; held.revision = adopted.revision
      held.workspace = structuredClone(adopted)
      this.advances.set(clientId, held)
      after.workspaceChange = { before, after: held.revision, changes: [{ before: original, after: structuredClone(after) }] }
      return { ...result, current: { project: after } }
    })
  }
}
