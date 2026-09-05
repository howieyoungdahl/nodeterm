/**
 * The remote session navigator's pure model: project → task → responsible director → supporting
 * workers, over the shared task-registry projection.
 *
 * WHY THIS EXISTS. The account-wide session listing a phone reaches is one flat list with no
 * grouping, filter, search or pin. A measurement on one host returned 227 peers in 19 KB, of which
 * 7 were live — a 3.1 % signal-to-noise ratio, and the reply declared itself truncated, so 227 was
 * a floor. Nothing in that surface can answer "which task needs me, and how do I open it". This
 * model answers that from a file in the shared task-registry shape, and answers it in a bounded
 * number of rows.
 *
 * THE INPUT is `$NODETERM_TASK_REGISTRY` — an absolute path to a JSON document in the registry
 * contract's shape (sections 2-4). nodeterm CONSUMES that document and never writes it; any
 * producer that emits the shape works, and nodeterm names no particular producer. Pins and task
 * closure are the registry's own state, written through the registry's own writer, so this model
 * exposes them as INTENTS (§ Intents below) and never performs one.
 *
 * TWO STRUCTURAL RULES, both load-bearing:
 *
 *   1. **Pure.** No I/O, no `Date.now()` (`nowMs` is always a parameter), no Node built-ins, no
 *      Electron. `src/shared` is imported by main, renderer and server alike.
 *   2. **No RUNTIME imports at all** — every cross-module import here is `import type`, which is
 *      erased. That is what lets `scripts/remote-nav.mjs` load this file directly through Node's
 *      built-in type stripping, with no build step, over an SSH connection. A single runtime
 *      `import` from a sibling module would break that (Node applies ESM resolution to a stripped
 *      `.ts`, and an extensionless relative specifier does not resolve), so the handful of frozen
 *      vocabulary constants this model needs are declared HERE and pinned against the fixture's
 *      copies by `model.test.ts`. A red test is the drift guard; a second silent definition is not.
 *
 * VOCABULARY. Two roles recur across every type here and are named once, so no call site has to
 * re-explain them: **supervisor** is the tier above a director — whatever process observes the
 * sessions and publishes the registry (it appears as an `owner.kind`, a `nodes[].role` and a
 * `freshness.source`); **operator** is the person the work is ultimately parked on, and it is the
 * spelling used by `blockers[].owner: 'operator'`, the stage `waiting-operator` and the node class
 * `NEEDS-OPERATOR`. A registry that spells either differently is a different producer's dialect;
 * these are the words nodeterm codes in.
 *
 * The record types come from `./fixture`, which is where this branch put the contract's shapes;
 * they are the contract's, not the fixture's, and moving them later is a pure rename.
 */

import type {
  BlockerKind,
  BlockerOwner,
  NodeClass,
  NodeRole,
  RegistryNode,
  RegistryTask,
  TaskBlocker,
  TaskProgress,
  TaskRegistry,
  TaskStage,
  UnregisteredSession,
  WarmBand
} from './fixture'

// ---------------------------------------------------------------------------
// Frozen vocabulary this model switches on
// ---------------------------------------------------------------------------

/** The environment variable naming the registry document. There is no default: unset is its own
 *  answer (`no-registry-configured`), never an empty list. */
export const REGISTRY_ENV_VAR = 'NODETERM_TASK_REGISTRY'

/** Contract §3 — stages that mean the work is over, whatever its nodes are doing. */
export const CLOSED_STAGES: readonly TaskStage[] = ['done', 'abandoned']

/** Contract §4 — the node classes that put a task into `views.needs_attention`. */
export const ATTENTION_CLASSES: readonly NodeClass[] = [
  'LIMIT',
  'PERMISSION',
  'QUESTION',
  'NEEDS-OPERATOR',
  'DEAD'
]

/** Contract §6 — the band at which nothing may type into a session. */
export const COLD_BAND: WarmBand = 'COLD'

/** The tmux socket nodeterm's own sessions live on, and the per-node session name. Declared here
 *  for rule 2 above; `registry-reader.test.ts` pins both against `src/core/tmux-naming.ts`. */
export const NAV_TMUX_SOCKET = 'node-terminal'

export function navSessionName(nodeId: string): string {
  return `nt-${nodeId.replace(/[^a-zA-Z0-9_-]/g, '_')}`
}

/** Session ids reach a shell command line, so they are re-validated at the interpolation site
 *  rather than trusted for being typed `string` — the registry is a file a human can edit.
 *  Pinned against `resumeCommand`'s own guard in `model.test.ts`. */
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** Resume grammar per provider. Pinned against `shared/agents/config.ts` `resumeCommandWith`. */
const RESUME_GRAMMAR: Record<string, (sessionId: string) => string> = {
  claude: (s) => `claude --resume ${s}`,
  codex: (s) => `codex resume ${s}`,
  gemini: (s) => `gemini --resume ${s}`,
  grok: (s) => `grok --resume ${s}`,
  opencode: (s) => `opencode --session ${s}`,
  copilot: (s) => `copilot --resume=${s}`
}

// ---------------------------------------------------------------------------
// Reading the registry — four distinguishable failures, never an empty list
// ---------------------------------------------------------------------------

/**
 * What an I/O shell found. The shell (the core reader, or the CLI) does the `fs` work; the
 * classification below is the single decider both call, so the app and the terminal cannot
 * disagree about what "stale" or "missing" means.
 */
export type RegistrySource =
  | { kind: 'unset' }
  | { kind: 'missing'; path: string; detail?: string }
  | { kind: 'unreadable'; path: string; detail: string }
  | { kind: 'text'; path: string; text: string }

export interface RegistryStaleness {
  generatedAtEpoch: number | null
  hostBootEpoch: number | null
  /** The registry was generated before the host last booted: nothing in it is current. */
  generatedBeforeHostBoot: boolean
  /** Seconds between `generated_at_epoch` and `nowMs`. Reported beside the registry's own
   *  per-node ages, never folded into them — the contract forbids synthesizing freshness. */
  registryAgeS: number | null
  message: string | null
}

export type RegistryRead =
  | { ok: false; kind: 'no-registry-configured'; envVar: string; message: string }
  | { ok: false; kind: 'registry-missing'; path: string; message: string }
  | { ok: false; kind: 'registry-unreadable'; path: string; detail: string; message: string }
  | { ok: false; kind: 'registry-unparseable'; path: string; detail: string; message: string }
  | {
      ok: true
      kind: 'registry'
      path: string
      registry: TaskRegistry
      staleness: RegistryStaleness
      message: string
    }

/**
 * The configured registry path, or null with the reason it is unusable.
 *
 * A RELATIVE path is refused rather than resolved against the process cwd. The Desktop app, the
 * Server Edition and a CLI reached over SSH each start in a different directory, so one relative
 * value would name three different files depending on which surface asked — and each would then
 * report a different set of tasks with no sign that anything was wrong. Absolute-path detection
 * accepts both dialects wherever it runs (POSIX `/`, Windows `C:\` / `C:/` and UNC `\\`), because
 * the value may have been written by a different machine than the one reading it.
 *
 * Pure, so the core reader and the CLI resolve it identically. `path.isAbsolute` would be the
 * obvious call and is deliberately not used: it answers for the platform it runs on, and
 * `src/shared` may not import Node built-ins at all.
 */
export function resolveRegistryPath(env: Record<string, string | undefined>): {
  path: string | null
  reason: string | null
} {
  const raw = env[REGISTRY_ENV_VAR]
  if (typeof raw !== 'string' || raw.trim() === '') return { path: null, reason: null }
  const value = raw.trim()
  const absolute = value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith('\\\\')
  if (!absolute) {
    return {
      path: null,
      reason: `${REGISTRY_ENV_VAR} is set to a relative path ("${value}"); it must be absolute, because the app, the server and a remote shell each start in a different directory.`
    }
  }
  return { path: value, reason: null }
}

/**
 * Turn what the shell found into one of five answers.
 *
 * `ok: false` is never `ok: true` with no rows — the same rule this repo already enforces for
 * session memory. A navigator that prints "no tasks" when it means "I could not read the registry"
 * is the failure this exists to prevent, and it is the likeliest one: an unset variable, a path
 * that moved, and a half-written file all end with an empty screen unless they are separated here.
 *
 * The parse is deliberately shallow. Contract guarantee 2 says new fields appear without notice and
 * consumers must not validate strictly, so only the two structures this model indexes on are
 * checked (`tasks[]`, `nodes{}`); everything else is passed through untouched.
 */
export function classifyRegistryPayload(source: RegistrySource, nowMs: number): RegistryRead {
  if (source.kind === 'unset') {
    return {
      ok: false,
      kind: 'no-registry-configured',
      envVar: REGISTRY_ENV_VAR,
      message: `No task registry configured. Set ${REGISTRY_ENV_VAR} to the absolute path of a task-registry JSON document.`
    }
  }
  if (source.kind === 'missing') {
    return {
      ok: false,
      kind: 'registry-missing',
      path: source.path,
      message: `No registry file at ${source.path}. This is not "no tasks" — the file named by ${REGISTRY_ENV_VAR} is not there.`
    }
  }
  if (source.kind === 'unreadable') {
    // A failed read is never evidence of absence: a permission error, a dead mount and an
    // interrupted read all say nothing about whether tasks exist.
    return {
      ok: false,
      kind: 'registry-unreadable',
      path: source.path,
      detail: source.detail,
      message: `Could not read ${source.path}: ${source.detail}. Nothing is known about the tasks — this is not an empty registry.`
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(source.text)
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    return {
      ok: false,
      kind: 'registry-unparseable',
      path: source.path,
      detail,
      message: `Registry at ${source.path} is not valid JSON: ${detail}`
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      kind: 'registry-unparseable',
      path: source.path,
      detail: 'top level is not an object',
      message: `Registry at ${source.path} parsed, but its top level is not an object.`
    }
  }
  const doc = parsed as Partial<TaskRegistry>
  if (!Array.isArray(doc.tasks) || !doc.nodes || typeof doc.nodes !== 'object') {
    return {
      ok: false,
      kind: 'registry-unparseable',
      path: source.path,
      detail: 'no tasks[] / nodes{}',
      message: `Registry at ${source.path} parsed, but carries no tasks[] and nodes{} — it is not a task registry.`
    }
  }

  const registry = parsed as TaskRegistry
  const staleness = registryStaleness(registry, nowMs)
  return {
    ok: true,
    kind: 'registry',
    path: source.path,
    registry,
    staleness,
    message: staleness.message ?? `Registry read from ${source.path}.`
  }
}

/**
 * Contract §4 guarantee 4 and §6: a document generated before the host last booted describes a
 * machine that no longer exists. It is shown, loudly marked — hiding it would lose the only record
 * of what was running, and rendering it as current is the failure the mark exists to prevent.
 */
export function registryStaleness(registry: TaskRegistry, nowMs: number): RegistryStaleness {
  const generated = numberOrNull(registry.generated_at_epoch)
  const boot = numberOrNull(registry.host_boot_epoch)
  const before = generated !== null && boot !== null && generated < boot
  const ageS = generated === null ? null : Math.max(0, Math.round(nowMs / 1000 - generated))
  return {
    generatedAtEpoch: generated,
    hostBootEpoch: boot,
    generatedBeforeHostBoot: before,
    registryAgeS: ageS,
    message: before
      ? 'STALE REGISTRY — generated before the host last booted. Every status below predates the restart and none of it is current.'
      : null
  }
}

// ---------------------------------------------------------------------------
// Freshness — travels with every status, never synthesized
// ---------------------------------------------------------------------------

export interface FreshnessView {
  /** Verbatim from the registry. Never summed with the registry's own age (§4 reply R3.1). */
  observationAgeS: number | null
  band: WarmBand
  lastObserved: string | null
  /** True when the last look at this pane predates the host's boot (§6). */
  observedBeforeHostBoot: boolean
  mayBeStale: boolean
  staleReason: string | null
  /** One short string a row can print beside a badge, e.g. `WARM · seen 12s ago`. */
  label: string
}

/** Freshness for one node. `null` node = the registry has no record of it at all. */
export function nodeFreshness(
  node: RegistryNode | null | undefined,
  hostBootEpoch: number | null
): FreshnessView {
  if (!node) {
    return {
      observationAgeS: null,
      band: 'UNKNOWN',
      lastObserved: null,
      observedBeforeHostBoot: false,
      mayBeStale: true,
      staleReason: 'node is not in the registry',
      label: 'UNKNOWN · never observed'
    }
  }
  const observedEpoch = isoToEpoch(node.last_observed)
  const beforeBoot =
    observedEpoch !== null && hostBootEpoch !== null && observedEpoch < hostBootEpoch
  const ageS = numberOrNull(node.observation_age_s)
  const reason = beforeBoot ? 'no observation since the host restarted' : null
  return {
    observationAgeS: ageS,
    band: node.band,
    lastObserved: node.last_observed ?? null,
    observedBeforeHostBoot: beforeBoot,
    mayBeStale: beforeBoot,
    staleReason: reason,
    // Short on purpose: it prints inside a fixed column on a phone-width row, and a label that
    // needs truncating is a label whose last word — which here is `pre-boot`, the one that says
    // the reading predates the restart — is the first thing lost.
    label: `${node.band} ${ageS === null ? 'age unknown' : `${formatAge(ageS)} ago`}${
      beforeBoot ? ' · pre-boot' : ''
    }`
  }
}

/** Freshness of the task RECORD — a judgment clock, distinct from the observation clock (§6). */
export function taskFreshness(task: RegistryTask, hostBootEpoch: number | null): FreshnessView {
  const updated = isoToEpoch(task.freshness?.last_update)
  const beforeBoot = updated !== null && hostBootEpoch !== null && updated < hostBootEpoch
  const stale = !!task.freshness?.may_be_stale || beforeBoot
  const reason =
    task.freshness?.stale_reason ?? (beforeBoot ? 'no update since the host restarted' : null)
  return {
    observationAgeS: null,
    band: 'UNKNOWN',
    lastObserved: task.freshness?.last_update ?? null,
    observedBeforeHostBoot: beforeBoot,
    mayBeStale: stale,
    staleReason: stale ? reason : null,
    label: `${task.freshness?.source ?? 'unknown source'} · ${
      task.freshness?.last_update ?? 'never updated'
    }${stale ? ` · MAY BE STALE${reason ? ` (${reason})` : ''}` : ''}`
  }
}

// ---------------------------------------------------------------------------
// Opening a session — printed always, typed never at COLD
// ---------------------------------------------------------------------------

export interface OpenAction {
  /** The exact line to paste. `null` only when nothing addressable is known. */
  command: string | null
  kind: 'tmux-attach' | 'resume' | 'none'
  /** Attaching is read-write on the pane, so it is refused at COLD like any other typing action. */
  typingAllowed: boolean
  /** Set when `typingAllowed` is false: the code the contract names, plus the reason to show. */
  refusal: { code: 'STALE-REFUSED'; reason: string } | null
  /** True when the caller must ask for an explicit override before running the command. */
  requiresOverride: boolean
  note: string | null
}

/**
 * How to reach the session behind a task, as one copy-pasteable line.
 *
 * A LIVE node's session is a tmux session on the host, so the line attaches to it — that is the
 * shortest path from an SSH prompt to the actual work. A node the registry classes DEAD has no
 * pane left, so the line is the provider's own resume, built from the session uuid.
 *
 * §6: nothing may type into a session at `COLD`. Printing is not typing, so the command is always
 * shown; what changes is that it is marked as requiring an explicit override, with the reason. A
 * navigator that silently hid the line would leave the operator with no way to reach a cold session
 * at all, and one that offered it unmarked would invite the write §6 forbids.
 */
export function openActionFor(
  nodeId: string,
  node: RegistryNode | null | undefined,
  fallbackSession: string | null,
  fallbackProvider: string | null
): OpenAction {
  const cold = !!node && node.band === COLD_BAND
  const refusal = cold
    ? {
        code: 'STALE-REFUSED' as const,
        reason: `owner session is COLD (${
          node && node.warm_min !== null ? `${node.warm_min} min since its last request` : 'no recent request'
        }); do not type into it without checking it first`
      }
    : null

  if (node && node.class !== 'DEAD' && nodeId) {
    // `-t =` is an EXACT target: without the `=`, tmux falls back to fnmatch and then to PREFIX
    // matching on a miss, and `nt-…-1` is a prefix of `nt-…-12`, so a typo could attach to a
    // different session than the one on screen.
    return {
      command: `tmux -L ${NAV_TMUX_SOCKET} attach -t =${navSessionName(nodeId)}`,
      kind: 'tmux-attach',
      typingAllowed: !cold,
      refusal,
      requiresOverride: cold,
      note: null
    }
  }

  const session = (node?.session ?? fallbackSession ?? '').trim()
  const provider = (node?.provider ?? fallbackProvider ?? '').trim()
  const grammar = RESUME_GRAMMAR[provider]
  if (!grammar || !session || !SAFE_SESSION_ID.test(session)) {
    return {
      command: null,
      kind: 'none',
      typingAllowed: false,
      refusal,
      requiresOverride: false,
      note: !session
        ? 'no session id recorded — nothing to reopen'
        : !grammar
          ? `no resume grammar known for provider "${provider}"`
          : 'session id is not in a form that may be put on a command line'
    }
  }
  return {
    command: grammar(session),
    kind: 'resume',
    typingAllowed: !cold,
    refusal,
    requiresOverride: cold,
    note: node ? 'the pane is gone; this starts a fresh one on the recorded session' : null
  }
}

// ---------------------------------------------------------------------------
// The hierarchy
// ---------------------------------------------------------------------------

export interface WorkerRow {
  node: string
  role: string
  state: NodeClass
  band: WarmBand
  title: string | null
  freshness: FreshnessView
  live: boolean
}

export interface WorkerSummary {
  total: number
  live: number
  /** Counts by class, so a collapsed row can still say "3 need you" without listing 30 rows. */
  byClass: Partial<Record<NodeClass, number>>
  /** Blockers raised BY these workers, hoisted onto the parent task. This is the entire point of
   *  collapsing: the count hides the rows, never the reason the task is stuck. */
  hoistedBlockers: BlockerView[]
}

export interface BlockerView {
  id: string
  kind: BlockerKind
  text: string
  owner: BlockerOwner
  since: string | null
  /** v0.1: which node raised it. Never inferred from `where` — that parse was dropped. */
  node: string | null
  role: string | null
  raisedByWorker: boolean
  quote: string | null
  suggested: string | null
  where: string | null
}

/** Why a task is on the needs-attention list. Two causes, and they read differently: a blocker is
 *  something someone WROTE down, a session reason is something the tick OBSERVED. */
export type AttentionReason =
  | { source: 'blocker'; blockerId: string; kind: BlockerKind; text: string; owner: BlockerOwner }
  | { source: 'session'; nodeClass: NodeClass; node: string }

export function describeAttentionReason(reason: AttentionReason): string {
  return reason.source === 'blocker'
    ? `${reason.kind} needs the operator: ${reason.text}`
    : `${reason.nodeClass} on ${reason.node}`
}

export interface OwnerView {
  kind: string
  node: string
  session: string | null
  provider: string | null
  account: string | null
  model: string | null
  role: NodeRole | null
  class: NodeClass | null
  band: WarmBand
  /** False when the owner node is DEAD or absent from `nodes{}` entirely. */
  live: boolean
  present: boolean
  freshness: FreshnessView
}

export interface TaskView {
  taskId: string
  title: string
  project: string
  projectId: string | null
  stage: TaskStage
  stageSince: string | null
  pinned: boolean
  closed: boolean
  objective: string
  scope: string
  owner: OwnerView
  nextAction: { text: string; owner: BlockerOwner | string; since: string | null }
  progress: TaskProgress
  blockers: BlockerView[]
  workers: WorkerSummary
  workerRows: WorkerRow[]
  freshness: FreshnessView
  /** True when a node joined to this task carries an attention class, or a blocker is the
   *  operator's. Carries the reasons STRUCTURED, so the needs-attention list can group them
   *  without re-parsing a sentence it printed a moment earlier. */
  attention: { needed: boolean; reasons: AttentionReason[] }
  open: OpenAction
  dependencies: string[]
  retiredNodes: Array<{ node: string; until: string | null; disposition: string | null }>
  sessionLineage: string[]
  artifacts: RegistryTask['artifacts']
}

export interface ProjectView {
  project: string
  projectId: string | null
  taskIds: string[]
  /** Tasks not in a closed stage whose owner node is live. */
  activeTaskIds: string[]
  attentionTaskIds: string[]
}

export interface UnregisteredRow {
  session: string
  provider: string
  account: string | null
  project: string | null
  path: string
  lastModified: string | null
  sizeBytes: number | null
  /** Set when this on-disk record matches a node the registry DOES know, joined by session uuid
   *  only. Never a synthetic task id — an unclaimed session has none and never will (reply R4). */
  joinedNode: string | null
  joinedTaskId: string | null
}

export interface AttentionRow {
  /** `(kind, text, owner)` — the deduplication key the contract's 21:58 ruling fixes. */
  key: string
  kind: BlockerKind | 'session'
  text: string
  owner: BlockerOwner
  /** Every task this one item blocks, shown together instead of repeating the item per task. */
  taskIds: string[]
  raisedBy: Array<{ node: string; role: string | null; taskId: string }>
  since: string | null
  quote: string | null
  suggested: string | null
  where: string | null
}

export type ViewName = 'primary' | 'needs_attention' | 'active' | 'inactive' | 'workers_by_task' | 'all'

export interface ViewResult {
  name: ViewName
  taskIds: string[]
  /** Whether the registry precomputed this list or this model recomputed it. A future contract
   *  version that drops or renames a view must not leave the navigator silently diverging. */
  source: 'registry' | 'recomputed'
}

export interface NavigatorModel {
  path: string | null
  generatedAt: string | null
  staleness: RegistryStaleness
  hostBootEpoch: number | null
  sourceGeneration: number | null
  tasks: TaskView[]
  tasksById: Record<string, TaskView>
  projects: ProjectView[]
  attention: AttentionRow[]
  unregistered: UnregisteredRow[]
  counts: {
    tasks: number
    active: number
    needsAttention: number
    nodes: number
    workers: number
    deadNodes: number
    unregistered: number
  }
}

export interface NavigatorInput {
  registry: TaskRegistry
  unregistered?: readonly UnregisteredSession[]
  path?: string | null
  nowMs: number
}

/**
 * Build the whole model in one pass.
 *
 * Joins are by `task_id` and by node id, never by `pane` and never by title (§2 forbids both).
 * The fixture deliberately contains two live nodes sharing `%3` and several sharing a title, so a
 * join that reached for either fails a test rather than shipping.
 */
export function buildNavigator(input: NavigatorInput): NavigatorModel {
  const { registry, nowMs } = input
  const hostBoot = numberOrNull(registry.host_boot_epoch)
  const nodes = registry.nodes ?? {}
  const tasks = Array.isArray(registry.tasks) ? registry.tasks : []

  // Nodes grouped by the task that claims them. `task_id: null` is an unclaimed node and stays out.
  const nodesByTask = new Map<string, string[]>()
  for (const [nodeId, node] of Object.entries(nodes)) {
    if (!node || typeof node !== 'object') continue
    const taskId = node.task_id
    if (!taskId) continue
    const list = nodesByTask.get(taskId) ?? []
    list.push(nodeId)
    nodesByTask.set(taskId, list)
  }

  const views = registry.views ?? ({} as TaskRegistry['views'])
  const registryWorkersByTask = views.workers_by_task ?? {}

  const taskViews: TaskView[] = tasks.map((task) =>
    buildTaskView(task, nodes, nodesByTask, registryWorkersByTask, hostBoot)
  )
  const tasksById: Record<string, TaskView> = {}
  for (const t of taskViews) tasksById[t.taskId] = t

  // Projects, in first-seen order so the output is stable across runs.
  const projectOrder: string[] = []
  const projectTasks = new Map<string, TaskView[]>()
  for (const t of taskViews) {
    if (!projectTasks.has(t.project)) {
      projectTasks.set(t.project, [])
      projectOrder.push(t.project)
    }
    projectTasks.get(t.project)!.push(t)
  }
  const projects: ProjectView[] = projectOrder.map((project) => {
    const rows = projectTasks.get(project)!
    return {
      project,
      projectId: rows.find((r) => r.projectId)?.projectId ?? null,
      taskIds: rows.map((r) => r.taskId),
      activeTaskIds: rows.filter((r) => !CLOSED_STAGES.includes(r.stage) && r.owner.live).map((r) => r.taskId),
      attentionTaskIds: rows.filter((r) => r.attention.needed).map((r) => r.taskId)
    }
  })

  const attention = buildAttentionRows(taskViews, resolveView(registry, taskViews, 'needs_attention').taskIds)

  const unregistered = buildUnregisteredRows(nodes, input.unregistered ?? [])

  const counts = registry.counts ?? ({} as TaskRegistry['counts'])
  const nodeValues = Object.values(nodes)
  return {
    path: input.path ?? null,
    generatedAt: registry.generated_at ?? null,
    staleness: registryStaleness(registry, nowMs),
    hostBootEpoch: hostBoot,
    sourceGeneration: numberOrNull(registry.source?.generation),
    tasks: taskViews,
    tasksById,
    projects,
    attention,
    unregistered,
    counts: {
      tasks: numberOrNull(counts.tasks) ?? taskViews.length,
      active: resolveView(registry, taskViews, 'active').taskIds.length,
      needsAttention: resolveView(registry, taskViews, 'needs_attention').taskIds.length,
      nodes: numberOrNull(counts.nodes) ?? nodeValues.length,
      workers: numberOrNull(counts.workers) ?? nodeValues.filter((n) => n?.role === 'worker').length,
      deadNodes: numberOrNull(counts.dead_nodes) ?? nodeValues.filter((n) => n?.class === 'DEAD').length,
      unregistered: unregistered.length
    }
  }
}

function buildTaskView(
  task: RegistryTask,
  nodes: Record<string, RegistryNode>,
  nodesByTask: Map<string, string[]>,
  registryWorkersByTask: Record<string, string[]>,
  hostBoot: number | null
): TaskView {
  const ownerNodeId = task.owner?.node ?? ''
  const ownerNode = nodes[ownerNodeId]
  const ownerFreshness = nodeFreshness(ownerNode, hostBoot)

  // Worker roster: the registry's precomputed list where it has one, else the nodes joined to this
  // task whose role is `worker`. `task.workers[]` is the director's own membership statement and is
  // used for role/state text, but never as the roster — a worker the director forgot to record is
  // still a worker the tick can see.
  const joined = nodesByTask.get(task.task_id) ?? []
  const rosterIds = registryWorkersByTask[task.task_id] ?? joined.filter((id) => nodes[id]?.role === 'worker')
  const declaredRole = new Map<string, string>()
  for (const w of task.workers ?? []) if (w?.node) declaredRole.set(w.node, w.role)

  const workerRows: WorkerRow[] = rosterIds
    .filter((id) => !!nodes[id])
    .map((id) => {
      const node = nodes[id]
      return {
        node: id,
        role: declaredRole.get(id) ?? node.role ?? 'worker',
        state: node.class,
        band: node.band,
        title: node.title ?? null,
        freshness: nodeFreshness(node, hostBoot),
        live: node.class !== 'DEAD'
      }
    })

  const workerIds = new Set(workerRows.map((r) => r.node))
  const blockers: BlockerView[] = (task.blockers ?? []).map((b) => toBlockerView(b, workerIds))

  const byClass: Partial<Record<NodeClass, number>> = {}
  for (const row of workerRows) byClass[row.state] = (byClass[row.state] ?? 0) + 1

  const attentionReasons: AttentionReason[] = []
  for (const b of blockers) {
    if (b.owner === 'operator') {
      attentionReasons.push({ source: 'blocker', blockerId: b.id, kind: b.kind, text: b.text, owner: b.owner })
    }
  }
  for (const id of joined) {
    const node = nodes[id]
    if (node && ATTENTION_CLASSES.includes(node.class)) {
      attentionReasons.push({ source: 'session', nodeClass: node.class, node: id })
    }
  }

  return {
    taskId: task.task_id,
    title: task.title ?? task.task_id,
    project: task.project ?? 'unknown',
    projectId: task.project_id ?? null,
    stage: task.stage,
    stageSince: task.stage_since ?? null,
    pinned: !!task.pinned,
    closed: !!task.closed || CLOSED_STAGES.includes(task.stage),
    objective: task.objective ?? '',
    scope: task.scope ?? '',
    owner: {
      kind: task.owner?.kind ?? 'unknown',
      node: ownerNodeId,
      session: task.owner?.session ?? ownerNode?.session ?? null,
      provider: task.owner?.provider ?? ownerNode?.provider ?? null,
      account: task.owner?.account ?? ownerNode?.account ?? null,
      model: task.owner?.model ?? ownerNode?.model ?? null,
      role: ownerNode?.role ?? null,
      class: ownerNode?.class ?? null,
      band: ownerNode?.band ?? 'UNKNOWN',
      live: !!ownerNode && ownerNode.class !== 'DEAD',
      present: !!ownerNode,
      freshness: ownerFreshness
    },
    nextAction: {
      text: task.next_action?.text ?? '',
      owner: task.next_action?.owner ?? 'unknown',
      since: task.next_action?.since ?? null
    },
    progress: task.progress ?? {},
    blockers,
    workers: {
      total: workerRows.length,
      live: workerRows.filter((r) => r.live).length,
      byClass,
      hoistedBlockers: blockers.filter((b) => b.raisedByWorker)
    },
    workerRows,
    freshness: taskFreshness(task, hostBoot),
    attention: { needed: attentionReasons.length > 0, reasons: attentionReasons },
    open: openActionFor(ownerNodeId, ownerNode, task.owner?.session ?? null, task.owner?.provider ?? null),
    dependencies: task.dependencies ?? [],
    retiredNodes: (task.retired_nodes ?? []).map((r) => ({
      node: r.node,
      until: r.until ?? null,
      disposition: r.disposition ?? null
    })),
    sessionLineage: task.session_lineage ?? [],
    artifacts: task.artifacts ?? {}
  }
}

function toBlockerView(b: TaskBlocker, workerIds: Set<string>): BlockerView {
  const node = b.node ?? null
  return {
    id: b.id,
    kind: b.kind,
    text: b.text,
    owner: b.owner,
    since: b.since ?? null,
    node,
    role: b.role ?? null,
    // v0.1 added `blockers[].node`. Attribution comes from it and from nothing else: the earlier
    // plan of parsing a leading `term-…` out of `where` was explicitly dropped, and a `where` like
    // `briefs/3/review.md:23-60` shows why it could never have held.
    raisedByWorker: !!node && workerIds.has(node),
    quote: b.quote ?? null,
    suggested: b.suggested ?? null,
    where: b.where ?? null
  }
}

// ---------------------------------------------------------------------------
// The six saved views
// ---------------------------------------------------------------------------

/**
 * Prefer the registry's own precomputed list; recompute only what it does not carry.
 *
 * `all` is never precomputed — it is not a filter, it is the absence of one — so it is always
 * recomputed. The other four are the contract's, and the local recomputation is the fallback for a
 * registry that predates them or drops one. `source` is reported so a divergence is visible rather
 * than silent.
 */
export function resolveView(
  registry: TaskRegistry,
  taskViews: readonly TaskView[],
  name: ViewName
): ViewResult {
  const known = new Set(taskViews.map((t) => t.taskId))
  const fromRegistry = (list: unknown): string[] | null =>
    Array.isArray(list) ? list.filter((id): id is string => typeof id === 'string' && known.has(id)) : null

  const views = registry.views ?? ({} as TaskRegistry['views'])
  if (name === 'all') {
    return { name, taskIds: taskViews.map((t) => t.taskId), source: 'recomputed' }
  }
  if (name === 'workers_by_task') {
    // Not a task list: it is a per-task roster, answered by `TaskView.workerRows`. Returning every
    // task that HAS a worker keeps the signature honest for a caller iterating view names.
    return {
      name,
      taskIds: taskViews.filter((t) => t.workers.total > 0).map((t) => t.taskId),
      source: views.workers_by_task ? 'registry' : 'recomputed'
    }
  }

  const precomputed = fromRegistry((views as Record<string, unknown>)[name])
  if (precomputed) return { name, taskIds: precomputed, source: 'registry' }

  const directorTasks = new Set<string>()
  for (const node of Object.values(registry.nodes ?? {})) {
    if (node?.role === 'director' && node.task_id) directorTasks.add(node.task_id)
  }
  switch (name) {
    case 'needs_attention':
      return { name, taskIds: taskViews.filter((t) => t.attention.needed).map((t) => t.taskId), source: 'recomputed' }
    case 'primary':
      return {
        name,
        taskIds: taskViews
          .filter((t) => t.pinned || t.owner.kind === 'operator' || directorTasks.has(t.taskId))
          .map((t) => t.taskId),
        source: 'recomputed'
      }
    case 'active':
      return {
        name,
        taskIds: taskViews.filter((t) => !CLOSED_STAGES.includes(t.stage) && t.owner.live).map((t) => t.taskId),
        source: 'recomputed'
      }
    case 'inactive': {
      const active = new Set(
        taskViews.filter((t) => !CLOSED_STAGES.includes(t.stage) && t.owner.live).map((t) => t.taskId)
      )
      return { name, taskIds: taskViews.filter((t) => !active.has(t.taskId)).map((t) => t.taskId), source: 'recomputed' }
    }
    default:
      return { name, taskIds: [], source: 'recomputed' }
  }
}

/** The six saved views, in the order they are offered. `all` is last and explicit-only. */
export const VIEW_NAMES: readonly ViewName[] = [
  'primary',
  'needs_attention',
  'active',
  'workers_by_task',
  'inactive',
  'all'
]

// ---------------------------------------------------------------------------
// Needs-attention, deduplicated
// ---------------------------------------------------------------------------

/**
 * One row per distinct `(kind, text, owner)`, naming every task it blocks.
 *
 * The contract's 21:58 ruling: the same blocker legitimately sits on more than one task, and each
 * task's own view must show it — only the aggregated operator-facing list dedupes, or the operator
 * is asked the same question twice.
 *
 * A task flagged only by a node CLASS (a session that hit a limit, a permission prompt, a dead
 * card) has no written blocker, so it gets a `session` row. Without it, "needs attention" would
 * list a task and then show nothing to act on.
 */
export function buildAttentionRows(
  taskViews: readonly TaskView[],
  attentionTaskIds: readonly string[]
): AttentionRow[] {
  const wanted = new Set(attentionTaskIds)
  const byKey = new Map<string, AttentionRow>()
  const push = (row: AttentionRow): void => {
    const seen = byKey.get(row.key)
    if (!seen) {
      byKey.set(row.key, row)
      return
    }
    for (const id of row.taskIds) if (!seen.taskIds.includes(id)) seen.taskIds.push(id)
    for (const r of row.raisedBy) {
      if (!seen.raisedBy.some((x) => x.node === r.node && x.taskId === r.taskId)) seen.raisedBy.push(r)
    }
    // Oldest wins: the age of the OLDEST task it has been blocking is the honest number.
    if (row.since && (!seen.since || row.since < seen.since)) seen.since = row.since
    if (!seen.quote && row.quote) seen.quote = row.quote
    if (!seen.suggested && row.suggested) seen.suggested = row.suggested
    if (!seen.where && row.where) seen.where = row.where
  }

  for (const task of taskViews) {
    if (!wanted.has(task.taskId)) continue
    for (const b of task.blockers) {
      if (b.owner !== 'operator') continue
      push({
        key: attentionKey(b.kind, b.text, b.owner),
        kind: b.kind,
        text: b.text,
        owner: b.owner,
        taskIds: [task.taskId],
        raisedBy: b.node ? [{ node: b.node, role: b.role, taskId: task.taskId }] : [],
        since: b.since,
        quote: b.quote,
        suggested: b.suggested,
        where: b.where
      })
    }
    for (const reason of task.attention.reasons) {
      if (reason.source !== 'session') continue
      // One row per CLASS, not per node: "8 sessions hit a usage limit" is one thing to act on,
      // and eight identical rows is the flat list this navigator exists to replace.
      const text = `session classed ${reason.nodeClass}`
      push({
        key: attentionKey('session', text, 'operator'),
        kind: 'session',
        text,
        owner: 'operator',
        taskIds: [task.taskId],
        raisedBy: [{ node: reason.node, role: null, taskId: task.taskId }],
        since: null,
        quote: null,
        suggested: null,
        where: null
      })
    }
  }
  return [...byKey.values()]
}

/** NUL separator, written as the escape `\x00`: it cannot occur in any of the three parts, so
 *  no two distinct triples can collide by concatenation. Written as an escape rather than as the
 *  raw byte because git classifies a file holding one as BINARY, and the whole file then renders
 *  as "Binary files differ" in every review surface (`src/shared/source-hygiene.test.ts`). */
export function attentionKey(kind: string, text: string, owner: string): string {
  return `${kind}\x00${text}\x00${owner}`
}

// ---------------------------------------------------------------------------
// The unregistered bucket
// ---------------------------------------------------------------------------

/**
 * Sessions that exist on disk with no node record at all. Explicitly requested only, joined to the
 * registry by session uuid where one matches, and NEVER given a synthetic task id — the registry
 * ruling is that an unclaimed session has none and never will, and inventing one would make the
 * navigator a second source of truth about what a task is.
 */
export function buildUnregisteredRows(
  nodes: Record<string, RegistryNode>,
  unregistered: readonly UnregisteredSession[]
): UnregisteredRow[] {
  const bySession = new Map<string, { nodeId: string; taskId: string | null }>()
  for (const [nodeId, node] of Object.entries(nodes)) {
    if (node?.session && !bySession.has(node.session)) {
      bySession.set(node.session, { nodeId, taskId: node.task_id ?? null })
    }
  }
  return unregistered.map((u) => {
    const join = bySession.get(u.session)
    return {
      session: u.session,
      provider: u.provider,
      account: u.account ?? null,
      project: u.project ?? null,
      path: u.path,
      lastModified: u.last_modified ?? null,
      sizeBytes: numberOrNull(u.size_bytes),
      joinedNode: join?.nodeId ?? null,
      joinedTaskId: join?.taskId ?? null
    }
  })
}

// ---------------------------------------------------------------------------
// Search and sort
// ---------------------------------------------------------------------------

export interface SearchHit {
  taskId: string
  /** Where the match landed, so a result can say why it is on the list. */
  matchedOn: Array<'title' | 'objective' | 'project' | 'task-id' | 'node-title' | 'session'>
}

/**
 * Case-insensitive substring search over task title, objective, project, task id, the titles of
 * the nodes joined to the task, and session ids.
 *
 * Node titles are searchable and are still never a KEY: matching one tells you which task to open,
 * and the task id is what identifies it. The fixture holds several byte-identical titles precisely
 * so a search that returned a title as an identity would collide.
 */
export function searchTasks(
  model: NavigatorModel,
  query: string,
  nodes: Record<string, RegistryNode> = {}
): SearchHit[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const nodeTitlesByTask = new Map<string, string[]>()
  const sessionsByTask = new Map<string, string[]>()
  for (const node of Object.values(nodes)) {
    if (!node?.task_id) continue
    if (node.title) {
      const list = nodeTitlesByTask.get(node.task_id) ?? []
      list.push(node.title)
      nodeTitlesByTask.set(node.task_id, list)
    }
    if (node.session) {
      const list = sessionsByTask.get(node.task_id) ?? []
      list.push(node.session)
      sessionsByTask.set(node.task_id, list)
    }
  }

  const hits: SearchHit[] = []
  for (const task of model.tasks) {
    const matchedOn: SearchHit['matchedOn'] = []
    if (task.title.toLowerCase().includes(q)) matchedOn.push('title')
    if (task.objective.toLowerCase().includes(q)) matchedOn.push('objective')
    if (task.project.toLowerCase().includes(q)) matchedOn.push('project')
    if (task.taskId.toLowerCase().includes(q)) matchedOn.push('task-id')
    if ((nodeTitlesByTask.get(task.taskId) ?? []).some((t) => t.toLowerCase().includes(q))) {
      matchedOn.push('node-title')
    }
    const sessions = [...(sessionsByTask.get(task.taskId) ?? []), ...task.sessionLineage]
    if (sessions.some((s) => s.toLowerCase().includes(q))) matchedOn.push('session')
    if (matchedOn.length) hits.push({ taskId: task.taskId, matchedOn })
  }
  return hits
}

export type SortKey = 'stage' | 'freshness' | 'project' | 'attention'
export type SortDirection = 'asc' | 'desc'

/** Stage order for sorting: the work that still needs someone first, finished work last. */
const STAGE_ORDER: readonly TaskStage[] = [
  'waiting-operator',
  'blocked',
  'review',
  'verifying',
  'building',
  'briefing',
  'planned',
  'done',
  'abandoned'
]

/** Sort a task list. Pure and total: an unknown stage sorts last rather than throwing, and ties
 *  break on task id so two runs over the same input print the same order. */
export function sortTasks(
  rows: readonly TaskView[],
  key: SortKey,
  direction: SortDirection = 'asc'
): TaskView[] {
  const sign = direction === 'desc' ? -1 : 1
  const rank = (t: TaskView): number => {
    switch (key) {
      case 'stage': {
        const i = STAGE_ORDER.indexOf(t.stage)
        return i === -1 ? STAGE_ORDER.length : i
      }
      case 'freshness':
        // Freshest first. An unknown age sorts last: "we do not know" is not "just seen".
        return t.owner.freshness.observationAgeS ?? Number.MAX_SAFE_INTEGER
      case 'attention':
        return t.attention.needed ? 0 : 1
      case 'project':
      default:
        return 0
    }
  }
  return [...rows].sort((a, b) => {
    if (key === 'project') {
      const byProject = a.project.localeCompare(b.project)
      if (byProject !== 0) return sign * byProject
    } else {
      const byRank = rank(a) - rank(b)
      if (byRank !== 0) return sign * byRank
    }
    return a.taskId.localeCompare(b.taskId)
  })
}

// ---------------------------------------------------------------------------
// Intents — the model never writes
// ---------------------------------------------------------------------------

/**
 * A pin, an unpin and a promotion are SHARED state in the registry, not display preferences: a pin
 * set from a phone has to survive a restart and agree with the local canvas. So they are the
 * registry's own to write, through the registry's own writer, and this model only ever describes
 * the write it would like. Nothing here performs one.
 */
export type NavIntent =
  | { action: 'pin'; target: 'task'; taskId: string }
  | { action: 'unpin'; target: 'task'; taskId: string }
  | { action: 'pin'; target: 'node'; nodeId: string }
  | { action: 'unpin'; target: 'node'; nodeId: string }
  | { action: 'promote'; target: 'node'; nodeId: string; taskId: string }

export function pinIntent(taskId: string): NavIntent {
  return { action: 'pin', target: 'task', taskId }
}
export function unpinIntent(taskId: string): NavIntent {
  return { action: 'unpin', target: 'task', taskId }
}
export function promoteWorkerIntent(nodeId: string, taskId: string): NavIntent {
  return { action: 'promote', target: 'node', nodeId, taskId }
}

// ---------------------------------------------------------------------------
// Display-local preferences
// ---------------------------------------------------------------------------

/**
 * Sort direction, collapse state and which view is open are DISPLAY-LOCAL: they describe one
 * device's layout, not the work, so they live beside the registry in `view-prefs.json` and are
 * never written into the registry itself. The reader owns the file; this owns its shape.
 */
export interface ViewPrefs {
  version: 1
  view: ViewName
  sort: { key: SortKey; direction: SortDirection }
  collapseWorkers: boolean
}

export const VIEW_PREFS_FILENAME = 'view-prefs.json'

export const DEFAULT_VIEW_PREFS: ViewPrefs = {
  version: 1,
  view: 'needs_attention',
  sort: { key: 'attention', direction: 'asc' },
  collapseWorkers: true
}

const SORT_KEYS: readonly SortKey[] = ['stage', 'freshness', 'project', 'attention']

/**
 * Coerce anything at all into a usable `ViewPrefs`. The file is hand-editable and sits next to a
 * document served over a tunnel, so every field is re-validated by VALUE rather than trusted for
 * having a type; an unrecognized value falls back to the default rather than reaching a switch.
 */
export function normalizeViewPrefs(raw: unknown): ViewPrefs {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
  const sortRaw = src.sort && typeof src.sort === 'object' ? (src.sort as Record<string, unknown>) : {}
  const view = VIEW_NAMES.includes(src.view as ViewName) ? (src.view as ViewName) : DEFAULT_VIEW_PREFS.view
  const key = SORT_KEYS.includes(sortRaw.key as SortKey) ? (sortRaw.key as SortKey) : DEFAULT_VIEW_PREFS.sort.key
  const direction = sortRaw.direction === 'desc' ? 'desc' : 'asc'
  return {
    version: 1,
    view,
    sort: { key, direction },
    collapseWorkers: typeof src.collapseWorkers === 'boolean' ? src.collapseWorkers : true
  }
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

/** A finite number, or null. `undefined`, `null`, `NaN` and non-numbers are all "not known". */
export function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/** Epoch seconds from an ISO-8601 instant, or null. Offsets are honoured by `Date.parse`. */
export function isoToEpoch(iso: string | null | undefined): number | null {
  if (!iso || typeof iso !== 'string') return null
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? Math.round(ms / 1000) : null
}

/** `12s`, `4m`, `3h 10m`, `2d 4h` — short enough for a phone-width row. */
export function formatAge(seconds: number): string {
  const s = Math.max(0, Math.round(seconds))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) {
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    return m ? `${h}h ${m}m` : `${h}h`
  }
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  return h ? `${d}d ${h}h` : `${d}d`
}
