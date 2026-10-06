import { completeCreationPlanning, creationAdmission, type AssistantCreation } from '../shared/assistant-creation'
import { parseTaskPlanning, planningAtCreation, type TaskPlanning } from '../shared/task-planning'
import { AssistantCreationReceipts } from './assistant-creation-receipts'
import { promises as fsPromises } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'

import {
  planOrphanAdoption,
  type OrphanMirrorEntry,
  type OrphanSkipReason
} from '../core/orphan-adoption'
import { sessionName } from '../core/tmux-naming'
import type { AgentState } from '../shared/agents/normalize'
import { OPS_OPERATOR_SOURCE_ID } from '../shared/ops-operator-identity'
import type { BoardLogEntry, CanvasNodeState, Project, Workspace, WorkspaceSaveAck } from '../shared/types'
import { nodePlacement, placeNode, planOrganization, type OrganizationPlan } from '../core/kanban-organization'
import { organizationKey, parseOrganizationMetadata, parseOrganizationPolicy, withManualAssignment } from '../shared/kanban-organization'
import type { NodeOrganization, OrganizationMetadata, OrganizationPolicy } from '../shared/kanban-organization'
import { OrganizationJournal, type CreationReservation, type OrganizationJournalState, type OrganizationReceipt } from './organization-journal'
import { WorkspaceMutationQueue } from './workspace-mutation-queue'

/**
 * Ownership-ledger `sourceNodeId` stamped on a node the `/opsapi/nodes` operator plane created
 * directly — never a spoofed live node id. `remove`/`update` read it back to recognize an
 * operator-created card without an explicit `?force=1`, and `list` surfaces it so a caller can
 * tell operator-spawned cards from agent-spawned ones.
 *
 * Defined in `shared/ops-operator-identity.ts` (re-exported here for every existing import of this
 * module) so `headless-node-factory.ts`'s `ownsSpawn` can refuse it as a control-plane CALLER
 * identity without this file and that one depending on each other.
 */
export { OPS_OPERATOR_SOURCE_ID }

// Mirrors headless-node-factory.ts's `terminalSize()` clamp range and default terminal geometry.
// Duplicated rather than imported: the operator plane (this file) is wired unconditionally in
// index.ts, while headless-node-factory.ts backs the OPTIONAL `config.canvasControl` verified-node
// control plane, and node-ops must not gain a hard dependency on that optional module.
const OPERATOR_NODE_WIDTH_BOUNDS = { min: 280, max: 2400 }
const OPERATOR_NODE_HEIGHT_BOUNDS = { min: 160, max: 1600 }
const OPERATOR_DEFAULT_NODE_SIZE = { width: 640, height: 440 }
const OPERATOR_TERMINAL_COLS = 120
const OPERATOR_TERMINAL_ROWS = 36
const OPERATOR_NODE_COLOR = '#5b8def'
const OPERATOR_H_GAP = 80
const OPERATOR_V_GAP = 36

export { OPERATOR_NODE_WIDTH_BOUNDS, OPERATOR_NODE_HEIGHT_BOUNDS }

function operatorNodeToken(): string {
  return Math.random().toString(36).slice(2, 10)
}

/** Same `term-<ts36>-<token>` shape headless-node-factory.ts's `nextId('term')` mints. */
function nextOperatorNodeId(): string {
  return `term-${Date.now().toString(36)}-${operatorNodeToken()}`
}

/**
 * Place a new card in the first free slot of a 3-row grid scanning out from the canvas origin —
 * the same collision-avoidance approach `placeRight` uses in headless-node-factory.ts, anchored at
 * (0,0) since an operator create has no source node to place relative to. Only considers top-level
 * (unparented) cards: a card inside a group frame is positioned in the frame's own local space, not
 * comparable to this root-space scan, and operator placement only needs to avoid the common case.
 */
/** Bound on the collision-scan grid (below). A saved card's size is foreign data — a corrupt or
 *  absurd value (width `1e12`, still valid JSON) must never turn one HTTP request into an
 *  unbounded loop on the single event-loop thread; see the fallback below. */
const MAX_PLACEMENT_SLOTS = 2_000

function placeFromOrigin(
  project: Project,
  size: { width: number; height: number }
): { x: number; y: number } {
  const occupied = project.nodes
    .filter((candidate) => !candidate.parentId)
    .map((candidate) => ({
      x: candidate.position.x,
      y: candidate.position.y,
      width: Math.max(1, candidate.size?.width || OPERATOR_DEFAULT_NODE_SIZE.width),
      height: Math.max(1, candidate.size?.height || OPERATOR_DEFAULT_NODE_SIZE.height)
    }))
  for (let slot = 0; slot < MAX_PLACEMENT_SLOTS; slot++) {
    const column = Math.floor(slot / 3)
    const row = slot % 3
    const candidate = {
      x: column * (size.width + OPERATOR_H_GAP),
      y: row * (size.height + OPERATOR_V_GAP),
      width: size.width,
      height: size.height
    }
    const collides = occupied.some(
      (rect) =>
        candidate.x < rect.x + rect.width &&
        candidate.x + candidate.width > rect.x &&
        candidate.y < rect.y + rect.height &&
        candidate.y + candidate.height > rect.y
    )
    if (!collides) return { x: candidate.x, y: candidate.y }
  }
  // The scan gave up rather than spin: place past the right edge of the widest occupied extent.
  // Not guaranteed collision-free against every card (a huge one could still reach past it), but
  // guaranteed to terminate, and clear of every NORMALLY sized card on the canvas.
  const maxRight = occupied.reduce(
    (max, rect) => (Number.isFinite(rect.x + rect.width) ? Math.max(max, rect.x + rect.width) : max),
    0
  )
  return { x: maxRight + OPERATOR_H_GAP, y: 0 }
}

export type OpsPaneState = 'alive' | 'dead' | 'unknown' | 'none'
export type OpsAgentStatus = 'working' | 'idle' | 'blocked' | null

export interface OpsNodeInventoryItem {
  organization?: NodeOrganization
  assistantCreated?: boolean
  columnId?: string | null
  revision?: string
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
  /** True when this node was created directly by `POST /opsapi/nodes` (never a spoofed source). */
  operatorCreated: boolean
}

export interface NodeOpsWorkspace {
  load(opts?: { sideline?: boolean }): Promise<Workspace>
  save(workspace: Workspace): Promise<unknown>
}

export interface ServerNodeOpsDeps {
  workspaceStore: NodeOpsWorkspace
  sessionPresence(nodeId: string): Promise<Exclude<OpsPaneState, 'none'>>
  destroySession(nodeId: string): Promise<void>
  statusOf(nodeId: string): { state?: AgentState; updatedAt: number } | undefined
  ownerOf(nodeId: string): { sourceNodeId: string; projectId?: string; assistantCreationId?: string } | undefined
  /** Stamp the durable ownership ledger for a node `create()` just persisted. Absent = ownership is
   *  never recorded and the node reads back as not operator-created (fails closed). */
  recordOwnership?(nodeId: string, owner: { sourceNodeId: string; projectId: string; assistantCreationId?: string }): void
  flushOwnership?(): Promise<void>
  creationReceipts?: AssistantCreationReceipts
  organizationJournal?: OrganizationJournal
  appendBoardLog?(projectId: string, entry: BoardLogEntry): Promise<boolean>
  /**
   * Spawn the real terminal backend for an operator-created node (the same `PtyManager.createHeadless`
   * the verified-node control plane uses). Absent = `create()` refuses with 501 rather than persist
   * a card that can never have a session.
   */
  createSession?(options: {
    cwd?: string
    cols: number
    rows: number
    persistKey: string
    ownerProjectId: string
  }): Promise<{ sessionId: string; fresh: boolean }>
  /** Type a `create()` node's initial `--cmd` once its session exists. */
  sendText?(nodeId: string, text: string): Promise<boolean>
  onRemoved?(nodeIds: readonly string[]): void
  protectedCleanupNodeIds?(): Promise<string[]>
  publishProject?(project: Project): void
  publishRemoval?(projectId: string, nodeId: string, workspaceRevision?: string): void
  /** Live insertion of one adopted card into every attached browser (canvas-sync upsert). Absent
   *  = no live channel, and `adoptOrphans` says so in its reply instead of implying one. */
  publishNode?(projectId: string, node: CanvasNodeState, workspaceRevision?: string): void
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
  /** Mass-sweep guard thresholds. Omitted = {@link DEFAULT_DEAD_CARD_MASS_LIMIT}. */
  massLimit?: DeadCardMassLimit
  /** The one loud line a refused sweep prints. Defaults to console.warn. */
  warn?(message: string): void
}

export interface OpsSweepResult {
  dryRun: boolean
  affectedIds: string[]
  scanned: number
  /** Set when the mass-sweep guard refused this pass. Absent = the pass was allowed to apply. */
  refused?: OpsSweepRefusal
}

/**
 * Why a pass refused to apply. `affectedIds` still carries the set it WOULD have removed, so an
 * operator can look at it before deciding to force the pass through.
 */
export interface OpsSweepRefusal {
  reason: 'mass_limit'
  deadCount: number
  scanned: number
  maxCards: number
  maxFraction: number
}

/**
 * Mass-sweep guard thresholds.
 *
 * The reaper's job is attrition: the card or two whose tmux session died on its own since the last
 * pass. A whole canvas reading dead in ONE pass is a different event — the tmux server died, the
 * socket name changed, a probe regressed — and in that event the cards are the only remaining
 * record of the sessions, so removing them destroys the evidence instead of tidying after it.
 * (2026-09-06: the tmux server died at 06:39 and the 07:07 pass removed 16 terminal cards.)
 * Above these thresholds the sweep applies NOTHING and says so; the operator forces it if the
 * cards really are stale.
 */
export interface DeadCardMassLimit {
  /** Dead cards in one pass at or above which the sweep refuses. 0 disables this rule. */
  maxCards: number
  /** Dead-of-scanned share at or above which the sweep refuses. 0 disables this rule. */
  maxFraction: number
}

/**
 * Five cards: more than four terminal sessions dying between two 30-minute passes is a host event,
 * not attrition. Half the canvas: the count rule alone cannot see a small canvas losing everything
 * it has (4 of 4 is as total a loss as 16 of 30), and the share rule alone cannot see a big canvas
 * losing a serious chunk that is still a minority. They are OR-ed for that reason.
 */
export const DEFAULT_DEAD_CARD_MASS_LIMIT: DeadCardMassLimit = { maxCards: 5, maxFraction: 0.5 }

/** One card is never a mass event, so the share rule needs at least a pair behind it. Without this
 *  floor a single dead card on a one-card canvas is 100% and could never be reaped at all. */
const MASS_FRACTION_FLOOR = 2

/** Pure guard decision, shared by the timer and POST /opsapi/sweep. */
export function deadCardMassRefusal(
  deadCount: number,
  scanned: number,
  limit: DeadCardMassLimit
): OpsSweepRefusal | null {
  const byCount = limit.maxCards > 0 && deadCount >= limit.maxCards
  const byFraction =
    limit.maxFraction > 0 &&
    deadCount >= MASS_FRACTION_FLOOR &&
    scanned > 0 &&
    deadCount / scanned >= limit.maxFraction
  if (!byCount && !byFraction) return null
  return {
    reason: 'mass_limit',
    deadCount,
    scanned,
    maxCards: limit.maxCards,
    maxFraction: limit.maxFraction
  }
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

export interface OpsCreateInput {
  creation?: AssistantCreation
  idempotencyKey?: string
  organization?: OrganizationMetadata
  organizationPolicy?: OrganizationPolicy
  expectedRevision?: string
  projectId?: string
  cmd?: string
  cwd?: string
  title?: string
  width?: number
  height?: number
}

export type OpsCreateResult =
  | { ok: true; id: string; projectId: string; title: string; tmuxSession: string; idempotencyKey?: string; replayed?: boolean; organization?: NodeOrganization }
  | {
      ok: false
      status: number
      error: string
      /** Set when the card was already persisted (a spawn/command failure, never a validation
       *  refusal) — the CLI can retry the command or clean up by id without parsing the error
       *  string. */
      id?: string
      tmuxSession?: string
      idempotencyKey?: string
      replayed?: boolean
    }

export interface OpsUpdateInput {
  taskPlanning?: TaskPlanning
  organization?: OrganizationMetadata
  organizationPolicy?: OrganizationPolicy
  expectedRevision?: string
  title?: string
  width?: number
  height?: number
}

export type OpsUpdateResult =
  | { ok: true; id: string; title: string; size: { width: number; height: number }; revision?: string; organization?: NodeOrganization; placement?: OrganizationPlan; receiptId?: string }
  | { ok: false; status: number; error: string; id?: string; receiptId?: string }

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
  private readonly massLimit: DeadCardMassLimit

  constructor(private readonly deps: ServerNodeOpsDeps) {
    this.now = deps.now ?? Date.now
    this.mutationQueue = deps.mutationQueue ?? new WorkspaceMutationQueue()
    this.massLimit = deps.massLimit ?? DEFAULT_DEAD_CARD_MASS_LIMIT
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
    const journal = await this.deps.organizationJournal?.read()
    const origins = new Map(Object.values(journal?.creations ?? {}).filter((r) => r.assistant).map((r) => [r.id, r]))
    const pending: Array<Promise<OpsNodeInventoryItem>> = []
    for (const project of workspace.projects) {
      for (const node of project.nodes) {
        pending.push((async () => {
          const status = this.deps.statusOf(node.id)
          const owner = this.deps.ownerOf(node.id)
          const origin = owner?.assistantCreationId ? origins.get(owner.assistantCreationId) : undefined
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
            ownerSession: this.deps.ownerOf(node.id)?.sourceNodeId ?? null,
            operatorCreated: this.deps.ownerOf(node.id)?.sourceNodeId === OPS_OPERATOR_SOURCE_ID,
            organization: node.organization,
            assistantCreated: owner?.sourceNodeId === OPS_OPERATOR_SOURCE_ID && owner.projectId === project.id &&
              origin?.nodeId === node.id && origin.projectId === project.id,
            columnId: nodePlacement(project.kanban, node.id).columnId,
            revision: project.revision
          }
        })())
      }
    }
    return Promise.all(pending)
  }

  /**
   * @param force Skip the mass-sweep guard. Only `POST /opsapi/sweep` with an explicit
   *              `"force": true` sets this; the periodic reaper never does.
   */
  sweep(dryRun: boolean, force = false): Promise<OpsSweepResult> {
    return this.runExclusive(async () => {
      const workspace = await this.deps.workspaceStore.load({ sideline: false })
      const deadByProject = new Map<Project, string[]>()
      let scanned = 0
      const protectedCleanupIds = new Set(await this.deps.protectedCleanupNodeIds?.() ?? [])
      for (const project of workspace.projects) {
        if (project.ssh) continue
        for (const node of project.nodes) {
          if (node.kind !== 'terminal' || node.cleanupArchiveId || protectedCleanupIds.has(node.id)) continue
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
      const refused = force ? null : deadCardMassRefusal(affectedIds.length, scanned, this.massLimit)
      if (refused) {
        // Exactly one line per refused APPLY, printed by the engine rather than by each caller, so
        // the timer and the REST route cannot each publish their own version of the same refusal.
        // A dry run reports the refusal in its reply and stays silent: it removed nothing either
        // way, and an operator probing the canvas must not have to mute a log to do it.
        if (!dryRun) {
          const warn = this.deps.warn ?? console.warn
          warn(
            `[nodeterm-server] REFUSED dead-card sweep: ${refused.deadCount} of ${scanned} local ` +
              `terminal card(s) read dead in one pass (limit ${refused.maxCards} cards / ` +
              `${Math.round(refused.maxFraction * 100)}% of the canvas). Nothing was removed — a ` +
              `whole canvas going dead at once is a host event, and the cards are the record of ` +
              `it. Sweep anyway: POST /opsapi/sweep {"dryRun":false,"force":true}. Change the ` +
              `thresholds: --dead-card-reap-mass-limit / --dead-card-reap-mass-fraction.`
          )
        }
        return { dryRun, affectedIds, scanned, refused }
      }
      if (dryRun || affectedIds.length === 0) return { dryRun, affectedIds, scanned }

      for (const [project, ids] of deadByProject) {
        for (const id of ids) removeNodeCard(project, id)
      }
      await this.deps.workspaceStore.save(workspace)
      for (const [project, ids] of deadByProject) {
        this.deps.publishProject?.(project)
        for (const id of ids) this.deps.publishRemoval?.(project.id, id, project.workspaceChange?.after)
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
        this.deps.publishNode?.(adoption.projectId, adoption.node, touched.get(adoption.projectId)?.workspaceChange?.after)
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
      // An operator-created node (§create) is terminated and removed like a forced delete WITHOUT
      // needing `?force=1` — it is this same principal's own card, so there is no third party's
      // work to protect it from. Every other node's behavior is byte-for-byte what it was before.
      const operatorCreated = this.deps.ownerOf(node.id)?.sourceNodeId === OPS_OPERATOR_SOURCE_ID
      const effectiveForce = force || operatorCreated
      const paneState = await this.paneState(project, node)
      if (paneState === 'alive' && !effectiveForce) {
        return { ok: false, status: 409, error: 'pane_alive', paneState }
      }
      if (paneState === 'unknown' && !effectiveForce) {
        return { ok: false, status: 503, error: 'pane_state_unknown', paneState }
      }
      if (paneState === 'dead' && node.kind === 'terminal' && !effectiveForce) {
        const confirmed = await this.paneState(project, node)
        if (confirmed === 'alive') {
          return { ok: false, status: 409, error: 'pane_alive', paneState: confirmed }
        }
        if (confirmed !== 'dead') {
          return { ok: false, status: 503, error: 'pane_state_unknown', paneState: confirmed }
        }
      }
      if (effectiveForce && node.kind === 'terminal' && !project.ssh) {
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
      this.deps.publishRemoval?.(project.id, node.id, project.workspaceChange?.after)
      this.deps.onRemoved?.([node.id])
      return { ok: true, removedIds: [node.id], forced: effectiveForce }
    })
  }

  /**
   * `POST /opsapi/nodes`: create a terminal node with no live source node to anchor it — the
   * out-of-canvas path `HeadlessNodeFactory.open()` structurally refuses (it requires an already
   * live, verified, control-capable caller). The ops-token principal IS the anchor here: ownership
   * is stamped as {@link OPS_OPERATOR_SOURCE_ID}, never a spoofed live node id, so the ledger and
   * every downstream "who owns this" read stay honest about a server-operator-created node.
   *
   * `cwd` is stat'd before the workspace transaction — a filesystem check has no business inside
   * the serialized mutation window — and the PTY spawn itself happens OUTSIDE that window too,
   * for the same non-cancellable-operation reason `launchPrepared` in headless-node-factory.ts
   * gives: the card is already durable and published by the time the tmux spawn can fail, so a
   * spawn failure is reported honestly rather than rolled back into an unknown state.
   */
  async create(input: OpsCreateInput): Promise<OpsCreateResult> {
    const refusal = creationAdmission(input.creation, input.organization, input.projectId, input.idempotencyKey)
    if (refusal || !input.idempotencyKey) return { ok: false, status: 400, error: refusal ?? 'assistant_creation_key_required' }
    if (!this.deps.creationReceipts || !this.deps.organizationJournal) return { ok: false, status: 503, error: 'assistant_creation_evidence_unavailable' }
    if (this.deps.organizationJournal) return this.createDurable(input)
    if (input.organization || input.organizationPolicy || input.idempotencyKey) {
      return { ok: false, status: 503, error: 'organization_persistence_unavailable' }
    }
    if (input.cwd !== undefined) {
      let stat: Awaited<ReturnType<typeof fsPromises.stat>>
      try {
        stat = await fsPromises.stat(input.cwd)
      } catch {
        return { ok: false, status: 400, error: `cwd_not_found: ${input.cwd}` }
      }
      if (!stat.isDirectory()) {
        return { ok: false, status: 400, error: `cwd_not_a_directory: ${input.cwd}` }
      }
    }

    const prepared = await this.runExclusive(async () => {
      const workspace = await this.deps.workspaceStore.load({ sideline: false })
      const knownIds = (): string => workspace.projects.map((project) => project.id).join(', ') || '(none)'
      let project: Project | undefined
      if (input.projectId !== undefined) {
        project = workspace.projects.find((candidate) => candidate.id === input.projectId)
        if (!project) {
          return {
            ok: false as const,
            status: 400,
            error: `unknown_project_id: no project ${JSON.stringify(input.projectId)}; known ids: ${knownIds()}`
          }
        }
      } else {
        project = workspace.projects.find((candidate) => candidate.id === workspace.activeProjectId)
        if (!project) {
          return {
            ok: false as const,
            status: 400,
            error: `no_default_project: workspace has no active project; pass projectId explicitly; known ids: ${knownIds()}`
          }
        }
      }
      if (project.ssh) {
        return {
          ok: false as const,
          status: 400,
          error: 'project_target_ssh_unsupported: the operator plane only creates local terminal sessions'
        }
      }

      const size = {
        width: input.width ?? OPERATOR_DEFAULT_NODE_SIZE.width,
        height: input.height ?? OPERATOR_DEFAULT_NODE_SIZE.height
      }
      const id = nextOperatorNodeId()
      const node: CanvasNodeState = {
        id,
        kind: 'terminal',
        position: placeFromOrigin(project, size),
        size,
        title: input.title ?? `Operator ${id}`,
        titleAuto: false,
        role: 'worker',
        color: OPERATOR_NODE_COLOR,
        group: null,
        tags: [],
        ...(input.cwd !== undefined ? { cwd: input.cwd } : {})
      }
      project.nodes.push(node)
      await this.deps.workspaceStore.save(workspace)
      this.deps.recordOwnership?.(id, { sourceNodeId: OPS_OPERATOR_SOURCE_ID, projectId: project.id })
      this.deps.publishProject?.(project)
      this.deps.publishNode?.(project.id, node, project.workspaceChange?.after)
      return { ok: true as const, project, node }
    })
    if (!prepared.ok) return prepared

    const { project, node } = prepared
    if (!this.deps.createSession) {
      return {
        ok: false,
        status: 501,
        error: 'create_not_supported: this server was not wired for operator node creation'
      }
    }
    // The real tmux session name, computed up front: needed on every path below, success or
    // failure, once the card is persisted (see the comment on the success return for why this is
    // never `spawned.sessionId`).
    const tmuxSession = sessionName(node.id)
    try {
      const spawned = await this.deps.createSession({
        // Same default `open()`/`ptyOptions()` uses for every other server-spawned terminal
        // (headless-node-factory.ts): an explicit --cwd wins, else the project's own folder — never
        // PtyManager's own fallback (the bearer holder's $HOME), which would put a `canvas new`
        // with no --cwd in a different place than the project it was created against, and a later
        // browser reopen of the same card (which resolves cwd the SAME way) would then diverge.
        cwd: node.cwd || project.cwd,
        cols: OPERATOR_TERMINAL_COLS,
        rows: OPERATOR_TERMINAL_ROWS,
        persistKey: node.id,
        ownerProjectId: project.id
      })
      if (!spawned.sessionId) {
        return {
          ok: false,
          status: 502,
          error: `pty_spawn_failed: node ${node.id} was persisted but its terminal session could not be started`,
          id: node.id,
          tmuxSession
        }
      }
      if (input.cmd !== undefined && !(await this.deps.sendText?.(node.id, input.cmd))) {
        return {
          ok: false,
          status: 502,
          error:
            `pty_command_failed: node ${node.id} was persisted and its session started, but the ` +
            'initial command could not be delivered',
          id: node.id,
          tmuxSession
        }
      }
      // `spawned.sessionId` is PtyManager's own internal pty-registry id ("pty-N"), not the tmux
      // session name — `sessionName()` (core/tmux-naming.ts) is the single source of truth for
      // that, the same function `has-session`/`send-keys`/`kill-session` callers must use to find
      // this node's real backend.
      return { ok: true, id: node.id, projectId: project.id, title: node.title, tmuxSession }
    } catch (error) {
      return {
        ok: false,
        status: 502,
        error: `pty_spawn_failed: ${error instanceof Error ? error.message : String(error)}`,
        id: node.id,
        tmuxSession
      }
    }
  }

  /**
   * `PATCH /opsapi/nodes/:id`: rename and/or resize. Allowed without `force` only for a node this
   * same operator plane created ({@link OPS_OPERATOR_SOURCE_ID}); every other node needs the same
   * explicit `?force=1` gate `DELETE` already requires, so an operator script cannot quietly rename
   * or resize a live agent's own card.
   */
  async update(nodeId: string, input: OpsUpdateInput, force: boolean): Promise<OpsUpdateResult> {
    return this.runExclusive(async () => {
      const workspace = await this.deps.workspaceStore.load({ sideline: false })
      const matches = workspace.projects.flatMap((project) =>
        project.nodes.filter((node) => node.id === nodeId).map((node) => ({ project, node }))
      )
      if (matches.length === 0) return { ok: false, status: 404, error: 'node_not_found' }
      if (matches.length !== 1) return { ok: false, status: 409, error: 'ambiguous_node_id' }

      const { project, node } = matches[0]
      if (input.taskPlanning) {
        if (!input.expectedRevision || input.expectedRevision !== project.revision) return { ok: false, status: 409, error: 'revision_conflict' }
        if (input.organization || input.organizationPolicy || input.title !== undefined || input.width !== undefined || input.height !== undefined)
          return { ok: false, status: 400, error: 'task_planning_requires_metadata_only_update' }
        const planning = parseTaskPlanning(input.taskPlanning)
        if (!planning || (node.taskPlanning && planning.taskId !== node.taskPlanning.taskId) ||
          (node.assistantCreation && planning.taskId !== node.assistantCreation.taskId))
          return { ok: false, status: 400, error: 'task_planning_requires_stable_task_identity' }
        const state = await this.deps.organizationJournal?.read()
        if (!state || node.kind !== 'terminal' || node.role !== 'worker' || !this.attested(project, nodeId, state))
          return { ok: false, status: 403, error: 'task_planning_creator_evidence_required' }
        const owner = this.deps.ownerOf(nodeId)!
        const reservations = Object.entries(state.creations).filter(([, reservation]) =>
          reservation.id === owner.assistantCreationId && reservation.nodeId === nodeId && reservation.projectId === project.id)
        if (reservations.length !== 1 || !this.deps.creationReceipts)
          return { ok: false, status: 403, error: 'task_planning_creator_evidence_required' }
        let evidence
        try { evidence = await this.deps.creationReceipts.find({ principal: 'ops-bearer',
          sourceNodeId: OPS_OPERATOR_SOURCE_ID, projectId: project.id }, reservations[0][0]) }
        catch { return { ok: false, status: 503, error: 'task_planning_creator_evidence_unavailable' } }
        if (!evidence || evidence.id !== owner.assistantCreationId || evidence.fingerprint !== reservations[0][1].fingerprint ||
          !evidence.nodes.some(entry => entry.nodeId === nodeId) || evidence.creation.taskId !== planning.taskId)
          return { ok: false, status: 403, error: 'task_planning_immutable_task_identity_required' }
        // Descriptive metadata only. The board, manual priorities, geometry and all processes stay untouched.
        const updated = { ...node, taskPlanning: planningAtCreation(planning.taskId, undefined, planning) }
        project.nodes = project.nodes.map(candidate => candidate.id === nodeId ? updated : candidate)
        try { await this.deps.workspaceStore.save(workspace) }
        catch { return { ok: false, id: nodeId, status: 503, error: 'task_planning_write_uncertain_reload_before_retry' } }
        this.deps.publishProject?.(project)
        this.deps.publishNode?.(project.id, updated, project.workspaceChange?.after)
        return { ok: true, id: nodeId, title: node.title, size: node.size, revision: project.revision }
      }
      if (input.organization || input.organizationPolicy) {
        try { return await this.updateOrganization(workspace, project, node, input) }
        catch { return { ok: false, id: nodeId, status: 503, error: 'organization_write_uncertain_inspect_audit_before_retry' } }
      }
      const operatorCreated = this.deps.ownerOf(nodeId)?.sourceNodeId === OPS_OPERATOR_SOURCE_ID
      if (!operatorCreated && !force) {
        return {
          ok: false,
          status: 403,
          error: 'force_required: node was not created by the operator plane; retry with ?force=1'
        }
      }
      if ((input.width !== undefined || input.height !== undefined) && node.kind !== 'terminal') {
        return { ok: false, status: 400, error: 'resize_requires_terminal_node' }
      }

      const updated: CanvasNodeState = { ...node }
      if (input.title !== undefined) {
        updated.title = input.title
        updated.titleAuto = false
      }
      if (input.width !== undefined || input.height !== undefined) {
        updated.size = {
          width: input.width ?? node.size.width,
          height: input.height ?? node.size.height
        }
      }
      project.nodes = project.nodes.map((candidate) => (candidate.id === nodeId ? updated : candidate))
      await this.deps.workspaceStore.save(workspace)
      this.deps.publishProject?.(project)
      this.deps.publishNode?.(project.id, updated, project.workspaceChange?.after)
      return { ok: true, id: nodeId, title: updated.title, size: updated.size }
    })
  }

  /** Exact IDs only. This read does not inspect panes, create columns or mutate project data. */
  async boards(): Promise<unknown> {
    const workspace = await this.deps.workspaceStore.load({ sideline: false })
    return { boards: workspace.projects.map((p) => ({ projectId: p.id, revision: p.revision,
      available: !p.unavailable, columns: p.kanban?.columns ?? [], assignments: p.kanban?.assignments ?? [],
      policy: p.kanbanOrganization ?? null })) }
  }

  private attested(project: Project, nodeId: string, state: OrganizationJournalState): boolean {
    const owner = this.deps.ownerOf(nodeId)
    if (!owner?.assistantCreationId || owner.sourceNodeId !== OPS_OPERATOR_SOURCE_ID || owner.projectId !== project.id) return false
    return Object.values(state.creations).some((r) => r.id === owner.assistantCreationId &&
      r.nodeId === nodeId && r.projectId === project.id && r.assistant)
  }

  private managed(state: OrganizationJournalState, nodeId: string): NodeOrganization | undefined {
    return state.receipts[nodeId]?.filter((r) => r.committed).at(-1)?.organization
  }

  private unchangedPlacement(project: Project, node: CanvasNodeState, state: OrganizationJournalState): boolean {
    const receipt = state.receipts[node.id]?.at(-1)
    const expected = state.placements?.[node.id]
    const current = nodePlacement(project.kanban, node.id)
    const ids = project.kanban?.assignments.map((a) => a.nodeId) ?? []
    // Pending writes may have reached the workspace but not acknowledged their sibling shifts.
    // Historical receipts stay unchanged; only server-explained shifts advance current evidence.
    return !!receipt?.committed && expected?.receiptId === receipt.id && expected.projectId === project.id &&
      expected.columnId === current.columnId && expected.index === current.index &&
      (current.columnId === null || project.kanban?.columns.filter((c) => c.id === current.columnId).length === 1) &&
      new Set(ids).size === ids.length && !Object.values(state.receipts).some((rows) =>
        rows.at(-1)?.projectId === project.id && !rows.at(-1)?.committed)
  }

  /** Reconcile a previously interrupted write from exact persisted content, never by reassigning. */
  private async recoverOrganizationWrite(project: Project, node: CanvasNodeState, state: OrganizationJournalState,
    kind: 'update' | 'undo', metadata?: OrganizationMetadata): Promise<OrganizationReceipt | 'blocked' | undefined> {
    const rows = state.receipts[node.id] ?? []
    const pending = rows.at(-1)
    if (!pending || pending.committed) return undefined
    if (!this.attested(project, node.id, state) || pending.kind !== kind ||
      (metadata && JSON.stringify(metadata) !== JSON.stringify(pending.organization.metadata))) return 'blocked'
    const current = nodePlacement(project.kanban, node.id)
    const matches = (placement: typeof current) => placement.columnId === current.columnId && placement.index === current.index
    if (JSON.stringify(node.organization) === JSON.stringify(pending.organization) && matches(pending.after)) {
      this.deps.organizationJournal!.commitReceipt(state, pending)
      if (kind === 'undo' && rows.at(-2)) rows.at(-2)!.undone = true
      await this.deps.organizationJournal!.write(state)
      return pending
    }
    const previous = rows.at(-2)
    if (previous?.committed && JSON.stringify(node.organization) === JSON.stringify(previous.organization) && matches(pending.before)) {
      rows.pop()
      await this.deps.organizationJournal!.write(state)
      return undefined
    }
    return 'blocked'
  }

  private async saveOrganization(workspace: Workspace, project: Project): Promise<void> {
    const ack = await this.deps.workspaceStore.save(workspace) as WorkspaceSaveAck | undefined
    if (workspace.revision && ack?.revision) project.organizationChange = { before: workspace.revision, after: ack.revision }
  }

  async preview(projectId: string, entries: Array<{ nodeId: string; metadata: OrganizationMetadata }>): Promise<unknown> {
    return this.runExclusive(async () => {
      const workspace = await this.deps.workspaceStore.load({ sideline: false })
      const project = workspace.projects.find((p) => p.id === projectId)
      if (!project) return { error: 'project_not_found' }
      const state = await this.deps.organizationJournal?.read()
      return { dryRun: true, projectId, revision: project.revision, plans: entries.map((entry) => {
        const matches = workspace.projects.flatMap((p) => p.nodes.filter((n) => n.id === entry.nodeId).map((node) => ({ project: p, node })))
        return { nodeId: entry.nodeId, ...(matches.length === 1 && matches[0].project.id === project.id && state ?
          planOrganization(project, matches[0].node, entry.metadata, {
            attested: this.attested(project, entry.nodeId, state) && this.unchangedPlacement(project, matches[0].node, state), managed: this.managed(state, entry.nodeId)
          }) : { action: 'skip', reason: 'missing_or_unknown_origin' }) }
      }) }
    })
  }

  async audit(nodeId: string): Promise<unknown> {
    const state = await this.deps.organizationJournal?.read()
    return { nodeId, receipts: state?.receipts[nodeId] ?? [] }
  }

  async creationReceipt(key: string): Promise<unknown> {
    const state = await this.deps.organizationJournal?.read()
    const receipt = state?.creations[key]
    const attribution = receipt && await this.deps.creationReceipts?.find({ principal: 'ops-bearer', sourceNodeId: OPS_OPERATOR_SOURCE_ID, projectId: receipt.projectId }, key)
    return receipt ? { idempotencyKey: key, id: receipt.nodeId, projectId: receipt.projectId,
      ...(attribution ? { creation: attribution.creation, verifiedCreator: attribution.verifiedCreator, creationReceiptId: attribution.id } : {}),
      stage: receipt.stage, outcome: receipt.outcome ?? null } : { error: 'creation_receipt_not_found' }
  }

  private async publishReceipt(receipt: OrganizationReceipt): Promise<void> {
    if (!this.deps.appendBoardLog || receipt.published || !receipt.committed) return
    const entry: BoardLogEntry = { id: receipt.id, ts: receipt.at, kind: 'event', nodeId: receipt.nodeId,
      author: { name: 'NodeTerm organization', color: '#5b8def' },
      event: { type: 'card-moved', from: receipt.before.columnId ?? 'Ungrouped', to: receipt.after.columnId ?? 'Ungrouped' } }
    if (!await this.deps.appendBoardLog(receipt.projectId, entry)) return
    await this.runExclusive(async () => {
      const journal = this.deps.organizationJournal!
      const state = await journal.read()
      const row = state.receipts[receipt.nodeId]?.find((r) => r.id === receipt.id)
      if (row) { row.published = true; await journal.write(state) }
    })
  }

  /** Explicit bounded publication retry; no card placement or external session action. */
  async retryOrganizationEvents(): Promise<{ pending: number }> {
    const state = await this.deps.organizationJournal?.read()
    const rows = Object.values(state?.receipts ?? {}).flat().filter((r) => r.committed && !r.published)
    for (const row of rows.slice(0, 100)) {
      try { await this.publishReceipt(row) }
      catch (error) { console.warn('[organization] board event remains pending', error instanceof Error ? error.message : 'publication_failed') }
    }
    const current = await this.deps.organizationJournal?.read()
    return { pending: Object.values(current?.receipts ?? {}).flat().filter((r) => r.committed && !r.published).length }
  }

  private async createDurable(input: OpsCreateInput): Promise<OpsCreateResult> {
    const journal = this.deps.organizationJournal!
    if (input.organization && (!parseOrganizationMetadata(input.organization) || !input.projectId ||
      input.organization.projectId !== input.projectId || !organizationKey(input.idempotencyKey))) {
      return { ok: false, status: 400, error: 'organization_requires_exact_project_and_idempotency_key' }
    }
    if (input.organizationPolicy && (!parseOrganizationPolicy(input.organizationPolicy) ||
      !input.organization || input.organizationPolicy.projectId !== input.projectId || !input.expectedRevision)) {
      return { ok: false, status: 400, error: 'policy_requires_organization_and_revision' }
    }
    const key = input.idempotencyKey ?? randomUUID()
    if (!organizationKey(key)) return { ok: false, status: 400, error: 'invalid_idempotency_key' }
    // Fixed field order; private command/title/cwd bytes never enter the journal or audit.
    const fingerprint = createHash('sha256').update(JSON.stringify({ projectId: input.projectId,
      cmd: input.cmd, cwd: input.cwd, title: input.title, width: input.width, height: input.height,
      creation: input.creation,
      organization: input.organization && parseOrganizationMetadata(input.organization),
      organizationPolicy: input.organizationPolicy && parseOrganizationPolicy(input.organizationPolicy),
      expectedRevision: input.expectedRevision }, (_key, value) => value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]])) : value)).digest('hex')
    let reservation: CreationReservation | undefined
    let receipt: OrganizationReceipt | undefined
    const partial = (error: string): OpsCreateResult => ({ ok: false, status: 503, error,
      ...(reservation ? { id: reservation.nodeId, tmuxSession: sessionName(reservation.nodeId) } : {}), idempotencyKey: key })
    try {
      const prepared = await this.runExclusive(async () => {
        const state = await journal.read()
        reservation = state.creations[key]
        const evidence = await this.deps.creationReceipts!.find({ principal: 'ops-bearer', sourceNodeId: OPS_OPERATOR_SOURCE_ID, projectId: input.projectId! }, key)
        if (evidence && (!reservation || evidence.id !== reservation.id || evidence.fingerprint !== fingerprint || evidence.nodes[0]?.nodeId !== reservation.nodeId))
          return { ok: false as const, status: 409, error: 'assistant_creation_evidence_conflict' }
        if (reservation && !evidence) return { ok: false as const, status: 409, error: 'assistant_creation_evidence_missing_no_adoption' }
        if (reservation && reservation.fingerprint !== fingerprint) return { ok: false as const, status: 409, error: 'idempotency_key_reused' }
        if (reservation?.stage === 'launch_claimed') return { ok: false as const, status: 409, error: 'launch_outcome_uncertain_do_not_repeat',
          id: reservation.nodeId, tmuxSession: sessionName(reservation.nodeId), idempotencyKey: key, replayed: true }
        if (reservation?.stage === 'finished') {
          if (reservation.outcome !== 'success') return { ok: false as const, status: 502, error: `${reservation.outcome}_do_not_repeat`,
            id: reservation.nodeId, tmuxSession: sessionName(reservation.nodeId), idempotencyKey: key, replayed: true }
          return { ok: true as const, replayed: true, id: reservation.nodeId, projectId: reservation.projectId,
            title: input.title ?? `Operator ${reservation.nodeId}`, tmuxSession: sessionName(reservation.nodeId), idempotencyKey: key }
        }
        const workspace = await this.deps.workspaceStore.load({ sideline: false })
        const project = workspace.projects.find((p) => p.id === (reservation?.projectId ?? input.projectId ?? workspace.activeProjectId))
        if (!project) return { ok: false as const, status: 400, error: input.projectId !== undefined
          ? `unknown_project_id: no project ${JSON.stringify(input.projectId)}; known ids: ${workspace.projects.map(p => p.id).join(', ') || '(none)'}`
          : `no_default_project: workspace has no active project; pass projectId explicitly; known ids: ${workspace.projects.map(p => p.id).join(', ') || '(none)'}` }
        if (project.ssh || project.unavailable) return { ok: false as const, status: 400, error: 'project_target_unavailable_or_ssh' }
        // A prior move can be on disk while its position evidence is still unacknowledged.
        // Appending against that mixed state would wrongly advance untouched sibling evidence.
        if (input.organization && Object.values(state.receipts).some((rows) => {
          const pending = rows.at(-1)
          return pending?.projectId === project.id && !pending.committed && pending.nodeId !== reservation?.nodeId
        })) return partial('organization_write_pending_inspect_audit')
        if (!reservation && input.expectedRevision && input.expectedRevision !== project.revision) return { ok: false as const, status: 409, error: 'revision_conflict' }
        if (input.cwd !== undefined) {
          try { if (!(await fsPromises.stat(input.cwd)).isDirectory()) return { ok: false as const, status: 400, error: `cwd_not_a_directory: ${input.cwd}` } }
          catch (error) { return { ok: false as const, status: 400, error:
            `${(error as NodeJS.ErrnoException).code === 'ENOENT' ? 'cwd_not_found' : 'cwd_unreadable'}: ${input.cwd}` } }
        }
        if (!reservation) {
          reservation = { id: randomUUID(), nodeId: nextOperatorNodeId(), projectId: project.id,
            fingerprint, assistant: !!input.organization, stage: 'reserved' }
          await this.deps.creationReceipts!.record({ principal: 'ops-bearer', sourceNodeId: OPS_OPERATOR_SOURCE_ID, projectId: project.id },
            completeCreationPlanning(input.creation!, input.organization!), [{ nodeId: reservation.nodeId, organization: input.organization! }], fingerprint, reservation.id)
          state.creations[key] = reservation
          await journal.write(state)
        }
        const matches = workspace.projects.flatMap((p) => p.nodes.filter((n) => n.id === reservation!.nodeId).map((node) => ({ project: p, node })))
        if (matches.length > 1 || (matches.length === 1 && matches[0].project.id !== project.id)) return partial('reserved_node_conflict')
        let node = matches[0]?.node
        if (!node) {
          // A reserved retry may follow a completely failed save. It cannot use an old policy
          // revision to replace a newer operator/browser configuration.
          if (input.organizationPolicy && input.expectedRevision !== project.revision) return {
            ok: false as const, status: 409, error: 'revision_conflict', id: reservation.nodeId, idempotencyKey: key }
          const size = { width: input.width ?? OPERATOR_DEFAULT_NODE_SIZE.width, height: input.height ?? OPERATOR_DEFAULT_NODE_SIZE.height }
          node = { id: reservation.nodeId, kind: 'terminal', position: placeFromOrigin(project, size), size,
            title: input.title ?? `Operator ${reservation.nodeId}`, titleAuto: false, role: 'worker',
            assistantCreation: completeCreationPlanning(input.creation!, input.organization!),
            taskPlanning: planningAtCreation(input.creation!.taskId, input.organization!.functionalRole, input.creation!.planning),
            color: OPERATOR_NODE_COLOR, group: null, tags: [], ...(input.cwd !== undefined ? { cwd: input.cwd } : {}) }
          if (input.organizationPolicy) project.kanbanOrganization = input.organizationPolicy
          if (input.organization) {
            const plan = planOrganization(project, node, input.organization, { attested: true, creating: true })
            if (!plan.organization) return partial(plan.reason)
            const id = randomUUID()
            node.organization = { ...plan.organization, receiptId: id }
            project.kanban = placeNode(project.kanban, node.id, { columnId: plan.to, index: -1, previous: null, next: null })
            receipt = { id, nodeId: node.id, projectId: project.id, kind: 'create', at: this.now(),
              before: plan.from, after: nodePlacement(project.kanban, node.id), organization: node.organization,
              committed: false, published: false }
            // Recover the same pending receipt when a previous workspace write failed completely.
            state.receipts[node.id] = [receipt]
            await journal.write(state)
          }
          this.deps.recordOwnership?.(node.id, { sourceNodeId: OPS_OPERATOR_SOURCE_ID, projectId: project.id,
            ...(input.organization ? { assistantCreationId: reservation.id } : {}) })
          if (!this.deps.recordOwnership || !this.deps.flushOwnership) return partial('ownership_persistence_unavailable')
          await this.deps.flushOwnership()
          project.nodes.push(node)
          await this.saveOrganization(workspace, project)
        } else {
          // A partial save can already have published the project file. Retain its original ID.
          if (input.organization && !this.attested(project, node.id, state)) return partial('assistant_origin_unknown')
          if (!this.deps.flushOwnership) return partial('ownership_persistence_unavailable')
          await this.deps.flushOwnership()
          receipt = state.receipts[node.id]?.at(-1)
          if (receipt && (node.organization?.receiptId !== receipt.id ||
            JSON.stringify(nodePlacement(project.kanban, node.id)) !== JSON.stringify(receipt.after))) return partial('partial_placement_changed')
          // Repair a partially saved index without overwriting newer project content.
          await this.saveOrganization(workspace, project)
        }
        if (receipt) journal.commitReceipt(state, receipt)
        reservation.stage = 'launch_claimed'
        await journal.write(state)
        return { ok: true as const, project, node }
      })
      if (!prepared.ok || !('project' in prepared)) return prepared
      const { project, node } = prepared
      // No workspace FIFO is held across PTY, command delivery, publication or board log I/O.
      this.deps.publishProject?.(project)
      this.deps.publishNode?.(project.id, node, project.workspaceChange?.after)
      let outcome: CreationReservation['outcome'] = 'uncertain'
      let launchError: string | undefined
      let expired = false
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const work = (async (): Promise<CreationReservation['outcome']> => {
          if (!this.deps.createSession) return 'spawn_failed'
          const spawned = await this.deps.createSession!({ cwd: node.cwd || project.cwd, cols: OPERATOR_TERMINAL_COLS,
            rows: OPERATOR_TERMINAL_ROWS, persistKey: node.id, ownerProjectId: project.id })
          if (expired) return 'uncertain'
          if (!spawned.sessionId) return 'spawn_failed'
          if (input.cmd === undefined) return 'success'
          // A rejected delivery may have reached the pane. Report that uncertainty truthfully.
          outcome = 'uncertain'
          return !await this.deps.sendText?.(node.id, input.cmd) ? 'command_failed' : 'success'
        })()
        outcome = await Promise.race([work, new Promise<'uncertain'>((resolve) => {
          timer = setTimeout(() => { expired = true; resolve('uncertain') }, 30_000)
        })])
      } catch (error) {
        // Keep the public diagnostic and the uncertain receipt together. A throw does not
        // prove the external effect never happened, so the creation key cannot launch again.
        launchError = `pty_spawn_failed: ${error instanceof Error ? error.message : String(error)}`
      }
      finally { if (timer) clearTimeout(timer) }
      await this.runExclusive(async () => {
        const state = await journal.read()
        const row = state.creations[key]
        if (!row || row.id !== reservation!.id) throw new Error('creation_reservation_changed')
        row.stage = 'finished'; row.outcome = outcome
        await journal.write(state)
      })
      if (receipt) await this.publishReceipt(receipt).catch((error) => {
        console.warn('[organization] durable board event remains pending', error instanceof Error ? error.message : 'publication_failed')
      })
      if (!this.deps.createSession) return { ok: false, status: 501,
        error: 'create_not_supported: this server was not wired for operator node creation',
        id: node.id, tmuxSession: sessionName(node.id), idempotencyKey: key }
      return outcome === 'success' ? { ok: true, id: node.id, projectId: project.id, title: node.title,
        tmuxSession: sessionName(node.id), idempotencyKey: key, organization: node.organization } :
        { ok: false, status: 502, error: outcome === 'uncertain' ? `${launchError ? launchError + '; ' : ''}launch_outcome_uncertain_do_not_repeat` :
          `pty_${outcome}_do_not_repeat`, id: node.id, tmuxSession: sessionName(node.id), idempotencyKey: key }
    } catch (error) {
      return partial(error instanceof Error ? error.message : 'creation_outcome_uncertain')
    }
  }

  private async updateOrganization(workspace: Workspace, project: Project, node: CanvasNodeState, input: OpsUpdateInput): Promise<OpsUpdateResult> {
    const journal = this.deps.organizationJournal
    if (!journal) return { ok: false, status: 503, error: 'organization_persistence_unavailable' }
    if (!input.expectedRevision || input.expectedRevision !== project.revision) return { ok: false, status: 409, error: 'revision_conflict' }
    if (!input.organization || !parseOrganizationMetadata(input.organization) ||
      (input.organizationPolicy && (!parseOrganizationPolicy(input.organizationPolicy) || input.organizationPolicy.projectId !== project.id))) {
      return { ok: false, status: 400, error: 'invalid_organization' }
    }
    const state = await journal.read()
    const recovered = await this.recoverOrganizationWrite(project, node, state, 'update', input.organization)
    if (recovered === 'blocked') return { ok: false, status: 409, error: 'placement_drift_or_pending_write' }
    if (recovered) return { ok: true, id: node.id, title: node.title, size: node.size, revision: project.revision,
      organization: node.organization, receiptId: recovered.id }
    if (!this.unchangedPlacement(project, node, state)) return { ok: false, status: 409, error: 'placement_drift_or_pending_write' }
    if (input.organizationPolicy) project.kanbanOrganization = input.organizationPolicy
    const plan = planOrganization(project, node, input.organization, { attested: this.attested(project, node.id, state), managed: this.managed(state, node.id) })
    if (plan.action !== 'apply' || !plan.organization) return { ok: false, status: 409, error: plan.reason }
    const id = randomUUID()
    const updated = { ...node, organization: { ...plan.organization, receiptId: id } }
    // Organization updates deliberately address no geometry, title or process fields.
    project.nodes = project.nodes.map((n) => n.id === node.id ? updated : n)
    if (plan.from.columnId !== plan.to) {
      project.kanban = placeNode(project.kanban, node.id, { columnId: plan.to, index: -1, previous: null, next: null })
    }
    const receipt: OrganizationReceipt = { id, nodeId: node.id, projectId: project.id, kind: 'update', at: this.now(),
      before: plan.from, after: nodePlacement(project.kanban, node.id), organization: updated.organization, committed: false, published: false }
    journal.addReceipt(state, receipt)
    await journal.write(state)
    await this.saveOrganization(workspace, project)
    journal.commitReceipt(state, receipt)
    await journal.write(state)
    this.deps.publishProject?.(project)
    this.deps.publishNode?.(project.id, updated, project.workspaceChange?.after)
    // Publication is retried by an explicit API call after the durable transaction releases.
    return { ok: true, id: node.id, title: node.title, size: node.size, revision: project.revision,
      organization: updated.organization, placement: plan, receiptId: id }
  }

  async undoOrganization(nodeId: string, receiptId: string, expectedRevision: string): Promise<OpsUpdateResult> {
    try { return await this.runExclusive(async () => {
      const journal = this.deps.organizationJournal
      if (!journal) return { ok: false, status: 503, error: 'organization_persistence_unavailable' }
      const workspace = await this.deps.workspaceStore.load({ sideline: false })
      const matches = workspace.projects.flatMap((project) => project.nodes.filter((n) => n.id === nodeId).map((node) => ({ project, node })))
      if (matches.length !== 1) return { ok: false, status: 404, error: 'node_not_found_or_ambiguous' }
      const { project, node } = matches[0]
      const state = await journal.read()
      const receipts = state.receipts[nodeId] ?? []
      if (!this.attested(project, nodeId, state)) return { ok: false, status: 403, error: 'assistant_origin_unknown' }
      if (project.revision !== expectedRevision) return { ok: false, status: 409, error: 'revision_conflict' }
      if (receipts.at(-1)?.kind === 'undo' && !receipts.at(-1)?.committed && receipts.at(-2)?.id !== receiptId) {
        return { ok: false, status: 409, error: 'placement_changed' }
      }
      const recovered = await this.recoverOrganizationWrite(project, node, state, 'undo')
      if (recovered === 'blocked') return { ok: false, status: 409, error: 'placement_changed' }
      if (recovered) return { ok: true, id: nodeId, title: node.title, size: node.size, revision: project.revision,
        organization: node.organization, receiptId: recovered.id }
      const receipt = receipts.at(-1)
      if (!receipt || receipt.id !== receiptId || !receipt.committed || receipt.undone || receipt.kind === 'undo' ||
        JSON.stringify(node.organization) !== JSON.stringify(receipt.organization) || node.organization?.mode !== 'auto' ||
        project.kanban?.manualAssignments?.[nodeId] || node.pinned || node.manualPlacement || node.role !== 'worker' ||
        !this.unchangedPlacement(project, node, state)) return { ok: false, status: 409, error: 'placement_changed' }
      if (receipt.before.columnId && !project.kanban?.columns.some((c) => c.id === receipt.before.columnId)) return { ok: false, status: 409, error: 'undo_column_missing' }
      const beforeUndo = nodePlacement(project.kanban, nodeId)
      project.kanban = placeNode(project.kanban, nodeId, receipt.before)
      if (project.kanban) project.kanban = withManualAssignment(project.kanban, nodeId)
      const id = randomUUID()
      const organization: NodeOrganization = { ...receipt.organization, mode: 'manual', sequence: receipt.organization.sequence + 1,
        columnId: receipt.before.columnId, receiptId: id }
      project.nodes = project.nodes.map((n) => n.id === nodeId ? { ...n, organization } : n)
      const undo: OrganizationReceipt = { id, nodeId, projectId: project.id, at: this.now(), kind: 'undo', before: beforeUndo,
        after: nodePlacement(project.kanban, nodeId), organization, committed: false, published: false }
      journal.addReceipt(state, undo)
      await journal.write(state)
      await this.saveOrganization(workspace, project)
      receipt.undone = true; journal.commitReceipt(state, undo)
      await journal.write(state)
      this.deps.publishProject?.(project)
      return { ok: true, id: nodeId, title: node.title, size: node.size, revision: project.revision, organization, receiptId: id }
    }) } catch { return { ok: false, id: nodeId, status: 503, error: 'organization_write_uncertain_inspect_audit_before_retry' } }
  }
}
