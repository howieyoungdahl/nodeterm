import { describe, expect, it } from 'vitest'
import {
  ATTENTION_CLASSES,
  CLOSED_STAGES,
  COLD_BAND,
  DEFAULT_VIEW_PREFS,
  REGISTRY_ENV_VAR,
  VIEW_NAMES,
  attentionKey,
  buildAttentionRows,
  buildNavigator,
  buildUnregisteredRows,
  classifyRegistryPayload,
  formatAge,
  isoToEpoch,
  navSessionName,
  nodeFreshness,
  normalizeViewPrefs,
  openActionFor,
  pinIntent,
  promoteWorkerIntent,
  resolveRegistryPath,
  resolveView,
  searchTasks,
  sortTasks
} from './model'
import type { RegistryNode, RegistryTask, TaskRegistry } from './fixture'
import {
  ATTENTION_CLASSES as FIXTURE_ATTENTION_CLASSES,
  CLOSED_STAGES as FIXTURE_CLOSED_STAGES,
  COLLIDING_PANE,
  COLLIDING_WORKER_TITLE,
  FIXTURE_BASE_EPOCH,
  FIXTURE_HOST_BOOT_EPOCH,
  UNICODE_LONG_TITLE,
  generateFixture
} from './fixture'
import { resumeCommandWith } from '../agents/config'

// ---------------------------------------------------------------------------
// Test fixtures — a small hand-built registry, so a rule is asserted against input a reader can
// see in one screen. The generated population is used where SCALE is the point.
// ---------------------------------------------------------------------------

const BASE = FIXTURE_BASE_EPOCH
const NOW_MS = BASE * 1000

function node(over: Partial<RegistryNode> = {}): RegistryNode {
  return {
    task_id: 't1',
    role: 'worker',
    owner_node: null,
    project: 'web-app',
    project_id: 'project-aaaa1111-bbbb2222',
    pinned: false,
    title: 'a worker',
    pane: '%1',
    account: '1',
    provider: 'claude',
    model: 'claude-opus-5',
    session: '11111111-2222-4333-8444-555555555555',
    status: 'busy',
    class: 'BUSY',
    band: 'WARM',
    warm_min: 2,
    context_pct: 10,
    last_observed: '2026-09-04T22:31:00-04:00',
    observation_age_s: 12,
    ...over
  }
}

function task(over: Partial<RegistryTask> = {}): RegistryTask {
  return {
    task_id: 't1',
    title: 'web-app · ledger',
    project: 'web-app',
    project_id: 'project-aaaa1111-bbbb2222',
    pinned: false,
    objective: 'ship the ledger',
    scope: 'web-app only',
    owner: {
      kind: 'director',
      node: 'term-owner01-aaaaaaaa',
      session: '99999999-8888-4777-8666-555555555555',
      account: '1',
      provider: 'claude',
      model: 'claude-opus-5'
    },
    stage: 'building',
    stage_since: '2026-09-04T20:00:00-04:00',
    progress: {},
    next_action: { text: 'land the last file', owner: 'director', since: '2026-09-04T22:00:00-04:00' },
    blockers: [],
    workers: [],
    dependencies: [],
    budgets: { provider: 'claude', account: '1', dollars_cap: null, dollars_spent: 0, notes: '' },
    artifacts: {},
    evidence: [],
    freshness: { last_update: '2026-09-04T22:20:00-04:00', source: 'tick', may_be_stale: false, stale_reason: null },
    closed: false,
    retired_nodes: [],
    session_lineage: [],
    ...over
  }
}

function registry(over: Partial<TaskRegistry> = {}): TaskRegistry {
  return {
    registry_schema: 1,
    generated_at: '2026-09-04T22:31:12-04:00',
    generated_at_epoch: BASE,
    source: { file: '/state/ledger.json', generation: 412, ledger_schema: 2 },
    host_boot_epoch: FIXTURE_HOST_BOOT_EPOCH,
    tasks: [task()],
    nodes: { 'term-owner01-aaaaaaaa': node({ role: 'director', class: 'BUSY' }) },
    views: { needs_attention: [], primary: [], active: ['t1'], inactive: [], workers_by_task: { t1: [] } },
    counts: { tasks: 1, active: 1, needs_attention: 0, nodes: 1, workers: 0, dead_nodes: 0 },
    ...over
  }
}

function navFor(reg: TaskRegistry, unregistered: Parameters<typeof buildNavigator>[0]['unregistered'] = []) {
  return buildNavigator({ registry: reg, unregistered, nowMs: NOW_MS, path: '/state/registry.json' })
}

// ---------------------------------------------------------------------------

describe('the vocabulary this model switches on stays equal to the fixture it is tested against', () => {
  // model.ts declares these locally so it carries NO runtime imports and the CLI can load it
  // straight from source with no build step (see its header). That is only safe while a red test
  // catches the divergence, which is what these are.
  it('closed stages agree', () => {
    expect([...CLOSED_STAGES].sort()).toEqual([...FIXTURE_CLOSED_STAGES].sort())
  })

  it('attention classes agree', () => {
    expect([...ATTENTION_CLASSES].sort()).toEqual([...FIXTURE_ATTENTION_CLASSES].sort())
  })

  it('the cold band is spelled the way the contract spells it', () => {
    expect(COLD_BAND).toBe('COLD')
  })

  it('the resume grammar agrees with the app launcher for every provider it emits', () => {
    const sid = 'abc-123'
    for (const [provider, expected] of [
      ['claude', resumeCommandWith('claude', 'claude', sid)],
      ['codex', resumeCommandWith('codex', 'codex', sid)],
      ['gemini', resumeCommandWith('gemini', 'gemini', sid)],
      ['grok', resumeCommandWith('grok', 'grok', sid)],
      ['opencode', resumeCommandWith('opencode', 'opencode', sid)],
      ['copilot', resumeCommandWith('copilot', 'copilot', sid)]
    ] as const) {
      const open = openActionFor('term-x', node({ class: 'DEAD', provider, session: sid }), null, null)
      expect(open.command, provider).toBe(expected)
    }
  })
})

describe('resolveRegistryPath', () => {
  it('is unset when the variable is absent or blank', () => {
    expect(resolveRegistryPath({})).toEqual({ path: null, reason: null })
    expect(resolveRegistryPath({ [REGISTRY_ENV_VAR]: '   ' })).toEqual({ path: null, reason: null })
  })

  it('refuses a relative path and says why, rather than resolving it against a cwd', () => {
    const answer = resolveRegistryPath({ [REGISTRY_ENV_VAR]: 'state/registry.json' })
    expect(answer.path).toBeNull()
    expect(answer.reason).toMatch(/must be absolute/)
  })

  it('accepts both path dialects, wherever it runs', () => {
    // The value may have been written on another machine, so absoluteness cannot be decided by
    // the reader's own platform.
    expect(resolveRegistryPath({ [REGISTRY_ENV_VAR]: '/state/registry.json' }).path).toBe('/state/registry.json')
    expect(resolveRegistryPath({ [REGISTRY_ENV_VAR]: 'C:\\state\\registry.json' }).path).toBe('C:\\state\\registry.json')
    expect(resolveRegistryPath({ [REGISTRY_ENV_VAR]: 'C:/state/registry.json' }).path).toBe('C:/state/registry.json')
    expect(resolveRegistryPath({ [REGISTRY_ENV_VAR]: '\\\\host\\share\\r.json' }).path).toBe('\\\\host\\share\\r.json')
  })
})

describe('classifyRegistryPayload — four failures, all distinguishable, none of them an empty list', () => {
  it('an unset variable is its own answer', () => {
    const read = classifyRegistryPayload({ kind: 'unset' }, NOW_MS)
    expect(read.ok).toBe(false)
    expect(read.ok === false && read.kind).toBe('no-registry-configured')
    expect(read.message).toContain(REGISTRY_ENV_VAR)
  })

  it('a missing file is not the same answer as an unset variable', () => {
    const read = classifyRegistryPayload({ kind: 'missing', path: '/state/registry.json' }, NOW_MS)
    expect(read.ok === false && read.kind).toBe('registry-missing')
    expect(read.message).toMatch(/not "no tasks"/)
  })

  it('a failed read is not evidence of absence', () => {
    const read = classifyRegistryPayload(
      { kind: 'unreadable', path: '/state/registry.json', detail: 'EACCES' },
      NOW_MS
    )
    expect(read.ok === false && read.kind).toBe('registry-unreadable')
    expect(read.ok === false && read.kind === 'registry-unreadable' && read.detail).toBe('EACCES')
  })

  it('bad JSON, and valid JSON that is not a registry, are both unparseable', () => {
    expect(classifyRegistryPayload({ kind: 'text', path: '/r.json', text: '{ "tasks": [' }, NOW_MS).ok).toBe(false)
    const notARegistry = classifyRegistryPayload({ kind: 'text', path: '/r.json', text: '{"hello":1}' }, NOW_MS)
    expect(notARegistry.ok === false && notARegistry.kind).toBe('registry-unparseable')
    const anArray = classifyRegistryPayload({ kind: 'text', path: '/r.json', text: '[]' }, NOW_MS)
    expect(anArray.ok === false && anArray.kind).toBe('registry-unparseable')
  })

  it('passes generated_at, its epoch, the source generation and host_boot_epoch through verbatim', () => {
    const doc = registry()
    const read = classifyRegistryPayload({ kind: 'text', path: '/r.json', text: JSON.stringify(doc) }, NOW_MS)
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.registry.generated_at).toBe(doc.generated_at)
    expect(read.registry.generated_at_epoch).toBe(doc.generated_at_epoch)
    expect(read.registry.source.generation).toBe(doc.source.generation)
    expect(read.registry.host_boot_epoch).toBe(doc.host_boot_epoch)
  })

  it('marks a registry generated before the host booted, and still returns the data', () => {
    const doc = registry({ host_boot_epoch: BASE + 3600 })
    const read = classifyRegistryPayload({ kind: 'text', path: '/r.json', text: JSON.stringify(doc) }, NOW_MS)
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(read.staleness.generatedBeforeHostBoot).toBe(true)
    expect(read.message).toMatch(/STALE REGISTRY/)
    // Shown, not hidden: hiding it would lose the only record of what was running.
    expect(read.registry.tasks).toHaveLength(1)
  })

  it('ignores unknown fields instead of rejecting them (contract guarantee 2)', () => {
    const doc = { ...registry(), somethingNew: { added: 'later' }, tasks: [{ ...task(), futureField: 1 }] }
    const read = classifyRegistryPayload({ kind: 'text', path: '/r.json', text: JSON.stringify(doc) }, NOW_MS)
    expect(read.ok).toBe(true)
    if (!read.ok) return
    expect(navFor(read.registry).tasks[0].taskId).toBe('t1')
  })
})

describe('freshness travels with every status', () => {
  it('reports the registry age separately and never folds it into an observation age', () => {
    const nav = navFor(registry())
    expect(nav.tasks[0].owner.freshness.observationAgeS).toBe(12) // verbatim, not 12 + registry age
    expect(nav.staleness.registryAgeS).toBe(0)
  })

  it('marks an observation that predates the host boot', () => {
    const stale = nodeFreshness(
      node({ last_observed: '2026-09-04T20:00:00-04:00', observation_age_s: 9000 }),
      FIXTURE_HOST_BOOT_EPOCH
    )
    expect(stale.observedBeforeHostBoot).toBe(true)
    expect(stale.mayBeStale).toBe(true)
    expect(stale.label).toMatch(/pre-boot/)
  })

  it('a node the registry does not hold is UNKNOWN, never "fresh"', () => {
    const f = nodeFreshness(undefined, FIXTURE_HOST_BOOT_EPOCH)
    expect(f.band).toBe('UNKNOWN')
    expect(f.mayBeStale).toBe(true)
  })

  it('every task row carries a band and an age', () => {
    const { registry: big } = generateFixture()
    for (const row of navFor(big).tasks) {
      expect(row.owner.freshness.band).toBeTruthy()
      expect(row.owner.freshness.label).toMatch(/WARM|HEARTBEAT|ACT|COLD|NEW|UNKNOWN/)
    }
  })
})

describe('opening a session', () => {
  it('a live node attaches to its own tmux session by EXACT target', () => {
    const open = openActionFor('term-abc-123', node({ class: 'BUSY', band: 'WARM' }), null, null)
    expect(open.kind).toBe('tmux-attach')
    expect(open.command).toBe(`tmux -L node-terminal attach -t =${navSessionName('term-abc-123')}`)
    expect(open.command).toContain('-t =nt-') // without `=`, tmux prefix-matches and can hit another session
    expect(open.typingAllowed).toBe(true)
  })

  it('a dead node falls back to the provider resume line', () => {
    const open = openActionFor('term-abc-123', node({ class: 'DEAD', provider: 'codex', session: 'sess-9' }), null, null)
    expect(open.kind).toBe('resume')
    expect(open.command).toBe('codex resume sess-9')
  })

  it('refuses to put an unsafe session id on a command line', () => {
    const open = openActionFor('term-x', node({ class: 'DEAD', session: 'x; rm -rf /' }), null, null)
    expect(open.command).toBeNull()
    expect(open.note).toMatch(/not in a form/)
  })

  it('says so rather than guessing when the provider has no known resume grammar', () => {
    const open = openActionFor('term-x', node({ class: 'DEAD', provider: 'something-else' }), null, null)
    expect(open.command).toBeNull()
    expect(open.note).toMatch(/no resume grammar/)
  })

  it('COLD still prints the command, marked as needing an explicit override', () => {
    // Contract §6: nothing may TYPE into a session at COLD. Printing is not typing — and hiding
    // the line would leave no way to reach a cold session at all.
    const open = openActionFor('term-abc-123', node({ band: 'COLD', warm_min: 91 }), null, null)
    expect(open.command).toContain('tmux -L node-terminal attach')
    expect(open.typingAllowed).toBe(false)
    expect(open.requiresOverride).toBe(true)
    expect(open.refusal?.code).toBe('STALE-REFUSED')
    expect(open.refusal?.reason).toMatch(/91/)
  })
})

describe('the hierarchy is joined by id, never by pane or title', () => {
  const { registry: big } = generateFixture()
  const nav = navFor(big)

  it('the population really does contain the collisions this rule exists for', () => {
    const panes = Object.values(big.nodes).filter((n) => n.pane === COLLIDING_PANE)
    const titles = Object.values(big.nodes).filter((n) => n.title === COLLIDING_WORKER_TITLE)
    expect(panes.length).toBeGreaterThan(1)
    expect(titles.length).toBeGreaterThan(1)
  })

  it('two nodes sharing a pane land on the tasks their task_id names, not on each other', () => {
    const sharing = Object.entries(big.nodes).filter(([, n]) => n.pane === COLLIDING_PANE)
    for (const [id, n] of sharing) {
      if (!n.task_id) continue
      const row = nav.tasksById[n.task_id]
      expect(row).toBeTruthy()
      const everywhere = nav.tasks.filter((t) => t.workerRows.some((w) => w.node === id))
      // A node belongs to at most one task's roster: a pane-keyed join would put it on both.
      expect(everywhere.length).toBeLessThanOrEqual(1)
    }
  })

  it('two nodes sharing a title stay distinct rows', () => {
    const ids = Object.entries(big.nodes)
      .filter(([, n]) => n.title === COLLIDING_WORKER_TITLE)
      .map(([id]) => id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('groups tasks under their project', () => {
    const web = nav.projects.find((p) => p.project === 'web-app')
    expect(web?.taskIds.length).toBeGreaterThan(1)
    expect(nav.projects.map((p) => p.project)).toEqual([...new Set(big.tasks.map((t) => t.project))])
  })
})

describe('workers collapse, and the collapse never hides the reason', () => {
  const withWorkers = registry({
    tasks: [
      task({
        blockers: [
          {
            id: 'b1',
            kind: 'approval',
            text: 'label the demo PRs',
            owner: 'operator',
            since: '2026-09-04T09:55:00-04:00',
            node: 'term-w1-11111111',
            role: 'impl-schema'
          }
        ],
        workers: [{ node: 'term-w1-11111111', role: 'impl-schema', started: '', state: 'BUSY', band: 'WARM' }]
      })
    ],
    nodes: {
      'term-owner01-aaaaaaaa': node({ role: 'director' }),
      'term-w1-11111111': node({ role: 'worker', class: 'QUESTION' }),
      'term-w2-22222222': node({ role: 'worker', class: 'DEAD' })
    },
    views: {
      needs_attention: ['t1'],
      primary: [],
      active: ['t1'],
      inactive: [],
      workers_by_task: { t1: ['term-w1-11111111', 'term-w2-22222222'] }
    }
  })

  it('reports a count and a per-class tally instead of a row each', () => {
    const row = navFor(withWorkers).tasks[0]
    expect(row.workers.total).toBe(2)
    expect(row.workers.live).toBe(1)
    expect(row.workers.byClass).toEqual({ QUESTION: 1, DEAD: 1 })
  })

  it('hoists a worker-raised blocker onto the parent, attributed by blockers[].node', () => {
    const row = navFor(withWorkers).tasks[0]
    expect(row.workers.hoistedBlockers).toHaveLength(1)
    expect(row.workers.hoistedBlockers[0].node).toBe('term-w1-11111111')
    expect(row.workers.hoistedBlockers[0].role).toBe('impl-schema')
  })

  it('does not attribute a blocker to a worker by parsing `where`', () => {
    // The v0.1 reply added blockers[].node precisely so the `where` parse could be dropped.
    const noNode = registry({
      tasks: [
        task({
          blockers: [
            {
              id: 'b1',
              kind: 'question',
              text: 'which revision',
              owner: 'operator',
              since: '',
              where: 'term-w1-11111111 briefs/3/review.md:23-60'
            }
          ]
        })
      ],
      nodes: { ...withWorkers.nodes },
      views: { ...withWorkers.views }
    })
    const row = navFor(noNode).tasks[0]
    expect(row.blockers[0].node).toBeNull()
    expect(row.blockers[0].raisedByWorker).toBe(false)
    expect(row.workers.hoistedBlockers).toHaveLength(0)
  })

  it('the roster survives a task whose director never recorded its workers', () => {
    const undeclared = registry({
      tasks: [task({ workers: [] })],
      nodes: { 'term-owner01-aaaaaaaa': node({ role: 'director' }), 'term-w9-99999999': node({ role: 'worker' }) },
      views: { needs_attention: [], primary: [], active: [], inactive: [], workers_by_task: {} }
    })
    expect(navFor(undeclared).tasks[0].workers.total).toBe(1)
  })
})

describe('the six saved views', () => {
  const { registry: big } = generateFixture()
  const nav = navFor(big)

  it('offers exactly six names, with `all` last', () => {
    expect(VIEW_NAMES).toHaveLength(6)
    expect(VIEW_NAMES[VIEW_NAMES.length - 1]).toBe('all')
  })

  it('prefers the registry\u2019s own precomputed list and says so', () => {
    const view = resolveView(big, nav.tasks, 'needs_attention')
    expect(view.source).toBe('registry')
    expect(view.taskIds).toEqual(big.views.needs_attention)
  })

  it('recomputes what the registry does not carry, and says THAT', () => {
    const without = { ...big, views: { ...big.views, needs_attention: undefined } } as unknown as TaskRegistry
    const view = resolveView(without, nav.tasks, 'needs_attention')
    expect(view.source).toBe('recomputed')
    expect(view.taskIds.length).toBeGreaterThan(0)
  })

  it('drops a task id the registry lists but no task defines', () => {
    const bogus = { ...big, views: { ...big.views, active: [...big.views.active, 'no-such-task'] } }
    expect(resolveView(bogus, nav.tasks, 'active').taskIds).not.toContain('no-such-task')
  })

  it('`all` is always recomputed and holds every task', () => {
    const view = resolveView(big, nav.tasks, 'all')
    expect(view.source).toBe('recomputed')
    expect(view.taskIds).toHaveLength(big.tasks.length)
  })
})

describe('needs-attention is deduplicated by (kind, text, owner)', () => {
  const shared = {
    id: 'b1',
    kind: 'approval' as const,
    text: 'label on the two demo PRs',
    owner: 'operator' as const,
    since: '2026-09-04T09:55:00-04:00'
  }
  const two = registry({
    tasks: [
      task({ task_id: 't1', blockers: [{ ...shared, node: 'term-w1-11111111' }] }),
      task({ task_id: 't2', blockers: [{ ...shared, since: '2026-09-04T12:00:00-04:00' }] })
    ],
    views: { needs_attention: ['t1', 't2'], primary: [], active: [], inactive: [], workers_by_task: {} }
  })

  it('collapses one blocker on two tasks into one row naming both', () => {
    const rows = navFor(two).attention.filter((r) => r.kind === 'approval')
    expect(rows).toHaveLength(1)
    expect(rows[0].taskIds).toEqual(['t1', 't2'])
  })

  it('keeps the oldest `since`, because that is how long it has actually been waiting', () => {
    expect(navFor(two).attention[0].since).toBe('2026-09-04T09:55:00-04:00')
  })

  it('keeps the raising node from whichever task recorded one', () => {
    expect(navFor(two).attention[0].raisedBy).toEqual([
      { node: 'term-w1-11111111', role: null, taskId: 't1' }
    ])
  })

  it('each task still shows the blocker in its own view — only the aggregate dedupes', () => {
    const nav = navFor(two)
    expect(nav.tasksById.t1.blockers).toHaveLength(1)
    expect(nav.tasksById.t2.blockers).toHaveLength(1)
  })

  it('two different texts stay two rows', () => {
    const distinct = registry({
      tasks: [
        task({ task_id: 't1', blockers: [{ ...shared, text: 'first question' }] }),
        task({ task_id: 't2', blockers: [{ ...shared, text: 'second question' }] })
      ],
      views: { needs_attention: ['t1', 't2'], primary: [], active: [], inactive: [], workers_by_task: {} }
    })
    expect(navFor(distinct).attention).toHaveLength(2)
  })

  it('a task flagged only by a session class gets a counted row, not a silent entry', () => {
    const flagged = registry({
      tasks: [task({ task_id: 't1', blockers: [] })],
      nodes: { 'term-owner01-aaaaaaaa': node({ role: 'director', class: 'LIMIT' }) },
      views: { needs_attention: ['t1'], primary: [], active: [], inactive: [], workers_by_task: {} }
    })
    const rows = navFor(flagged).attention
    expect(rows).toHaveLength(1)
    expect(rows[0].kind).toBe('session')
    expect(rows[0].text).toMatch(/LIMIT/)
  })

  it('the key cannot collide across two distinct triples', () => {
    expect(attentionKey('a', 'b c', 'd')).not.toBe(attentionKey('a b', 'c', 'd'))
  })

  it('every row on the generated population has a distinct key', () => {
    const { registry: big } = generateFixture()
    const rows = navFor(big).attention
    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length)
  })
})

describe('the unregistered bucket', () => {
  const { registry: big, unregistered } = generateFixture()

  it('joins to the registry by session uuid only, and never mints a task id', () => {
    const rows = buildUnregisteredRows(big.nodes, unregistered)
    expect(rows.length).toBe(unregistered.length)
    expect(rows.some((r) => r.joinedNode)).toBe(true)
    for (const row of rows) {
      expect(Object.keys(row)).not.toContain('task_id')
      if (row.joinedNode) expect(big.nodes[row.joinedNode].session).toBe(row.session)
    }
  })

  it('a joined row reports the joined node\u2019s task, and an unjoined one reports nothing', () => {
    const rows = buildUnregisteredRows(
      { 'term-a-1': node({ task_id: 't1', session: 'sess-a' }) },
      [
        { session: 'sess-a', provider: 'claude', account: '1', project: null, path: '/a', last_modified: '', last_modified_epoch: 0, size_bytes: 1 },
        { session: 'sess-b', provider: 'codex', account: null, project: null, path: '/b', last_modified: '', last_modified_epoch: 0, size_bytes: 1 }
      ]
    )
    expect(rows[0].joinedTaskId).toBe('t1')
    expect(rows[1].joinedNode).toBeNull()
    expect(rows[1].joinedTaskId).toBeNull()
  })

  it('is not part of any task view', () => {
    const nav = navFor(big, unregistered)
    expect(nav.unregistered).toHaveLength(unregistered.length)
    expect(nav.tasks.some((t) => t.taskId.includes('unregistered'))).toBe(false)
  })
})

describe('search', () => {
  const { registry: big } = generateFixture()
  const nav = navFor(big)

  it('finds a task by a word in its objective', () => {
    const target = big.tasks[3]
    const word = target.task_id.split('-').pop() as string
    const hits = searchTasks(nav, word, big.nodes)
    expect(hits.map((h) => h.taskId)).toContain(target.task_id)
  })

  it('finds a task by a session id, including a retired one in its lineage', () => {
    const target = big.tasks.find((t) => t.session_lineage.length > 1) as RegistryTask
    const hits = searchTasks(nav, target.session_lineage[0], big.nodes)
    expect(hits.map((h) => h.taskId)).toContain(target.task_id)
  })

  it('finds a task by a node title without treating the title as an identity', () => {
    const hits = searchTasks(nav, COLLIDING_WORKER_TITLE, big.nodes)
    // Two different tasks carry a node with this exact title, so a search must return both rather
    // than resolving "the" node with that name.
    expect(hits.length).toBeGreaterThan(1)
    expect(new Set(hits.map((h) => h.taskId)).size).toBe(hits.length)
  })

  it('is case-insensitive and answers an empty query with nothing', () => {
    expect(searchTasks(nav, 'WEB-APP', big.nodes).length).toBeGreaterThan(0)
    expect(searchTasks(nav, '   ', big.nodes)).toEqual([])
  })

  it('survives a unicode title', () => {
    expect(searchTasks(nav, UNICODE_LONG_TITLE.slice(0, 12), big.nodes).length).toBeGreaterThanOrEqual(0)
  })
})

describe('sort', () => {
  const { registry: big } = generateFixture()
  const nav = navFor(big)

  it('puts what needs someone first when sorting by stage', () => {
    const sorted = sortTasks(nav.tasks, 'stage')
    expect(['waiting-operator', 'blocked']).toContain(sorted[0].stage)
    expect(['done', 'abandoned']).toContain(sorted[sorted.length - 1].stage)
  })

  it('sorts unknown ages last rather than treating them as fresh', () => {
    const rows = sortTasks(nav.tasks, 'freshness')
    const ages = rows.map((r) => r.owner.freshness.observationAgeS)
    const firstUnknown = ages.indexOf(null)
    if (firstUnknown !== -1) expect(ages.slice(firstUnknown).every((a) => a === null)).toBe(true)
  })

  it('is stable and does not mutate its input', () => {
    const before = nav.tasks.map((t) => t.taskId)
    const once = sortTasks(nav.tasks, 'project').map((t) => t.taskId)
    const twice = sortTasks(nav.tasks, 'project').map((t) => t.taskId)
    expect(once).toEqual(twice)
    expect(nav.tasks.map((t) => t.taskId)).toEqual(before)
  })
})

describe('pin and promote are intents, never writes', () => {
  it('describes the write without performing one', () => {
    const before = JSON.stringify(registry())
    const doc = registry()
    const nav = navFor(doc)
    expect(pinIntent('t1')).toEqual({ action: 'pin', target: 'task', taskId: 't1' })
    expect(promoteWorkerIntent('term-w1', 't1')).toEqual({
      action: 'promote',
      target: 'node',
      nodeId: 'term-w1',
      taskId: 't1'
    })
    expect(JSON.stringify(doc)).toBe(before)
    expect(nav.tasksById.t1.pinned).toBe(false)
  })
})

describe('view preferences are display-local and hostile-input tolerant', () => {
  it('falls back to the defaults for anything unrecognized', () => {
    expect(normalizeViewPrefs(null)).toEqual(DEFAULT_VIEW_PREFS)
    expect(normalizeViewPrefs('nonsense')).toEqual(DEFAULT_VIEW_PREFS)
    expect(normalizeViewPrefs([])).toEqual(DEFAULT_VIEW_PREFS)
    expect(normalizeViewPrefs({ view: 'constructor', sort: { key: '__proto__' } })).toEqual(DEFAULT_VIEW_PREFS)
  })

  it('keeps values it recognizes', () => {
    expect(
      normalizeViewPrefs({ version: 99, view: 'active', sort: { key: 'stage', direction: 'desc' }, collapseWorkers: false })
    ).toEqual({ version: 1, view: 'active', sort: { key: 'stage', direction: 'desc' }, collapseWorkers: false })
  })
})

describe('small helpers', () => {
  it('formats ages at every scale', () => {
    expect(formatAge(0)).toBe('0s')
    expect(formatAge(59)).toBe('59s')
    expect(formatAge(600)).toBe('10m')
    expect(formatAge(3600)).toBe('1h')
    expect(formatAge(3660)).toBe('1h 1m')
    expect(formatAge(90000)).toBe('1d 1h')
    expect(formatAge(-5)).toBe('0s')
  })

  it('parses an ISO instant with an offset, and refuses anything else', () => {
    expect(isoToEpoch('2026-09-04T22:31:12-04:00')).toBe(BASE)
    expect(isoToEpoch('not a date')).toBeNull()
    expect(isoToEpoch(null)).toBeNull()
  })

  it('sanitizes a node id into a tmux session name', () => {
    expect(navSessionName('term-a1-b2')).toBe('nt-term-a1-b2')
    expect(navSessionName('a b;c')).toBe('nt-a_b_c')
  })
})

describe('buildAttentionRows on an empty input', () => {
  it('returns no rows rather than throwing', () => {
    expect(buildAttentionRows([], [])).toEqual([])
  })
})
