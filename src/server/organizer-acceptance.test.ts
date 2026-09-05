/**
 * ACCEPTANCE RUN for the automatic-organizer / visual-preferences series (PRs A–D, merged).
 *
 * The operator's criterion, in his words: spawn several workers under more than one director and
 * show that the canvas stays readable, that status is visible, that the node he is actually working
 * in is undisturbed, and that both the organization and the appearance survive a restart.
 *
 * It drives the REAL server spawn path (`HeadlessNodeFactory` + `WorkspaceStore`) and the real
 * `.nodeterm/project.json`, with the PTY faked. The PTY is faked deliberately: this repo's tmux
 * socket is a hardcoded constant shared with every live session on the machine, so an acceptance
 * run that spawned eight real sessions would put eight foreign sessions on somebody else's socket
 * to prove a point about layout. What is exercised for real is everything the four PRs actually
 * changed — placement, roles, trays, titles, the status derivation, the engine's refusals, and the
 * round trip through the project file.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { fakePlatform } from '../core/platform-fake'
import { initPlatform, resetPlatformForTests } from '../core/platform'
import { WorkspaceStore } from '../core/workspace-store'
import { plan } from '../core/canvas-layout/plan'
import { resolveLayoutRules } from '../shared/canvas-layout-rules'
import { COMPACT_CONTROL_NODE_SIZE, NORMAL_CONTROL_NODE_SIZE } from '../shared/control-node-size'
import { deriveNodeStatus } from '../shared/node-status'
import { resolveNodeAppearance } from '../shared/appearance'
import {
  DEFAULT_SETTINGS,
  type CanvasNodeState,
  type PtyCreateOptions,
  type PtyCreateResult,
  type Settings,
  type Workspace
} from '../shared/types'
import {
  createHeadlessNodeOwnership,
  HeadlessNodeFactory,
  type HeadlessPty
} from './headless-node-factory'
import { SpawnHandlerState } from './spawn-handler-state'

class FakePty implements HeadlessPty {
  readonly live = new Set<string>()
  async createHeadless(options: PtyCreateOptions): Promise<PtyCreateResult> {
    if (options.persistKey) this.live.add(options.persistKey)
    return { sessionId: `pty-${options.persistKey}`, fresh: true, persistent: true }
  }
  async sessionExists(persistKey: string): Promise<boolean> {
    return this.live.has(persistKey)
  }
  async sendText(): Promise<boolean> {
    return true
  }
  async destroySession(): Promise<void> {}
}

const node = (id: string, title: string, x: number): CanvasNodeState => ({
  id,
  kind: 'terminal',
  position: { x, y: 40 },
  size: { width: 640, height: 440 },
  title,
  color: '#d97757',
  group: null,
  tags: [],
  agentId: 'claude'
})

const settings = (): Settings => ({ ...DEFAULT_SETTINGS, claudePermissionMode: 'manual' })

describe('acceptance: eight workers under two directors', () => {
  it('stays readable, shows status, leaves the operator alone, and survives a restart', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeterm-acceptance-'))
    const projectDir = path.join(dataDir, 'project')
    fs.mkdirSync(projectDir, { recursive: true })
    resetPlatformForTests()
    initPlatform(fakePlatform({ userDataDir: dataDir }))

    const store = new WorkspaceStore()
    const pty = new FakePty()
    const ownership = createHeadlessNodeOwnership()

    // The operator's own canvas: two directors he opened, and the terminal he is working in.
    const initial: Workspace = {
      version: 2,
      activeProjectId: 'project-1',
      projects: [
        {
          id: 'project-1',
          name: 'Acceptance',
          color: '#0a84ff',
          cwd: projectDir,
          viewport: { x: 0, y: 0, zoom: 1 },
          nodes: [
            node('term-director-a', 'Director A', 20),
            node('term-director-b', 'Director B', 700),
            node('term-operator', 'My terminal', 1400)
          ],
          bridges: [],
          ropes: []
        }
      ]
    }
    await store.save(initial)

    const factory = new HeadlessNodeFactory({
      workspaceStore: store,
      ptyManager: pty,
      settings,
      cliCaps: async () => ({
        version: null,
        autoPermissionMode: false,
        fullscreenTui: false,
        sessionIdFlag: false,
        remoteControlFlag: false
      }),
      codexSharedIdentity: async () => false,
      ownership,
      spawnHandlerState: new SpawnHandlerState({ now: () => 1_000, wedgeAfterMs: 100 }),
      stateOf: () => undefined,
      publishNode: () => {},
      publishRemoval: () => {},
      publishProject: () => {}
    })

    const operatorBefore = structuredClone(
      (await store.load()).projects[0].nodes.find((n) => n.id === 'term-operator')!
    )

    const spawned: Record<string, string[]> = { 'term-director-a': [], 'term-director-b': [] }
    for (const director of ['term-director-a', 'term-director-b'] as const) {
      for (let i = 1; i <= 4; i += 1) {
        const reply = await factory.openAgent(director, { agent: 'claude', cwd: projectDir }, true)
        expect(reply.ok).toBe(true)
        spawned[director].push((reply.result as { id: string }).id)
      }
    }
    const workerIds = [...spawned['term-director-a'], ...spawned['term-director-b']]
    expect(workerIds).toHaveLength(8)

    const afterSpawn = (await store.load()).projects[0]
    const byId = new Map(afterSpawn.nodes.map((n) => [n.id, n]))

    // 1. READABLE — every spawned node is a worker, compact, titled, and inside a tray.
    const workers = workerIds.map((id) => byId.get(id)!)
    expect(workers.every((w) => w.role === 'worker')).toBe(true)
    expect(workers.every((w) => (w.size?.width ?? 9999) < 640)).toBe(true)
    expect(workers.every((w) => (w.title ?? '').length > 0)).toBe(true)
    const trays = afterSpawn.nodes.filter((n) => n.kind === 'group')
    expect(trays.length).toBeGreaterThanOrEqual(2)
    expect(trays.every((t) => t.collapsed === true)).toBe(true)
    for (const director of ['term-director-a', 'term-director-b'] as const) {
      const parents = new Set(spawned[director].map((id) => byId.get(id)!.parentId))
      expect(parents.size).toBe(1)
      expect([...parents][0]).toBeTruthy()
    }
    // The two directors do not share one tray.
    expect(byId.get(spawned['term-director-a'][0])!.parentId).not.toBe(
      byId.get(spawned['term-director-b'][0])!.parentId
    )

    // 2. THE OPERATOR'S NODE IS UNTOUCHED — same size, position, parent, title, no role.
    expect(byId.get('term-operator')).toEqual(operatorBefore)

    // 3. STATUS IS VISIBLE, and it never guesses.
    const now = 10_000_000
    const badges = {
      working: deriveNodeStatus({ state: 'working', updatedAt: now - 1_000, now }),
      blockedDeadPane: deriveNodeStatus({
        state: 'blocked',
        updatedAt: now - 1_000,
        pane: 'dead',
        now
      }),
      neverReported: deriveNodeStatus({ now }),
      staleUnprobeable: deriveNodeStatus({
        state: 'working',
        updatedAt: now - 60 * 60 * 1000,
        pane: 'unknown',
        now
      })
    }
    expect(badges.working.kind).toBe('working')
    // The widening this series shipped: an approval whose session died is a failure, not a
    // standing request the operator can still answer.
    expect(badges.blockedDeadPane.kind).toBe('failed')
    expect(badges.neverReported.kind).toBe('unknown')
    expect(badges.staleUnprobeable.kind).toBe('unknown')
    // Never colour alone, and never two states sharing a word.
    const words = Object.values(badges).map((b) => b.word)
    const glyphs = Object.values(badges).map((b) => b.glyph)
    expect(words.every((w) => w.length > 0)).toBe(true)
    expect(new Set(words).size).toBe(new Set(Object.values(badges).map((b) => b.kind)).size)
    expect(new Set(glyphs).size).toBe(new Set(Object.values(badges).map((b) => b.kind)).size)

    // 4. THE ENGINE REFUSES THE OPERATOR'S WORK, and says why.
    const pinnedId = workerIds[0]
    const layoutNodes = afterSpawn.nodes.map((n) => ({
      id: n.id,
      kind: n.kind ?? 'terminal',
      parentId: n.parentId ?? null,
      position: n.position,
      size: n.size ?? { width: 640, height: 440 },
      role: n.role,
      pinned: n.id === pinnedId ? true : n.pinned,
      manualPlacement: n.manualPlacement,
      collapsed: n.collapsed
    }))
    const organized = plan({
      trigger: 'organize',
      nodes: layoutNodes,
      ropes: afterSpawn.ropes ?? [],
      rules: resolveLayoutRules(undefined, undefined),
      sizes: { compact: COMPACT_CONTROL_NODE_SIZE, normal: NORMAL_CONTROL_NODE_SIZE },
      now: 1_000,
      actives: ['term-operator', workerIds[1]]
    })
    const reasons = new Map(organized.skipped.map((s) => [s.nodeId, s.reason]))
    expect(reasons.get(pinnedId)).toBe('pinned')
    expect(reasons.get(workerIds[1])).toBe('active')
    // The operator's own terminal: the engine emits NO op against it. It is not a candidate at all
    // (absent role reads as primary), so it need not appear in `skipped` — what matters is that
    // nothing in the plan moves, resizes or re-parents it.
    expect(organized.ops.some((op) => op.nodeId === 'term-operator')).toBe(false)
    if (reasons.has('term-operator')) expect(reasons.get('term-operator')).toBeTruthy()
    expect(organized.skipped.every((s) => typeof s.reason === 'string' && s.reason.length)).toBe(
      true
    )

    // 5. APPEARANCE — a shared project rule plus one explicit per-node override.
    const loaded = await store.load()
    const project = loaded.projects[0]
    project.layoutRules = {
      version: 1,
      appearance: { project: { color: '#7aa2f7', thickness: 2 } }
    }
    const overrideId = workerIds[2]
    project.nodes = project.nodes.map((n) =>
      n.id === overrideId ? { ...n, appearance: { color: '#ff375f' } } : n
    )
    await store.save(loaded)

    // 6. RESTART — a brand new store over the same data dir, exactly as a stopped and restarted
    //    Server would see it. Nothing in memory carries over.
    resetPlatformForTests()
    initPlatform(fakePlatform({ userDataDir: dataDir }))
    const restarted = await new WorkspaceStore().load()
    const after = restarted.projects[0]
    const afterById = new Map(after.nodes.map((n) => [n.id, n]))

    // Organization survived.
    for (const id of workerIds) {
      const before = byId.get(id)!
      const now2 = afterById.get(id)!
      expect(now2.role).toBe('worker')
      expect(now2.parentId).toBe(before.parentId)
      expect(now2.size).toEqual(before.size)
      expect(now2.position).toEqual(before.position)
      expect(now2.title).toBe(before.title)
    }
    expect(after.nodes.filter((n) => n.kind === 'group').length).toBe(trays.length)
    expect(afterById.get('term-operator')).toEqual(operatorBefore)

    // Appearance survived — the shared rule AND the explicit override, resolving as they did.
    expect(after.layoutRules?.appearance?.project).toEqual({ color: '#7aa2f7', thickness: 2 })
    expect(afterById.get(overrideId)!.appearance).toEqual({ color: '#ff375f' })
    const env = { rules: after.layoutRules?.appearance }
    const overrideResolved = resolveNodeAppearance(
      { kind: 'terminal', override: afterById.get(overrideId)!.appearance },
      env
    )
    const ruleResolved = resolveNodeAppearance({ kind: 'terminal' }, env)
    expect(overrideResolved.color).toBe('#ff375f')
    expect(ruleResolved.color).toBe('#7aa2f7')

    // The machine-local half never travelled: the shared file has no window edge and no motion key.
    const fileText = fs.readFileSync(path.join(projectDir, '.nodeterm', 'project.json'), 'utf8')
    expect(fileText).not.toContain('windowEdge')
    expect(fileText).not.toContain('reducedMotion')

    fs.writeFileSync(
      path.join(dataDir, 'acceptance-summary.json'),
      JSON.stringify(
        {
          directors: 2,
          workersSpawned: workerIds.length,
          trays: after.nodes.filter((n) => n.kind === 'group').map((t) => ({
            id: t.id,
            title: t.title,
            collapsed: t.collapsed,
            members: after.nodes.filter((n) => n.parentId === t.id).map((n) => n.title)
          })),
          operatorNodeUnchanged: true,
          badges: Object.fromEntries(
            Object.entries(badges).map(([k, v]) => [k, `${v.glyph} ${v.word}`])
          ),
          refusals: Object.fromEntries(reasons),
          appearanceAfterRestart: {
            projectRule: after.layoutRules?.appearance?.project,
            override: afterById.get(overrideId)!.appearance
          }
        },
        null,
        2
      )
    )
    // eslint-disable-next-line no-console
    console.log('ACCEPTANCE SUMMARY:', path.join(dataDir, 'acceptance-summary.json'))
    expect(fs.existsSync(path.join(dataDir, 'acceptance-summary.json'))).toBe(true)
  })
})
