/**
 * A large, deterministic, deliberately messy synthetic session population in the shape of the
 * shared task registry's `registry.json` projection.
 *
 * WHY THIS EXISTS. The remote navigator has to let the operator find one task among hundreds of
 * sessions from a phone. Tonight's host holds 11 live tmux panes against 486 + 60 Claude
 * `sessions/<pid>.json` records and 874 Codex rollouts — so a navigator tested only against the
 * live panes is tested against 2% of its real input, and the 98% is exactly where it breaks:
 * dead cards, retired nodes, renumbered panes, duplicate titles, sessions no task ever claimed.
 * This module is that population, generated rather than captured so it is reproducible, and
 * parameterised so a test can ask for a smaller one.
 *
 * THE SHAPE is the shared task-registry contract v0.1, sections 2–4 — the interface a supervising
 * tool publishes at `$NODETERM_TASK_REGISTRY`. nodeterm consumes that file and never edits it, and
 * deliberately names no particular supervisor: any producer that emits the contract shape works.
 * Guarantee
 * 2 of the contract says consumers ignore unknown fields and never validate strictly, so the types
 * here are tolerant in the same direction: every record carries an index signature, and every
 * field the contract marks optional is optional here.
 *
 * TWO RULES THE DETERMINISM RESTS ON, both load-bearing:
 *   - no `Math.random()`. The PRNG is a seeded mulberry32; `generateFixture(seed)` twice is
 *     byte-identical, and two seeds differ.
 *   - no `Date.now()`. Every timestamp is derived from `options.baseEpoch` (default
 *     `FIXTURE_BASE_EPOCH`). A fixture whose clock moves is a fixture whose test cannot assert
 *     anything about freshness.
 * A generator that broke either would still pass a smoke test and silently make every downstream
 * assertion a coin flip.
 *
 * `src/shared` is imported by main, renderer and server alike, so this file imports nothing.
 */

// ---------------------------------------------------------------------------
// Fixed vocabularies (contract §3, §4, §6; classes from DESIGN.md §3)
// ---------------------------------------------------------------------------

/** Contract §3 — fixed, and consumers may switch on it exhaustively. */
export const TASK_STAGES = [
  'planned',
  'briefing',
  'building',
  'review',
  'blocked',
  'waiting-operator',
  'verifying',
  'done',
  'abandoned'
] as const
export type TaskStage = (typeof TASK_STAGES)[number]

/** Stages that mean the work is over, whatever its nodes are doing (contract §4 `views.inactive`). */
export const CLOSED_STAGES: readonly TaskStage[] = ['done', 'abandoned']

/** Contract §3 — `blockers[].kind`. */
export const BLOCKER_KINDS = ['approval', 'question', 'dependency', 'failure', 'budget'] as const
export type BlockerKind = (typeof BLOCKER_KINDS)[number]

/** Who a blocker or a next action is parked on. */
export const BLOCKER_OWNERS = ['operator', 'director', 'supervisor', 'worker'] as const
export type BlockerOwner = (typeof BLOCKER_OWNERS)[number]

/** Contract §6 — the warm-clock bands. `warm_min` is the minutes behind them. */
export const WARM_BANDS = ['WARM', 'HEARTBEAT', 'ACT', 'COLD', 'NEW', 'UNKNOWN'] as const
export type WarmBand = (typeof WARM_BANDS)[number]

/**
 * The band a warm-clock reading of `min` minutes falls in (contract §6: WARM < 25 · HEARTBEAT ≥ 25
 * · ACT ≥ 45 · COLD ≥ 60). `NEW` and `UNKNOWN` are not readings — they mean "no clock yet" and
 * "could not read the clock" — so they carry `warm_min: null` and are not derivable from a number.
 */
export function bandForWarmMinutes(min: number): Extract<WarmBand, 'WARM' | 'HEARTBEAT' | 'ACT' | 'COLD'> {
  if (min >= 60) return 'COLD'
  if (min >= 45) return 'ACT'
  if (min >= 25) return 'HEARTBEAT'
  return 'WARM'
}

/** DESIGN.md §3, the tick's classifier, in its own priority order. */
export const NODE_CLASSES = [
  'LIMIT',
  'DEAD',
  'PERMISSION',
  'QUESTION',
  'NEEDS-OPERATOR',
  'DONE',
  'STALLED',
  'BUSY',
  'IDLE'
] as const
export type NodeClass = (typeof NODE_CLASSES)[number]

/** Contract §4 — the classes that put a node's task into `views.needs_attention`. */
export const ATTENTION_CLASSES: readonly NodeClass[] = [
  'LIMIT',
  'PERMISSION',
  'QUESTION',
  'NEEDS-OPERATOR',
  'DEAD'
]

/** Contract §4 — `nodes[].role`. */
export const NODE_ROLES = ['director', 'worker', 'helper', 'supervisor', 'operator', 'unknown'] as const
export type NodeRole = (typeof NODE_ROLES)[number]

/** Contract §3 — `owner.kind`. */
export const OWNER_KINDS = ['director', 'supervisor', 'operator', 'worker'] as const
export type OwnerKind = (typeof OWNER_KINDS)[number]

/** Contract §3 — `freshness.source`. */
export const FRESHNESS_SOURCES = [
  'tick',
  'director-cli',
  'supervisor-cli',
  'gh',
  'loop-registry',
  'operator'
] as const
export type FreshnessSource = (typeof FRESHNESS_SOURCES)[number]

/** Contract §4 — `nodes[].status`, the raw reading behind `class`. */
export type NodeStatus = 'busy' | 'idle' | 'shell'

/** The raw status a class implies. DEAD is precisely "a pane with a shell prompt and no agent". */
export function statusForClass(cls: NodeClass): NodeStatus {
  if (cls === 'DEAD') return 'shell'
  if (cls === 'BUSY' || cls === 'STALLED') return 'busy'
  return 'idle'
}

// ---------------------------------------------------------------------------
// Record types — tolerant by construction (contract guarantee 2)
// ---------------------------------------------------------------------------

/** Extra keys are allowed everywhere: the contract evolves additively and consumers must not care. */
type Extensible = { [key: string]: unknown }

export interface ProgressVerified extends Extensible {
  text: string
  /** The command that was RUN. §3: `verified` may only be written together with a proof. */
  proof: string
  at: string
  by: string
  role: string
}

export interface ProgressReported extends Extensible {
  text: string
  at: string
  by: string
  role: string
}

export interface TaskProgress extends Extensible {
  /** Separate slots. A reported update never clears or overwrites a verified one (§3). */
  verified?: ProgressVerified
  reported?: ProgressReported
}

export interface TaskBlocker extends Extensible {
  id: string
  kind: BlockerKind
  text: string
  owner: BlockerOwner
  since: string
  /** v0.1, optional (reply to R2): which node raised it, so a collapsed worker still surfaces. */
  node?: string
  role?: string
  quote?: string
  suggested?: string
  where?: string
}

export interface TaskWorker extends Extensible {
  node: string
  role: string
  started: string
  state: NodeClass
  band: WarmBand
}

export interface TaskOwner extends Extensible {
  kind: OwnerKind
  node: string
  session: string
  account: string
  provider: string
  model: string
}

export interface RetiredNode extends Extensible {
  node: string
  until: string
  disposition: string
  /** v0.1 (reply to O1): a retired node keeps the canvas it was last seen on. */
  project_id?: string
}

export interface TaskFreshness extends Extensible {
  last_update: string
  source: FreshnessSource
  may_be_stale: boolean
  stale_reason: string | null
}

export interface TaskArtifacts extends Extensible {
  report?: string
  plan?: string
  prs?: Array<{ repo: string; number: number; state: string; checks: string; as_of: string } & Extensible>
}

/** One piece of supporting evidence. The contract names `evidence[]` but does not fix the element
 *  shape, so this one is a documented assumption of ours, not a claim about the contract. */
export interface TaskEvidence extends Extensible {
  kind: 'test' | 'pr' | 'file' | 'command'
  ref: string
  at: string
}

export interface RegistryTask extends Extensible {
  task_id: string
  title: string
  project: string
  /** v0.1 (reply to O1): last known canvas, carried across node replacement. */
  project_id: string
  /** v0.1 (ruling on R1): a pin is shared state in the ledger, cli-owned. */
  pinned: boolean
  objective: string
  scope: string
  owner: TaskOwner
  stage: TaskStage
  stage_since: string
  progress: TaskProgress
  next_action: { text: string; owner: BlockerOwner; since: string } & Extensible
  blockers: TaskBlocker[]
  workers: TaskWorker[]
  dependencies: string[]
  budgets: {
    provider: string
    account: string
    dollars_cap: number | null
    dollars_spent: number
    notes: string
  } & Extensible
  artifacts: TaskArtifacts
  evidence: TaskEvidence[]
  freshness: TaskFreshness
  closed: boolean
  retired_nodes: RetiredNode[]
  session_lineage: string[]
}

export interface RegistryNode extends Extensible {
  /** null for a node the supervisor can see but no task claims (contract §4, reply to R4). */
  task_id: string | null
  role: NodeRole
  /** Mirrored from `node-ownership.json`, never contradicted. null when nothing spawned it. */
  owner_node: string | null
  project: string
  project_id: string
  pinned: boolean
  title: string
  /** Display only. §2: never an identity, never a key. This fixture reuses pane values on purpose. */
  pane: string
  account: string
  provider: string
  model: string
  session: string
  status: NodeStatus
  class: NodeClass
  band: WarmBand
  warm_min: number | null
  context_pct: number | null
  last_observed: string
  observation_age_s: number
}

export interface RegistryViews extends Extensible {
  needs_attention: string[]
  primary: string[]
  active: string[]
  inactive: string[]
  workers_by_task: Record<string, string[]>
}

export interface RegistryCounts extends Extensible {
  tasks: number
  active: number
  needs_attention: number
  nodes: number
  workers: number
  dead_nodes: number
}

export interface TaskRegistry extends Extensible {
  registry_schema: number
  generated_at: string
  generated_at_epoch: number
  source: { file: string; generation: number; ledger_schema: number } & Extensible
  host_boot_epoch: number
  tasks: RegistryTask[]
  nodes: Record<string, RegistryNode>
  views: RegistryViews
  counts: RegistryCounts
}

/**
 * A session that exists on disk but has no node record at all (reply to R4: these are NOT in
 * `nodes{}` and must never be given a synthetic `task_id`). Returned ALONGSIDE the registry so the
 * registry itself stays exactly the contract shape.
 */
export interface UnregisteredSession extends Extensible {
  session: string
  provider: 'claude' | 'codex' | 'opencode'
  account: string | null
  /** Best guess from the record's cwd; often unknown, which is the honest answer. */
  project: string | null
  path: string
  last_modified: string
  last_modified_epoch: number
  size_bytes: number
}

export interface FixturePopulation {
  registry: TaskRegistry
  unregistered: UnregisteredSession[]
}

// ---------------------------------------------------------------------------
// Seeded PRNG — mulberry32 over an FNV-1a hash of the seed
// ---------------------------------------------------------------------------

function hashSeed(seed: string | number): number {
  const s = String(seed)
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

class Rng {
  private state: number

  constructor(seed: string | number) {
    this.state = hashSeed(seed)
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0
    let t = this.state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  /** Uniform integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n)
  }

  /** Uniform integer in [lo, hi]. */
  between(lo: number, hi: number): number {
    return lo + this.int(hi - lo + 1)
  }

  /** One decimal place, so the numbers read like real meter output. */
  decimal(lo: number, hi: number): number {
    return Math.round((lo + this.next() * (hi - lo)) * 10) / 10
  }

  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)]
  }

  chance(p: number): boolean {
    return this.next() < p
  }

  /** Fisher-Yates on a copy — the input is never mutated. */
  shuffled<T>(items: readonly T[]): T[] {
    const out = items.slice()
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(i + 1)
      const tmp = out[i]
      out[i] = out[j]
      out[j] = tmp
    }
    return out
  }

  chars(alphabet: string, length: number): string {
    let out = ''
    for (let i = 0; i < length; i++) out += alphabet[this.int(alphabet.length)]
    return out
  }
}

const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz'
const HEX = '0123456789abcdef'

// ---------------------------------------------------------------------------
// Time — every instant derived from the base, never from the wall clock
// ---------------------------------------------------------------------------

/** 2026-09-04T22:31:12-04:00, the instant the contract's own §4 example is stamped with. */
export const FIXTURE_BASE_EPOCH = 1788575472

/** 39.6 minutes before the base: the last of the four restarts in the contract's §2 story. */
export const FIXTURE_HOST_BOOT_EPOCH = FIXTURE_BASE_EPOCH - 2374

/** America/New_York in September. Fixed rather than looked up: a fixture must not move with a TZ. */
const OFFSET_SECONDS = -4 * 3600

/** ISO-8601 with the fixed offset, e.g. `2026-09-04T22:31:12-04:00`. Seconds resolution. */
export function fixtureIso(epochSeconds: number): string {
  const shifted = new Date((Math.round(epochSeconds) + OFFSET_SECONDS) * 1000)
  return `${shifted.toISOString().slice(0, 19)}-04:00`
}

const MINUTE = 60
const HOUR = 3600

// ---------------------------------------------------------------------------
// Static pools — slugs in the style of the real host
// ---------------------------------------------------------------------------

const PROJECT_SLUGS = [
  'web-app',
  'nodeterm',
  'api-service',
  'design-system',
  'data-pipeline',
  'billing-service',
  'infra-tooling',
  'docs-site',
  'mobile-client',
  'search-index'
] as const

const LANE_SLUGS = [
  'ledger',
  'context',
  'navigator',
  'matrix',
  'persistence',
  'fixture',
  'harness',
  'triage',
  'rollup',
  'audit',
  'schema',
  'migration',
  'digest',
  'intake',
  'probe',
  'sweep',
  'panel',
  'router',
  'indexer',
  'reconcile',
  'budget',
  'handover',
  'watchdog',
  'beacon',
  'mirror',
  'seed',
  'columns',
  'teardown'
] as const

const WORKER_LANE_ROLES = [
  'impl-schema',
  'impl-cli',
  'tests',
  'review',
  'docs',
  'fixture',
  'probe',
  'merge',
  'audit',
  'rollup'
] as const

const CLAUDE_MODELS = ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'] as const
const CODEX_MODELS = ['gpt-5.6-sol', 'gpt-5.6-luna'] as const
const OPENCODE_MODELS = ['opencode/qwen3-coder'] as const

const DISPOSITIONS = [
  'died in the 17:56 power outage',
  'replaced after account switch',
  'killed by the reaper at 6h detached',
  'card closed by the operator',
  'host restart 4 of 4',
  'CLI exited unannounced (OOM)'
] as const

const STALE_REASONS = {
  coldOwner: 'owner node COLD',
  goneOwner: 'owner node gone from the registry',
  preBoot: 'no observation since restart',
  unverified: 'only reported progress, unverified for over an hour'
} as const

// ---------------------------------------------------------------------------
// Adversarial constants — exported so the tests name the same strings we emit
// ---------------------------------------------------------------------------

/** Case 3: panes renumber across restarts, so two live nodes really do carry the same `%N`. */
export const COLLIDING_PANE = '%3'

/** Case 4: a generic title several dead cards share. §2 forbids keying on titles. */
export const COLLIDING_TITLE = 'Terminal 24'

/** Case 4: two nodes on different tasks whose titles are byte-identical. */
export const COLLIDING_WORKER_TITLE = 'lane·worker (opus)'

/** Case 8: a title carrying both a `%` (pane-like, but not a pane) and a `·` separator. */
export const PERCENT_DOT_TITLE = '%3 · reconcile·worker — 92% context · retry 2'

/** Case 8: unicode across three scripts plus an emoji, well past any sensible column width. */
export const UNICODE_LONG_TITLE =
  '📊 data-pipeline·round-17 — réconciliation des enregistrements (v5) · 施設マッピングと再照合 · ' +
  'долгое название для проверки усечения · a tail long enough that every list surface has to decide ' +
  'what to do with it rather than pretending titles are short'

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface FixtureOptions {
  seed?: string | number
  /** Total `nodes{}` entries. Clamped to at least 24 so every category is representable. */
  nodeCount?: number
  /** Clamped to at least 9 so every stage in the fixed vocabulary appears. */
  taskCount?: number
  /** Clamped to at least 3. */
  projectCount?: number
  /** Sessions on disk with no node record, returned alongside the registry. */
  unregisteredCount?: number
  /** Every timestamp is derived from this instant. */
  baseEpoch?: number
}

export const DEFAULT_FIXTURE_OPTIONS: Required<FixtureOptions> = {
  seed: 'remote-nav-v1',
  nodeCount: 320,
  taskCount: 26,
  projectCount: 10,
  unregisteredCount: 48,
  baseEpoch: FIXTURE_BASE_EPOCH
}

const MIN_NODES = 24
const MIN_TASKS = TASK_STAGES.length
const MIN_PROJECTS = 3

function clampInt(value: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(value)))
}

/**
 * Task counts per project, deliberately uneven: one project carries ~8 and two carry exactly 1.
 * An even spread hides bugs — a grouping that silently drops a single-task project, or a list that
 * only ever renders the first page of a heavy one, both look correct against a flat distribution.
 */
export function allocateTasksToProjects(taskCount: number, projectCount: number): number[] {
  const counts = new Array<number>(projectCount).fill(0)
  let left = taskCount

  // Everyone gets one, so no project is invisible.
  for (let i = 0; i < projectCount && left > 0; i++) {
    counts[i] = 1
    left--
  }
  // The heavy project.
  const heavy = Math.min(left, 7)
  counts[0] += heavy
  left -= heavy

  // The remainder lands from index 3 onwards in a fixed descending pattern, so indices 1 and 2 are
  // never topped up and keep exactly one task each.
  const weights = [5, 4, 3, 3, 2, 2, 1, 1]
  let pass = 0
  while (left > 0) {
    let placed = false
    for (let i = 3; i < projectCount && left > 0; i++) {
      const take = Math.min(left, weights[(pass + i) % weights.length])
      counts[i] += take
      left -= take
      placed = true
    }
    if (!placed) {
      // Fewer than four projects: the heavy one absorbs the rest rather than looping forever.
      counts[0] += left
      left = 0
    }
    pass++
  }
  return counts
}

// ---------------------------------------------------------------------------
// Shared predicates — exported so a consumer and its tests agree on one definition
// ---------------------------------------------------------------------------

/**
 * Live = the registry still holds this node and the tick did not classify it DEAD.
 *
 * A COLD node is LIVE. §6 is explicit that COLD is a warm-clock reading, not a death certificate:
 * the process is running and must not be touched, which is a different statement from "gone".
 * Conflating the two is how a navigator offers a resume on a session that no longer exists, and
 * hides one that does.
 */
export function isLiveNode(registry: TaskRegistry, nodeId: string | null | undefined): boolean {
  if (!nodeId) return false
  const node = registry.nodes[nodeId]
  return !!node && node.class !== 'DEAD'
}

/**
 * Active = an agent is in the pane AND the session has spoken inside the warm bar. `UNKNOWN` is
 * not active: we could not read the clock, and a fixture that counts unknowns as working would let
 * a navigator inherit that optimism.
 */
export function isActiveNode(node: RegistryNode): boolean {
  return node.class !== 'DEAD' && node.band !== 'COLD' && node.band !== 'UNKNOWN'
}

/**
 * Contract §4, read literally: a task needs attention when any blocker is owned by `operator`, or
 * any node joined to it is classed LIMIT | PERMISSION | QUESTION | NEEDS-OPERATOR | DEAD.
 *
 * The DEAD clause is what makes this large on a realistic population — see the report. It is
 * implemented as written rather than narrowed, because narrowing a contract in a fixture is how a
 * consumer ends up testing against a rule nobody else implements.
 */
export function needsAttentionTaskIds(tasks: RegistryTask[], nodes: Record<string, RegistryNode>): string[] {
  const flagged = new Set<string>()
  for (const task of tasks) {
    if (task.blockers.some((b) => b.owner === 'operator')) flagged.add(task.task_id)
  }
  for (const node of Object.values(nodes)) {
    if (node.task_id && ATTENTION_CLASSES.includes(node.class)) flagged.add(node.task_id)
  }
  return tasks.filter((t) => flagged.has(t.task_id)).map((t) => t.task_id)
}

// ---------------------------------------------------------------------------
// The generator
// ---------------------------------------------------------------------------

interface NodeSpec {
  taskIndex: number | null
  role: NodeRole
  cls: NodeClass
  band: WarmBand
  title?: string
  pane?: string
  ownerNode?: string | null
  provider?: 'claude' | 'codex' | 'opencode'
  account?: string
  project?: string
  projectId?: string
  session?: string
  preBoot?: boolean
  pinned?: boolean
}

/** Indices of the tasks the deliberately adversarial cases are attached to. */
const MEGA_TASK_INDEX = 2 // case 6: 30+ workers
const REPLACED_TASK_INDEX = 3 // case 2: two retired nodes plus a live one
const ACCOUNT_SWITCH_TASK_INDEX = 6 // case 1: lineage of 2, current node on the other account
const MISSING_OWNER_TASK_INDEX = 8 // case 7: owner.node absent from nodes{}
// An open stage whose owner node is DEAD, so the "no live owner" branch of `views.inactive` is
// exercised by something other than a closed stage. It must sit OUTSIDE indices 0..8: those nine
// carry the stage vocabulary one apiece, and overwriting one silently drops a stage from the
// population (it dropped `blocked` the first time this was written).
const DEAD_OWNER_TASK_INDEX = 11

export function generateFixture(options: FixtureOptions | string | number = {}): FixturePopulation {
  const opts: Required<FixtureOptions> = {
    ...DEFAULT_FIXTURE_OPTIONS,
    ...(typeof options === 'object' ? options : { seed: options })
  }
  const rng = new Rng(opts.seed)
  const base = Math.round(opts.baseEpoch)
  const hostBoot = base - (FIXTURE_BASE_EPOCH - FIXTURE_HOST_BOOT_EPOCH)
  const nodeCount = Math.max(MIN_NODES, Math.round(opts.nodeCount))
  const taskCount = Math.max(MIN_TASKS, Math.round(opts.taskCount))
  const projectCount = Math.max(MIN_PROJECTS, Math.round(opts.projectCount))

  // --- ids, kept unique for the life of one population (contract guarantee 1) ---------------
  const usedNodeIds = new Set<string>()
  const usedSessions = new Set<string>()

  const newNodeId = (): string => {
    for (;;) {
      const id = `term-${rng.chars(BASE36, 8)}-${rng.chars(HEX, 8)}`
      if (!usedNodeIds.has(id)) {
        usedNodeIds.add(id)
        return id
      }
    }
  }
  const newSession = (): string => {
    for (;;) {
      const id = `${rng.chars(HEX, 8)}-${rng.chars(HEX, 4)}-4${rng.chars(HEX, 3)}-${
        '89ab'[rng.int(4)]
      }${rng.chars(HEX, 3)}-${rng.chars(HEX, 12)}`
      if (!usedSessions.has(id)) {
        usedSessions.add(id)
        return id
      }
    }
  }

  // --- projects ------------------------------------------------------------------------------
  const projects = Array.from({ length: projectCount }, (_, i) => {
    const slug = i < PROJECT_SLUGS.length ? PROJECT_SLUGS[i] : `${PROJECT_SLUGS[i % PROJECT_SLUGS.length]}-${i}`
    return { slug, projectId: `project-${rng.chars(BASE36, 8)}-${rng.chars(HEX, 8)}` }
  })

  // --- task skeletons ------------------------------------------------------------------------
  const perProject = allocateTasksToProjects(taskCount, projectCount)
  const skeletons: Array<{ taskId: string; projectIndex: number; stage: TaskStage; title: string }> = []
  const usedTaskIds = new Set<string>()
  let laneCursor = 0
  for (let p = 0; p < projectCount; p++) {
    for (let k = 0; k < perProject[p]; k++) {
      const lane = LANE_SLUGS[laneCursor % LANE_SLUGS.length]
      laneCursor++
      let taskId = `${projects[p].slug}-${lane}`
      let disambiguator = 2
      while (usedTaskIds.has(taskId)) {
        taskId = `${projects[p].slug}-${lane}-${disambiguator++}`
      }
      usedTaskIds.add(taskId)
      skeletons.push({
        taskId,
        projectIndex: p,
        stage: 'planned',
        title: `${projects[p].slug} · ${lane}`
      })
    }
  }
  // Stages: the first nine cover the whole vocabulary exactly once, so no test can pass on a
  // population that quietly dropped one. Everything after is weighted towards the closed end,
  // because most of a real host is finished work.
  const tailStages: TaskStage[] = [
    'done',
    'done',
    'done',
    'abandoned',
    'building',
    'review',
    'waiting-operator',
    'blocked',
    'verifying',
    'briefing'
  ]
  skeletons.forEach((s, i) => {
    s.stage = i < TASK_STAGES.length ? TASK_STAGES[i] : rng.pick(tailStages)
  })
  // Three extra `waiting-operator` tasks so the badge that matters most is not a single sample.
  for (const i of [9, 10]) if (i < skeletons.length) skeletons[i].stage = 'waiting-operator'
  // The dead-owner case needs an OPEN stage; it lives past the vocabulary block, and is simply
  // absent from a population too small to hold it (the tests assert it on the default).
  const deadOwnerTaskIndex = DEAD_OWNER_TASK_INDEX < skeletons.length ? DEAD_OWNER_TASK_INDEX : -1
  if (deadOwnerTaskIndex >= 0) skeletons[deadOwnerTaskIndex].stage = 'building'
  const megaTaskIndex = Math.min(MEGA_TASK_INDEX, skeletons.length - 1)
  const replacedTaskIndex = Math.min(REPLACED_TASK_INDEX, skeletons.length - 1)
  const switchTaskIndex = Math.min(ACCOUNT_SWITCH_TASK_INDEX, skeletons.length - 1)
  const missingOwnerTaskIndex = Math.min(MISSING_OWNER_TASK_INDEX, skeletons.length - 1)
  // Long/unicode titles on two tasks (case 8 reaches the task list, not only the node list).
  if (skeletons.length > 4) skeletons[4].title = UNICODE_LONG_TITLE
  if (skeletons.length > 5) skeletons[5].title = `${skeletons[5].title} — 100% of the ledger·rows`

  // --- node budget ---------------------------------------------------------------------------
  // Every category below is a fixed count; the ordinary spread workers are what is left over and
  // are added LAST, so `counts.nodes` is exactly `nodeCount` no matter which adversarial cases a
  // given population is big enough to hold. Deriving the worker count up front instead was off by
  // the six hand-placed adversarial nodes, which is the kind of drift a fixture must not have.
  const directorNodeCount = clampInt(nodeCount * 0.03, 1, Math.max(1, taskCount))
  const operatorNodeCount = clampInt(nodeCount * 0.0125, 1, 8)
  const orphanNodeCount = clampInt(nodeCount * 0.125, 1, nodeCount)
  const helperNodeCount = clampInt(nodeCount * 0.045, 1, nodeCount)
  const unknownNodeCount = clampInt(nodeCount * 0.025, 1, nodeCount)
  const retiredNodeCount = clampInt(nodeCount * 0.0625, 3, nodeCount)
  const megaWorkerCount = Math.min(34, Math.max(1, Math.floor(nodeCount * 0.11)))

  // --- node materialisation --------------------------------------------------------------------
  const nodes: Record<string, RegistryNode> = {}
  const nodeIdsInOrder: string[] = []
  const nodesByTask = new Map<number, string[]>()

  const addNode = (spec: NodeSpec): string => {
    const id = newNodeId()
    const skeleton = spec.taskIndex === null ? null : skeletons[spec.taskIndex]
    const projectIndex = skeleton ? skeleton.projectIndex : rng.int(projectCount)
    const project = spec.project ?? projects[projectIndex].slug
    const projectId = spec.projectId ?? projects[projectIndex].projectId
    const provider = spec.provider ?? (rng.chance(0.72) ? 'claude' : 'codex')
    const account =
      spec.account ?? (provider === 'claude' ? (rng.chance(0.55) ? '2' : '1') : provider === 'codex' ? '1' : 'none')
    const model =
      provider === 'claude' ? rng.pick(CLAUDE_MODELS) : provider === 'codex' ? rng.pick(CODEX_MODELS) : OPENCODE_MODELS[0]

    const warmMin = spec.band === 'NEW' || spec.band === 'UNKNOWN' ? null : warmMinutesFor(rng, spec.band)
    // A pre-boot observation is the §6 case a consumer must distrust: the last look at this pane
    // happened before the host restarted, so nothing about it is current.
    const ageSeconds = spec.preBoot
      ? base - hostBoot + rng.between(3 * MINUTE, 5 * HOUR)
      : spec.cls === 'DEAD'
        ? rng.between(4 * MINUTE, 3 * HOUR)
        : rng.between(2, 4 * MINUTE)

    nodes[id] = {
      task_id: skeleton ? skeleton.taskId : null,
      role: spec.role,
      owner_node: spec.ownerNode === undefined ? null : spec.ownerNode,
      project,
      project_id: projectId,
      pinned: spec.pinned ?? false,
      title: spec.title ?? defaultTitle(rng, spec, skeleton?.taskId),
      pane: spec.pane ?? `%${rng.between(0, 59)}`,
      account,
      provider,
      model,
      session: spec.session ?? newSession(),
      status: statusForClass(spec.cls),
      class: spec.cls,
      band: spec.band,
      warm_min: warmMin,
      context_pct: spec.cls === 'DEAD' ? null : rng.decimal(2, 97),
      last_observed: fixtureIso(base - ageSeconds),
      observation_age_s: ageSeconds
    }
    nodeIdsInOrder.push(id)
    if (spec.taskIndex !== null) {
      const list = nodesByTask.get(spec.taskIndex) ?? []
      list.push(id)
      nodesByTask.set(spec.taskIndex, list)
    }
    return id
  }

  // 1. the supervisor — exactly one, ever.
  const supervisorNodeId = addNode({
    taskIndex: null,
    role: 'supervisor',
    cls: 'BUSY',
    band: 'WARM',
    provider: 'claude',
    account: '2',
    title: 'supervisor (opus)',
    pane: '%141',
    ownerNode: null
  })

  // 2. directors — at most one per task, so "≤1 live director per task" holds by construction.
  //    The account-switch and dead-owner tasks are excluded because each gets its own hand-placed
  //    director below; without the exclusion the switch task would carry two LIVE directors, which
  //    is precisely the state that rule forbids.
  const handPlacedDirectorTasks = new Set([switchTaskIndex, deadOwnerTaskIndex, replacedTaskIndex])
  const directorCandidates = Array.from({ length: skeletons.length }, (_, i) => i).filter(
    (i) => !handPlacedDirectorTasks.has(i)
  )
  // Open lanes first. Picking uniformly put most directors on finished tasks, where they are DEAD
  // by construction, and left the population with three live directors instead of the ~10 a host
  // running ten lanes actually has — a shape a navigator's "show me the directors" view would then
  // be tested against and pass on.
  const directorTaskIndices = [
    ...rng.shuffled(directorCandidates.filter((i) => !CLOSED_STAGES.includes(skeletons[i].stage))),
    ...rng.shuffled(directorCandidates.filter((i) => CLOSED_STAGES.includes(skeletons[i].stage)))
  ]
    .slice(0, directorNodeCount)
    .sort((a, b) => a - b)
  const directorNodeByTask = new Map<number, string>()
  for (const taskIndex of directorTaskIndices) {
    const closed = CLOSED_STAGES.includes(skeletons[taskIndex].stage)
    const cls: NodeClass = closed ? 'DEAD' : rng.pick<NodeClass>(['BUSY', 'IDLE', 'BUSY', 'STALLED'])
    const band: WarmBand = closed ? 'COLD' : rng.pick<WarmBand>(['WARM', 'WARM', 'HEARTBEAT', 'ACT'])
    const id = addNode({
      taskIndex,
      role: 'director',
      cls,
      band,
      ownerNode: supervisorNodeId,
      title: `${skeletons[taskIndex].taskId.split('-').pop()}·director (opus)`,
      provider: 'claude',
      account: rng.chance(0.5) ? '2' : '1',
      pinned: rng.chance(0.25)
    })
    directorNodeByTask.set(taskIndex, id)
  }

  // 3. the operator's own cards.
  for (let i = 0; i < operatorNodeCount; i++) {
    const taskIndex = i < skeletons.length ? (i * 5) % skeletons.length : null
    addNode({
      taskIndex,
      role: 'operator',
      cls: rng.pick<NodeClass>(['IDLE', 'BUSY', 'IDLE']),
      band: rng.pick<WarmBand>(['WARM', 'HEARTBEAT', 'COLD']),
      ownerNode: null,
      title: i === 0 ? "the operator's desk" : `the operator · ${projects[i % projectCount].slug}`,
      provider: 'claude',
      account: '1'
    })
  }

  // 4. the collapse-by-default case: one task with 30+ workers.
  for (let i = 0; i < megaWorkerCount; i++) {
    addNode({
      taskIndex: megaTaskIndex,
      role: 'worker',
      cls: rng.pick<NodeClass>(['BUSY', 'IDLE', 'BUSY', 'DONE', 'STALLED', 'DEAD']),
      band: rng.pick<WarmBand>(['WARM', 'WARM', 'HEARTBEAT', 'ACT', 'COLD', 'NEW']),
      ownerNode: directorNodeByTask.get(megaTaskIndex) ?? supervisorNodeId,
      title: `${skeletons[megaTaskIndex].taskId.split('-').pop()}·worker ${i + 1} (${
        i % 3 === 0 ? 'opus' : 'sonnet'
      })`
    })
  }

  // 5. helpers — monitors, watchers, tails. Owned, but never the task's own worker roster.
  for (let i = 0; i < helperNodeCount; i++) {
    const taskIndex = rng.int(skeletons.length)
    addNode({
      taskIndex,
      role: 'helper',
      cls: rng.pick<NodeClass>(['IDLE', 'BUSY', 'DEAD']),
      band: rng.pick<WarmBand>(['WARM', 'COLD', 'COLD', 'UNKNOWN']),
      ownerNode: directorNodeByTask.get(taskIndex) ?? supervisorNodeId,
      title: `${projects[skeletons[taskIndex].projectIndex].slug} · ci-watch ${i + 1}`
    })
  }

  // 6. unknown-role nodes — a pane the tick can see and cannot place.
  for (let i = 0; i < unknownNodeCount; i++) {
    addNode({
      taskIndex: rng.chance(0.5) ? rng.int(skeletons.length) : null,
      role: 'unknown',
      cls: rng.pick<NodeClass>(['IDLE', 'DEAD', 'DEAD']),
      band: rng.pick<WarmBand>(['UNKNOWN', 'COLD', 'UNKNOWN']),
      ownerNode: null,
      title: COLLIDING_TITLE,
      preBoot: rng.chance(0.4)
    })
  }

  // 7. orphans — visible to the supervisor, claimed by no task and spawned by nobody (case 5).
  for (let i = 0; i < orphanNodeCount; i++) {
    addNode({
      taskIndex: null,
      role: rng.pick<NodeRole>(['worker', 'unknown', 'worker', 'helper']),
      cls: rng.pick<NodeClass>(['DEAD', 'DEAD', 'IDLE', 'DEAD', 'LIMIT']),
      band: rng.pick<WarmBand>(['COLD', 'COLD', 'UNKNOWN', 'ACT']),
      ownerNode: null,
      preBoot: rng.chance(0.35),
      title: rng.chance(0.35) ? COLLIDING_TITLE : undefined
    })
  }

  // 8. retired predecessors — the cards that died and were reopened. Kept IN `nodes{}`: §2 says
  //    retiring a node never deletes its history, and a navigator has to be able to resolve
  //    "the session that did step 3" after the card is gone.
  const retiredByTask = new Map<number, string[]>()
  const retireInto = (taskIndex: number, spec: Partial<NodeSpec> = {}): string => {
    const id = addNode({
      taskIndex,
      role: spec.role ?? 'worker',
      cls: 'DEAD',
      band: rng.pick<WarmBand>(['COLD', 'UNKNOWN']),
      ownerNode: directorNodeByTask.get(taskIndex) ?? supervisorNodeId,
      preBoot: true,
      ...spec
    })
    const list = retiredByTask.get(taskIndex) ?? []
    list.push(id)
    retiredByTask.set(taskIndex, list)
    return id
  }

  // 9. the hand-placed adversarial cases. Each exists because it is a state that breaks a
  //    navigator, and a fixture that leaves one out is a fixture that lies about its coverage.
  // Case 2: two retired nodes on one task that also has a live one.
  retireInto(replacedTaskIndex, { role: 'director', title: 'review·director (opus) — card 1' })
  retireInto(replacedTaskIndex, { role: 'worker', title: COLLIDING_WORKER_TITLE, pane: COLLIDING_PANE })
  // ...and the card that was opened to replace them. It has to be LIVE and it has to be the task's
  // owner, or the case degenerates into "a closed task with history" and stops testing anything.
  const replacementNodeId = addNode({
    taskIndex: replacedTaskIndex,
    role: 'director',
    cls: 'BUSY',
    band: 'WARM',
    provider: 'claude',
    ownerNode: supervisorNodeId,
    title: 'review·director (opus) — card 3'
  })
  directorNodeByTask.set(replacedTaskIndex, replacementNodeId)
  // Case 1: the account switch. The surviving node runs on account 1; the retired one ran on 2.
  const switchedFromNodeId = retireInto(switchTaskIndex, {
    role: 'director',
    account: '2',
    provider: 'claude',
    title: 'verify·director (opus) — account 2'
  })
  const switchedToNodeId = addNode({
    taskIndex: switchTaskIndex,
    role: 'director',
    cls: 'BUSY',
    band: 'WARM',
    account: '1',
    provider: 'claude',
    ownerNode: supervisorNodeId,
    title: 'verify·director (opus) — account 1',
    pinned: true
  })
  directorNodeByTask.set(switchTaskIndex, switchedToNodeId)
  // Case 3 + 4: the second `%3`, and the second byte-identical worker title, on another task.
  addNode({
    taskIndex: Math.min(1, skeletons.length - 1),
    role: 'worker',
    cls: 'BUSY',
    band: 'WARM',
    ownerNode: supervisorNodeId,
    title: COLLIDING_WORKER_TITLE,
    pane: COLLIDING_PANE
  })
  // Case 8: the `%`-and-`·` title, and the unicode/long one, on live nodes.
  addNode({
    taskIndex: Math.min(5, skeletons.length - 1),
    role: 'worker',
    cls: 'QUESTION',
    band: 'HEARTBEAT',
    ownerNode: supervisorNodeId,
    title: PERCENT_DOT_TITLE
  })
  addNode({
    taskIndex: Math.min(4, skeletons.length - 1),
    role: 'worker',
    cls: 'BUSY',
    band: 'WARM',
    ownerNode: supervisorNodeId,
    title: UNICODE_LONG_TITLE
  })
  // The third provider, so a navigator that hardcodes claude|codex breaks here and not in the field.
  addNode({
    taskIndex: Math.min(7, skeletons.length - 1),
    role: 'worker',
    cls: 'IDLE',
    band: 'ACT',
    provider: 'opencode',
    account: 'none',
    ownerNode: supervisorNodeId,
    title: 'opencode · sweep'
  })
  // The remaining retirement budget, spread over closed tasks — the ordinary case, in bulk.
  const alreadyRetired = 3
  for (let i = alreadyRetired; i < retiredNodeCount; i++) {
    retireInto(rng.int(skeletons.length))
  }
  // An open-stage task whose owner node is DEAD: `inactive` must catch it despite the stage.
  const deadOwnerNodeId =
    deadOwnerTaskIndex >= 0
      ? addNode({
          taskIndex: deadOwnerTaskIndex,
          role: 'director',
          cls: 'DEAD',
          band: 'COLD',
          ownerNode: supervisorNodeId,
          title: 'building·director (opus) — died before the tick could retire it',
          preBoot: true
        })
      : null

  // 10. the bulk of the workers — the REMAINDER, so the population is exactly `nodeCount` however
  //     many adversarial nodes a population of this size could hold. Spread unevenly and skewed
  //     towards finished work, because most of a real host is finished work.
  while (nodeIdsInOrder.length < nodeCount) {
    const taskIndex = rng.chance(0.35)
      ? rng.int(Math.min(6, skeletons.length))
      : rng.int(skeletons.length)
    const closed = CLOSED_STAGES.includes(skeletons[taskIndex].stage)
    const cls: NodeClass = closed
      ? rng.pick<NodeClass>(['DEAD', 'DEAD', 'DEAD', 'IDLE'])
      : rng.pick<NodeClass>([
          'BUSY',
          'IDLE',
          'DONE',
          'DEAD',
          'STALLED',
          'LIMIT',
          'PERMISSION',
          'QUESTION',
          'NEEDS-OPERATOR',
          'IDLE',
          'DEAD'
        ])
    const band: WarmBand = closed
      ? rng.pick<WarmBand>(['COLD', 'COLD', 'UNKNOWN'])
      : rng.pick<WarmBand>(['WARM', 'HEARTBEAT', 'ACT', 'COLD', 'COLD', 'COLD', 'NEW', 'UNKNOWN'])
    addNode({
      taskIndex,
      role: 'worker',
      cls,
      band,
      ownerNode: directorNodeByTask.get(taskIndex) ?? supervisorNodeId,
      preBoot: rng.chance(0.12)
    })
  }


  // --- tasks ---------------------------------------------------------------------------------
  const tasks: RegistryTask[] = skeletons.map((skeleton, index) => {
    const project = projects[skeleton.projectIndex]
    const taskNodeIds = nodesByTask.get(index) ?? []
    const workerNodeIds = taskNodeIds.filter((id) => nodes[id].role === 'worker')
    const retiredIds = retiredByTask.get(index) ?? []
    const closed = CLOSED_STAGES.includes(skeleton.stage)

    // Owner: the task's director if it has one, else the supervisor, else the operator.
    const directorId = directorNodeByTask.get(index)
    let ownerNodeId: string
    let ownerKind: OwnerKind
    if (index === missingOwnerTaskIndex) {
      // Case 7: the owner node is gone entirely — not retired, not present, just absent. This is
      // what a card destroyed in a restart before the tick could retire it actually looks like.
      ownerNodeId = `term-${rng.chars(BASE36, 8)}-${rng.chars(HEX, 8)}`
      ownerKind = 'director'
    } else if (index === deadOwnerTaskIndex && deadOwnerNodeId) {
      ownerNodeId = deadOwnerNodeId
      ownerKind = 'director'
    } else if (directorId) {
      ownerNodeId = directorId
      ownerKind = 'director'
    } else if (rng.chance(0.15)) {
      ownerNodeId = supervisorNodeId
      ownerKind = 'supervisor'
    } else if (workerNodeIds.length > 0) {
      ownerNodeId = workerNodeIds[0]
      ownerKind = 'worker'
    } else {
      ownerNodeId = supervisorNodeId
      ownerKind = 'supervisor'
    }
    const ownerNode = nodes[ownerNodeId]

    const stageSince = base - rng.between(12 * MINUTE, 26 * HOUR)

    // Session lineage: append-only, so an account switch shows two uuids and history survives.
    const lineage: string[] = []
    for (const retiredId of retiredIds) lineage.push(nodes[retiredId].session)
    if (ownerNode) lineage.push(ownerNode.session)
    if (index === switchTaskIndex) {
      // Belt and braces: the switch case must carry ≥ 2 whatever the retirement budget did.
      if (!lineage.includes(nodes[switchedFromNodeId].session)) lineage.push(nodes[switchedFromNodeId].session)
      if (!lineage.includes(nodes[switchedToNodeId].session)) lineage.push(nodes[switchedToNodeId].session)
    }
    if (lineage.length === 0) lineage.push(newSession())

    const progress = buildProgress(rng, index, base, ownerNodeId)
    const blockers = buildBlockers(rng, index, base, taskNodeIds, nodes)
    const workers: TaskWorker[] = workerNodeIds.map((id) => ({
      node: id,
      role: WORKER_LANE_ROLES[hashSeed(id) % WORKER_LANE_ROLES.length],
      started: fixtureIso(base - rng.between(20 * MINUTE, 20 * HOUR)),
      state: nodes[id].class,
      band: nodes[id].band
    }))

    const lastUpdate = closed
      ? base - rng.between(2 * HOUR, 40 * HOUR)
      : rng.chance(0.22)
        ? base - (base - hostBoot) - rng.between(5 * MINUTE, 8 * HOUR) // deliberately pre-restart
        : base - rng.between(1 * MINUTE, 90 * MINUTE)

    // §6, implemented as written: stale when the owner node is COLD or gone, when the last update
    // predates the restart, or when the only progress is an unverified claim older than an hour.
    const ownerMissing = !ownerNode
    const ownerCold = !!ownerNode && (ownerNode.band === 'COLD' || ownerNode.class === 'DEAD')
    const preBootUpdate = lastUpdate < hostBoot
    const reportedOnlyStale =
      !!progress.reported && !progress.verified && base - isoToEpoch(progress.reported.at) > 60 * MINUTE
    const staleReason = ownerMissing
      ? STALE_REASONS.goneOwner
      : preBootUpdate
        ? STALE_REASONS.preBoot
        : ownerCold
          ? STALE_REASONS.coldOwner
          : reportedOnlyStale
            ? STALE_REASONS.unverified
            : null

    const task: RegistryTask = {
      task_id: skeleton.taskId,
      title: skeleton.title,
      project: project.slug,
      project_id: project.projectId,
      pinned: index === switchTaskIndex || index === 0 || rng.chance(0.08),
      objective: `${skeleton.title}: ship the lane's deliverable with a proof command that was run.`,
      scope: `${project.slug} only. Not the shared contract, not another lane's worktree.`,
      owner: {
        kind: ownerKind,
        node: ownerNodeId,
        session: ownerNode ? ownerNode.session : lineage[lineage.length - 1],
        account: ownerNode ? ownerNode.account : '2',
        provider: ownerNode ? ownerNode.provider : 'claude',
        model: ownerNode ? ownerNode.model : CLAUDE_MODELS[0]
      },
      stage: skeleton.stage,
      stage_since: fixtureIso(stageSince),
      progress,
      next_action: {
        text: nextActionText(rng, skeleton.stage),
        owner: blockers.some((b) => b.owner === 'operator') ? 'operator' : rng.pick(BLOCKER_OWNERS),
        since: fixtureIso(base - rng.between(3 * MINUTE, 6 * HOUR))
      },
      blockers,
      workers,
      dependencies: index > 0 && rng.chance(0.3) ? [skeletons[rng.int(index)].taskId] : [],
      budgets: {
        provider: ownerNode ? ownerNode.provider : 'claude',
        account: ownerNode ? ownerNode.account : '2',
        dollars_cap: rng.chance(0.25) ? rng.between(5, 40) : null,
        dollars_spent: rng.decimal(0, 12),
        notes: rng.chance(0.3) ? 'no paid provider calls in this lane' : ''
      },
      artifacts: {
        report: `~/.task-registry/briefs/${skeleton.taskId}/report.md`,
        plan: `~/${project.slug}/docs/plans/2026-09-04-${skeleton.taskId}.md`,
        prs: rng.chance(0.45)
          ? [
              {
                repo: `howieyoungdahl/${project.slug}`,
                number: rng.between(40, 1400),
                state: rng.pick(['OPEN', 'MERGED', 'CLOSED']),
                checks: rng.pick(['pending', 'passing', 'failing']),
                as_of: fixtureIso(base - rng.between(2 * MINUTE, 12 * HOUR))
              }
            ]
          : []
      },
      evidence: buildEvidence(rng, skeleton.taskId, base),
      freshness: {
        last_update: fixtureIso(lastUpdate),
        source: rng.pick(FRESHNESS_SOURCES),
        may_be_stale: staleReason !== null,
        stale_reason: staleReason
      },
      closed,
      retired_nodes: retiredIds.map((id) => ({
        node: id,
        until: fixtureIso(base - rng.between(30 * MINUTE, 30 * HOUR)),
        disposition: rng.pick(DISPOSITIONS),
        project_id: nodes[id].project_id
      })),
      session_lineage: lineage
    }
    return task
  })

  // --- views ---------------------------------------------------------------------------------
  const workersByTask: Record<string, string[]> = {}
  for (const task of tasks) workersByTask[task.task_id] = []
  for (const id of nodeIdsInOrder) {
    const node = nodes[id]
    if (node.role === 'worker' && node.task_id && workersByTask[node.task_id]) {
      workersByTask[node.task_id].push(id)
    }
  }

  const registry: TaskRegistry = {
    registry_schema: 1,
    generated_at: fixtureIso(base),
    generated_at_epoch: base,
    source: {
      file: '~/.task-registry/state/ledger.json',
      generation: 400 + (hashSeed(String(opts.seed)) % 600),
      ledger_schema: 2
    },
    host_boot_epoch: hostBoot,
    tasks,
    nodes,
    views: {
      needs_attention: [],
      primary: [],
      active: [],
      inactive: [],
      workers_by_task: workersByTask
    },
    counts: { tasks: 0, active: 0, needs_attention: 0, nodes: 0, workers: 0, dead_nodes: 0 }
  }

  const directorTaskIds = new Set<string>()
  for (const id of nodeIdsInOrder) {
    const node = nodes[id]
    if (node.role === 'director' && node.task_id) directorTaskIds.add(node.task_id)
  }

  registry.views.needs_attention = needsAttentionTaskIds(tasks, nodes)
  registry.views.primary = tasks
    .filter((t) => t.pinned || t.owner.kind === 'operator' || directorTaskIds.has(t.task_id))
    .map((t) => t.task_id)
  registry.views.active = tasks
    .filter((t) => !CLOSED_STAGES.includes(t.stage) && isLiveNode(registry, t.owner.node))
    .map((t) => t.task_id)
  const activeSet = new Set(registry.views.active)
  registry.views.inactive = tasks.filter((t) => !activeSet.has(t.task_id)).map((t) => t.task_id)

  registry.counts = {
    tasks: tasks.length,
    active: registry.views.active.length,
    needs_attention: registry.views.needs_attention.length,
    nodes: nodeIdsInOrder.length,
    workers: nodeIdsInOrder.filter((id) => nodes[id].role === 'worker').length,
    dead_nodes: nodeIdsInOrder.filter((id) => nodes[id].class === 'DEAD').length
  }

  // --- unregistered sessions (case 5) ----------------------------------------------------------
  const unregisteredCount = Math.max(0, Math.round(opts.unregisteredCount))
  const unregistered: UnregisteredSession[] = []
  // Two of them are the same uuid as a live node's session: on a real host a pane's session ALSO
  // has a record on disk, and the join by uuid is the only thing that spots it. The rest exist
  // nowhere else, which is the 98% this bucket is for.
  const joinable = nodeIdsInOrder.slice(0, 2).map((id) => nodes[id].session)
  for (let i = 0; i < unregisteredCount; i++) {
    const provider: UnregisteredSession['provider'] = rng.chance(0.55)
      ? 'claude'
      : rng.chance(0.85)
        ? 'codex'
        : 'opencode'
    const session = i < joinable.length && rng.chance(1) ? joinable[i] : newSession()
    const modified = base - rng.between(20 * MINUTE, 32 * 24 * HOUR)
    unregistered.push({
      session,
      provider,
      account: provider === 'claude' ? (rng.chance(0.5) ? '1' : '2') : null,
      project: rng.chance(0.45) ? projects[rng.int(projectCount)].slug : null,
      path:
        provider === 'claude'
          ? `~/.claude/sessions/${rng.between(1000, 99999)}.json`
          : provider === 'codex'
            ? `~/.codex/sessions/2026/09/${String(rng.between(1, 4)).padStart(2, '0')}/rollout-${session}.jsonl`
            : `~/.opencode/sessions/${session}.json`,
      last_modified: fixtureIso(modified),
      last_modified_epoch: modified,
      size_bytes: rng.between(1200, 4_200_000)
    })
  }

  return { registry, unregistered }
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

function warmMinutesFor(rng: Rng, band: WarmBand): number {
  if (band === 'COLD') return rng.decimal(60, 600)
  if (band === 'ACT') return rng.decimal(45, 59.9)
  if (band === 'HEARTBEAT') return rng.decimal(25, 44.9)
  return rng.decimal(0, 24.9)
}

function defaultTitle(rng: Rng, spec: NodeSpec, taskId: string | undefined): string {
  const lane = taskId ? taskId.split('-').pop() : 'lane'
  if (spec.role === 'worker') return `${lane}·worker (${rng.chance(0.4) ? 'opus' : 'sonnet'})`
  if (spec.role === 'helper') return `${lane}·watch`
  if (spec.role === 'director') return `${lane}·director (opus)`
  return `Terminal ${rng.between(1, 60)}`
}

function nextActionText(rng: Rng, stage: TaskStage): string {
  switch (stage) {
    case 'planned':
      return 'write the brief and open the lane'
    case 'briefing':
      return 'dispatch the workers'
    case 'building':
      return rng.chance(0.5) ? 'finish the generator and run the suite' : 'land the remaining two files'
    case 'review':
      return 'address the reviewer notes'
    case 'blocked':
      return 'unblock the dependency, then resume'
    case 'waiting-operator':
      return "wait for the operator's call, do not proceed"
    case 'verifying':
      return 'run the proof command and paste the output'
    case 'done':
      return 'nothing — closed'
    default:
      return 'nothing — abandoned'
  }
}

/**
 * The three progress shapes a navigator has to render differently, plus the empty one.
 *
 * Task 0 is verified-only, task 1 reported-only, tasks 2 and 6 carry BOTH with different text and
 * different timestamps. That last case is the one most easily rendered wrong — a UI that shows "the
 * latest progress" collapses a proven claim and an unproven one into a single line, which is
 * exactly what §3's two-slot rule exists to prevent.
 */
function buildProgress(rng: Rng, index: number, base: number, byNode: string): TaskProgress {
  const verifiedAt = base - rng.between(40 * MINUTE, 9 * HOUR)
  const reportedAt = base - rng.between(2 * MINUTE, 35 * MINUTE)
  const verified: ProgressVerified = {
    text: `${rng.between(4, 220)} tests pass over the generator and its invariants`,
    proof: 'npx vitest run src/shared/remote-nav/ --reporter=basic',
    at: fixtureIso(verifiedAt),
    by: byNode,
    role: 'worker'
  }
  const reported: ProgressReported = {
    text: 'handover path implemented, tests not written yet',
    at: fixtureIso(reportedAt),
    by: byNode,
    role: 'worker'
  }
  if (index === 0) return { verified }
  if (index === 1) return { reported }
  if (index === 2 || index === 6) return { verified, reported }
  const roll = rng.next()
  if (roll < 0.25) return { verified }
  if (roll < 0.55) return { reported }
  if (roll < 0.8) return { verified, reported }
  return {}
}

function buildEvidence(rng: Rng, taskId: string, base: number): TaskEvidence[] {
  const count = rng.between(0, 3)
  const out: TaskEvidence[] = []
  for (let i = 0; i < count; i++) {
    const kind = rng.pick<TaskEvidence['kind']>(['test', 'pr', 'file', 'command'])
    out.push({
      kind,
      ref:
        kind === 'pr'
          ? `example-org/example-app#${rng.between(40, 1400)}`
          : kind === 'file'
            ? `~/.task-registry/briefs/${taskId}/report.md`
            : kind === 'test'
              ? 'src/shared/remote-nav/fixture.test.ts'
              : 'npm run typecheck',
      at: fixtureIso(base - rng.between(10 * MINUTE, 26 * HOUR))
    })
  }
  return out
}

/**
 * Blockers. The first six tasks carry one forced blocker each so all five kinds appear and four are
 * owned by the operator — that set IS the `needs_attention` filter he asked for by name.
 *
 * One of the four (task 3) sits on a task whose stage is `review`, NOT `waiting-operator`. That is
 * deliberate: stage is a judgment a director writes and a blocker can arrive after it, so a
 * navigator that treats `stage === 'waiting-operator'` as equivalent to "has a the operator blocker" is
 * wrong on a real host. Random extra blockers are never owned by the operator, so the the operator-owned set
 * stays exactly the forced four plus nothing.
 */
function buildBlockers(
  rng: Rng,
  index: number,
  base: number,
  taskNodeIds: string[],
  nodes: Record<string, RegistryNode>
): TaskBlocker[] {
  const forced: Array<{ kind: BlockerKind; owner: BlockerOwner; text: string }> = [
    { kind: 'budget', owner: 'supervisor', text: 'lane has no dollar cap set; paid calls refused until it does' },
    { kind: 'question', owner: 'director', text: 'which of the two brief revisions is canonical' },
    { kind: 'dependency', owner: 'worker', text: 'waiting on the schema lane to land its migration' },
    { kind: 'approval', owner: 'operator', text: 'allow-demo-fn-change label on #1095/#1097' },
    { kind: 'failure', owner: 'director', text: 'proof command exits 1 on a clean checkout' },
    { kind: 'approval', owner: 'operator', text: 'merge call on the ledger PR' }
  ]
  const out: TaskBlocker[] = []
  if (index < forced.length) {
    const f = forced[index]
    // v0.1: attribute the blocker to the worker that raised it, so collapsing workers does not
    // hide the reason the parent task is stuck (reply to R2).
    const raiser = taskNodeIds.find((id) => nodes[id].role === 'worker')
    out.push({
      id: 'b1',
      kind: f.kind,
      text: f.text,
      owner: f.owner,
      since: fixtureIso(base - rng.between(25 * MINUTE, 14 * HOUR)),
      ...(raiser ? { node: raiser, role: nodes[raiser].role } : {}),
      quote: 'Should I proceed with the second option, or wait?',
      suggested: 'Yes if he accepts the reviewer note',
      where: `briefs/${index}/review.md:23-60`
    })
  }
  if (index >= 6 && rng.chance(0.3)) {
    out.push({
      id: `b${out.length + 1}`,
      kind: rng.pick<BlockerKind>(['dependency', 'failure', 'question', 'budget']),
      owner: rng.pick<BlockerOwner>(['director', 'supervisor', 'worker']),
      text: 'CI is red on the branch and nobody has looked',
      since: fixtureIso(base - rng.between(10 * MINUTE, 20 * HOUR))
    })
  }
  // Two more the operator-owned blockers so `waiting-operator` is never a single sample.
  if (index === 9 || index === 10) {
    out.push({
      id: `b${out.length + 1}`,
      kind: index === 9 ? 'question' : 'approval',
      owner: 'operator',
      text: index === 9 ? 'which account should this lane run on tonight' : 'sign-off on the removal plan',
      since: fixtureIso(base - rng.between(30 * MINUTE, 10 * HOUR)),
      quote: 'Which account do you want this on?',
      suggested: 'Account 1 — account 2 is at 91% of the five-hour window'
    })
  }
  return out
}

/** Inverse of `fixtureIso` for the fixed offset. Used only inside the generator's own staleness rule. */
function isoToEpoch(iso: string): number {
  return Math.round(Date.parse(`${iso.slice(0, 19)}Z`) / 1000) - OFFSET_SECONDS
}
