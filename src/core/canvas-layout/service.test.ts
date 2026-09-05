// The service is where "off by default" and "one authority" actually bite. Its stand-downs are the
// thing to pin: an empty plan with no reason is indistinguishable from "there was nothing to do",
// and those are different facts the preview has to be able to tell apart.
import { describe, it, expect } from 'vitest'
import { planForRequest } from './service'
import { LayoutLeaseStore } from './lease'
import type { LayoutPlanRequest } from '../../shared/canvas-layout'

function request(over: Partial<LayoutPlanRequest> = {}): LayoutPlanRequest {
  return {
    projectId: 'p1',
    trigger: 'organize',
    nodes: [],
    sizes: { compact: { width: 440, height: 320 }, normal: { width: 640, height: 440 } },
    holder: 'ui-a',
    ...over
  }
}

function lease(): LayoutLeaseStore {
  let file: string | null = null
  return new LayoutLeaseStore({
    read: () => file,
    write: async (text) => {
      file = text
    },
    now: () => 1_000
  })
}

const ON = { settings: () => ({ enabled: true }) }

describe('planForRequest', () => {
  it('is OFF unless the machine says otherwise — an absent settings block plans nothing', async () => {
    for (const settings of [undefined, () => undefined, () => ({}), () => ({ enabled: false })]) {
      const plan = await planForRequest(request(), { settings, lease: lease() })
      expect(plan.stoodDown).toEqual({ reason: 'disabled' })
    }
  })

  it('a hand-edited settings.json that is the wrong SHAPE reads as off, not as a crash', async () => {
    for (const value of ['yes', 1, [], { enabled: 'true' }, null]) {
      const plan = await planForRequest(request(), { settings: () => value, lease: lease() })
      expect(plan.stoodDown).toEqual({ reason: 'disabled' })
    }
  })

  it('stands down with a reason when there is no project to plan for', async () => {
    const plan = await planForRequest(request({ projectId: '' }), { ...ON, lease: lease() })
    expect(plan.stoodDown).toEqual({ reason: 'unknown-project' })
  })

  it('stands down and NAMES the lease holder when another instance has the canvas', async () => {
    const shared = lease()
    await shared.acquire('p1', 'ui-other')
    const plan = await planForRequest(request(), { ...ON, lease: shared })
    expect(plan.stoodDown).toEqual({ reason: 'lease-held', holder: 'ui-other' })
  })

  it('the SAME holder is not locked out of its own project', async () => {
    const shared = lease()
    await shared.acquire('p1', 'ui-a')
    const plan = await planForRequest(request(), { ...ON, lease: shared })
    expect(plan.stoodDown).toBeUndefined()
  })

  it('sanitizes the project’s rule block — it is hand-editable, git-shared input', async () => {
    const plan = await planForRequest(
      request({
        trigger: 'organize',
        projectRules: { spawn: { place: 'rm -rf' }, tray: { collapsed: 'yes' }, evil: true }
      }),
      { ...ON, lease: lease() }
    )
    // Unrecognised values fell through to the built-in rules rather than reaching the planner.
    expect(plan.stoodDown).toBeUndefined()
    expect(plan.ops).toEqual([])
  })

  it('an unrecognised trigger falls back to `organize` rather than throwing', async () => {
    const plan = await planForRequest(
      { ...request(), trigger: 'whenever' as never },
      { ...ON, lease: lease() }
    )
    expect(plan.trigger).toBe('organize')
  })

  it('a non-array `nodes` plans nothing instead of throwing', async () => {
    const plan = await planForRequest(
      { ...request(), nodes: 'nope' as never },
      { ...ON, lease: lease() }
    )
    expect(plan.ops).toEqual([])
  })
})
