// What `plan()` is given. Everything arrives as DATA: no store, no filesystem, no clock of its
// own. That is what lets one function serve the Server's spawn path, the desktop renderer's
// organize request and a unit test with nothing mocked.

import type { LayoutNode, LayoutTrigger } from '../../shared/canvas-layout'
import type { ResolvedLayoutRules } from '../../shared/canvas-layout-rules'
import type { NodeStatusKind } from '../../shared/node-status'

export type { LayoutNode }

export interface LayoutInput {
  trigger: LayoutTrigger
  /** Every node of the project, frames included. */
  nodes: readonly LayoutNode[]
  /**
   * Lineage edges (`project.ropes`) — the record of which node opened which. The same source
   * @shared/worker-frame reads, so the tray the engine maintains and the tray the spawn path
   * creates are derived from one fact rather than kept in step by hand.
   */
  ropes?: readonly { source: string; target: string }[]
  /** Per-node status, for the rules that key on it. A node with no entry has no status. */
  statuses?: Readonly<Record<string, NodeStatusKind>>
  rules: ResolvedLayoutRules
  /**
   * Nodes the operator is actively using — focused, or last interacted with inside the activity
   * window. A PLAN-TIME courtesy only: the same question is re-asked at apply time
   * (`gateLayoutPlan`), because a verdict about what someone's hands are on is stale in seconds.
   */
  actives?: readonly string[]
  /**
   * Frames another authority owns — a director loop's frame and everything inside it. Supplied,
   * never guessed: in the app it is derived from the nodes carrying a live loop/cron card
   * (`loopOwnedFrameIds`), and the organize skill derives it from the loop registry. The engine
   * has no business inferring ownership from a frame's name.
   */
  loopFrames?: readonly string[]
  /**
   * May this caller act on that node? The creator-ownership boundary the rest of the control
   * plane already enforces (`HeadlessNodeFactory.ownsSpawn`). Omitted = the caller vouches for
   * everything it names — the desktop case, where the canvas and the caller are one principal.
   */
  owns?: (nodeId: string) => boolean
  /** Nodes created by THIS trigger, when the trigger is `node-created`. */
  createdIds?: readonly string[]
  /** The size a `normal` worker is opened at, and the compact one. Injected so the engine holds
   *  no geometry constants of its own. */
  sizes: { compact: { width: number; height: number }; normal: { width: number; height: number } }
  now: number
}
