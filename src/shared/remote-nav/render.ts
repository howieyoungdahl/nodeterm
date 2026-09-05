/**
 * The text the navigator prints.
 *
 * WHY IT IS ITS OWN MODULE. The rendering rules are the product here — "a task line shows stage,
 * freshness, next action and owner", "workers collapse to a count", "every task prints the exact
 * command to open its session", "the default output fits on a screen" — and rules that live only
 * inside a CLI's `console.log` calls cannot be tested. These are pure functions from a model to
 * lines, so `render.test.ts` asserts the shape of the output the operator actually reads.
 *
 * Like `model.ts`, this file has NO RUNTIME IMPORTS (every cross-module import is `import type`,
 * which is erased), because `scripts/remote-nav.mjs` loads it directly through Node's built-in type
 * stripping with no build step. See the header of `model.ts` for why that constraint exists.
 *
 * TWO RULES THE OUTPUT OBEYS:
 *   1. **Freshness never appears without its status.** Contract §4 guarantee 4: a consumer must
 *      show freshness alongside any badge. Every status line here carries its band and age.
 *   2. **A refusal is a sentence, never an empty list.** `renderReadFailure` prints what went wrong
 *      and what to do about it; nothing in this file can render "no tasks" for a registry it could
 *      not read.
 */

import type {
  AttentionRow,
  NavigatorModel,
  OpenAction,
  SearchHit,
  RegistryRead,
  TaskView,
  UnregisteredRow,
  ViewName
} from './model'

/** Roughly one phone-terminal screen. The surface this replaces printed 227 rows. */
export const DEFAULT_SCREEN_LINES = 40

/** Widest a title may print before it is cut. Counted in code points, so an emoji or a CJK
 *  character is one unit and a surrogate pair is never split in half. */
const TITLE_WIDTH = 46
const TASK_ID_WIDTH = 24
const STAGE_WIDTH = 16
const FRESHNESS_WIDTH = 24

/** How many ids a summary row names before it says "+N more". Naming all of them is what the flat
 *  list this replaces already does: one measured row named 25 tasks and 95 sessions. */
const IDS_IN_SUMMARY = 4

export interface RenderOptions {
  /** Cap the body at this many lines, appending a truthful "…and N more" note. 0 = no cap. */
  maxLines?: number
  /** Expand every worker instead of collapsing to a count. */
  expandWorkers?: boolean
  /** Print the `open:` line under every task row. On by default: reaching the session in one
   *  copy-paste is the acceptance criterion, not a detail view. */
  showOpen?: boolean
}

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

/**
 * What to print when the registry could not be read. Each of the four refusals says what happened
 * AND what would fix it, because the four have four different fixes and a shared "unavailable"
 * would send the operator looking in the wrong place.
 */
export function renderReadFailure(read: Extract<RegistryRead, { ok: false }>): string[] {
  const lines = [`NO REGISTRY — ${read.kind}`, '', read.message, '']
  switch (read.kind) {
    case 'no-registry-configured':
      lines.push(
        `Set it to the file a task-registry producer writes, for example:`,
        `  export ${read.envVar}=/absolute/path/to/registry.json`
      )
      break
    case 'registry-missing':
      lines.push(
        'Either the producer has not written it yet, or the path moved.',
        'This is NOT an empty task list — nothing is known about any task.'
      )
      break
    case 'registry-unreadable':
      lines.push(
        'The file is there and could not be read, so its contents are unknown.',
        'A failed read is not evidence that there is no work.'
      )
      break
    case 'registry-unparseable':
      lines.push(
        'The producer may have been mid-write, or the file is not a task registry.',
        'Re-run the producer and try again.'
      )
      break
  }
  return lines
}

// ---------------------------------------------------------------------------
// Header — the provenance line, verbatim
// ---------------------------------------------------------------------------

/**
 * Provenance, printed before anything else and never omitted: which file, when it was generated,
 * which generation of the source it came from, and — loudly — whether it predates the host's boot.
 *
 * The registry's own age and each node's observation age are printed SEPARATELY and never summed.
 * Adding them would be synthesizing a freshness number the producer never stated, which the
 * contract forbids for exactly the reason it matters here: a made-up age is indistinguishable from
 * a measured one once it is on the screen.
 */
export function renderHeader(model: NavigatorModel): string[] {
  const parts: string[] = []
  const age = model.staleness.registryAgeS
  parts.push(
    `registry ${model.path ?? '(in memory)'}` +
      `  generated ${model.generatedAt ?? 'unknown'}` +
      (age === null ? '' : ` (${formatAge(age)} ago)`) +
      (model.sourceGeneration === null ? '' : ` · gen ${model.sourceGeneration}`)
  )
  if (model.staleness.generatedBeforeHostBoot) {
    parts.push(`!! ${model.staleness.message}`)
  }
  // The two attention numbers are printed separately and named differently on purpose. The
  // registry's `needs_attention` is nearly every task on a realistic host (its node-class clause
  // includes DEAD); the number that means "somebody is waiting on an answer from you" is the count
  // of questions parked on the operator. Printing only the first taught the reader to ignore it.
  const asks = model.attention.filter((r) => r.kind !== 'session').length
  parts.push(
    `${model.counts.tasks} tasks · ${model.counts.active} active · ${asks} asking you ` +
      `(${model.counts.needsAttention} flagged) · ${model.counts.nodes} sessions (${model.counts.deadNodes} dead)`
  )
  return parts
}

// ---------------------------------------------------------------------------
// Task rows
// ---------------------------------------------------------------------------

/** stage · freshness · next action · owner — the four facts a task line owes, on one line. */
export function taskLine(task: TaskView): string {
  const pin = task.pinned ? '*' : ' '
  const stale = task.freshness.mayBeStale ? ' [stale]' : ''
  return (
    `${pin}${pad(task.taskId, TASK_ID_WIDTH)} ${pad(task.stage, STAGE_WIDTH)} ` +
    `${pad(task.owner.freshness.label, FRESHNESS_WIDTH)} ${task.owner.kind}${stale}`
  )
}

/** The detail lines under a task row: title, next action, workers, blockers, open command. */
export function taskDetailLines(task: TaskView, opts: RenderOptions = {}): string[] {
  const out: string[] = []
  out.push(`    ${truncate(task.title, TITLE_WIDTH * 2)}`)
  out.push(`    next: ${task.nextAction.text || '(none recorded)'} — ${task.nextAction.owner}`)
  out.push(`    ${workerSummaryLine(task)}`)
  for (const b of task.blockers) {
    const who = b.raisedByWorker && b.node ? ` (raised by ${b.role ?? 'worker'} ${b.node})` : ''
    out.push(`    ! ${b.kind}/${b.owner}: ${truncate(b.text, TITLE_WIDTH * 2)}${who}`)
  }
  if (opts.expandWorkers) {
    for (const w of task.workerRows) {
      out.push(`      - ${pad(w.node, 24)} ${pad(w.role, 16)} ${pad(w.state, 12)} ${w.freshness.label}`)
    }
  }
  if (opts.showOpen !== false) out.push(`    ${openLine(task.open)}`)
  return out
}

/**
 * Workers collapsed to a count — and the count NEVER hides the reason the task is stuck. Any
 * blocker a worker raised is hoisted onto the parent line, which is the entire point of collapsing
 * (contract reply R2). The per-class tally is what lets a 30-worker task say "3 need you" without
 * printing 30 rows.
 */
export function workerSummaryLine(task: TaskView): string {
  if (task.workers.total === 0) return 'workers: none'
  const classes = Object.entries(task.workers.byClass)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([cls, n]) => `${n} ${cls}`)
    .join(', ')
  const hoisted = task.workers.hoistedBlockers.length
  return (
    `workers: ${task.workers.total} (${task.workers.live} live) [${classes}]` +
    (hoisted ? ` · ${hoisted} blocker${hoisted === 1 ? '' : 's'} raised by a worker` : '')
  )
}

/**
 * The one copy-pasteable line that reaches the session.
 *
 * At `COLD` the command is still PRINTED — hiding it would leave no way to reach a cold session at
 * all — but it is marked as needing an explicit override, with the reason, because §6 forbids
 * typing into a session at that band without checking it first.
 */
export function openLine(open: OpenAction): string {
  if (!open.command) return `open: unavailable — ${open.note ?? 'no addressable session'}`
  if (open.requiresOverride && open.refusal) {
    return `open: ${open.command}   [STALE-REFUSED: ${open.refusal.reason}]`
  }
  return `open: ${open.command}${open.note ? `   (${open.note})` : ''}`
}

// ---------------------------------------------------------------------------
// Needs attention
// ---------------------------------------------------------------------------

/**
 * The deduplicated operator-facing list. One row per distinct `(kind, text, owner)`, naming the
 * tasks it blocks together — the contract's ruling, and the difference between being asked one
 * question and being asked the same question twice.
 *
 * THE TWO HALVES ARE PRINTED DIFFERENTLY, and the difference is the whole readability of this
 * screen. `views.needs_attention` flags a task when a blocker is the operator's OR when any node
 * joined to it carries an attention class — and the class clause includes `DEAD`, which on a
 * realistic population is most of the host: on the synthetic population, 117 of 320 sessions are
 * dead and 25 of 26 tasks are flagged by that clause alone.
 *
 *   - **A blocker is an ASK.** Somebody wrote a question down and parked it. It prints in full:
 *     the text, every task it blocks, who raised it, and the suggested answer.
 *   - **A session class is an OBSERVATION.** Nobody asked anything; the tick saw a dead card. It
 *     prints as ONE counted line — "session classed DEAD · 25 tasks · 95 sessions" — because the
 *     alternative is a row naming 25 task ids and 95 node ids, which is precisely the undifferentiated
 *     flat list this navigator exists to replace. The first draft of this function did exactly that.
 *
 * Nothing is dropped: the counts are exact, and `--view needs_attention` lists the tasks.
 */
export function renderAttention(rows: readonly AttentionRow[], limit = 0): string[] {
  if (rows.length === 0) return ['NEEDS YOU: nothing. No blocker is parked on the operator.']
  const asks = rows.filter((r) => r.kind !== 'session')
  const observed = rows.filter((r) => r.kind === 'session')
  const shown = limit > 0 ? asks.slice(0, limit) : asks

  const out: string[] = [
    `NEEDS YOU — ${asks.length} question${asks.length === 1 ? '' : 's'} parked on you across ${countTasks(
      asks
    )} task${countTasks(asks) === 1 ? '' : 's'}`
  ]
  if (asks.length === 0) out.push('  (nothing is parked on you — the rows below are session states, not asks)')
  shown.forEach((row, i) => {
    out.push(` ${i + 1}. ${row.kind}: ${truncate(row.text, TITLE_WIDTH * 2)}`)
    out.push(`    tasks: ${joinCapped(row.taskIds)}`)
    if (row.raisedBy.length) {
      out.push(`    raised by: ${joinCapped(row.raisedBy.map((r) => `${r.role ?? 'worker'} ${r.node}`))}`)
    }
    if (row.suggested) out.push(`    suggested: ${row.suggested}`)
  })
  if (shown.length < asks.length) out.push(` …and ${asks.length - shown.length} more (--view needs_attention)`)

  if (observed.length) {
    out.push(`SESSION STATES — no question attached, but the registry flags them:`)
    for (const row of observed) {
      out.push(
        `    ${pad(row.text, 30)} ${row.taskIds.length} task${row.taskIds.length === 1 ? '' : 's'} · ${
          row.raisedBy.length
        } session${row.raisedBy.length === 1 ? '' : 's'}`
      )
    }
  }
  return out
}

/** Name the first few and count the rest, rather than printing a line of eighty ids. */
function joinCapped(ids: readonly string[], cap = IDS_IN_SUMMARY): string {
  if (ids.length <= cap) return ids.join(', ')
  return `${ids.slice(0, cap).join(', ')} +${ids.length - cap} more`
}

function countTasks(rows: readonly AttentionRow[]): number {
  const ids = new Set<string>()
  for (const r of rows) for (const id of r.taskIds) ids.add(id)
  return ids.size
}

// ---------------------------------------------------------------------------
// The screens
// ---------------------------------------------------------------------------

/**
 * The default screen: what needs the operator, then the active projects, and nothing else.
 *
 * It is capped rather than complete. A complete listing is what the surface this replaces already
 * does, and it is unreadable; the cap says truthfully how much it left out and which flag shows the
 * rest.
 */
export function renderDefault(model: NavigatorModel, opts: RenderOptions = {}): string[] {
  const max = opts.maxLines ?? DEFAULT_SCREEN_LINES
  // Tasks carrying a question somebody parked on the operator, and tasks the registry flagged only
  // because a session on them is in an attention class. The first list is what to act on; the
  // second is a count, for the reason `renderAttention` explains at length.
  const asked = model.tasks.filter((t) => t.attention.reasons.some((r) => r.source === 'blocker'))
  const flaggedOnly = model.tasks.filter(
    (t) => t.attention.needed && !t.attention.reasons.some((r) => r.source === 'blocker')
  )
  const out: string[] = [...renderHeader(model), '']
  out.push(...renderAttention(model.attention, 3), '')

  if (asked.length) {
    out.push(`TASKS WITH A QUESTION FOR YOU — ${asked.length}`)
    for (const task of asked.slice(0, 3)) {
      out.push(taskLine(task))
      out.push(...taskDetailLines(task, { ...opts, expandWorkers: false }))
    }
    if (asked.length > 3) out.push(` …and ${asked.length - 3} more (--view needs_attention)`)
    out.push('')
  }
  if (flaggedOnly.length) {
    out.push(
      `${flaggedOnly.length} further task${flaggedOnly.length === 1 ? ' is' : 's are'} flagged only by a ` +
        'session state (--view needs_attention)',
      ''
    )
  }

  out.push(`ACTIVE PROJECTS — ${model.projects.filter((p) => p.activeTaskIds.length).length}`)
  for (const project of model.projects) {
    if (!project.activeTaskIds.length) continue
    out.push(
      ` ${pad(project.project, 22)} ${project.activeTaskIds.length} active` +
        (project.attentionTaskIds.length ? ` · ${project.attentionTaskIds.length} need you` : '')
    )
  }
  out.push('', 'more: --view <primary|needs_attention|active|workers_by_task|inactive|all>')
  out.push('      --task <task_id> · --search <text> · --all (includes unregistered) · --json')
  return capLines(out, max, '--view all')
}

/** One saved view, as a task list. */
export function renderView(
  model: NavigatorModel,
  name: ViewName,
  taskIds: readonly string[],
  source: 'registry' | 'recomputed',
  opts: RenderOptions = {}
): string[] {
  const out: string[] = [...renderHeader(model), '']
  out.push(`VIEW ${name} — ${taskIds.length} task${taskIds.length === 1 ? '' : 's'} (${source})`)
  if (taskIds.length === 0) {
    out.push('  the registry lists no task in this view (this is a real answer, not a failed read)')
    return out
  }
  for (const id of taskIds) {
    const task = model.tasksById[id]
    if (!task) continue
    out.push(taskLine(task))
    out.push(...taskDetailLines(task, opts))
  }
  return capLines(out, opts.maxLines ?? 0, `--view ${name} --json`)
}

/** One task in full: stage, last verified progress, next action, owner, blockers, workers. */
export function renderTask(model: NavigatorModel, taskId: string, opts: RenderOptions = {}): string[] {
  const task = model.tasksById[taskId]
  if (!task) {
    const near = Object.keys(model.tasksById)
      .filter((id) => id.includes(taskId))
      .slice(0, 5)
    return [
      `No task "${taskId}" in this registry.`,
      ...(near.length ? [`Did you mean: ${near.join(', ')}`] : ['Run --search <text> to find one.'])
    ]
  }
  const out: string[] = [...renderHeader(model), '']
  out.push(`${task.pinned ? '* ' : ''}${task.taskId} — ${task.title}`)
  out.push(`project: ${task.project}${task.projectId ? ` (${task.projectId})` : ''}`)
  out.push(`stage:   ${task.stage}${task.stageSince ? ` since ${task.stageSince}` : ''}`)
  out.push(`owner:   ${task.owner.kind} ${task.owner.node} · ${task.owner.freshness.label}`)
  if (!task.owner.present) out.push('         !! the owner node is not in the registry at all')
  out.push(`record:  ${task.freshness.label}`)
  out.push(`objective: ${task.objective}`)
  out.push(`scope:     ${task.scope}`)
  out.push('')
  // The two progress slots are printed separately and never merged: a proven claim and an unproven
  // one are different facts, and collapsing them into "latest progress" is what the contract's
  // two-slot rule exists to prevent.
  if (task.progress.verified) {
    out.push(`VERIFIED ${task.progress.verified.at}: ${task.progress.verified.text}`)
    out.push(`  proof: ${task.progress.verified.proof}`)
  } else {
    out.push('VERIFIED: nothing has been verified with a proof command.')
  }
  if (task.progress.reported) {
    out.push(`REPORTED ${task.progress.reported.at}: ${task.progress.reported.text}  (unverified)`)
  }
  out.push('')
  out.push(`NEXT: ${task.nextAction.text || '(none recorded)'} — ${task.nextAction.owner}`)
  out.push('')
  out.push(workerSummaryLine(task))
  if (opts.expandWorkers) {
    for (const w of task.workerRows) {
      out.push(`  - ${pad(w.node, 24)} ${pad(w.role, 18)} ${pad(w.state, 12)} ${w.freshness.label}`)
    }
  } else if (task.workers.total) {
    out.push('  (--workers to list them)')
  }
  for (const b of task.workers.hoistedBlockers) {
    out.push(`  ! from ${b.role ?? 'worker'} ${b.node}: ${b.kind}/${b.owner} ${b.text}`)
  }
  out.push('')
  if (task.blockers.length) {
    out.push('BLOCKERS')
    for (const b of task.blockers) {
      out.push(`  ${b.kind}/${b.owner} since ${b.since ?? 'unknown'}: ${b.text}`)
      if (b.quote) out.push(`    asked: ${b.quote}`)
      if (b.suggested) out.push(`    suggested: ${b.suggested}`)
      if (b.where) out.push(`    where: ${b.where}`)
    }
    out.push('')
  }
  if (task.dependencies.length) out.push(`depends on: ${task.dependencies.join(', ')}`, '')
  if (task.retiredNodes.length) {
    out.push(`history: ${task.retiredNodes.length} retired node(s), ${task.sessionLineage.length} session(s)`)
    for (const r of task.retiredNodes) out.push(`  ${r.node} until ${r.until ?? '?'} — ${r.disposition ?? ''}`)
    out.push('')
  }
  out.push(openLine(task.open))
  return out
}

/** Search results, newest match rules omitted on purpose: the point is to find ONE task fast. */
export function renderSearch(model: NavigatorModel, query: string, hits: readonly SearchHit[]): string[] {
  if (hits.length === 0) {
    return [`No task matches "${query}". Searched title, objective, project, task id, session ids and node titles.`]
  }
  const out = [`SEARCH "${query}" — ${hits.length} task${hits.length === 1 ? '' : 's'}`]
  for (const hit of hits) {
    const task = model.tasksById[hit.taskId]
    if (!task) continue
    out.push(taskLine(task))
    out.push(`    matched on: ${hit.matchedOn.join(', ')}`)
    out.push(`    ${truncate(task.title, TITLE_WIDTH * 2)}`)
    out.push(`    ${openLine(task.open)}`)
  }
  return out
}

/**
 * Everything, including the unregistered bucket — reachable only on explicit request.
 *
 * The bucket is kept visibly separate and its rows carry no task id, because they have none: they
 * are session records on disk that no task ever claimed, joined to the registry by session uuid
 * where one happens to match and never written back.
 */
export function renderAll(model: NavigatorModel, opts: RenderOptions = {}): string[] {
  const out: string[] = [...renderHeader(model), '']
  out.push(`ALL TASKS — ${model.tasks.length}`)
  for (const task of model.tasks) {
    out.push(taskLine(task))
    if (opts.showOpen !== false) out.push(`    ${openLine(task.open)}`)
  }
  out.push('')
  out.push(...renderUnregistered(model.unregistered))
  return capLines(out, opts.maxLines ?? 0, '--all --json')
}

export function renderUnregistered(rows: readonly UnregisteredRow[]): string[] {
  if (rows.length === 0) return ['UNREGISTERED SESSIONS — none reported.']
  const joined = rows.filter((r) => r.joinedNode).length
  const out = [
    `UNREGISTERED SESSIONS — ${rows.length} session record${rows.length === 1 ? '' : 's'} on disk that no task claims`,
    `  (${joined} of them match a session the registry does know; none is given a task id)`
  ]
  for (const row of rows) {
    out.push(
      `  ${pad(row.provider, 9)} ${pad(row.session, 38)} ${pad(row.project ?? '-', 16)} ${
        row.lastModified ?? 'unknown'
      }${row.joinedNode ? `  → node ${row.joinedNode}` : ''}`
    )
  }
  return out
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

/** Cut to `width` code points, never UTF-16 units — slicing units splits a surrogate pair and an
 *  emoji becomes a replacement character. The fixture carries a title across three scripts plus an
 *  emoji for exactly this reason. */
export function truncate(text: string, width: number): string {
  const chars = Array.from(text ?? '')
  if (chars.length <= width) return chars.join('')
  return `${chars.slice(0, Math.max(0, width - 1)).join('')}…`
}

export function pad(text: string, width: number): string {
  const cut = truncate(text ?? '', width)
  return cut + ' '.repeat(Math.max(0, width - Array.from(cut).length))
}

/** Cap the body, and say how much was left out and how to see it. Truthful by construction: it
 *  never claims to have shown everything. */
export function capLines(lines: readonly string[], max: number, moreHint: string): string[] {
  if (max <= 0 || lines.length <= max) return [...lines]
  const kept = lines.slice(0, Math.max(1, max - 1))
  return [...kept, `… ${lines.length - kept.length} more lines — ${moreHint}`]
}

/** Local copy of the model's age formatter: this module has no runtime imports (see the header),
 *  and the two are pinned equal by `render.test.ts`. */
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
