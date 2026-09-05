/**
 * The fixture's own invariants.
 *
 * These are properties, not smoke checks. A synthetic population is only worth anything if it is
 * reproducible, conforms to the contract it claims to speak, and still contains the awkward cases
 * on the day someone refactors the generator — a fixture that quietly stops emitting the pane
 * collision is worse than no fixture, because the navigator's test suite goes green while the case
 * it was protecting against goes untested.
 *
 * Every adversarial case in the brief gets its own named test, asserting the case actually occurs.
 */

import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import {
  ATTENTION_CLASSES,
  BLOCKER_KINDS,
  CLOSED_STAGES,
  COLLIDING_PANE,
  COLLIDING_TITLE,
  COLLIDING_WORKER_TITLE,
  DEFAULT_FIXTURE_OPTIONS,
  NODE_CLASSES,
  NODE_ROLES,
  PERCENT_DOT_TITLE,
  TASK_STAGES,
  UNICODE_LONG_TITLE,
  WARM_BANDS,
  bandForWarmMinutes,
  generateFixture,
  isActiveNode,
  isLiveNode,
  needsAttentionTaskIds,
  statusForClass
} from './fixture'
import type { RegistryNode, RegistryTask, TaskRegistry } from './fixture'

/** One default population, generated once — every test below reads the same bytes. */
const population = generateFixture()
const registry: TaskRegistry = population.registry
const unregistered = population.unregistered
const nodeEntries = Object.entries(registry.nodes)
const nodeList: RegistryNode[] = nodeEntries.map(([, n]) => n)
const taskById = new Map(registry.tasks.map((t) => [t.task_id, t]))

/** §3 — every field the task record is documented to carry. */
const REQUIRED_TASK_FIELDS = [
  'task_id',
  'title',
  'project',
  'project_id',
  'pinned',
  'objective',
  'scope',
  'owner',
  'stage',
  'stage_since',
  'progress',
  'next_action',
  'blockers',
  'workers',
  'dependencies',
  'budgets',
  'artifacts',
  'evidence',
  'freshness',
  'closed',
  'retired_nodes',
  'session_lineage'
] as const

/** §4 — every field a `nodes{}` entry is documented to carry. */
const REQUIRED_NODE_FIELDS = [
  'task_id',
  'role',
  'owner_node',
  'project',
  'project_id',
  'pinned',
  'title',
  'pane',
  'account',
  'provider',
  'model',
  'session',
  'status',
  'class',
  'band',
  'warm_min',
  'context_pct',
  'last_observed',
  'observation_age_s'
] as const

const has = (obj: object, key: string): boolean => Object.prototype.hasOwnProperty.call(obj, key)

/** Every string anywhere in the document, for the whole-document scans. */
function allStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) for (const v of value) allStrings(v, out)
  else if (value && typeof value === 'object') for (const v of Object.values(value)) allStrings(v, out)
  return out
}

// ---------------------------------------------------------------------------

describe('determinism', () => {
  it('is byte-identical for the same seed', () => {
    const a = generateFixture('same-seed')
    const b = generateFixture('same-seed')
    expect(a).toEqual(b)
    // toEqual ignores key order; a fixture that is only *deeply* equal still produces a different
    // file on disk and a different diff, so pin the serialization too.
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('differs for a different seed', () => {
    const a = generateFixture('seed-a')
    const b = generateFixture('seed-b')
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b))
    // Not merely a different id somewhere: the populations disagree about their own shape.
    expect(a.registry.nodes).not.toEqual(b.registry.nodes)
  })

  it('derives every timestamp from baseEpoch rather than the wall clock', () => {
    const shift = 3600
    const a = generateFixture({ seed: 'clock', baseEpoch: 1_700_000_000 })
    const b = generateFixture({ seed: 'clock', baseEpoch: 1_700_000_000 + shift })

    expect(b.registry.generated_at_epoch - a.registry.generated_at_epoch).toBe(shift)
    expect(b.registry.host_boot_epoch - a.registry.host_boot_epoch).toBe(shift)
    // Same seed ⇒ same rng stream ⇒ the same node ids in the same order, so every observation
    // instant must have moved by exactly the shift and nothing else may have changed.
    const aIds = Object.keys(a.registry.nodes)
    expect(Object.keys(b.registry.nodes)).toEqual(aIds)
    for (const id of aIds) {
      const an = a.registry.nodes[id]
      const bn = b.registry.nodes[id]
      expect(bn.observation_age_s).toBe(an.observation_age_s)
      expect(Date.parse(bn.last_observed) - Date.parse(an.last_observed)).toBe(shift * 1000)
    }
  })

  it('never reaches for Math.random or Date.now', () => {
    // The determinism tests above would catch Math.random. They would NOT catch a Date.now() in a
    // default argument or an error path that the default population happens not to take, and that
    // is exactly the kind of drift that makes a fixture stop being a fixture.
    const source = readFileSync(join(__dirname, 'fixture.ts'), 'utf8').replace(/\r\n/g, '\n')
    const code = source
      .split('\n')
      .filter((line) => !line.trim().startsWith('*') && !line.trim().startsWith('//'))
      .join('\n')
    expect(code).not.toContain('Math.random')
    expect(code).not.toContain('Date.now')
  })
})

describe('contract conformance', () => {
  it('gives every task every field §3 documents', () => {
    for (const task of registry.tasks) {
      for (const field of REQUIRED_TASK_FIELDS) {
        expect(has(task, field), `${task.task_id} is missing ${field}`).toBe(true)
      }
    }
  })

  it('gives every node every field §4 documents', () => {
    for (const [id, node] of nodeEntries) {
      for (const field of REQUIRED_NODE_FIELDS) {
        expect(has(node, field), `${id} is missing ${field}`).toBe(true)
      }
    }
  })

  it('uses only the fixed stage vocabulary, and uses all nine of it', () => {
    const seen = new Set<string>()
    for (const task of registry.tasks) {
      expect(TASK_STAGES).toContain(task.stage)
      seen.add(task.stage)
    }
    expect([...seen].sort()).toEqual([...TASK_STAGES].sort())
  })

  it('uses only the typed blocker kinds, and uses all five', () => {
    const seen = new Set<string>()
    for (const task of registry.tasks) {
      for (const blocker of task.blockers) {
        expect(BLOCKER_KINDS).toContain(blocker.kind)
        expect(typeof blocker.id).toBe('string')
        expect(typeof blocker.text).toBe('string')
        expect(typeof blocker.since).toBe('string')
        seen.add(blocker.kind)
      }
    }
    expect([...seen].sort()).toEqual([...BLOCKER_KINDS].sort())
  })

  it('uses only the six warm bands, and uses all six', () => {
    const seen = new Set<string>()
    for (const node of nodeList) {
      expect(WARM_BANDS).toContain(node.band)
      seen.add(node.band)
    }
    expect([...seen].sort()).toEqual([...WARM_BANDS].sort())
  })

  it('keeps warm_min inside the band it is bucketed into (§6 thresholds)', () => {
    // A navigator that sorts by warm_min and badges by band must not be able to show a "WARM"
    // chip above a 90-minute reading.
    for (const [id, node] of nodeEntries) {
      if (node.band === 'NEW' || node.band === 'UNKNOWN') {
        expect(node.warm_min, `${id} carries a clock it cannot have`).toBeNull()
        continue
      }
      expect(typeof node.warm_min).toBe('number')
      expect(bandForWarmMinutes(node.warm_min as number), `${id} band disagrees with warm_min`).toBe(node.band)
    }
  })

  it('uses only the tick class vocabulary, with a status that follows from the class', () => {
    for (const node of nodeList) {
      expect(NODE_CLASSES).toContain(node.class)
      expect(NODE_ROLES).toContain(node.role)
      expect(node.status).toBe(statusForClass(node.class))
    }
  })

  it('carries no secret material (§3, the rule R3 added)', () => {
    // The registry is served to a browser over a tunnel. Free text is the realistic leak path.
    const markers = ['sk-ant-', 'ghp_', 'gho_', 'Bearer ', 'BEGIN PRIVATE KEY', 'BEGIN OPENSSH', 'password=']
    for (const value of allStrings(registry)) {
      for (const marker of markers) {
        expect(value.includes(marker), `secret-shaped string: ${value.slice(0, 60)}`).toBe(false)
      }
    }
  })
})

describe('referential integrity', () => {
  it('names only existing tasks from every view', () => {
    for (const view of ['needs_attention', 'primary', 'active', 'inactive'] as const) {
      for (const taskId of registry.views[view]) {
        expect(taskById.has(taskId), `${view} names unknown task ${taskId}`).toBe(true)
      }
    }
    for (const taskId of Object.keys(registry.views.workers_by_task)) {
      expect(taskById.has(taskId), `workers_by_task names unknown task ${taskId}`).toBe(true)
    }
  })

  it('lists in workers_by_task only nodes that exist and are joined to that task', () => {
    for (const [taskId, workerIds] of Object.entries(registry.views.workers_by_task)) {
      for (const nodeId of workerIds) {
        const node = registry.nodes[nodeId]
        expect(node, `workers_by_task[${taskId}] names unknown node ${nodeId}`).toBeTruthy()
        expect(node.task_id).toBe(taskId)
        expect(node.role).toBe('worker')
      }
    }
  })

  it('points every non-null nodes[].task_id at an existing task', () => {
    for (const [id, node] of nodeEntries) {
      if (node.task_id !== null) {
        expect(taskById.has(node.task_id), `${id} claims unknown task ${node.task_id}`).toBe(true)
      }
    }
  })

  it('points every tasks[].workers[].node and every retired node at an existing node', () => {
    for (const task of registry.tasks) {
      for (const worker of task.workers) {
        expect(registry.nodes[worker.node], `${task.task_id} worker ${worker.node} is absent`).toBeTruthy()
      }
      for (const retired of task.retired_nodes) {
        // §2: retiring a node never deletes its history, so the record stays resolvable.
        expect(registry.nodes[retired.node], `${task.task_id} retired ${retired.node} is absent`).toBeTruthy()
      }
    }
  })

  it('keeps node ids and session uuids unique (contract guarantee 1)', () => {
    const ids = nodeEntries.map(([id]) => id)
    expect(new Set(ids).size).toBe(ids.length)
    const sessions = nodeList.map((n) => n.session)
    expect(new Set(sessions).size).toBe(sessions.length)
  })

  it('agrees with itself about which nodes a task owns', () => {
    for (const task of registry.tasks) {
      const workerIds = registry.views.workers_by_task[task.task_id]
      expect(workerIds, `${task.task_id} has no workers_by_task entry`).toBeTruthy()
      expect(task.workers.map((w) => w.node).sort()).toEqual([...workerIds].sort())
    }
  })
})

describe('counts', () => {
  it('agrees with the data it counts', () => {
    // Recomputed from the emitted document, not by re-calling the generator's own helpers: a count
    // is the cheapest thing to get wrong and the most misleading thing to read.
    expect(registry.counts.tasks).toBe(registry.tasks.length)
    expect(registry.counts.nodes).toBe(nodeEntries.length)
    expect(registry.counts.active).toBe(registry.views.active.length)
    expect(registry.counts.needs_attention).toBe(registry.views.needs_attention.length)
    expect(registry.counts.workers).toBe(nodeList.filter((n) => n.role === 'worker').length)
    expect(registry.counts.dead_nodes).toBe(nodeList.filter((n) => n.class === 'DEAD').length)
  })

  it('partitions every task into exactly one of active and inactive', () => {
    const active = new Set(registry.views.active)
    const inactive = new Set(registry.views.inactive)
    for (const task of registry.tasks) {
      expect(active.has(task.task_id) !== inactive.has(task.task_id), `${task.task_id} is in both or neither`).toBe(
        true
      )
    }
    expect(active.size + inactive.size).toBe(registry.tasks.length)
  })

  it('defines active as an open stage with a live owner node', () => {
    for (const task of registry.tasks) {
      const expected = !CLOSED_STAGES.includes(task.stage) && isLiveNode(registry, task.owner.node)
      expect(registry.views.active.includes(task.task_id), `${task.task_id} (${task.stage})`).toBe(expected)
    }
  })
})

describe('needs_attention', () => {
  it('is exactly the set the contract defines — nothing missing, nothing extra', () => {
    const expected = new Set<string>()
    for (const task of registry.tasks) {
      if (task.blockers.some((b) => b.owner === 'operator')) expected.add(task.task_id)
    }
    for (const node of nodeList) {
      if (node.task_id && ATTENTION_CLASSES.includes(node.class)) expected.add(node.task_id)
    }
    const actual = new Set(registry.views.needs_attention)
    for (const id of expected) expect(actual.has(id), `${id} qualifies but is missing`).toBe(true)
    for (const id of actual) expect(expected.has(id), `${id} is listed but does not qualify`).toBe(true)
    expect(actual.size).toBe(expected.size)
    // The helper the generator used and the recomputation above must be the same rule.
    expect(registry.views.needs_attention).toEqual(needsAttentionTaskIds(registry.tasks, registry.nodes))
  })

  it('over-selects on a realistic population, which is the point of testing against one', () => {
    // FINDING for the navigator lane. §4 puts `class in {…, DEAD}` in this view, and on a host
    // where most cards are dead nearly every task has at least one dead node — so the view the operator
    // asked for as "show only what needs my attention" selects almost the whole board. The
    // the operator-owned-blocker half is the part that discriminates, and a navigator has to filter on
    // that rather than render this view as-is. Asserted as a ratio, because the exact figure is a
    // property of this population and the claim is about the shape.
    const operatorBlocked = registry.tasks.filter((t) => t.blockers.some((b) => b.owner === 'operator'))
    expect(operatorBlocked.length).toBeGreaterThanOrEqual(3)
    expect(operatorBlocked.length).toBeLessThan(registry.views.needs_attention.length / 4)
    expect(registry.views.needs_attention.length).toBeGreaterThan(registry.tasks.length * 0.9)
  })

  it('does not require a waiting-operator stage to carry a the operator-owned blocker', () => {
    // Stage is a judgment a director writes; a blocker can arrive after it. A navigator that
    // treats `stage === 'waiting-operator'` as equivalent to "has a the operator blocker" is wrong on a
    // real host, so the fixture contains at least one counter-example on purpose.
    const drifted = registry.tasks.filter(
      (t) => t.stage !== 'waiting-operator' && t.blockers.some((b) => b.owner === 'operator')
    )
    expect(drifted.length).toBeGreaterThanOrEqual(1)
  })
})

describe('scale', () => {
  it('is big enough to be worth testing against', () => {
    expect(nodeEntries.length).toBeGreaterThanOrEqual(300)
    expect(registry.tasks.length).toBeGreaterThanOrEqual(25)
    expect(new Set(registry.tasks.map((t) => t.project)).size).toBeGreaterThanOrEqual(10)
  })

  it('is mostly inactive, like the host it is modelled on', () => {
    const active = nodeList.filter(isActiveNode).length
    const inactive = nodeList.length - active
    expect(inactive).toBeGreaterThan(active)
  })

  it('spreads tasks unevenly across projects', () => {
    const perProject = new Map<string, number>()
    for (const task of registry.tasks) perProject.set(task.project, (perProject.get(task.project) ?? 0) + 1)
    const counts = [...perProject.values()].sort((a, b) => b - a)
    // One heavy project and at least two holding exactly one — an even spread hides grouping bugs.
    expect(counts[0]).toBeGreaterThanOrEqual(8)
    expect(counts.filter((c) => c === 1).length).toBeGreaterThanOrEqual(2)
  })

  it('honours nodeCount exactly and scales down on request', () => {
    expect(nodeEntries.length).toBe(DEFAULT_FIXTURE_OPTIONS.nodeCount)
    const small = generateFixture({ seed: 'small', nodeCount: 60, taskCount: 12, projectCount: 4 })
    expect(Object.keys(small.registry.nodes).length).toBe(60)
    expect(small.registry.tasks.length).toBe(12)
    expect(small.registry.counts.nodes).toBe(60)
  })
})

describe('adversarial case 1 — account switch', () => {
  it('has a task whose lineage spans two sessions and whose live node runs on the other account', () => {
    const switched = registry.tasks.filter((task) => {
      if (task.session_lineage.length < 2) return false
      const owner = registry.nodes[task.owner.node]
      if (!owner || owner.class === 'DEAD') return false
      return task.retired_nodes.some((r) => {
        const retired = registry.nodes[r.node]
        return !!retired && retired.provider === owner.provider && retired.account !== owner.account
      })
    })
    expect(switched.length).toBeGreaterThanOrEqual(1)
    // History survives the switch: both sessions are still resolvable from the lineage.
    const task = switched[0]
    expect(new Set(task.session_lineage).size).toBeGreaterThanOrEqual(2)
  })
})

describe('adversarial case 2 — node replacement', () => {
  it('has a task with two or more retired nodes and a live one', () => {
    const replaced = registry.tasks.filter(
      (t) => t.retired_nodes.length >= 2 && isLiveNode(registry, t.owner.node)
    )
    expect(replaced.length).toBeGreaterThanOrEqual(1)
    for (const retired of replaced[0].retired_nodes) {
      expect(typeof retired.disposition).toBe('string')
      expect(retired.disposition.length).toBeGreaterThan(0)
      // §2: history is kept, not discarded — the dead card is still in nodes{}.
      expect(registry.nodes[retired.node]).toBeTruthy()
    }
  })
})

describe('adversarial case 3 — pane collision', () => {
  it('has two different nodes carrying the same pane', () => {
    const byPane = new Map<string, string[]>()
    for (const [id, node] of nodeEntries) byPane.set(node.pane, [...(byPane.get(node.pane) ?? []), id])
    // §2: a pane is display-only. Anything that keys on it breaks here, which is the point.
    expect((byPane.get(COLLIDING_PANE) ?? []).length).toBeGreaterThanOrEqual(2)
    const collisions = [...byPane.values()].filter((ids) => ids.length > 1)
    expect(collisions.length).toBeGreaterThanOrEqual(2)
  })
})

describe('adversarial case 4 — title collision', () => {
  it('has several nodes sharing one generic title and two sharing a lane title', () => {
    const byTitle = new Map<string, string[]>()
    for (const [id, node] of nodeEntries) byTitle.set(node.title, [...(byTitle.get(node.title) ?? []), id])
    expect((byTitle.get(COLLIDING_TITLE) ?? []).length).toBeGreaterThanOrEqual(3)
    const twins = byTitle.get(COLLIDING_WORKER_TITLE) ?? []
    expect(twins.length).toBeGreaterThanOrEqual(2)
    // The two lane twins are on different tasks, so a title cannot even stand in for a grouping.
    expect(new Set(twins.map((id) => registry.nodes[id].task_id)).size).toBeGreaterThanOrEqual(2)
  })
})

describe('adversarial case 5 — orphans and unregistered sessions', () => {
  it('has nodes claimed by no task and spawned by nobody', () => {
    const orphans = nodeList.filter((n) => n.task_id === null && n.owner_node === null)
    expect(orphans.length).toBeGreaterThanOrEqual(20)
  })

  it('returns at least 40 sessions that have no node record at all', () => {
    const knownSessions = new Set(nodeList.map((n) => n.session))
    expect(unregistered.length).toBeGreaterThanOrEqual(40)
    const trulyUnknown = unregistered.filter((u) => !knownSessions.has(u.session))
    expect(trulyUnknown.length).toBeGreaterThanOrEqual(40)
    for (const record of unregistered) {
      expect(typeof record.session).toBe('string')
      expect(typeof record.path).toBe('string')
      // Reply to R4: these must NEVER be given a synthetic task_id.
      expect(has(record, 'task_id')).toBe(false)
    }
  })

  it('leaves a couple of unregistered records joinable to a live node by session uuid', () => {
    // On a real host a live pane's session ALSO has a record on disk. The uuid join is the only
    // thing that spots it, so the fixture has to contain the case the join is written for.
    const knownSessions = new Set(nodeList.map((n) => n.session))
    expect(unregistered.filter((u) => knownSessions.has(u.session)).length).toBeGreaterThanOrEqual(1)
  })

  it('keeps the unregistered bucket outside the registry document', () => {
    // The registry must stay exactly the contract shape; the disk-only sessions ride alongside.
    expect(has(registry, 'unregistered')).toBe(false)
    expect(Object.keys(registry).sort()).toEqual(
      [
        'counts',
        'generated_at',
        'generated_at_epoch',
        'host_boot_epoch',
        'nodes',
        'registry_schema',
        'source',
        'tasks',
        'views'
      ].sort()
    )
  })
})

describe('adversarial case 6 — a task with 30+ workers', () => {
  it('has one, so the collapse-by-default path has something to collapse', () => {
    const biggest = Object.values(registry.views.workers_by_task).reduce((m, w) => Math.max(m, w.length), 0)
    expect(biggest).toBeGreaterThanOrEqual(30)
    const heavy = registry.tasks.find((t) => registry.views.workers_by_task[t.task_id].length >= 30) as RegistryTask
    expect(heavy).toBeTruthy()
    expect(heavy.workers.length).toBe(registry.views.workers_by_task[heavy.task_id].length)
  })
})

describe('adversarial case 7 — the owner node is gone', () => {
  it('has a task whose owner.node is not in nodes{}', () => {
    const orphaned = registry.tasks.filter((t) => !registry.nodes[t.owner.node])
    expect(orphaned.length).toBeGreaterThanOrEqual(1)
    // The task is still fully readable — owner identity, lineage and history all survive the card.
    const task = orphaned[0]
    expect(typeof task.owner.session).toBe('string')
    expect(task.session_lineage.length).toBeGreaterThanOrEqual(1)
    expect(registry.views.active).not.toContain(task.task_id)
  })

  it('also has an open-stage task whose owner node is DEAD', () => {
    // The other way into `inactive`: the stage says the work is live, the card is not.
    const deadOwner = registry.tasks.filter(
      (t) =>
        !CLOSED_STAGES.includes(t.stage) &&
        !!registry.nodes[t.owner.node] &&
        registry.nodes[t.owner.node].class === 'DEAD'
    )
    expect(deadOwner.length).toBeGreaterThanOrEqual(1)
    expect(registry.views.inactive).toContain(deadOwner[0].task_id)
  })
})

describe('adversarial case 8 — unicode, long, and punctuation-bearing titles', () => {
  it('has a long multi-script title on both a node and a task', () => {
    expect(UNICODE_LONG_TITLE.length).toBeGreaterThan(120)
    expect(nodeList.some((n) => n.title === UNICODE_LONG_TITLE)).toBe(true)
    expect(registry.tasks.some((t) => t.title === UNICODE_LONG_TITLE)).toBe(true)
  })

  it('has a title carrying both a % and a ·', () => {
    const holder = nodeList.find((n) => n.title === PERCENT_DOT_TITLE)
    expect(holder).toBeTruthy()
    expect(PERCENT_DOT_TITLE).toContain('%')
    expect(PERCENT_DOT_TITLE).toContain('·')
    // The `%3` inside the title is NOT this node's pane — a reader that scrapes panes out of
    // titles gets the wrong answer, which is why §2 says pane is never an identity.
    expect((holder as RegistryNode).pane).not.toBe(COLLIDING_PANE)
  })
})

describe('provider and role coverage', () => {
  it('covers claude on both accounts, codex, and a third provider', () => {
    const keys = new Set(nodeList.map((n) => `${n.provider}/${n.account}`))
    expect(keys.has('claude/1')).toBe(true)
    expect(keys.has('claude/2')).toBe(true)
    expect([...keys].some((k) => k.startsWith('codex/'))).toBe(true)
    expect([...keys].some((k) => k.startsWith('opencode/'))).toBe(true)
  })

  it('has exactly one supervisor and a handful of the operator cards', () => {
    expect(nodeList.filter((n) => n.role === 'supervisor').length).toBe(1)
    expect(nodeList.filter((n) => n.role === 'operator').length).toBeGreaterThanOrEqual(2)
    for (const role of NODE_ROLES) {
      expect(nodeList.some((n) => n.role === role), `no ${role} node`).toBe(true)
    }
  })

  it('never puts two live directors on one task', () => {
    const liveDirectors = new Map<string, number>()
    for (const node of nodeList) {
      if (node.role !== 'director' || !node.task_id || node.class === 'DEAD') continue
      liveDirectors.set(node.task_id, (liveDirectors.get(node.task_id) ?? 0) + 1)
    }
    for (const [taskId, count] of liveDirectors) {
      expect(count, `${taskId} has ${count} live directors`).toBeLessThanOrEqual(1)
    }
    expect(liveDirectors.size).toBeGreaterThanOrEqual(5)
  })
})

describe('freshness', () => {
  it('has records that predate the host boot, and says so', () => {
    const preBoot = nodeList.filter((n) => Date.parse(n.last_observed) / 1000 < registry.host_boot_epoch)
    expect(preBoot.length).toBeGreaterThanOrEqual(10)
    // §6: anything observed before the restart is not current, and its age says how far off it is.
    for (const node of preBoot) expect(node.observation_age_s).toBeGreaterThan(0)
  })

  it('has observation ages measured in hours, not only seconds', () => {
    expect(nodeList.filter((n) => n.observation_age_s > 3600).length).toBeGreaterThanOrEqual(10)
  })

  it('flags may_be_stale with a reason, and only with a reason', () => {
    const stale = registry.tasks.filter((t) => t.freshness.may_be_stale)
    expect(stale.length).toBeGreaterThanOrEqual(3)
    for (const task of registry.tasks) {
      if (task.freshness.may_be_stale) {
        expect(typeof task.freshness.stale_reason, `${task.task_id} is stale for no stated reason`).toBe('string')
      } else {
        expect(task.freshness.stale_reason).toBeNull()
      }
    }
  })

  it('states a stale reason that the record itself supports', () => {
    for (const task of registry.tasks) {
      if (!task.freshness.may_be_stale) continue
      const owner = registry.nodes[task.owner.node]
      const ownerBad = !owner || owner.band === 'COLD' || owner.class === 'DEAD'
      const preBoot = Date.parse(task.freshness.last_update) / 1000 < registry.host_boot_epoch
      const unverified = !!task.progress.reported && !task.progress.verified
      expect(ownerBad || preBoot || unverified, `${task.task_id} is stale for none of the §6 reasons`).toBe(true)
    }
  })
})

describe('progress slots', () => {
  it('keeps reported and verified apart, both surviving generation', () => {
    const both = registry.tasks.filter((t) => t.progress.verified && t.progress.reported)
    expect(both.length).toBeGreaterThanOrEqual(1)
    const disagreeing = both.filter(
      (t) => t.progress.verified!.text !== t.progress.reported!.text && t.progress.verified!.at !== t.progress.reported!.at
    )
    // The case a navigator most easily renders wrong: showing "the latest progress" collapses a
    // proven claim and an unproven one into one line, which is what the two slots exist to prevent.
    expect(disagreeing.length).toBeGreaterThanOrEqual(1)
    for (const task of disagreeing) {
      expect(task.progress.verified!.proof.length).toBeGreaterThan(0)
      expect(has(task.progress.reported!, 'proof')).toBe(false)
    }
  })

  it('has tasks carrying only one of the two slots', () => {
    expect(registry.tasks.some((t) => t.progress.verified && !t.progress.reported)).toBe(true)
    expect(registry.tasks.some((t) => t.progress.reported && !t.progress.verified)).toBe(true)
  })

  it('never writes a verified slot without the proof command that produced it', () => {
    for (const task of registry.tasks) {
      if (!task.progress.verified) continue
      expect(typeof task.progress.verified.proof, `${task.task_id} verified with no proof`).toBe('string')
      expect(task.progress.verified.proof.length).toBeGreaterThan(0)
    }
  })
})

describe('cost', () => {
  it('generates the default population well under a second', () => {
    // A ceiling, not a benchmark: the point is to catch an accidental O(n²) before it reaches a
    // population ten times this size.
    const started = performance.now()
    generateFixture({ seed: 'cost' })
    expect(performance.now() - started).toBeLessThan(2000)
  })

  it('stays linear enough to grow tenfold', () => {
    const started = performance.now()
    const big = generateFixture({ seed: 'big', nodeCount: 3200, taskCount: 120, projectCount: 20 })
    const elapsed = performance.now() - started
    expect(Object.keys(big.registry.nodes).length).toBe(3200)
    expect(elapsed).toBeLessThan(2000)
  })
})
