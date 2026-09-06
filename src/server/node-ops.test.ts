import path from 'path'

import { describe, expect, it } from 'vitest'

import type { AgentState } from '../shared/agents/normalize'
import type { CanvasNodeState, Project, Workspace } from '../shared/types'
import { createHeadlessNodeOwnership } from './headless-node-factory'
import {
  ServerNodeOps,
  deadCardMassRefusal,
  DEFAULT_DEAD_CARD_MASS_LIMIT,
  type DeadCardMassLimit,
  type NodeOpsWorkspace
} from './node-ops'

const node = (
  id: string,
  kind: CanvasNodeState['kind'] = 'terminal',
  extra: Partial<CanvasNodeState> = {}
): CanvasNodeState => ({
  id,
  kind,
  title: id,
  color: '#0a84ff',
  group: null,
  position: { x: 10, y: 20 },
  size: { width: 640, height: 440 },
  ...extra
})

function harness(opts: {
  nodes?: CanvasNodeState[]
  pane?: Record<string, boolean | Error>
  status?: Record<string, { state?: AgentState; updatedAt: number }>
  remote?: boolean
  destroyError?: Error
  massLimit?: DeadCardMassLimit
} = {}) {
  let workspace: Workspace = {
    version: 2,
    activeProjectId: 'p1',
    projects: [
      {
        id: 'p1',
        name: 'One',
        color: '#0a84ff',
        viewport: { x: 0, y: 0, zoom: 1 },
        nodes: opts.nodes ?? [],
        bridges: [],
        ropes: [],
        ...(opts.remote
          ? { ssh: { server: { host: 'remote.test', user: 'ops' }, remoteCwd: '/srv/app' } }
          : {})
      }
    ]
  }
  let saves = 0
  const removed: string[] = []
  const destroyed: string[] = []
  const probes: string[] = []
  const warnings: string[] = []
  const ownership = createHeadlessNodeOwnership()
  const store: NodeOpsWorkspace = {
    load: async () => structuredClone(workspace),
    save: async (next) => {
      workspace = structuredClone(next)
      saves += 1
    }
  }
  const service = new ServerNodeOps({
    workspaceStore: store,
    sessionPresence: async (id) => {
      probes.push(id)
      const answer = opts.pane?.[id]
      if (answer instanceof Error) throw answer
      return answer ? 'alive' : 'dead'
    },
    destroySession: async (id) => {
      destroyed.push(id)
      if (opts.destroyError) throw opts.destroyError
    },
    statusOf: (id) => opts.status?.[id],
    ownerOf: (id) => ownership.ownerOf(id),
    onRemoved: (ids) => removed.push(...ids),
    now: () => 1_800_000_000_000,
    ...(opts.massLimit ? { massLimit: opts.massLimit } : {}),
    warn: (message) => warnings.push(message)
  })
  return {
    service,
    ownership,
    workspace: () => workspace,
    saves: () => saves,
    removed,
    destroyed,
    probes,
    warnings
  }
}

describe('ServerNodeOps', () => {
  it(
    'inventories every card with pane liveness, normalized status, activity, group and owner',
    async () => {
    const created = 1_700_000_000_000
    const createdId = `term-${created.toString(36)}-cafebabe`
    const h = harness({
      nodes: [
        node(createdId, 'terminal', { title: 'Builder', parentId: 'group-a' }),
        node('sticky-a', 'sticky')
      ],
      pane: { [createdId]: true },
      status: { [createdId]: { state: 'waiting', updatedAt: 1234 } }
    })
    h.ownership.record(createdId, { sourceNodeId: 'director-card', projectId: 'p1' })

    expect(await h.service.list()).toEqual([
      {
        id: createdId,
        kind: 'terminal',
        title: 'Builder',
        projectId: 'p1',
        groupId: 'group-a',
        createdAt: created,
        paneState: 'alive',
        agentStatus: 'blocked',
        lastActivityAt: 1234,
        ownerSession: 'director-card'
      },
      {
        id: 'sticky-a',
        kind: 'sticky',
        title: 'sticky-a',
        projectId: 'p1',
        groupId: null,
        createdAt: null,
        paneState: 'none',
        agentStatus: null,
        lastActivityAt: null,
        ownerSession: null
      }
    ])
    }
  )

  it('sweeps only terminals proven dead twice and dry-run changes nothing', async () => {
    const h = harness({
      nodes: [node('dead'), node('live'), node('unknown'), node('note', 'sticky')],
      pane: { dead: false, live: true, unknown: new Error('tmux unreadable') }
    })

    expect(await h.service.sweep(true)).toMatchObject({ affectedIds: ['dead'], dryRun: true })
    expect(h.workspace().projects[0].nodes).toHaveLength(4)
    expect(h.saves()).toBe(0)

    expect(await h.service.sweep(false)).toMatchObject({ affectedIds: ['dead'], dryRun: false })
    expect(h.workspace().projects[0].nodes.map((n) => n.id)).toEqual(['live', 'unknown', 'note'])
    expect(h.removed).toEqual(['dead'])
    expect(h.probes.filter((id) => id === 'dead')).toHaveLength(4)
  })

  it(
    'refuses a live or unreadable pane without force and kills a live pane before forced removal',
    async () => {
    const live = harness({ nodes: [node('live')], pane: { live: true } })
    await expect(live.service.remove('live', false)).resolves.toMatchObject({
      ok: false,
      status: 409,
      error: 'pane_alive'
    })
    expect(live.workspace().projects[0].nodes).toHaveLength(1)

    await expect(live.service.remove('live', true)).resolves.toMatchObject({
      ok: true,
      removedIds: ['live'],
      forced: true
    })
    expect(live.destroyed).toEqual(['live'])
    expect(live.workspace().projects[0].nodes).toHaveLength(0)

    const unknown = harness({
      nodes: [node('unknown')],
      pane: { unknown: new Error('probe failed') }
    })
    await expect(unknown.service.remove('unknown', false)).resolves.toMatchObject({
      ok: false,
      status: 503,
      error: 'pane_state_unknown'
    })

    const dead = harness({ nodes: [node('dead')], pane: { dead: false } })
    await expect(dead.service.remove('dead', false)).resolves.toMatchObject({
      ok: true,
      removedIds: ['dead'],
      forced: false
    })
    expect(dead.probes).toEqual(['dead', 'dead'])
    expect(dead.destroyed).toEqual([])
    }
  )

  it('keeps the card when forced backend teardown fails', async () => {
    const h = harness({
      nodes: [node('live')],
      pane: { live: true },
      destroyError: new Error('tmux unavailable')
    })

    await expect(h.service.remove('live', true)).resolves.toMatchObject({
      ok: false,
      status: 503,
      error: 'pane_destroy_failed'
    })
    expect(h.destroyed).toEqual(['live'])
    expect(h.workspace().projects[0].nodes.map((candidate) => candidate.id)).toEqual(['live'])
    expect(h.saves()).toBe(0)
  })

  it('marks remote panes unknown and never sweeps them from a local absence probe', async () => {
    const h = harness({ nodes: [node('remote')], pane: { remote: false }, remote: true })

    await expect(h.service.list()).resolves.toEqual([
      expect.objectContaining({ id: 'remote', paneState: 'unknown' })
    ])
    await expect(h.service.sweep(false)).resolves.toMatchObject({ affectedIds: [], scanned: 0 })
    expect(h.probes).toEqual([])
    expect(h.workspace().projects[0].nodes.map((candidate) => candidate.id)).toEqual(['remote'])
  })

  it('deleting a group preserves its children at absolute positions', async () => {
    const h = harness({
      nodes: [
        node('group-a', 'group', { position: { x: 100, y: 200 } }),
        node('child', 'sticky', { parentId: 'group-a', position: { x: 12, y: 18 } })
      ]
    })
    await expect(h.service.remove('group-a', false)).resolves.toMatchObject({ ok: true })
    expect(h.workspace().projects[0].nodes).toEqual([
      expect.objectContaining({ id: 'child', position: { x: 112, y: 218 } })
    ])
    expect(h.workspace().projects[0].nodes[0].parentId).toBeUndefined()
  })
})

/**
 * Mass-sweep guard (2026-09-06 incident: the tmux server died at 06:39 and the 07:07 pass removed
 * 16 terminal cards). The cards ARE the record of the sessions, so a pass that large is refused
 * whole; only an operator with `force` may push it through.
 */
describe('ServerNodeOps mass-sweep guard', () => {
  const fiveDead = () =>
    harness({
      nodes: [
        node('d1'), node('d2'), node('d3'), node('d4'), node('d5'),
        node('live-1'), node('live-2'), node('live-3'), node('live-4'), node('live-5'),
        node('live-6'), node('live-7')
      ],
      pane: {
        d1: false, d2: false, d3: false, d4: false, d5: false,
        'live-1': true, 'live-2': true, 'live-3': true, 'live-4': true,
        'live-5': true, 'live-6': true, 'live-7': true
      }
    })

  it('refuses a pass over the count threshold, mutates nothing, and logs one loud line', async () => {
    const h = fiveDead()

    const result = await h.service.sweep(false)
    expect(result.refused).toEqual({
      reason: 'mass_limit',
      deadCount: 5,
      scanned: 12,
      maxCards: 5,
      maxFraction: 0.5
    })
    // The set it declined to touch is still reported, so an operator can inspect it before forcing.
    expect(result.affectedIds).toEqual(['d1', 'd2', 'd3', 'd4', 'd5'])
    expect(h.workspace().projects[0].nodes).toHaveLength(12)
    expect(h.saves()).toBe(0)
    expect(h.removed).toEqual([])
    expect(h.warnings).toHaveLength(1)
    expect(h.warnings[0]).toContain('REFUSED dead-card sweep: 5 of 12')
    expect(h.warnings[0]).toContain('"force":true')
  })

  it('refuses on the share rule when the count rule alone would let a small canvas empty', async () => {
    const h = harness({
      nodes: [node('d1'), node('d2'), node('d3'), node('live')],
      pane: { d1: false, d2: false, d3: false, live: true }
    })

    const result = await h.service.sweep(false)
    expect(result.refused).toMatchObject({ reason: 'mass_limit', deadCount: 3, scanned: 4 })
    expect(h.workspace().projects[0].nodes).toHaveLength(4)
    expect(h.saves()).toBe(0)
  })

  it('still reaps a pass under both thresholds', async () => {
    const h = harness({
      nodes: [node('d1'), node('d2'), node('live-1'), node('live-2'), node('live-3')],
      pane: { d1: false, d2: false, 'live-1': true, 'live-2': true, 'live-3': true }
    })

    const result = await h.service.sweep(false)
    expect(result.refused).toBeUndefined()
    expect(result.affectedIds).toEqual(['d1', 'd2'])
    expect(h.workspace().projects[0].nodes.map((n) => n.id)).toEqual(['live-1', 'live-2', 'live-3'])
    expect(h.saves()).toBe(1)
    expect(h.warnings).toEqual([])
  })

  it('force applies the same pass and prints no refusal', async () => {
    const h = fiveDead()

    const result = await h.service.sweep(false, true)
    expect(result.refused).toBeUndefined()
    expect(result.affectedIds).toEqual(['d1', 'd2', 'd3', 'd4', 'd5'])
    expect(h.workspace().projects[0].nodes.map((n) => n.id)).toEqual([
      'live-1', 'live-2', 'live-3', 'live-4', 'live-5', 'live-6', 'live-7'
    ])
    expect(h.removed).toEqual(['d1', 'd2', 'd3', 'd4', 'd5'])
    expect(h.warnings).toEqual([])
  })

  it('a dry run reports the refusal without logging — it removed nothing either way', async () => {
    const h = fiveDead()

    const result = await h.service.sweep(true)
    expect(result).toMatchObject({ dryRun: true, refused: { reason: 'mass_limit' } })
    expect(h.saves()).toBe(0)
    expect(h.warnings).toEqual([])
  })

  it('honours configured thresholds, including zero to disable a rule', async () => {
    const h = harness({
      nodes: [node('d1'), node('d2'), node('live')],
      pane: { d1: false, d2: false, live: true },
      massLimit: { maxCards: 2, maxFraction: 0 }
    })
    expect((await h.service.sweep(false)).refused).toMatchObject({ deadCount: 2, maxCards: 2 })

    const off = harness({
      nodes: [node('d1'), node('d2'), node('d3'), node('live')],
      pane: { d1: false, d2: false, d3: false, live: true },
      massLimit: { maxCards: 0, maxFraction: 0 }
    })
    expect((await off.service.sweep(false)).refused).toBeUndefined()
    expect(off.workspace().projects[0].nodes.map((n) => n.id)).toEqual(['live'])
  })
})

describe('deadCardMassRefusal', () => {
  const limit = DEFAULT_DEAD_CARD_MASS_LIMIT

  it('needs a pair before the share rule can trip, so a one-card canvas stays reapable', () => {
    expect(deadCardMassRefusal(1, 1, limit)).toBeNull()
    expect(deadCardMassRefusal(2, 3, limit)).not.toBeNull()
  })

  it('trips on either rule alone', () => {
    // Count only: 5 of 40 is an eighth of the canvas.
    expect(deadCardMassRefusal(5, 40, limit)).toMatchObject({ deadCount: 5 })
    // Share only: 4 of 4 is under the count threshold and still total.
    expect(deadCardMassRefusal(4, 4, limit)).toMatchObject({ deadCount: 4 })
  })

  it('lets an empty or ordinary pass through', () => {
    expect(deadCardMassRefusal(0, 0, limit)).toBeNull()
    expect(deadCardMassRefusal(0, 30, limit)).toBeNull()
    expect(deadCardMassRefusal(2, 30, limit)).toBeNull()
  })
})

/**
 * Orphan adoption — the sweep's mirror image, on the same workspace FIFO. The plan itself is pinned
 * in `src/core/orphan-adoption.test.ts`; what matters here is the WRITE: one save, the card in the
 * right project, the live insertion, and the boot classification that keeps the adopted id
 * attach-only.
 */
function adoptHarness(opts: {
  nodes?: CanvasNodeState[]
  sessions?: string[]
  paneCwds?: Record<string, string>
  wireListings?: boolean
  publish?: boolean
} = {}) {
  const cwd = path.resolve(path.sep, 'srv', 'repo')
  let workspace: Workspace = {
    version: 2,
    activeProjectId: 'p1',
    projects: [
      {
        id: 'p1',
        name: 'One',
        color: '#0a84ff',
        cwd,
        viewport: { x: 0, y: 0, zoom: 1 },
        nodes: opts.nodes ?? []
      }
    ]
  }
  const order: string[] = []
  const upserts: Array<{ projectId: string; nodeId: string }> = []
  const protectedIds: string[] = []
  const listings = opts.wireListings === false
    ? {}
    : {
        listSessions: async () => opts.sessions ?? [],
        listPaneCwds: async () =>
          new Map(Object.entries(opts.paneCwds ?? { 'nt-term-a': path.join(cwd, 'src') }))
      }
  const service = new ServerNodeOps({
    workspaceStore: {
      load: async () => structuredClone(workspace),
      save: async (next) => {
        order.push('save')
        workspace = structuredClone(next)
      }
    },
    sessionPresence: async () => 'dead',
    destroySession: async () => undefined,
    statusOf: () => undefined,
    ownerOf: () => undefined,
    ...listings,
    mirrorOf: (id) => (id === 'term-a' ? { name: 'live agent', agentId: 'claude' } : undefined),
    protectAdopted: async (ids) => {
      order.push('protect')
      protectedIds.push(...ids)
    },
    ...(opts.publish === false
      ? {}
      : {
          publishNode: (projectId, adopted) => {
            order.push('publish')
            upserts.push({ projectId, nodeId: adopted.id })
          }
        })
  })
  return { service, cwd, order, upserts, protectedIds, workspace: () => workspace }
}

describe('ServerNodeOps.adoptOrphans', () => {
  it('cards a live session with no node, publishes it live, and keeps it attach-only', async () => {
    const h = adoptHarness({ sessions: ['nt-term-a'] })
    const result = await h.service.adoptOrphans()

    expect(result.adopted).toEqual([
      {
        id: 'term-a',
        projectId: 'p1',
        projectName: 'One',
        title: 'live agent',
        sessionName: 'nt-term-a'
      }
    ])
    expect(result.skipped).toEqual([])
    expect(result.live).toBe(true)
    expect(h.workspace().projects[0].nodes.map((n) => n.id)).toEqual(['term-a'])
    expect(h.upserts).toEqual([{ projectId: 'p1', nodeId: 'term-a' }])
    // The id was not created during this Server run, so it takes the persisted-card classification.
    expect(h.protectedIds).toEqual(['term-a'])
    // …and only after the card is durable: classifying an id we then failed to persist would mark
    // a node attach-only that no project has.
    expect(h.order).toEqual(['save', 'protect', 'publish'])
  })

  it('writes nothing when every live session already has a card', async () => {
    const h = adoptHarness({ nodes: [node('term-a')], sessions: ['nt-term-a'] })
    await expect(h.service.adoptOrphans()).resolves.toEqual({ adopted: [], skipped: [], live: true })
    expect(h.order).toEqual([])
  })

  it('reports a pane it could not place instead of guessing a project', async () => {
    const h = adoptHarness({
      sessions: ['nt-term-a'],
      paneCwds: { 'nt-term-a': path.resolve(path.sep, 'elsewhere') }
    })
    const result = await h.service.adoptOrphans()
    expect(result.adopted).toEqual([])
    expect(result.skipped).toEqual([
      {
        id: 'term-a',
        sessionName: 'nt-term-a',
        cwd: path.resolve(path.sep, 'elsewhere'),
        reason: 'unmatched-cwd'
      }
    ])
    expect(h.order).toEqual([])
  })

  it('adopts nothing at all on a shell that wired no session listing', async () => {
    const h = adoptHarness({ sessions: ['nt-term-a'], wireListings: false })
    await expect(h.service.adoptOrphans()).resolves.toEqual({ adopted: [], skipped: [], live: true })
    expect(h.order).toEqual([])
  })

  it('says the cards are not live when there is no insertion channel', async () => {
    const h = adoptHarness({ sessions: ['nt-term-a'], publish: false })
    const result = await h.service.adoptOrphans()
    expect(result.adopted).toHaveLength(1)
    expect(result.live).toBe(false)
  })
})
