// The layout rule engine (plan of record §4). Pure planner, plus the two things that cannot be:
// the lease that makes one instance the authority for a project, and the channel both shells
// register. Nothing here runs on a timer.

export { plan, isLayoutSubject } from './plan'
export { refuse, insideLoopFrame, refusalContext, type RefusalContext } from './refusals'
export { gateLayoutPlan, type ApplyGateDeps } from './apply-gate'
export { loopOwnedFrameIds, type FrameChainNode } from './loop-frames'
export { LayoutLeaseStore, LAYOUT_LEASE_TTL_MS, type LayoutLease } from './lease'
export {
  planForRequest,
  registerCanvasLayoutIpc,
  type CanvasLayoutServiceDeps
} from './service'
export type { LayoutInput, LayoutNode } from './types'
