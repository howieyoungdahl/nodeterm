import { promises as fsPromises } from 'node:fs'

import {
  planOrphanAdoption,
  type OrphanMirrorEntry,
  type OrphanSkipReason
} from '../core/orphan-adoption'
import { sessionName } from '../core/tmux-naming'
import type { AgentState } from '../shared/agents/normalize'
import type { CanvasNodeState, Project, Workspace } from '../shared/types'
import { WorkspaceMutationQueue } from './workspace-mutation-queue'

/**
 * Ownership-ledger `sourceNodeId` stamped on a node the `/opsapi/nodes` operator plane created
 * directly — never a spoofed live node id. `remove`/`update` read it back to recognize an
 * operator-created card without an explicit `?force=1`, and `list` surfaces it so a caller can
 * tell operator-spawned cards from agent-spawned ones.
 */
// Charset-constrained to `isSafeNodeId` ([A-Za-z0-9._-]): the durable ownership ledger
// (node-ownership-store.ts `record()`) silently refuses any sourceNodeId outside that charset
// (fail-closed, by design), so a colon or other separator here would make `create()`'s ownership
// stamp a no-op against the persistent store even though the in-memory test double accepts it.
export const OPS_OPERATOR_SOURCE_ID = 'ops-operator'

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
  for (let slot = 0; ; slot++) {
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
}

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
  /** True when this node was created directly by `POST /opsapi/nodes` (never a spoofed source). */
  operatorCreated: boolean
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
  /** Stamp the durable ownership ledger for a node `create()` just persisted. Absent = ownership is
   *  never recorded and the node reads back as not operator-created (fails closed). */
  recordOwnership?(nodeId: string, owner: { sourceNodeId: string; projectId: string }): void
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
  projectId?: string
  cmd?: string
  cwd?: string
  title?: string
  width?: number
  height?: number
}

export type OpsCreateResult =
  | { ok: true; id: string; projectId: string; title: string; tmuxSession: string }
  | { ok: false; status: number; error: string }

export interface OpsUpdateInput {
  title?: string
  width?: number
  height?: number
}

export type OpsUpdateResult =
  | { ok: true; id: string; title: string; size: { width: number; height: number } }
  | { ok: false; status: number; error: string }

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
            ownerSession: this.deps.ownerOf(node.id)?.sourceNodeId ?? null,
            operatorCreated: this.deps.ownerOf(node.id)?.sourceNodeId === OPS_OPERATOR_SOURCE_ID
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
      this.deps.publishRemoval?.(project.id, node.id)
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
      this.deps.publishNode?.(project.id, node)
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
    try {
      const spawned = await this.deps.createSession({
        cwd: node.cwd,
        cols: OPERATOR_TERMINAL_COLS,
        rows: OPERATOR_TERMINAL_ROWS,
        persistKey: node.id,
        ownerProjectId: project.id
      })
      if (!spawned.sessionId) {
        return {
          ok: false,
          status: 502,
          error: `pty_spawn_failed: node ${node.id} was persisted but its terminal session could not be started`
        }
      }
      if (input.cmd !== undefined && !(await this.deps.sendText?.(node.id, input.cmd))) {
        return {
          ok: false,
          status: 502,
          error:
            `pty_command_failed: node ${node.id} was persisted and its session started, but the ` +
            'initial command could not be delivered'
        }
      }
      // `spawned.sessionId` is PtyManager's own internal pty-registry id ("pty-N"), not the tmux
      // session name — `sessionName()` (core/tmux-naming.ts) is the single source of truth for
      // that, the same function `has-session`/`send-keys`/`kill-session` callers must use to find
      // this node's real backend.
      return {
        ok: true,
        id: node.id,
        projectId: project.id,
        title: node.title,
        tmuxSession: sessionName(node.id)
      }
    } catch (error) {
      return {
        ok: false,
        status: 502,
        error: `pty_spawn_failed: ${error instanceof Error ? error.message : String(error)}`
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
      this.deps.publishNode?.(project.id, updated)
      return { ok: true, id: nodeId, title: updated.title, size: updated.size }
    })
  }
}
