/**
 * The Server Edition `assign` verb: the pure board transforms first, then the real factory against
 * a real `WorkspaceStore`, so the kanban round-trip through the project file is exercised rather
 * than assumed. The reply TEXT is pinned because `nodeterm.sh` prints it verbatim.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { fakePlatform } from '../core/platform-fake'
import { initPlatform, resetPlatformForTests } from '../core/platform'
import { WorkspaceStore } from '../core/workspace-store'
import { NODE_COLORS } from '../shared/node-colors'
import {
  DEFAULT_SETTINGS,
  type CanvasNodeState,
  type Project,
  type ProjectKanban,
  type PtyCreateOptions,
  type PtyCreateResult,
  type Settings,
  type Workspace
} from '../shared/types'
import { AssistantCreationReceipts } from './assistant-creation-receipts'
import {
  addBoardColumn,
  assignBoardCard,
  GITHUB_BOARD_CREATE_REFUSAL,
  parseCreateFlag,
  resolveBoardColumn
} from './board-assign'
import {
  createHeadlessNodeOwnership,
  HeadlessNodeFactory,
  type HeadlessNodeOwnership,
  type HeadlessPty
} from './headless-node-factory'

const board = (over: Partial<ProjectKanban> = {}): ProjectKanban => ({
  columns: [
    { id: 'kcol-todo', title: 'To Do', color: NODE_COLORS[0] },
    { id: 'kcol-doing', title: 'In Progress', color: NODE_COLORS[2] },
    { id: 'kcol-done', title: 'Done', color: NODE_COLORS[1] }
  ],
  assignments: [],
  ...over
})

describe('resolveBoardColumn', () => {
  it('maps empty and "ungrouped" (any case) to null', () => {
    for (const ref of ['', '   ', 'ungrouped', 'Ungrouped', 'UNGROUPED']) {
      expect(resolveBoardColumn(board(), ref), ref).toBeNull()
    }
    expect(resolveBoardColumn(undefined, 'Ungrouped')).toBeNull()
  })

  it('matches an exact column id, then a case-insensitive title', () => {
    expect(resolveBoardColumn(board(), 'kcol-doing')).toBe('kcol-doing')
    expect(resolveBoardColumn(board(), 'in progress')).toBe('kcol-doing')
    expect(resolveBoardColumn(board(), '  DONE ')).toBe('kcol-done')
  })

  it('prefers an id over a title that happens to spell another column id', () => {
    const tricky = board({
      columns: [
        { id: 'a', title: 'b', color: NODE_COLORS[0] },
        { id: 'b', title: 'a', color: NODE_COLORS[1] }
      ]
    })
    expect(resolveBoardColumn(tricky, 'a')).toBe('a')
    expect(resolveBoardColumn(tricky, 'b')).toBe('b')
  })

  it('returns undefined for an unknown column, and for any column of a project with no board', () => {
    expect(resolveBoardColumn(board(), 'Review')).toBeUndefined()
    expect(resolveBoardColumn(undefined, 'Review')).toBeUndefined()
  })
})

describe('assignBoardCard', () => {
  const ids = (b: ProjectKanban): string[] => b.assignments.map((a) => `${a.nodeId}@${a.columnId}`)

  it('appends a new assignment and records manual intent', () => {
    const next = assignBoardCard(board(), 'n1', 'kcol-doing', null)
    expect(ids(next)).toEqual(['n1@kcol-doing'])
    expect(next.manualAssignments).toEqual({ n1: true })
    expect(typeof next.manualAssignmentVersions?.n1).toBe('string')
  })

  it('moves an existing assignment instead of duplicating it', () => {
    const start = board({
      assignments: [
        { nodeId: 'n1', columnId: 'kcol-todo' },
        { nodeId: 'n2', columnId: 'kcol-todo' }
      ]
    })
    const next = assignBoardCard(start, 'n1', 'kcol-done', null)
    expect(ids(next)).toEqual(['n2@kcol-todo', 'n1@kcol-done'])
  })

  it('inserts before the named card only when that card is in the target column', () => {
    const start = board({
      assignments: [
        { nodeId: 'a', columnId: 'kcol-doing' },
        { nodeId: 'b', columnId: 'kcol-doing' },
        { nodeId: 'c', columnId: 'kcol-done' }
      ]
    })
    expect(ids(assignBoardCard(start, 'n1', 'kcol-doing', 'b'))).toEqual([
      'a@kcol-doing',
      'n1@kcol-doing',
      'b@kcol-doing',
      'c@kcol-done'
    ])
    // `c` lives in another column, so the anchor is ignored and the card goes to the end.
    expect(ids(assignBoardCard(start, 'n1', 'kcol-doing', 'c')).at(-1)).toBe('n1@kcol-doing')
  })

  it('null drops the assignment but still records manual intent', () => {
    const start = board({ assignments: [{ nodeId: 'n1', columnId: 'kcol-todo' }] })
    const next = assignBoardCard(start, 'n1', null, 'whatever')
    expect(next.assignments).toEqual([])
    expect(next.manualAssignments).toEqual({ n1: true })
  })

  it('is a no-op for an unknown column or a card anchored on itself', () => {
    const start = board({ assignments: [{ nodeId: 'n1', columnId: 'kcol-todo' }] })
    expect(assignBoardCard(start, 'n1', 'kcol-nope', null)).toBe(start)
    expect(assignBoardCard(start, 'n1', 'kcol-done', 'n1')).toBe(start)
    expect(assignBoardCard(start, 'n1', null, 'n1')).toBe(start)
  })

  it('does not mutate its input', () => {
    const start = board({ assignments: [{ nodeId: 'n1', columnId: 'kcol-todo' }] })
    const snapshot = JSON.stringify(start)
    assignBoardCard(start, 'n1', 'kcol-done', null)
    assignBoardCard(start, 'n1', null, null)
    expect(JSON.stringify(start)).toBe(snapshot)
  })
})

describe('addBoardColumn', () => {
  it('appends a kcol- column, cycling the node palette by column count', () => {
    const result = addBoardColumn(board(), 'Review')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.column.id).toMatch(/^kcol-[0-9a-z]{8}$/)
    expect(result.column.title).toBe('Review')
    expect(result.column.color).toBe(NODE_COLORS[3 % NODE_COLORS.length])
    expect(result.board.columns.map((c) => c.title)).toEqual(['To Do', 'In Progress', 'Done', 'Review'])
  })

  it('wraps the palette once there are more columns than colors', () => {
    const many = board({
      columns: Array.from({ length: NODE_COLORS.length }, (_, i) => ({
        id: `c${i}`,
        title: `C${i}`,
        color: NODE_COLORS[i]
      }))
    })
    const result = addBoardColumn(many, 'Wrapped')
    expect(result.ok && result.column.color).toBe(NODE_COLORS[0])
  })

  it('turns a missing board into a one-column board', () => {
    const result = addBoardColumn(undefined, 'First')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.board.assignments).toEqual([])
    expect(result.board.columns).toEqual([
      { id: result.column.id, title: 'First', color: NODE_COLORS[0] }
    ])
  })

  it('refuses a GitHub-synced board with the named message', () => {
    const synced = board({ github: { columnMappings: [] } })
    expect(addBoardColumn(synced, 'Review')).toEqual({
      ok: false,
      error: 'assign --create is not available on a GitHub-synced board; add the column in the browser UI'
    })
    expect(GITHUB_BOARD_CREATE_REFUSAL).toContain('GitHub-synced board')
  })
})

describe('parseCreateFlag', () => {
  it('accepts the shim valueless form and the yes/true spellings', () => {
    for (const value of ['', 'yes', 'YES', 'true', '1', ' yes ']) {
      expect(parseCreateFlag(value), value).toBe(true)
    }
  })
  it('is off when absent or explicitly negative, and undefined when ambiguous', () => {
    expect(parseCreateFlag(undefined)).toBe(false)
    for (const value of ['no', 'false', '0']) expect(parseCreateFlag(value), value).toBe(false)
    expect(parseCreateFlag('maybe')).toBeUndefined()
  })
})

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

describe('Server Edition assign (factory)', () => {
  let dataDir = ''
  let projectDir = ''
  let store: WorkspaceStore
  let ownership: HeadlessNodeOwnership
  let factory: HeadlessNodeFactory
  let publishProject: ReturnType<typeof vi.fn<(project: Project) => void>>

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
      creationReceipts: new AssistantCreationReceipts(path.join(dataDir, 'creation-receipts')),
      ptyManager: new QuietPty(),
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
      stateOf: () => undefined,
      agentIdOf: () => undefined,
      publishNode: () => {},
      publishRemoval: () => {},
      publishProject
    })
  }

  const persisted = async (): Promise<Project> =>
    (await new WorkspaceStore().load({ sideline: false })).projects[0]

  const standardNodes = (): CanvasNodeState[] => [
    node({ id: 'term-caller', title: 'Director', agentId: 'claude' }),
    node({ id: 'term-a', title: 'Worker A', agentId: 'codex' }),
    node({ id: 'term-b', title: 'Worker B', agentId: 'codex' }),
    node({ id: 'sticky-1', kind: 'sticky', title: 'Note', text: '# Status\nrunning' }),
    node({ id: 'group-1', kind: 'group', title: 'Frame' })
  ]

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeterm-assign-'))
    projectDir = path.join(dataDir, 'project')
    fs.mkdirSync(projectDir, { recursive: true })
    resetPlatformForTests()
    initPlatform(fakePlatform({ userDataDir: dataDir }))
    store = new WorkspaceStore()
    ownership = createHeadlessNodeOwnership()
    publishProject = vi.fn<(project: Project) => void>()
  })

  afterEach(() => {
    factory?.stop()
    resetPlatformForTests()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  it('files a card by column id, persists it with manual intent, and publishes the project', async () => {
    await seed(standardNodes(), board())

    const reply = await factory.assign(
      'term-caller',
      { node: 'term-a', column: 'kcol-doing' },
      true
    )

    expect(reply).toEqual({
      ok: true,
      message: 'moved Worker A to In Progress',
      result: { node: 'term-a', column: 'kcol-doing', created: false }
    })
    const kanban = (await persisted()).kanban!
    expect(kanban.assignments).toEqual([{ nodeId: 'term-a', columnId: 'kcol-doing' }])
    expect(kanban.manualAssignments).toEqual({ 'term-a': true })
    expect(kanban.manualAssignmentVersions?.['term-a']).toBeTruthy()
    expect(publishProject).toHaveBeenCalledTimes(1)
    expect(publishProject.mock.calls[0][0].kanban?.assignments).toEqual([
      { nodeId: 'term-a', columnId: 'kcol-doing' }
    ])
  })

  it('resolves the column by case-insensitive title, and a sticky note is a card', async () => {
    await seed(standardNodes(), board())

    const reply = await factory.assign('term-caller', { node: 'sticky-1', column: 'DONE' }, true)

    expect(reply.message).toBe('moved Status to Done')
    expect((await persisted()).kanban!.assignments).toEqual([
      { nodeId: 'sticky-1', columnId: 'kcol-done' }
    ])
  })

  it('"ungrouped" unassigns a filed card and keeps the manual intent', async () => {
    await seed(
      standardNodes(),
      board({ assignments: [{ nodeId: 'term-a', columnId: 'kcol-todo' }] })
    )

    const reply = await factory.assign('term-caller', { node: 'term-a', column: 'Ungrouped' }, true)

    expect(reply).toMatchObject({
      ok: true,
      message: 'moved Worker A to Ungrouped',
      result: { node: 'term-a', column: null, created: false }
    })
    const kanban = (await persisted()).kanban!
    expect(kanban.assignments).toEqual([])
    expect(kanban.manualAssignments).toEqual({ 'term-a': true })
  })

  it('"ungrouped" on a project with no board writes nothing (no empty board replaces the defaults)', async () => {
    await seed(standardNodes())

    const reply = await factory.assign('term-caller', { node: 'term-a', column: 'ungrouped' }, true)

    expect(reply).toMatchObject({ ok: true, message: 'moved Worker A to Ungrouped' })
    expect((await persisted()).kanban).toBeUndefined()
    expect(publishProject).not.toHaveBeenCalled()
  })

  it('--before places the card ahead of the named card in the target column', async () => {
    await seed(
      standardNodes(),
      board({
        assignments: [
          { nodeId: 'term-a', columnId: 'kcol-doing' },
          { nodeId: 'sticky-1', columnId: 'kcol-doing' }
        ]
      })
    )

    const reply = await factory.assign(
      'term-caller',
      { node: 'term-b', column: 'kcol-doing', before: 'sticky-1' },
      true
    )

    expect(reply.ok).toBe(true)
    expect((await persisted()).kanban!.assignments.map((a) => a.nodeId)).toEqual([
      'term-a',
      'term-b',
      'sticky-1'
    ])
  })

  it('an unknown column lists the real ones and writes nothing', async () => {
    await seed(standardNodes(), board())

    const reply = await factory.assign('term-caller', { node: 'term-a', column: 'Review' }, true)

    expect(reply).toEqual({
      ok: false,
      error:
        'assign: no column "Review" - columns: To Do, In Progress, Done; pass --create to add it'
    })
    expect((await persisted()).kanban!.assignments).toEqual([])
    expect(publishProject).not.toHaveBeenCalled()
  })

  it('an unknown column on a project with no board says (none)', async () => {
    await seed(standardNodes())

    const reply = await factory.assign('term-caller', { node: 'term-a', column: 'Review' }, true)

    expect(reply.error).toBe(
      'assign: no column "Review" - columns: (none); pass --create to add it'
    )
  })

  it('--create appends the missing column and files the card into it', async () => {
    await seed(standardNodes(), board())

    const reply = await factory.assign(
      'term-caller',
      { node: 'term-a', column: 'Review', create: '' },
      true
    )

    expect(reply).toMatchObject({
      ok: true,
      message: 'moved Worker A to Review',
      result: { node: 'term-a', created: true }
    })
    const kanban = (await persisted()).kanban!
    const created = kanban.columns.at(-1)!
    expect(kanban.columns).toHaveLength(4)
    expect(created).toMatchObject({ title: 'Review', color: NODE_COLORS[3] })
    expect(created.id).toMatch(/^kcol-[0-9a-z]{8}$/)
    expect(kanban.assignments).toEqual([{ nodeId: 'term-a', columnId: created.id }])
    expect((reply.result as { column: string }).column).toBe(created.id)
  })

  it('--create on a project with no board creates a one-column board; "yes" works too', async () => {
    await seed(standardNodes())

    const first = await factory.assign(
      'term-caller',
      { node: 'term-a', column: 'Review', create: 'yes' },
      true
    )
    expect(first.ok).toBe(true)
    // The column now exists, so a repeat with --create reuses it instead of adding a twin.
    const second = await factory.assign(
      'term-caller',
      { node: 'term-b', column: 'review', create: '' },
      true
    )
    expect(second).toMatchObject({ ok: true, result: { created: false } })

    const kanban = (await persisted()).kanban!
    expect(kanban.columns.map((c) => c.title)).toEqual(['Review'])
    expect(kanban.assignments.map((a) => a.nodeId)).toEqual(['term-a', 'term-b'])
  })

  it('--create is refused on a GitHub-synced board, which stays untouched', async () => {
    const synced = board({ github: { columnMappings: [] } })
    await seed(standardNodes(), synced)

    const reply = await factory.assign(
      'term-caller',
      { node: 'term-a', column: 'Review', create: '' },
      true
    )

    expect(reply).toEqual({
      ok: false,
      error: 'assign --create is not available on a GitHub-synced board; add the column in the browser UI'
    })
    expect((await persisted()).kanban!.columns).toHaveLength(3)
    // Without --create the plain unknown-column error stays, minus the --create hint it cannot honor.
    const plain = await factory.assign('term-caller', { node: 'term-a', column: 'Review' }, true)
    expect(plain.error).toBe('assign: no column "Review" - columns: To Do, In Progress, Done')
    expect(publishProject).not.toHaveBeenCalled()
  })

  it('refuses an ambiguous --create value rather than guessing', async () => {
    await seed(standardNodes(), board())
    const reply = await factory.assign(
      'term-caller',
      { node: 'term-a', column: 'Review', create: 'Review' },
      true
    )
    expect(reply.ok).toBe(false)
    expect(reply.error).toContain('--create')
    expect((await persisted()).kanban!.columns).toHaveLength(3)
  })

  it('requires --column, so an omitted flag never silently unassigns', async () => {
    await seed(
      standardNodes(),
      board({ assignments: [{ nodeId: 'term-a', columnId: 'kcol-todo' }] })
    )

    const omitted: Array<Record<string, string>> = [{ node: 'term-a' }, { node: 'term-a', column: '' }]
    for (const args of omitted) {
      const reply = await factory.assign('term-caller', args, true)
      expect(reply).toEqual({
        ok: false,
        error: 'assign requires --column <id|title|ungrouped>'
      })
    }
    expect((await persisted()).kanban!.assignments).toEqual([
      { nodeId: 'term-a', columnId: 'kcol-todo' }
    ])
  })

  it('refuses a target that is not a session card', async () => {
    await seed(standardNodes(), board())

    const frame = await factory.assign('term-caller', { node: 'group-1', column: 'Done' }, true)
    expect(frame).toEqual({
      ok: false,
      error: 'assign: --node names no session card (group-1)'
    })
    const missing = await factory.assign('term-caller', { column: 'Done' }, true)
    expect(missing.error).toBe('assign: --node names no session card (missing)')
    const ghost = await factory.assign('term-caller', { node: 'ghost', column: 'Done' }, true)
    expect(ghost.error).toBe('assign: --node names no session card (ghost)')
  })

  it('refuses a node that belongs to another project', async () => {
    await seed(standardNodes(), board(), {
      id: 'project-2',
      name: 'Other',
      color: '#32d74b',
      cwd: path.join(dataDir, 'other'),
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [node({ id: 'term-foreign', title: 'Foreign', agentId: 'claude' })]
    })

    const reply = await factory.assign('term-caller', { node: 'term-foreign', column: 'Done' }, true)

    expect(reply).toEqual({
      ok: false,
      error: 'assign: --node names no session card (term-foreign)'
    })
    expect((await persisted()).kanban!.assignments).toEqual([])
  })

  it('refuses an unverified caller before reading or writing anything', async () => {
    await seed(standardNodes(), board())

    const reply = await factory.assign('term-caller', { node: 'term-a', column: 'Done' }, false)

    expect(reply).toEqual({
      ok: false,
      error: 'assign-identity-refused: Server Edition assign requires verified node identity'
    })
    expect((await persisted()).kanban!.assignments).toEqual([])
    expect(publishProject).not.toHaveBeenCalled()
  })

  it('refuses an unknown flag, naming it', async () => {
    await seed(standardNodes(), board())

    const reply = await factory.assign(
      'term-caller',
      { node: 'term-a', column: 'Done', force: '' },
      true
    )

    expect(reply).toEqual({
      ok: false,
      error: 'assign: --force is not supported by Server Edition canvas control'
    })
  })

  it('refuses a caller that is not a control-capable agent', async () => {
    // A plain shell with no agent is the non-capable caller.
    await seed(
      [...standardNodes(), node({ id: 'term-shell', title: 'Shell' })],
      board()
    )
    const reply = await factory.assign('term-shell', { node: 'term-a', column: 'Done' }, true)

    expect(reply).toEqual({ ok: false, error: 'source node is not a control-capable agent' })
  })

  it('has no creator-ownership gate: a card the caller did not open can be filed', async () => {
    await seed(standardNodes(), board())
    ownership.record('term-a', { sourceNodeId: 'someone-else', projectId: 'project-1' })

    const reply = await factory.assign('term-caller', { node: 'term-a', column: 'Done' }, true)

    expect(reply.ok).toBe(true)
    // Board metadata only: the node itself is byte-for-byte what it was.
    const after = (await persisted()).nodes.find((n) => n.id === 'term-a')
    expect(after).toEqual(standardNodes().find((n) => n.id === 'term-a'))
  })
})
