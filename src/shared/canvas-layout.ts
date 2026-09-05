// The layout engine's VOCABULARY: what a layout plan is, what an op is, and why a node was
// refused. Shared rather than core-only because four sides speak it — the engine (`src/core/
// canvas-layout/`), both shells that trigger it, and the renderer that previews and applies it.
// Same split as `shared/node-status.ts` (the words) beside `core/node-status-service.ts` (the one
// thing that does I/O): the renderer cannot import `src/core`, and a second copy of the words is
// how two surfaces start describing one plan in two vocabularies.
//
// THE REFUSALS ARE THE FEATURE. An automatic layout engine is only tolerable if it can be trusted
// not to move the thing you are working on, so `plan()` reports every node it declined and why,
// and the report is what the operator reads before anything is applied. A silent skip is
// indistinguishable from a bug; every one of them is a row with a reason.

/** What woke the engine. There is deliberately no `timer`: nothing here polls. */
export type LayoutTrigger =
  /** A node was just created. Placement happens ONCE, at birth. */
  | 'node-created'
  /** A node's status changed. Emits ops only when a rule asks for them. */
  | 'status-changed'
  /** The operator (or an agent) changed the rules. */
  | 'rules-changed'
  /** An explicit "organize this canvas" request. */
  | 'organize'

export const LAYOUT_TRIGGERS: readonly LayoutTrigger[] = [
  'node-created',
  'status-changed',
  'rules-changed',
  'organize'
]

export function isLayoutTrigger(value: unknown): value is LayoutTrigger {
  return LAYOUT_TRIGGERS.includes(value as LayoutTrigger)
}

/**
 * Why a node the engine considered was left alone. Every one of these is reported with the node
 * it applies to; none is ever applied silently.
 *
 * `pinned` / `manual-placement` are the operator's durable intent (PR-A's flags). `loop-owned` is
 * another authority's structure. `active` is the node under the operator's hands right now, and
 * is the one re-asked at APPLY time because a plan-time verdict about it is stale in seconds.
 * `foreign-authority` is the creator-ownership boundary the rest of the control plane already
 * enforces. `primary-role` is the operator's own workspace, which nothing automatic may arrange.
 */
export type LayoutSkipReason =
  | 'pinned'
  | 'manual-placement'
  | 'loop-owned'
  | 'active'
  | 'foreign-authority'
  | 'primary-role'

export const LAYOUT_SKIP_REASONS: readonly LayoutSkipReason[] = [
  'pinned',
  'manual-placement',
  'loop-owned',
  'active',
  'foreign-authority',
  'primary-role'
]

/**
 * One sentence per refusal, written for the operator reading the preview table. Kept beside the
 * union so a new reason cannot ship without a sentence — a reason code with no words is the
 * silent skip this whole module exists to prevent.
 */
export const LAYOUT_SKIP_LABELS: Record<LayoutSkipReason, string> = {
  pinned: 'pinned — you asked for this one to stay put',
  'manual-placement': 'you placed this one by hand',
  'loop-owned': 'inside a frame a loop owns',
  active: 'you are using this one right now',
  'foreign-authority': 'opened by another authority',
  'primary-role': 'your own workspace, not a delegated worker'
}

/** Why the engine produced no plan at all, as opposed to a plan that skipped nodes. */
export type LayoutStandDownReason = 'disabled' | 'lease-held' | 'unknown-project'

export const LAYOUT_STAND_DOWN_LABELS: Record<LayoutStandDownReason, string> = {
  disabled: 'automatic layout is off for this machine',
  'lease-held': 'another instance holds this project’s layout lease',
  'unknown-project': 'no project to plan for'
}

/** A rect in ROOT space — the same convention `premaxRect` and `compactRect` use, and for the
 *  same reason: a frame's origin moves when it is re-fitted, so a parent-relative answer decays. */
export interface LayoutRect {
  x: number
  y: number
  width: number
  height: number
}

/**
 * The five ops §4 of the plan names. Every one is a pure canvas-state write: none creates a
 * session, attaches to a pane, kills a PTY, types into anything or moves loop authority
 * (plan D8 / registry contract §7). `resize` in particular leaves the PTY alone — that is a
 * property the existing `resize` verb already has and a test, not a habit.
 */
export type LayoutOp =
  /** Move a node. `position` is ROOT space; the applier converts to the parent's frame. */
  | { op: 'place'; nodeId: string; position: { x: number; y: number } }
  /** Resize a node, optionally recording the named geometry choice so `--size` stays truthful. */
  | {
      op: 'resize'
      nodeId: string
      size: { width: number; height: number }
      controlSize?: 'compact' | 'normal'
    }
  /** Move a node (or a whole frame subtree) into a frame, or `null` for top level. */
  | { op: 'reparent'; nodeId: string; parentId: string | null }
  /** Open or close a frame (or collapse a node). */
  | { op: 'collapse'; nodeId: string; collapsed: boolean }
  /** Rename a frame or node. Titles are one line by construction (see @shared/one-line). */
  | { op: 'label'; nodeId: string; title: string }

export type LayoutOpKind = LayoutOp['op']

export interface LayoutSkip {
  nodeId: string
  reason: LayoutSkipReason
}

export interface LayoutPlan {
  trigger: LayoutTrigger
  /** Ops in application order. Empty is a legitimate answer and is reported as such. */
  ops: LayoutOp[]
  /** Every node considered and declined, with its reason. Never silently omitted. */
  skipped: LayoutSkip[]
  /**
   * Set when the engine produced nothing because it was not allowed to run at all. `holder` names
   * the instance that owns the lease, so a second director reads why it stood down instead of
   * fighting for the same canvas.
   */
  stoodDown?: { reason: LayoutStandDownReason; holder?: string }
}

/** An empty plan carrying its reason. Nothing here ever returns a bare `[]`. */
export function standDownPlan(
  trigger: LayoutTrigger,
  reason: LayoutStandDownReason,
  holder?: string
): LayoutPlan {
  return { trigger, ops: [], skipped: [], stoodDown: { reason, ...(holder ? { holder } : {}) } }
}

/** True when applying this plan would change nothing. A preview still renders — the skip table is
 *  the point, and "we looked and refused all six" is its own sentence. */
export function isEmptyPlan(plan: LayoutPlan): boolean {
  return plan.ops.length === 0
}

/** Ops grouped by the node they touch, in first-appearance order. The preview lists one row per
 *  node rather than one per op: three ops on one card is one decision to the reader. */
export function opsByNode(plan: LayoutPlan): { nodeId: string; ops: LayoutOp[] }[] {
  const order: string[] = []
  const byId = new Map<string, LayoutOp[]>()
  for (const op of plan.ops) {
    const bucket = byId.get(op.nodeId)
    if (bucket) bucket.push(op)
    else {
      order.push(op.nodeId)
      byId.set(op.nodeId, [op])
    }
  }
  return order.map((nodeId) => ({ nodeId, ops: byId.get(nodeId) ?? [] }))
}

/** One short phrase per op, for the preview table and the skill's report. */
export function describeLayoutOp(op: LayoutOp): string {
  switch (op.op) {
    case 'place':
      return `move to ${Math.round(op.position.x)}, ${Math.round(op.position.y)}`
    case 'resize':
      return op.controlSize
        ? `resize to ${Math.round(op.size.width)}×${Math.round(op.size.height)} (${op.controlSize})`
        : `resize to ${Math.round(op.size.width)}×${Math.round(op.size.height)}`
    case 'reparent':
      return op.parentId ? `move into frame ${op.parentId}` : 'move out to top level'
    case 'collapse':
      return op.collapsed ? 'collapse' : 'expand'
    case 'label':
      return `rename to “${op.title}”`
  }
}

/**
 * The shape of one canvas node the engine reads — a subset of `CanvasNodeState`, and everything
 * in it is something a placement decision genuinely depends on. Shared because the renderer
 * builds this list out of its live React Flow nodes and sends it with the request.
 */
export interface LayoutNode {
  id: string
  /** React Flow node type / persisted `kind`: `terminal`, `group`, `sticky`, … */
  kind: string
  parentId?: string
  title?: string
  /** @shared/node-role. Absent reads as `primary`, which is a refusal. */
  role?: unknown
  /** Operator intent: never move this node automatically. */
  pinned?: boolean
  /** Written the first time the operator dragged or resized this node by hand. */
  manualPlacement?: boolean
  /** group-only: this frame is a control-plane spawn tray. */
  taskFrame?: boolean
  collapsed?: boolean
  controlSize?: 'compact' | 'normal'
  /** Position in the PARENT's space, as persisted. */
  position?: { x: number; y: number }
  size?: { width: number; height: number }
}

/**
 * What the renderer sends to build a plan.
 *
 * The canvas travels IN the request rather than being read off disk by the engine. React Flow is
 * the single live source of truth for the active project's nodes (CLAUDE.md), so a plan built from
 * `project.json` would be planning against a snapshot that is up to one autosave debounce old —
 * and would refuse the wrong nodes, which for a refusal table is the whole ballgame.
 */
export interface LayoutPlanRequest {
  projectId: string
  trigger: LayoutTrigger
  nodes: LayoutNode[]
  /** Lineage edges (`project.ropes`): which node opened which. */
  ropes?: { source: string; target: string }[]
  /** Per-node status, for the rules that key on it. Never persisted anywhere (plan D4). */
  statuses?: Record<string, string>
  /** Nodes the operator is using right now. A courtesy at plan time; re-asked at apply time. */
  actives?: string[]
  /** Frames another authority owns. Supplied, never guessed — see `loopOwnedFrameIds`. */
  loopFrames?: string[]
  /** Nodes created by this trigger, when the trigger is `node-created`. */
  createdIds?: string[]
  /** The project's shared `layoutRules` block, unsanitized — the core body sanitizes it. */
  projectRules?: unknown
  /** The compact and normal worker footprints, so the engine holds no geometry constants. */
  sizes: {
    compact: { width: number; height: number }
    normal: { width: number; height: number }
  }
  /** Who is asking, for the lease. Stable for the life of one renderer connection. */
  holder: string
}

// Which frames another authority owns.
//
// A director loop organises itself — one slug-labelled frame per loop — and the layout engine
// never re-parents its members. The engine does not GUESS that: `plan()` takes the frame ids as
// input, and this is the one derivation the app itself can make honestly.
//
// The in-app signal is a node carrying a live loop / schedule / cron card. That is a fact the
// hook layer already establishes (`agentStatus.loop`, set from the agent's own tool events and
// persisted), not an inference from a frame's name — which matters, because a frame called
// "nodeterm-organizer" is not evidence of anything and a canvas where the engine refuses by
// name would refuse the wrong frames on someone else's naming convention.
//
// A shell that cannot enumerate loop-driven nodes passes nothing, and the refusal simply does not
// fire there. That is not a silent hole: the automatic triggers (`node-created`, `status-changed`)
// only ever address the node the event was about, and only an explicit `organize` — raised from
// the renderer, which does have `agentStatus` — reaches existing members.

/** One canvas node, as this derivation needs it. */
export interface FrameChainNode {
  id: string
  kind: string
  parentId?: string
}

/**
 * Every frame that contains a loop-driven node, at any depth — so a loop that has nested its
 * members into sub-frames still owns all of them. Walking up from each loop node rather than down
 * from each frame is what makes a nested tree cost one pass per loop node instead of a search.
 *
 * The walk is bounded by the node count; a parent cycle in a hand-edited `project.json` ends the
 * walk rather than hanging it.
 */
export function loopOwnedFrameIds(
  nodes: readonly FrameChainNode[],
  loopNodeIds: readonly string[]
): string[] {
  if (!loopNodeIds.length) return []
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const frames = new Set<string>()
  for (const start of loopNodeIds) {
    const seen = new Set<string>([start])
    let parentId = byId.get(start)?.parentId
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId)
      const parent = byId.get(parentId)
      if (!parent) break
      if (parent.kind === 'group') frames.add(parent.id)
      parentId = parent.parentId
    }
  }
  return [...frames]
}

// The active-node refusal, re-asked at APPLY time.
//
// `plan()` already skips a node the operator was using when the plan was built. That verdict is
// stale in seconds: a plan is previewed, read, and only then approved, and in between the
// operator can click into any card on it. Applying a plan-time verdict about someone's hands is
// the "it moved the terminal I was typing in" failure the whole feature exists to avoid.
//
// So the question is asked twice, and the second answer wins — the same discipline agent
// hibernation uses (CLAUDE.md: "Fire-time re-asks: still-offscreen, remote, eligibility — a
// plan-time verdict is stale by seconds"), for the same reason.
//
// Nothing else is re-asked here. `pinned` and `manualPlacement` are durable persisted facts and
// the applier reads them off the very nodes it is about to write, so a second reading would be
// the same reading; loop ownership and creator ownership do not change inside a preview.


export interface ApplyGateDeps {
  /** Asked NOW, per node, for every node the plan would touch. */
  isActive: (nodeId: string) => boolean
}

/**
 * Drop every op addressing a node the operator is using right now, and report each as a refusal
 * so the applied result still accounts for every node the preview listed.
 *
 * Returns the SAME plan object when nothing was dropped, so a caller can cheaply tell whether the
 * preview it showed is still exactly what it is about to apply.
 */
export function gateLayoutPlan(plan: LayoutPlan, deps: ApplyGateDeps): LayoutPlan {
  const dropped = new Set<string>()
  for (const op of plan.ops) {
    if (deps.isActive(op.nodeId)) dropped.add(op.nodeId)
  }
  if (!dropped.size) return plan
  const already = new Set(plan.skipped.map((s) => s.nodeId))
  const added: LayoutSkip[] = [...dropped]
    .filter((nodeId) => !already.has(nodeId))
    .map((nodeId) => ({ nodeId, reason: 'active' as const }))
  return {
    ...plan,
    ops: plan.ops.filter((op) => !dropped.has(op.nodeId)),
    skipped: [...plan.skipped, ...added]
  }
}
