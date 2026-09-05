// Where a control-spawned worker lands, and what it is called.
//
// This module is the DECISION only — pure, over the persisted node shape, with no geometry in it.
// Each shell applies the answer with its own already-correct transforms (the Server's
// `groupPersistedNodes` / re-parent helpers, the renderer's `groupSelectedNodes` / `reparentNode`),
// because frame geometry is the one thing the two surfaces genuinely implement differently and a
// third copy of it is how they drift.
//
// The rule the plan calls "the tray": workers a node spawns collect under a frame derived from
// that node. Two shapes, in this order:
//
//  1. The spawner is already inside a frame — the workers join it. Nothing existing moves.
//  2. The spawner is not — the workers stay loose until there are TWO of them, and only then is a
//     frame created around them. A frame per single node is frame churn, and a canvas full of
//     one-member boxes is less readable than the loose nodes were.
//
// Lineage comes from `project.ropes`, which the control plane already writes on every open
// (`ctrl-<spawner>-<opened>`): the spawner→opened edge IS the record of what a node opened, so no
// new persisted relation is minted for this.
//
// Nothing here ever proposes moving a node the operator has touched. `pinned` and
// `manualPlacement` are refusals at this layer too, not only in the later layout engine — pulling
// a hand-placed card into a box is exactly the "it moved my workspace" failure the whole feature
// exists to avoid.

import { isWorkerNode } from './node-role'
import { oneLine } from './one-line'

/** The minimum a caller must be able to say about a node for this planner to place it. */
export interface WorkerFrameNode {
  id: string
  kind: string
  parentId?: string
  role?: unknown
  /** Operator intent: never move this node automatically. */
  pinned?: boolean
  /** Set the first time the operator dragged or resized this node by hand. */
  manualPlacement?: boolean
  /** group-only: this frame is a spawn tray, created by the control plane. */
  taskFrame?: boolean
}

export interface WorkerFrameInput {
  /** Every node of the project the spawn landed in, INCLUDING the freshly created workers. */
  nodes: readonly WorkerFrameNode[]
  /** The control-capable agent node that asked for the spawn. */
  spawnerId: string
  /** Workers created by this one command, in creation order. */
  newWorkerIds: readonly string[]
  /** Lineage edges (`project.ropes`); only `source === spawnerId` is read. */
  ropes: readonly { source: string; target: string }[]
  /**
   * Whether the caller may move this node. Creator ownership is the control boundary for every
   * other Server mutation and re-parenting is a mutation, so an unowned prior worker is left
   * exactly where it is. Omitted = the caller vouches for everything it names (desktop, where the
   * canvas and the caller are the same principal).
   */
  owns?: (nodeId: string) => boolean
}

export type WorkerFrameSkip = 'no-workers' | 'spawner-missing' | 'single-worker'

export type WorkerFramePlan =
  /** Nothing to do — the reason is reportable, never silent. */
  | { kind: 'none'; reason: WorkerFrameSkip }
  /** Put `memberIds` into the frame that already exists. Existing members do not move. */
  | { kind: 'join'; groupId: string; memberIds: string[] }
  /** Wrap `memberIds` (all siblings at top level) in a new tray frame. */
  | { kind: 'create'; memberIds: string[] }

/** A node the planner is allowed to re-parent. */
function movable(node: WorkerFrameNode): boolean {
  return !node.pinned && !node.manualPlacement
}

export function planWorkerFrame(input: WorkerFrameInput): WorkerFramePlan {
  const byId = new Map(input.nodes.map((node) => [node.id, node]))
  const owns = input.owns ?? (() => true)

  const fresh = input.newWorkerIds
    .map((id) => byId.get(id))
    .filter((node): node is WorkerFrameNode => !!node && isWorkerNode(node))
  if (!fresh.length) return { kind: 'none', reason: 'no-workers' }

  const spawner = byId.get(input.spawnerId)
  if (!spawner) return { kind: 'none', reason: 'spawner-missing' }

  // 1. The spawner's own frame. Joining it moves nothing that already exists, so there is no
  //    single-member rule here and no ownership question about the frame's other occupants.
  const ownFrame = spawner.parentId ? byId.get(spawner.parentId) : undefined
  if (ownFrame && ownFrame.kind === 'group') {
    const memberIds = fresh.filter((node) => node.parentId !== ownFrame.id).map((node) => node.id)
    return memberIds.length
      ? { kind: 'join', groupId: ownFrame.id, memberIds }
      : { kind: 'none', reason: 'no-workers' }
  }

  const freshIds = new Set(fresh.map((node) => node.id))
  const prior = [
    ...new Set(
      input.ropes
        .filter((rope) => rope.source === input.spawnerId)
        .map((rope) => rope.target)
        .filter((id) => !freshIds.has(id))
    )
  ]
    .map((id) => byId.get(id))
    .filter((node): node is WorkerFrameNode => !!node && isWorkerNode(node))

  // 2. A tray this spawner already has. Found through its occupants rather than by name, so a
  //    renamed frame is still the same tray. Ambiguity (two trays hold this spawner's workers,
  //    e.g. after a hand re-parent) declines rather than picking one.
  const trays = [
    ...new Set(
      prior
        .map((node) => (node.parentId ? byId.get(node.parentId) : undefined))
        .filter((node): node is WorkerFrameNode => !!node && node.kind === 'group' && !!node.taskFrame)
        .map((node) => node.id)
    )
  ]
  if (trays.length === 1) {
    const memberIds = fresh.filter((node) => node.parentId !== trays[0]).map((node) => node.id)
    return memberIds.length
      ? { kind: 'join', groupId: trays[0], memberIds }
      : { kind: 'none', reason: 'no-workers' }
  }

  // 3. No tray yet. The frame appears with the SECOND worker, and only over workers that are
  //    still where the control plane put them.
  const loose = prior.filter((node) => !node.parentId && movable(node) && owns(node.id))
  const candidates = [
    ...loose.map((node) => node.id),
    ...fresh.filter((node) => !node.parentId).map((node) => node.id)
  ]
  if (candidates.length < 2) return { kind: 'none', reason: 'single-worker' }
  return { kind: 'create', memberIds: candidates }
}

/** Longest a spawner's name may be inside a generated title before it is elided. */
const LANE_MAX = 28
/** Longest generated task summary; a prompt is a paragraph and a card header is not. */
const SUMMARY_MAX = 160

/**
 * One line, and one space between words. `oneLine` removes what could END a line; a card header
 * additionally has no room for the run of spaces a wrapped prompt leaves behind.
 */
function squeeze(text: string): string {
  return oneLine(text ?? '').replace(/\s+/g, ' ')
}

function lane(ownerTitle: string): string {
  const clean = squeeze(ownerTitle)
  if (!clean) return 'Agent'
  return clean.length > LANE_MAX ? `${clean.slice(0, LANE_MAX - 1).trimEnd()}…` : clean
}

/**
 * A generated worker's title: `<lane> · <role>`, where the lane names who opened it and the role
 * names what it runs. The ordinal is the worker's position in this spawner's whole fan-out, so
 * two separate `open-agent` calls do not both produce a "Claude 1".
 *
 * This is an OPENING name, not a final one. `titleAuto` stays true, so once the agent names its
 * own session the session-name writer replaces this with the real subject — which is the point:
 * before that happens the card said "Claude", which named neither the owner nor the job.
 */
export function workerNodeTitle(ownerTitle: string, roleLabel: string, ordinal: number): string {
  const suffix = ordinal > 1 ? ` ${ordinal}` : ''
  return oneLine(`${lane(ownerTitle)} · ${roleLabel}${suffix}`)
}

/**
 * The one-line "who and what" a generated node carries. Kept in its own field rather than folded
 * into the title precisely because the title is claimed by the session name: the summary is the
 * fact that survives the retitle.
 */
export function workerTaskSummary(ownerTitle: string, prompt?: string): string {
  const owner = `Opened by ${lane(ownerTitle)}`
  const task = squeeze(prompt ?? '')
  if (!task) return owner
  const trimmed =
    task.length > SUMMARY_MAX ? `${task.slice(0, SUMMARY_MAX - 1).trimEnd()}…` : task
  return `${owner} — ${trimmed}`
}

/** The tray frame's label. */
export function workerFrameLabel(ownerTitle: string): string {
  return oneLine(`${lane(ownerTitle)} workers`)
}
