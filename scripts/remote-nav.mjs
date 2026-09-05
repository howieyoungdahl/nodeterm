#!/usr/bin/env node
/**
 * remote-nav — find the task that needs you, see its status and next step, and get the one line
 * that opens its session. Without sorting through every supporting terminal.
 *
 * WHY A CLI AT ALL. The surface this competes with is an account-wide session list reached from a
 * phone: on one measured host it returned 227 peers in 19 KB with no grouping, filter, search or
 * pin, and 7 of them were live. This runs over the same SSH connection that reaches the host and
 * answers the question that list cannot.
 *
 *   node scripts/remote-nav.mjs                 # needs-attention, then the active projects
 *   node scripts/remote-nav.mjs --view active   # primary|needs_attention|active|
 *                                               # workers_by_task|inactive|all
 *   node scripts/remote-nav.mjs --task <id>     # one task in full (--workers to expand them)
 *   node scripts/remote-nav.mjs --search <text>
 *   node scripts/remote-nav.mjs --all           # includes the unregistered bucket; explicit only
 *   node scripts/remote-nav.mjs --json          # machine-readable
 *
 * The registry it reads is `$NODETERM_TASK_REGISTRY`, an absolute path to a JSON document in the
 * shared task-registry shape. There is no default: unset is reported as "no registry configured",
 * which is a different fact from "no tasks" and is printed as such.
 *
 * NO BUILD STEP. This loads the pure model and renderer straight from their TypeScript sources
 * through Node's built-in type stripping, so a checkout on the host is enough — nothing has to be
 * compiled first, which is the whole point of having it reachable over SSH. Those two modules
 * therefore carry no runtime imports of their own (see the header of `src/shared/remote-nav/
 * model.ts`); the version floor that costs us is checked below and reported plainly.
 *
 * READ-ONLY on the registry. Pins and task closure are the registry's own shared state, written
 * through the registry's own writer; `--pin` here prints the intent and performs nothing.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// Type stripping runs `.ts` without a compiler. It is unflagged from Node 22.18 and 23.6; on an
// older runtime the import below fails with a syntax error that says nothing about the cause, so
// the cause is stated here instead.
const [major, minor] = process.versions.node.split('.').map(Number)
const STRIPS_TYPES = major > 23 || (major === 23 && minor >= 6) || (major === 22 && minor >= 18)
if (!STRIPS_TYPES) {
  process.stderr.write(
    `remote-nav needs Node 22.18+ or 23.6+ (found ${process.versions.node}).\n` +
      'It runs the TypeScript sources directly through the runtime\'s own type stripping so that a\n' +
      'checkout is enough — there is nothing to build. Upgrade Node, or run it on a host that has one.\n'
  )
  process.exit(2)
}

const here = path.dirname(fileURLToPath(import.meta.url))
const model = await import(path.join(here, '../src/shared/remote-nav/model.ts'))
const render = await import(path.join(here, '../src/shared/remote-nav/render.ts'))

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

/**
 * `--flag value`, `--flag=value`, and valueless flags anywhere on the line. The next token is only
 * consumed when it is not itself a flag, so `--all --view active` cannot silently swallow `--view`
 * as `--all`'s value — the same peeking rule the canvas-control shim had to learn.
 */
function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (!token.startsWith('--')) {
      out._.push(token)
      continue
    }
    const eq = token.indexOf('=')
    if (eq !== -1) {
      out[token.slice(2, eq)] = token.slice(eq + 1)
      continue
    }
    const name = token.slice(2)
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      out[name] = next
      i++
    } else {
      out[name] = true
    }
  }
  return out
}

const args = parseArgs(process.argv.slice(2))

if (args.help || args.h) {
  process.stdout.write(
    [
      'remote-nav — the task-first view of the sessions on this host',
      '',
      '  --view <name>   primary | needs_attention | active | workers_by_task | inactive | all',
      '  --task <id>     one task in full',
      '  --workers       expand the worker roster instead of collapsing it to a count',
      '  --search <text> search title, objective, project, task id, session ids and node titles',
      '  --all           every task plus the unregistered session bucket',
      '  --sort <key>    stage | freshness | project | attention',
      '  --json          machine-readable output',
      '  --registry <p>  read this file instead of $NODETERM_TASK_REGISTRY',
      '  --pin <id>      print the registry write that would pin a task (performs nothing)',
      '',
      `registry: $${model.REGISTRY_ENV_VAR} (absolute path; no default)`,
      ''
    ].join('\n')
  )
  process.exit(0)
}

// ---------------------------------------------------------------------------
// Read the registry — the same decider the app's core reader uses
// ---------------------------------------------------------------------------

/**
 * The filesystem half. It is deliberately tiny and the DECISION it feeds is shared: the app's
 * reader (`src/core/remote-nav/registry-reader.ts`) and this CLI both hand a `RegistrySource` to
 * `classifyRegistryPayload`, so the two surfaces cannot disagree about what "missing", "unreadable"
 * or "stale" means. Only the `fs` call differs, because core's reader is async and bundled while
 * this one must run from source.
 */
function readSource(explicitPath) {
  const env = explicitPath ? { [model.REGISTRY_ENV_VAR]: explicitPath } : process.env
  const resolved = model.resolveRegistryPath(env)
  if (!resolved.path) return { source: { kind: 'unset' }, reason: resolved.reason }
  try {
    return { source: { kind: 'text', path: resolved.path, text: readFileSync(resolved.path, 'utf-8') }, reason: null }
  } catch (e) {
    // ENOENT is the only code that proves absence. Everything else is a failed read, and a failed
    // read is never evidence that there is no work.
    const detail = e && e.message ? e.message : String(e)
    return {
      source:
        e && e.code === 'ENOENT'
          ? { kind: 'missing', path: resolved.path, detail }
          : { kind: 'unreadable', path: resolved.path, detail },
      reason: null
    }
  }
}

const explicit = typeof args.registry === 'string' ? args.registry : null
const { source, reason } = readSource(explicit)
const read = model.classifyRegistryPayload(source, Date.now())

if (!read.ok) {
  const failure = reason ? { ...read, message: reason } : read
  if (args.json) {
    process.stdout.write(`${JSON.stringify(failure, null, 2)}\n`)
  } else {
    process.stdout.write(`${render.renderReadFailure(failure).join('\n')}\n`)
  }
  // A distinct exit code per failure, so a script calling this can tell "not configured" from
  // "the file is gone" without parsing prose.
  const codes = {
    'no-registry-configured': 3,
    'registry-missing': 4,
    'registry-unreadable': 5,
    'registry-unparseable': 6
  }
  process.exit(codes[failure.kind] ?? 1)
}

// ---------------------------------------------------------------------------
// Build and print
// ---------------------------------------------------------------------------

// The unregistered bucket is sessions on disk that no task claims. The registry contract does not
// carry them — `nodes{}` is what a supervisor observes — so this reads an OPTIONAL top-level
// `unregistered[]` when a producer supplies one (an unknown field is allowed and ignored by
// everything else). nodeterm does not scan the provider session stores itself; when nothing
// supplies the array, `--all` says the bucket is empty rather than implying there is nothing there.
const nav = model.buildNavigator({
  registry: read.registry,
  unregistered: Array.isArray(read.registry.unregistered) ? read.registry.unregistered : [],
  path: read.path,
  nowMs: Date.now()
})

const renderOpts = { expandWorkers: !!args.workers }
let lines
let payload

if (typeof args.pin === 'string') {
  // The model describes the write; nothing here performs one. A pin is shared registry state and
  // belongs to the registry's own writer, so the CLI hands back the intent and says so.
  payload = { intent: model.pinIntent(args.pin) }
  lines = [
    `pin is registry state, not a display preference, so this tool does not write it.`,
    `intent: ${JSON.stringify(payload.intent)}`,
    `Run the registry's own writer to apply it.`
  ]
} else if (typeof args.task === 'string') {
  payload = { task: nav.tasksById[args.task] ?? null }
  lines = render.renderTask(nav, args.task, renderOpts)
} else if (typeof args.search === 'string') {
  const hits = model.searchTasks(nav, args.search, read.registry.nodes ?? {})
  payload = { query: args.search, hits }
  lines = render.renderSearch(nav, args.search, hits)
} else if (args.all) {
  payload = { tasks: nav.tasks, unregistered: nav.unregistered }
  lines = render.renderAll(nav, renderOpts)
} else if (typeof args.view === 'string') {
  const view = model.resolveView(read.registry, nav.tasks, args.view)
  if (args.view === 'all') {
    payload = { tasks: nav.tasks, unregistered: nav.unregistered }
    lines = render.renderAll(nav, renderOpts)
  } else {
    const ordered = typeof args.sort === 'string'
      ? model.sortTasks(view.taskIds.map((id) => nav.tasksById[id]).filter(Boolean), args.sort).map((t) => t.taskId)
      : view.taskIds
    payload = { view: view.name, source: view.source, taskIds: ordered }
    lines = render.renderView(nav, view.name, ordered, view.source, renderOpts)
  }
} else {
  payload = {
    attention: nav.attention,
    projects: nav.projects,
    counts: nav.counts
  }
  lines = render.renderDefault(nav, renderOpts)
}

if (args.json) {
  process.stdout.write(
    `${JSON.stringify(
      {
        path: nav.path,
        generated_at: nav.generatedAt,
        staleness: nav.staleness,
        counts: nav.counts,
        ...payload
      },
      null,
      2
    )}\n`
  )
} else {
  process.stdout.write(`${lines.join('\n')}\n`)
}

// A stale registry is data, so it prints — but it is not a success: a caller that acts on it
// should be able to tell without reading the banner.
process.exit(nav.staleness.generatedBeforeHostBoot ? 7 : 0)
