import {
  planOrphanAdoption,
  type OrphanMirrorEntry,
  type OrphanSkipReason
} from '../core/orphan-adoption'
import type { AgentState } from '../shared/agents/normalize'
import type { CanvasNodeState, Project, Workspace } from '../shared/types'
import { WorkspaceMutationQueue } from './workspace-mutation-queue'

export type OpsPaneState = 'alive' | 'dead' | 'unknown' | 'none'
export type OpsAgentStatus = 'working' | 'idle' | 'blocked' | null

export interface OpsNodeInventoryItem {
  id: string
  kind: CanvasNodeState['kind']
  title: string
  projectId: string
  groupId: string | null
  /** Epoch milliseconds recovered from nodeterm's timestamped id; null for legacy/foreign ids. */
  createdAt: number | null
  paneState: OpsPaneState
  agentStatus: OpsAgentStatus
  lastActivityAt: number | null
  /** The creator card that owns this spawn for the current server run, when one exists. */
  ownerSession: string | null
}

export interface NodeOpsWorkspace {
  load(opts?: { sideline?: boolean }): Promise<Workspace>
  save(workspace: Workspace): Promise<void>
}

export interface ServerNodeOpsDeps {
  workspaceStore: NodeOpsWorkspace
  sessionPresence(nodeId: string): Promise<Exclude<OpsPaneState, 'none'>>
  destroySession(nodeId: string): Promise<void>
  statusOf(nodeId: string): { state?: AgentState; updatedAt: number } | undefined
  ownerOf(nodeId: string): { sourceNodeId: string } | undefined
  onRemoved?(nodeIds: readonly string[]): void
  publishProject?(project: Project): void
  publishRemoval?(projectId: string, nodeId: string): void
  /** Live insertion of one adopted card into every attached browser (canvas-sync upsert). Absent
   *  = no live channel, and `adoptOrphans` says so in its reply instead of implying one. */
  publishNode?(projectId: string, node: CanvasNodeState): void
  /** Live `nt-<id>` session names on this host (`PtyManager.listNodetermSessions`). Absent = the
   *  shell wired no adoption; `adoptOrphans` then adopts nothing. */
  listSessions?(): Promise<string[]>
  /** Session name → pane cwd (`PtyManager.listNodetermPaneCwds`). */
  listPaneCwds?(): Promise<Map<string, string>>
  /** The agent-status mirror entry for a node id, for the recovered card's title/agent. */
  mirrorOf?(nodeId: string): OrphanMirrorEntry | undefined
  /**
   * Put the just-adopted ids through the SAME boot classification a persisted card gets
   * (`PtyManager.protectPersistedSessionsAtBoot`). An adopted id was not created during this Server
   * run, so it must be attach-only: without this it has no `bootPersisted` entry and a browser that
   * mounts after the session dies would fall through to attach-or-CREATE and hand the operator a
   * fresh shell wearing a recovered card's name.
   */
  protectAdopted?(nodeIds: readonly string[]): Promise<unknown>
  now?: () => number
  mutationQueue?: WorkspaceMutationQueue
}

export interface OpsSweepResult {
  dryRun: boolean
  affectedIds: string[]
  scanned: number
}

export interface OpsAdoptedNode {
  id: string
  projectId: string
  projectName: string
  title: string
  sessionName: string
}

export interface OpsSkippedOrphan {
  id: string
  sessionName: string
  cwd: string | null
  reason: OrphanSkipReason
}

export interface OpsAdoptResult {
  adopted: OpsAdoptedNode[]
  skipped: OpsSkippedOrphan[]
  /** Were the new cards pushed into attached browsers? False = the caller must reload to see them. */
  live: boolean
}

export type OpsRemoveResult =
  | { ok: true; removedIds: string[]; forced: boolean }
  | { ok: false; status: number; error: string; paneState?: OpsPaneState }

const TIMESTAMPED_ID_PREFIXES = new Set([
  'term', 'ssh', 'sticky', 'group', 'editor', 'diff', 'video', 'web', 'browser', 'dino', 'trigger'
])
const EARLIEST_REASONABLE_NODE_MS = Date.UTC(2017, 0, 1)

/** Recover the timestamp encoded by renderer/server `nextId`; never invent one for legacy ids. */
export function createdAtFromNodeId(id: string, now = Date.now()): number | null {
  const match = /^([a-z]+)-([0-9a-z]+)-[A-Za-z0-9._-]+$/.exec(id)
  if (!match || !TIMESTAMPED_ID_PREFIXES.has(match[1])) return null
  const parsed = Number.parseInt(match[2], 36)
  if (!Number.isSafeInteger(parsed)) return null
  if (parsed < EARLIEST_REASONABLE_NODE_MS || parsed > now + 5 * 60_000) return null
  return parsed
}

function normalizedAgentStatus(
  status: { state?: AgentState; updatedAt: number } | undefined
): OpsAgentStatus {
  if (!status) return null
  if (status.state === 'working') return 'working'
  if (status.state === 'waiting' || status.state === 'blocked') return 'blocked'
  return 'idle'
}

function groupsFirst(nodes: CanvasNodeState[]): CanvasNodeState[] {
  return [
    ...nodes.filter((node) => node.kind === 'group'),
    ...nodes.filter((node) => node.kind !== 'group')
  ]
}

function rootPosition(
  nodes: readonly CanvasNodeState[],
  node: CanvasNodeState
): { x: number; y: number } {
  const byId = new Map(nodes.map((candidate) => [candidate.id, candidate]))
  let x = node.position.x
  let y = node.position.y
  let parentId = node.parentId
  const seen = new Set<string>()
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId)
    const parent = byId.get(parentId)
    if (!parent) break
    x += parent.position.x
    y += parent.position.y
    parentId = parent.parentId
  }
  return { x, y }
}

/** Delete one persisted card using the browser's group semantics: a frame's children survive. */
export function removeNodeCard(project: Project, nodeId: string): boolean {
  const target = project.nodes.find((node) => node.id === nodeId)
  if (!target) return false
  if (target.kind === 'group') {
    const parent = target.parentId
      ? project.nodes.find((node) => node.id === target.parentId && node.kind === 'group')
      : undefined
    const parentRoot = parent ? rootPosition(project.nodes, parent) : { x: 0, y: 0 }
    project.nodes = groupsFirst(
      project.nodes
        .filter((node) => node.id !== nodeId)
        .map((node) => {
          if (node.parentId !== nodeId) return node
          const root = rootPosition(project.nodes, node)
          const promoted: CanvasNodeState = {
            ...node,
            position: { x: root.x - parentRoot.x, y: root.y - parentRoot.y }
          }
          if (parent) promoted.parentId = parent.id
          else delete promoted.parentId
          return promoted
        })
    )
  } else {
    project.nodes = project.nodes.filter((node) => node.id !== nodeId)
  }
  project.ropes = project.ropes?.filter((edge) => edge.source !== nodeId && edge.target !== nodeId)
  project.bridges = project.bridges?.filter(
    (edge) => edge.source !== nodeId && edge.target !== nodeId
  )
  if (project.kanban) {
    project.kanban.assignments = project.kanban.assignments.filter(
      (entry) => entry.nodeId !== nodeId
    )
    project.kanban.meta = project.kanban.meta?.filter((entry) => entry.nodeId !== nodeId)
  }
  project.breadcrumbs = project.breadcrumbs?.filter((entry) => entry.nodeId !== nodeId)
  return true
}

/** One mutation engine shared by the REST sweep, single delete, and the periodic reaper. */
export class ServerNodeOps {
  private readonly now: () => number
  private readonly mutationQueue: WorkspaceMutationQueue

  constructor(private readonly deps: ServerNodeOpsDeps) {
    this.now = deps.now ?? Date.now
    this.mutationQueue = deps.mutationQueue ?? new WorkspaceMutationQueue()
  }

  private runExclusive<T>(work: () => Promise<T>): Promise<T> {
    return this.mutationQueue.run(work)
  }

  private async paneState(project: Project, node: CanvasNodeState): Promise<OpsPaneState> {
    if (node.kind !== 'terminal') return 'none'
    // This Server process has no ControlMaster for a stored SSH project; local absence says nothing
    // about that host. Inventory says unknown and destructive sweep skips it.
    if (project.ssh) return 'unknown'
    try {
      return await this.deps.sessionPresence(node.id)
    } catch {
      return 'unknown'
    }
  }

  async list(): Promise<OpsNodeInventoryItem[]> {
    const workspace = await this.deps.workspaceStore.load({ sideline: false })
    const pending: Array<Promise<OpsNodeInventoryItem>> = []
    for (const project of workspace.projects) {
      for (const node of project.nodes) {
        pending.push((async () => {
          const status = this.deps.statusOf(node.id)
          return {
            id: node.id,
            kind: node.kind,
            title: node.title,
            projectId: project.id,
            groupId: node.parentId ?? null,
            createdAt: createdAtFromNodeId(node.id, this.now()),
            paneState: await this.paneState(project, node),
            agentStatus: normalizedAgentStatus(status),
            lastActivityAt: status?.updatedAt ?? null,
            ownerSession: this.deps.ownerOf(node.id)?.sourceNodeId ?? null
          }
        })())
      }
    }
    return Promise.all(pending)
  }

  sweep(dryRun: boolean): Promise<OpsSweepResult> {
    return this.runExclusive(async () => {
      const workspace = await this.deps.workspaceStore.load({ sideline: false })
      const deadByProject = new Map<Project, string[]>()
      let scanned = 0
      for (const project of workspace.projects) {
        if (project.ssh) continue
        for (const node of project.nodes) {
          if (node.kind !== 'terminal') continue
          scanned += 1
          // Two definitive misses: the second is the mutation-boundary recheck. Any read failure
          // becomes `unknown`, never absence, and therefore cannot enter the deletion set.
          if ((await this.paneState(project, node)) !== 'dead') continue
          if ((await this.paneState(project, node)) !== 'dead') continue
          const ids = deadByProject.get(project) ?? []
          ids.push(node.id)
          deadByProject.set(project, ids)
        }
      }
      const affectedIds = [...deadByProject.values()].flat()
      if (dryRun || affectedIds.length === 0) return { dryRun, affectedIds, scanned }

      for (const [project, ids] of deadByProject) {
        for (const id of ids) removeNodeCard(project, id)
      }
      await this.deps.workspaceStore.save(workspace)
      for (const [project, ids] of deadByProject) {
        this.deps.publishProject?.(project)
        for (const id of ids) this.deps.publishRemoval?.(project.id, id)
      }
      this.deps.onRemoved?.(affectedIds)
      return { dryRun, affectedIds, scanned }
    })
  }

  /**
   * The other half of dead-card hygiene: give a live `nt-<id>` session with no card a card again.
   *
   * Same engine for boot and for `POST /opsapi/adopt-orphans`, on the SAME workspace FIFO as the
   * sweep — an adoption that raced a sweep's load/save pair could otherwise write back cards the
   * sweep had just removed. The evidence rule is the sweep's, inverted: the sweep removes on two
   * definite absences, this adds on one definite presence (a live session AND a pane cwd inside a
   * project). It creates nothing, attaches to nothing, and types nothing — the browser reaches the
   * pane through the ordinary attach-only path when the card mounts (see `protectAdopted`).
   *
   * A shell that wires no session listing adopts nothing, which is what makes this inert on the
   * desktop and in every test that does not ask for it.
   */
  adoptOrphans(): Promise<OpsAdoptResult> {
    return this.runExclusive(async () => {
      const live = !!this.deps.publishNode
      if (!this.deps.listSessions || !this.deps.listPaneCwds) {
        return { adopted: [], skipped: [], live }
      }
      const [sessionNames, paneCwdBySession] = await Promise.all([
        this.deps.listSessions(),
        this.deps.listPaneCwds()
      ])
      const workspace = await this.deps.workspaceStore.load({ sideline: false })
      const plan = planOrphanAdoption({
        projects: workspace.projects,
        sessionNames,
        paneCwdBySession,
        mirror: this.deps.mirrorOf
      })
      const skipped = plan.skipped.map((entry) => ({
        id: entry.nodeId,
        sessionName: entry.sessionName,
        cwd: entry.cwd,
        reason: entry.reason
      }))
      if (!plan.adopt.length) return { adopted: [], skipped, live }

      const touched = new Map<string, Project>()
      for (const adoption of plan.adopt) {
        const project = workspace.projects.find((candidate) => candidate.id === adoption.projectId)
        // The plan was built from this very workspace object, so this cannot miss — but a plan is
        // data and the write must not trust it blindly.
        if (!project) continue
        project.nodes.push(adoption.node)
        touched.set(project.id, project)
      }
      const adopted = plan.adopt
        .filter((adoption) => touched.has(adoption.projectId))
        .map((adoption) => ({
          id: adoption.node.id,
          projectId: adoption.projectId,
          projectName: adoption.projectName,
          title: adoption.node.title,
          sessionName: adoption.sessionName
        }))
      if (!adopted.length) return { adopted: [], skipped, live }

      await this.deps.workspaceStore.save(workspace)
      // Only AFTER the card is durable: classifying an id we then failed to persist would mark a
      // node attach-only that no project has.
      await this.deps.protectAdopted?.(adopted.map((entry) => entry.id)).catch(() => undefined)
      for (const project of touched.values()) this.deps.publishProject?.(project)
      for (const adoption of plan.adopt) {
        if (!touched.has(adoption.projectId)) continue
        this.deps.publishNode?.(adoption.projectId, adoption.node)
      }
      return { adopted, skipped, live }
    })
  }

  remove(nodeId: string, force: boolean): Promise<OpsRemoveResult> {
    return this.runExclusive(async () => {
      const workspace = await this.deps.workspaceStore.load({ sideline: false })
      const matches = workspace.projects.flatMap((project) =>
        project.nodes.filter((node) => node.id === nodeId).map((node) => ({ project, node }))
      )
      if (matches.length === 0) return { ok: false, status: 404, error: 'node_not_found' }
      if (matches.length !== 1) return { ok: false, status: 409, error: 'ambiguous_node_id' }

      const { project, node } = matches[0]
      const paneState = await this.paneState(project, node)
      if (paneState === 'alive' && !force) {
        return { ok: false, status: 409, error: 'pane_alive', paneState }
      }
      if (paneState === 'unknown' && !force) {
        return { ok: false, status: 503, error: 'pane_state_unknown', paneState }
      }
      if (paneState === 'dead' && node.kind === 'terminal' && !force) {
        const confirmed = await this.paneState(project, node)
        if (confirmed === 'alive') {
          return { ok: false, status: 409, error: 'pane_alive', paneState: confirmed }
        }
        if (confirmed !== 'dead') {
          return { ok: false, status: 503, error: 'pane_state_unknown', paneState: confirmed }
        }
      }
      if (force && node.kind === 'terminal' && !project.ssh) {
        try {
          // Kill before persistence. A failed end is an unknown outcome and must keep the card.
          await this.deps.destroySession(node.id)
        } catch {
          return { ok: false, status: 503, error: 'pane_destroy_failed', paneState }
        }
      }

      removeNodeCard(project, node.id)
      await this.deps.workspaceStore.save(workspace)
      this.deps.publishProject?.(project)
      this.deps.publishRemoval?.(project.id, node.id)
      this.deps.onRemoved?.([node.id])
      return { ok: true, removedIds: [node.id], forced: force }
    })
  }
}
