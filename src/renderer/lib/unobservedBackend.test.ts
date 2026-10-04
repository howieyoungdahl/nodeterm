import { describe, expect, it, vi } from 'vitest'
import { PANE_RECHECK_MS } from '@shared/node-status'
import { MAX_UNOBSERVED_BACKEND_PROBES, probeUnobservedBackends, unobservedBackendPresentation,
  type BackendObservation, type BackendProbeTarget } from './unobservedBackend'

const target = (id = 'n1', overrides: Partial<BackendProbeTarget> = {}): BackendProbeTarget =>
  ({ id, projectId: 'project', eligible: true, ...overrides })
const observation = (t: BackendProbeTarget, pane: BackendObservation['pane'], checkedAt = 1): BackendObservation =>
  ({ target: t, pane, checkedAt })

describe('unobserved backend display', () => {
  it('separates presence and confirmed absence from task evidence', () => {
    const t = target()
    const present = unobservedBackendPresentation(t, observation(t, 'alive'), 2)
    expect(present.word).toBe('backend present')
    expect(present.detail).toContain('Agent activity and task completion are unobserved')
    const stopped = unobservedBackendPresentation(t, observation(t, 'dead'), 2)
    expect(stopped.word).toBe('backend stopped')
    expect(stopped.detail).toContain('Task completion is unobserved')
  })

  it.each(['missing', 'unknown', 'corrupt'] as const)('%s evidence cannot establish absence', (kind) => {
    const t = target()
    const obs = kind === 'missing' ? undefined : observation(t, kind === 'unknown' ? 'unknown' : 'garbage' as never)
    expect(unobservedBackendPresentation(t, obs, 2).word).toBe('backend unverified')
  })

  it.each([PANE_RECHECK_MS + 1, -1, Number.NaN, Number.POSITIVE_INFINITY])('rejects stale or invalid clock %s', (now) => {
    const t = target()
    expect(unobservedBackendPresentation(t, observation(t, 'dead'), now).word).toBe('backend unverified')
  })

  it.each([
    { projectId: 'foreign' },
    { statusToken: {} },
    { eligible: false },
    { id: 'other' }
  ])('rejects foreign or replaced target %j', (overrides) => {
    const t = target()
    expect(unobservedBackendPresentation(target('n1', overrides), observation(t, 'dead'), 2).word).toBe('backend unverified')
  })
})

describe('read-only unobserved backend pass', () => {
  it('probes hookless targets only, deduplicates, and ignores unsolicited answers', async () => {
    const t = target()
    const probe = vi.fn(async () => ({ n1: 'dead', foreign: 'dead' }))
    const out = await probeUnobservedBackends({ targets: () => [t, t, target('foreign', { eligible: false })], observations: {}, probe, now: () => 2 })
    expect(probe).toHaveBeenCalledExactlyOnceWith(['n1'])
    expect(out).toEqual({ n1: observation(t, 'dead', 2) })
  })

  it('caps a pass and gives unprobed targets a chance on the next pass', async () => {
    const targets = Array.from({ length: MAX_UNOBSERVED_BACKEND_PROBES + 1 }, (_, i) => target(`n${i}`))
    const probe = vi.fn(async (ids: string[]) => Object.fromEntries(ids.map((id) => [id, 'alive'])))
    const first = await probeUnobservedBackends({ targets: () => targets, observations: {}, probe, now: () => 2 })
    expect(Object.keys(first)).toHaveLength(MAX_UNOBSERVED_BACKEND_PROBES)
    await probeUnobservedBackends({ targets: () => targets, observations: first, probe, now: () => 3 })
    expect(probe.mock.calls[1][0]).toEqual([`n${MAX_UNOBSERVED_BACKEND_PROBES}`])
  })

  it('rechecks only after the observation expires', async () => {
    const t = target()
    const probe = vi.fn(async () => ({ n1: 'alive' }))
    const observations = { n1: observation(t, 'dead') }
    expect(await probeUnobservedBackends({ targets: () => [t], observations, probe, now: () => 2 })).toEqual({})
    expect(probe).not.toHaveBeenCalled()
    expect((await probeUnobservedBackends({ targets: () => [t], observations, probe, now: () => PANE_RECHECK_MS + 1 })).n1.pane).toBe('alive')
  })

  it.each([undefined, null, [], 'dead', { n1: 'bad' }, { foreign: 'dead' }, Object.create({ n1: 'dead' })])('normalizes missing/corrupt/foreign evidence %j to unverified', async (answer) => {
    const t = target()
    const out = await probeUnobservedBackends({ targets: () => [t], observations: {}, probe: async () => answer, now: () => 2 })
    expect(out.n1.pane).toBe('unknown')
  })

  it('a missing or failed API cannot establish absence', async () => {
    const deps = { targets: () => [target()], observations: {}, now: () => 2 }
    expect((await probeUnobservedBackends(deps)).n1.pane).toBe('unknown')
    expect((await probeUnobservedBackends({ ...deps, probe: async () => { throw new Error('offline') } })).n1.pane).toBe('unknown')
  })

  it.each(['hook', 'project', 'removed', 'foreign-core', 'identity'] as const)('discards a reply after %s changes', async (change) => {
    const t = target()
    let targets = [t]
    const out = await probeUnobservedBackends({
      targets: () => targets, observations: {}, now: () => 2,
      probe: async () => {
        targets = change === 'removed' ? [] : [{ ...t,
          eligible: change !== 'hook' && change !== 'foreign-core',
          projectId: change === 'project' ? 'other' : t.projectId,
          statusToken: change === 'identity' ? {} : t.statusToken
        }]
        return { n1: 'dead' }
      }
    })
    expect(out).toEqual({})
  })

  it('does not renew freshness using a delayed reply', async () => {
    let clock = 1
    const out = await probeUnobservedBackends({ targets: () => [target()], observations: {}, now: () => clock,
      probe: async () => { clock += PANE_RECHECK_MS; return { n1: 'dead' } } })
    expect(out).toEqual({})
  })
})
