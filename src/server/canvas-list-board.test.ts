/**
 * The Server Edition's two READ-ONLY canvas-control verbs, proven through the real factory and a
 * real `WorkspaceStore` (so the kanban round-trip through the project file is exercised, not
 * assumed).
 *
 * What is pinned here is the reply TEXT, because that is the contract: `nodeterm.sh` prints the
 * handler's `message` verbatim and an agent reads that. Asserting only on `result` would stay green
 * on a build that renders nothing an agent can act on.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { fakePlatform } from '../core/platform-fake'
import { initPlatform, resetPlatformForTests } from '../core/platform'
import { WorkspaceStore } from '../core/workspace-store'
import type { AgentState } from '../shared/agents/normalize'
import {
  DEFAULT_SETTINGS,
  type CanvasNodeState,
  type ProjectKanban,
  type PtyCreateOptions,
  type PtyCreateResult,
  type Settings,
  type Workspace
} from '../shared/types'
import { SERVER_BOARD_NO_COLUMNS_NOTE } from './canvas-inventory'
import {
  createHeadlessNodeOwnership,
  HeadlessNodeFactory,
  type HeadlessNodeOwnership,
  type HeadlessPty,
  type ServerControlReply
} from './headless-node-factory'

class QuietPty implements HeadlessPty {
  createHeadless = vi.fn(
    async (options: PtyCreateOptions): Promise<PtyCreateResult> => ({
      sessionId: `pty-${options.persistKey}`,
      fresh: true,
      persistent: true
    })
  )
  async sessionExists(): Promise<boolean> {
    return true
  }
  async sendText(): Promise<boolean> {
    return true
  }
  async destroySession(): Promise<void> {}
}

const node = (over: Partial<CanvasNodeState> & { id: string }): CanvasNodeState => ({
  kind: 'terminal',
  position: { x: 20, y: 30 },
  size: { width: 640, height: 440 },
  title: 'Node',
  color: '#d97757',
  group: null,
  ...over
})

describe('Server Edition read-only canvas control', () => {
  let dataDir = ''
  let projectDir = ''
  let store: WorkspaceStore
  let pty: QuietPty
  let ownership: HeadlessNodeOwnership
  let states: Record<string, AgentState | undefined>
  let runtimeAgentIds: Record<string, string | undefined>
  let factory: HeadlessNodeFactory

  const settings = (): Settings => ({ ...DEFAULT_SETTINGS })

  const seed = async (
    nodes: CanvasNodeState[],
    kanban?: ProjectKanban,
    extraProject?: Workspace['projects'][number]
  ): Promise<void> => {
    const workspace: Workspace = {
      version: 2,
      activeProjectId: 'project-1',
      projects: [
        {
          id: 'project-1',
          name: 'Loop Canvas',
          color: '#0a84ff',
          cwd: projectDir,
          viewport: { x: 0, y: 0, zoom: 1 },
          nodes,
          bridges: [],
          ropes: [],
          ...(kanban ? { kanban } : {})
        },
        ...(extraProject ? [extraProject] : [])
      ]
    }
    await store.save(workspace)
    factory = new HeadlessNodeFactory({
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
      stateOf: (id) => states[id],
      agentIdOf: (id) => runtimeAgentIds[id],
      publishNode: () => {},
      publishRemoval: () => {},
      publishProject: () => {}
    })
  }

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeterm-list-board-'))
    projectDir = path.join(dataDir, 'project')
    fs.mkdirSync(projectDir, { recursive: true })
    resetPlatformForTests()
    initPlatform(fakePlatform({ userDataDir: dataDir }))
    store = new WorkspaceStore()
    pty = new QuietPty()
    ownership = createHeadlessNodeOwnership()
    states = {}
    runtimeAgentIds = {}
  })

  afterEach(() => {
    factory?.stop()
    resetPlatformForTests()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  const lines = (reply: ServerControlReply): string[] => (reply.message ?? '').split('\n')

  // ---- list --------------------------------------------------------------

  it('lists a project holding nothing but the caller, and names the project in the header', async () => {
    await seed([node({ id: 'term-caller', title: 'Director', agentId: 'claude' })])

    const reply = await factory.list('term-caller', {})

    expect(reply.ok).toBe(true)
    expect(lines(reply)).toEqual([
      'Nodes in "Loop Canvas" (project project-1) — Server Edition has no current view, so this is ' +
        'the project that owns the calling node (term-caller).',
      'term-caller [terminal] Director | group=- | agent=claude | status=unknown | opened-by-you=no'
    ])
    expect(reply.result).toMatchObject({
      project: { id: 'project-1', name: 'Loop Canvas' },
      caller: 'term-caller',
      nodes: [
        {
          id: 'term-caller',
          kind: 'terminal',
          title: 'Director',
          group: null,
          agentId: 'claude',
          status: 'unknown',
          openedByCaller: false
        }
      ]
    })
  })

  it('reports kind, group, agent state and the creator marker for a mixed canvas', async () => {
    await seed([
      node({ id: 'term-caller', title: 'Director', agentId: 'claude' }),
      node({ id: 'group-1', kind: 'group', title: 'Workers' }),
      node({ id: 'term-worker', title: 'Worker A', agentId: 'codex', parentId: 'group-1' }),
      node({ id: 'term-plain', title: 'Shell' }),
      node({ id: 'sticky-1', kind: 'sticky', title: 'Note', text: '# Status\nrunning' }),
      node({ id: 'term-hookonly', title: 'Adopted' })
    ])
    states['term-caller'] = 'working'
    states['term-worker'] = 'done'
    states['term-hookonly'] = 'waiting'
    // A plain terminal that turned out to be running an agent: the id comes from the hook mirror,
    // not the persisted node. Without this fallback the node would print `agent=-` and, worse,
    // `status=-` while the mirror is actively reporting one.
    runtimeAgentIds['term-hookonly'] = 'gemini'
    ownership.record('term-worker', { sourceNodeId: 'term-caller', projectId: 'project-1' })
    ownership.record('sticky-1', { sourceNodeId: 'someone-else', projectId: 'project-1' })

    const reply = await factory.list('term-caller', {})

    expect(lines(reply).slice(1)).toEqual([
      'term-caller [terminal] Director | group=- | agent=claude | status=working | opened-by-you=no',
      'group-1 [group] Workers | group=- | agent=- | status=- | opened-by-you=no',
      'term-worker [terminal] Worker A | group=group-1 | agent=codex | status=done | opened-by-you=yes',
      'term-plain [terminal] Shell | group=- | agent=- | status=- | opened-by-you=no',
      'sticky-1 [sticky] Note | group=- | agent=- | status=- | opened-by-you=no',
      'term-hookonly [terminal] Adopted | group=- | agent=gemini | status=waiting | opened-by-you=no'
    ])
  })

  it('distinguishes an agent the mirror has never seen from a node that has no agent at all', async () => {
    // `unknown` and `-` are different facts: one is "could not measure", the other "does not
    // apply". Collapsing them is how a caller concludes a working agent is idle.
    await seed([
      node({ id: 'term-caller', title: 'Director', agentId: 'claude' }),
      node({ id: 'term-silent', title: 'Silent', agentId: 'codex' }),
      node({ id: 'term-plain', title: 'Shell' })
    ])

    const rows = (await factory.list('term-caller', {})).result as {
      nodes: Array<{ id: string; status: string | null }>
    }
    expect(rows.nodes.find((n) => n.id === 'term-silent')?.status).toBe('unknown')
    expect(rows.nodes.find((n) => n.id === 'term-plain')?.status).toBeNull()
  })

  it('shows only the CALLER’s project, never every project the server holds', async () => {
    await seed(
      [node({ id: 'term-caller', title: 'Director', agentId: 'claude' })],
      undefined,
      {
        id: 'project-2',
        name: 'Other',
        color: '#32d74b',
        cwd: path.join(dataDir, 'other'),
        viewport: { x: 0, y: 0, zoom: 1 },
        nodes: [node({ id: 'term-foreign', title: 'Foreign', agentId: 'claude' })]
      }
    )

    const reply = await factory.list('term-caller', {})
    expect(reply.message).toContain('project project-1')
    expect(reply.message).not.toContain('term-foreign')
    expect(reply.message).not.toContain('project-2')
  })

  // ---- board -------------------------------------------------------------

  it('reads the project’s real columns and files each card under its column', async () => {
    const kanban: ProjectKanban = {
      columns: [
        { id: 'kcol-todo', title: 'To Do', color: '#0a84ff' },
        { id: 'kcol-doing', title: 'In Progress', color: '#ffd60a' }
      ],
      assignments: [
        { nodeId: 'term-worker', columnId: 'kcol-doing' },
        { nodeId: 'sticky-1', columnId: 'kcol-todo' },
        // Dangling: names a column that no longer exists. The card must fall to Ungrouped, not
        // vanish and not print under a phantom column.
        { nodeId: 'term-caller', columnId: 'kcol-deleted' }
      ]
    }
    await seed(
      [
        node({ id: 'term-caller', title: 'Director', agentId: 'claude' }),
        node({ id: 'term-worker', title: 'Worker A', agentId: 'codex' }),
        node({ id: 'sticky-1', kind: 'sticky', title: 'ignored', text: '## Plan\nstep one' }),
        // A frame is not a card — desktop's `toKanbanSession` returns null for it.
        node({ id: 'group-1', kind: 'group', title: 'Workers' })
      ],
      kanban
    )

    const reply = await factory.board('term-caller', {})

    expect(reply.ok).toBe(true)
    expect(lines(reply)).toEqual([
      'Kanban board in "Loop Canvas" (project project-1) — Server Edition has no current view, so ' +
        'this is the project that owns the calling node (term-caller).',
      'To Do (1) [column id: kcol-todo]:',
      '  - Plan (id: sticky-1)',
      'In Progress (1) [column id: kcol-doing]:',
      '  - Worker A (id: term-worker)',
      'Ungrouped (1):',
      '  - Director (id: term-caller)'
    ])
    expect(reply.result).toMatchObject({
      project: { id: 'project-1', name: 'Loop Canvas' },
      columns: [
        { id: 'kcol-todo', title: 'To Do', cards: ['sticky-1'] },
        { id: 'kcol-doing', title: 'In Progress', cards: ['term-worker'] }
      ],
      ungrouped: ['term-caller']
    })
    expect(reply.message).not.toContain('group-1')
  })

  it('returns one virtual Ungrouped column, and says why, when the project has no board', async () => {
    await seed([
      node({ id: 'term-caller', title: 'Director', agentId: 'claude' }),
      node({ id: 'term-worker', title: 'Worker A', agentId: 'codex' })
    ])

    const reply = await factory.board('term-caller', {})

    expect(lines(reply)).toEqual([
      'Kanban board in "Loop Canvas" (project project-1) — Server Edition has no current view, so ' +
        'this is the project that owns the calling node (term-caller).',
      SERVER_BOARD_NO_COLUMNS_NOTE,
      'Ungrouped (2):',
      '  - Director (id: term-caller)',
      '  - Worker A (id: term-worker)'
    ])
    expect(reply.message).toContain('Server Edition v1 has no columns yet')
    expect(reply.result).toMatchObject({ columns: [], ungrouped: ['term-caller', 'term-worker'] })
  })

  it('reports an empty column as empty rather than omitting it', async () => {
    await seed(
      [node({ id: 'term-caller', title: 'Director', agentId: 'claude' })],
      { columns: [{ id: 'kcol-done', title: 'Done', color: '#32d74b' }], assignments: [] }
    )

    expect(lines(await factory.board('term-caller', {}))).toEqual([
      expect.stringContaining('Kanban board in "Loop Canvas"'),
      'Done (0) [column id: kcol-done]:',
      'Ungrouped (1):',
      '  - Director (id: term-caller)'
    ])
  })

  // ---- shared refusals ---------------------------------------------------

  it('refuses a caller that is not a control-capable agent, and one in no saved project', async () => {
    await seed([
      node({ id: 'term-caller', title: 'Director', agentId: 'claude' }),
      node({ id: 'term-plain', title: 'Shell' })
    ])

    for (const verb of ['list', 'board'] as const) {
      expect(await factory[verb]('term-plain', {})).toEqual({
        ok: false,
        error: 'source node is not a control-capable agent'
      })
      expect(await factory[verb]('term-missing', {})).toEqual({
        ok: false,
        error: 'source node is not in exactly one saved project'
      })
    }
  })

  it('refuses a flag neither verb takes instead of silently ignoring it', async () => {
    await seed([node({ id: 'term-caller', title: 'Director', agentId: 'claude' })])

    expect(await factory.list('term-caller', { project: 'project-2' })).toEqual({
      ok: false,
      error: 'list: --project is not supported by Server Edition canvas control'
    })
    expect(await factory.board('term-caller', { column: 'To Do' })).toEqual({
      ok: false,
      error: 'board: --column is not supported by Server Edition canvas control'
    })
  })

  it('answers while a spawn holds the workspace mutation lock', async () => {
    // `list` is what an agent runs when it suspects something is stuck. Putting the reads behind
    // `runExclusive` would make the diagnosis wait on the very launch being diagnosed — up to the
    // 15s launch deadline — so the reads deliberately take no mutation ticket.
    await seed([node({ id: 'term-caller', title: 'Director', agentId: 'claude' })])
    let release!: (result: PtyCreateResult) => void
    let entered!: () => void
    const hasEntered = new Promise<void>((resolve) => (entered = resolve))
    pty.createHeadless.mockImplementationOnce(() => {
      entered()
      return new Promise<PtyCreateResult>((resolve) => (release = resolve))
    })

    const spawn = factory.openTerminal('term-caller', { cwd: projectDir }, true)
    await hasEntered

    const stuck = Symbol('read queued behind the hung spawn')
    const observed = await Promise.race([
      factory.list('term-caller', {}),
      new Promise<typeof stuck>((resolve) => setTimeout(() => resolve(stuck), 500))
    ])
    expect(observed).not.toBe(stuck)
    expect((observed as ServerControlReply).ok).toBe(true)

    release({ sessionId: 'pty-late', fresh: true, persistent: true })
    await spawn
  })
})
