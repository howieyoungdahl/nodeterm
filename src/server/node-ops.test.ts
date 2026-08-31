import { describe, expect, it } from 'vitest'

import type { AgentState } from '../shared/agents/normalize'
import type { CanvasNodeState, Project, Workspace } from '../shared/types'
import { createHeadlessNodeOwnership } from './headless-node-factory'
import { ServerNodeOps, type NodeOpsWorkspace } from './node-ops'

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
    now: () => 1_800_000_000_000
  })
  return {
    service,
    ownership,
    workspace: () => workspace,
    saves: () => saves,
    removed,
    destroyed,
    probes
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
