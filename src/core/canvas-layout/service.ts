// The layout engine's one I/O surface: the channel both shells register, from this one body.
//
// Everything above it is pure. This is where the lease lives, where the machine-local switch is
// read, and where a request from the renderer turns into a plan. It is deliberately the ONLY way
// in — there is no timer, no watcher and no poll here, and adding one would be the thing the
// operator ruled out ("do not spend model tokens repeatedly inspecting an unchanged canvas"; a
// poll is that cost in a different currency).
//
// WHY BOTH SHELLS REGISTER THE SAME BODY. `core/node-status-parity.test.ts` is the local
// precedent and its comment is the reason: this repo has shipped a hook/mirror change to exactly
// one shell three times. A shell that stopped calling `registerCanvasLayoutIpc` boots fine, serves
// every other channel, and simply never organises anything — with no error anywhere. So the call
// is one greppable line per shell and a source-level test asserts both of them.

import { IPC } from '../../shared/ipc'
import { platform } from '../platform'
import {
  isLayoutTrigger,
  standDownPlan,
  type LayoutPlan,
  type LayoutPlanRequest,
  type LayoutTrigger
} from '../../shared/canvas-layout'
import {
  layoutEngineEnabled,
  resolveLayoutRules,
  sanitizeCanvasLayoutRules,
  sanitizeCanvasLayoutSettings
} from '../../shared/canvas-layout-rules'
import { plan } from './plan'
import { LayoutLeaseStore } from './lease'
import type { LayoutInput } from './types'

export interface CanvasLayoutServiceDeps {
  /** This machine's `Settings.canvasLayout`, read at call time so a settings change takes effect
   *  without a restart. Absent ⇒ the feature is off, which is also the default. */
  settings?: () => unknown
  lease?: LayoutLeaseStore
  now?: () => number
}

/**
 * Build a plan for one request, or say why not.
 *
 * Three stand-downs, and each is a WORD rather than an empty answer: the feature is off on this
 * machine; another instance holds the lease (named); there is no project to plan for. An empty
 * `ops` array with no reason would be indistinguishable from "there was nothing to do", which is
 * a different fact and one the preview has to be able to state.
 */
export async function planForRequest(
  request: LayoutPlanRequest,
  deps: CanvasLayoutServiceDeps = {}
): Promise<LayoutPlan> {
  const trigger: LayoutTrigger = isLayoutTrigger(request?.trigger) ? request.trigger : 'organize'
  if (!request?.projectId) return standDownPlan(trigger, 'unknown-project')
  const settings = sanitizeCanvasLayoutSettings(deps.settings?.())
  if (!layoutEngineEnabled(settings)) return standDownPlan(trigger, 'disabled')

  const lease = deps.lease ?? new LayoutLeaseStore({ now: deps.now })
  const taken = await lease.acquire(request.projectId, request.holder)
  if (!taken.ok) return standDownPlan(trigger, 'lease-held', taken.holder)

  return plan({
    trigger,
    nodes: Array.isArray(request.nodes) ? request.nodes : [],
    ropes: request.ropes ?? [],
    statuses: (request.statuses ?? {}) as LayoutInput['statuses'],
    rules: resolveLayoutRules(sanitizeCanvasLayoutRules(request.projectRules), settings?.defaults),
    actives: request.actives ?? [],
    loopFrames: request.loopFrames ?? [],
    createdIds: request.createdIds ?? [],
    sizes: request.sizes,
    now: (deps.now ?? (() => Date.now()))()
  })
}

/** The one registration for the layout-plan channel, called by both shells. */
export function registerCanvasLayoutIpc(deps: CanvasLayoutServiceDeps = {}): void {
  const lease = deps.lease ?? new LayoutLeaseStore({ now: deps.now })
  platform().handle(IPC.canvasLayoutPlan, (request: unknown) =>
    planForRequest(request as LayoutPlanRequest, { ...deps, lease })
  )
  platform().handle(IPC.canvasLayoutRelease, async (payload: unknown) => {
    const { projectId, holder } = (payload ?? {}) as { projectId?: string; holder?: string }
    if (!projectId || !holder) return false
    await lease.release(projectId, holder)
    return true
  })
}
