import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect, it, onTestFinished, vi } from 'vitest'
import { LayoutLeaseStore } from '../../src/core/canvas-layout/lease'
import { plan } from '../../src/core/canvas-layout/plan'
import { applyLayoutTransaction, captureLayoutTransaction } from '../../src/core/canvas-layout/transaction'
import { writeFileAtomic } from '../../src/core/fs-atomic'
import { resolveLayoutRules } from '../../src/shared/canvas-layout-rules'
import { withProjectBorder } from '../../src/shared/project-border'
import { applyLayoutPlan, layoutNodesOf } from '../../src/renderer/lib/layoutPlanApply'
import { flowToNodeStates, nodeStatesToFlow, type CanvasNode } from '../../src/renderer/state/workspace'

it('plans, fences, applies and round-trips eight workers while preserving a primary and another director tree', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'nodeterm-organizer-acceptance-'))
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }))
  vi.stubGlobal('window', new Proxy({}, { get() { throw new Error('presentation reached a window/transport') } }))
  onTestFinished(() => { vi.unstubAllGlobals() })
  const node = (id: string, group = false, parentId?: string): CanvasNode => ({
    id, type: group ? 'group' : 'terminal', parentId, position: { x: 100, y: 100 },
    width: group ? 2800 : 640, height: group ? 700 : 440,
    data: { title: `Meaningful ${id}`, color: '#0a84ff', group: null, tags: [],
      ...(group ? { taskFrame: true } : { role: 'worker' }) }
  })
  let nodes = [node('primary'), node('director-a', true), node('director-b', true),
    ...Array.from({ length: 8 }, (_, i) => node(`worker-${i}`, false, i < 4 ? 'director-a' : 'director-b'))]
  nodes[0] = { ...nodes[0], selected: true, data: { ...nodes[0].data, role: 'primary', pinned: true } }
  const primary = nodes[0]
  const foreignBefore = JSON.stringify(nodes.filter((n) => n.id === 'director-b' || n.parentId === 'director-b'))
  const owns = (id: string) => id === 'director-a' || /^worker-[0-3]$/.test(id)
  const rules = {
    version: 8, spawn: { size: 'compact' as const, place: 'none' as const },
    tray: { collapsed: false, floatOnAttention: false }, future: { keep: true },
    appearance: { project: { color: '#abc' } }
  }
  const candidate = plan({
    trigger: 'organize', nodes: layoutNodesOf(nodes), owns,
    rules: resolveLayoutRules(rules), actives: ['primary'], loopFrames: ['director-b'],
    sizes: { compact: { width: 440, height: 320 }, normal: { width: 640, height: 440 } }, now: 1_000
  })
  expect(candidate.ops.length).toBeGreaterThan(0)
  const lease = new LayoutLeaseStore({ filePath: path.join(dir, 'leases.json'), now: () => 1_000 })
  const grant = await lease.acquire('p1', 'ui-a')
  if (!grant.ok) throw new Error('fixture failed to acquire')
  const revision = { projectId: 'p1', revision: 'committed-1', inputRevision: 'working-1',
    holder: 'ui-a', ownershipEpoch: 'assignment-1' }
  const captured = captureLayoutTransaction(candidate, revision, grant.lease.token)
  const apply = vi.fn((approved: typeof candidate): undefined => {
    nodes = applyLayoutPlan(nodes, approved)
    revision.inputRevision = 'working-2'
  })
  const run = () => applyLayoutTransaction(captured, {
    lease, current: () => ({ ...revision, enabled: true, source: 'current', activityComplete: true,
      nodes: layoutNodesOf(nodes), actives: ['primary'], loopFrames: ['director-b'], owns }), apply
  })
  expect(await run()).toMatchObject({ kind: 'applied' })
  expect(nodes[0]).toBe(primary)
  expect(JSON.stringify(nodes.filter((n) => n.id === 'director-b' || n.parentId === 'director-b'))).toBe(foreignBefore)
  expect(nodes.find((n) => n.id === 'worker-0')?.width).toBe(440)
  expect(await run()).toMatchObject({ kind: 'refused', reason: 'stale-inputRevision' })
  expect(apply).toHaveBeenCalledTimes(1)

  // This is the real serializer and atomic file utility in a disposable directory, not a claim
  // that the pending workspace coordinator/renderer or physical-device reopen has been wired.
  const projectPath = path.join(dir, 'project.json')
  await writeFileAtomic(projectPath, JSON.stringify({ nodes: flowToNodeStates(nodes),
    layoutRules: withProjectBorder(rules, undefined) }))
  const reopened = JSON.parse(readFileSync(projectPath, 'utf8'))
  const restored = nodeStatesToFlow(reopened.nodes)
  // Loading sorts parents before children for React Flow. Identity and content are keyed by ID.
  expect(restored.map((n) => n.id).sort()).toEqual(nodes.map((n) => n.id).sort())
  expect(Object.fromEntries(restored.map((n) => [n.id, n.data.title])))
    .toEqual(Object.fromEntries(nodes.map((n) => [n.id, n.data.title])))
  expect(restored.find((n) => n.id === 'worker-0')?.width).toBe(440)
  expect(restored.find((n) => n.id === 'worker-0')?.parentId).toBe('director-a')
  expect(reopened.layoutRules).toEqual({ version: 8, spawn: rules.spawn, tray: rules.tray, future: rules.future })
})
