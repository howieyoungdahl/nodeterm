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
  now?: () => number
  mutationQueue?: WorkspaceMutationQueue
}

export interface OpsSweepResult {
  dryRun: boolean
  affectedIds: string[]
  scanned: number
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
