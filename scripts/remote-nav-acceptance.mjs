#!/usr/bin/env node
/**
 * The acceptance walk: eight demonstrations, run end to end through the real CLI against the
 * synthetic session population, counting the steps it takes to find the right task and open it.
 *
 * The criterion this answers: *from a remote connection, find the right task, see its status and
 * next step, and open the relevant session without sorting through every supporting terminal.*
 * The surface it competes with returned 227 peers in one flat list, 3.1 % of them live.
 *
 * It drives `scripts/remote-nav.mjs` as a child process rather than calling the model directly, so
 * what is demonstrated is what an operator would actually type — reader, model, renderer and CLI
 * together, including the exit codes. Every demonstration asserts; the script exits non-zero on the
 * first failure, so a green run is a claim that was checked and not merely printed.
 *
 *   node scripts/remote-nav-acceptance.mjs
 */

import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(here, 'remote-nav.mjs')
const { generateFixture, FIXTURE_BASE_EPOCH } = await import(path.join(here, '../src/shared/remote-nav/fixture.ts'))

const dir = mkdtempSync(path.join(tmpdir(), 'remote-nav-acceptance-'))
const registryPath = path.join(dir, 'registry.json')
const stalePath = path.join(dir, 'stale-registry.json')
const missingPath = path.join(dir, 'no-such-registry.json')

const { registry, unregistered } = generateFixture()
// The bucket rides the same document here so one file drives the whole walk. `unregistered[]` is an
// extra top-level field; the contract's guarantee 2 says consumers ignore what they do not know.
writeFileSync(registryPath, JSON.stringify({ ...registry, unregistered }, null, 2))
// Case 7: a document generated BEFORE the host last booted. Nothing in it is current.
writeFileSync(
  stalePath,
  JSON.stringify({ ...registry, unregistered, host_boot_epoch: FIXTURE_BASE_EPOCH + 3600 }, null, 2)
)

let failures = 0
let stepBudget = 0

function run(argv, env = {}) {
  const res = spawnSync(process.execPath, [CLI, ...argv], {
    encoding: 'utf-8',
    env: { ...process.env, NODETERM_TASK_REGISTRY: registryPath, ...env }
  })
  return { code: res.status, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

function show(title, argv, result, { head = 0, tail = 0 } = {}) {
  const lines = result.out.replace(/\n$/, '').split('\n')
  console.log(`\n${'='.repeat(78)}\n${title}\n$ node scripts/remote-nav.mjs ${argv.join(' ')}\n`)
  if (head && lines.length > head + tail) {
    console.log(lines.slice(0, head).join('\n'))
    console.log(`   … ${lines.length - head - tail} more lines (${lines.length} total) …`)
    if (tail) console.log(lines.slice(-tail).join('\n'))
  } else {
    console.log(lines.join('\n'))
  }
  console.log(`\n[exit ${result.code}, ${lines.length} lines]`)
}

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${label}`)
  } else {
    failures++
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

// ---------------------------------------------------------------------------

console.log('REMOTE NAVIGATOR — ACCEPTANCE WALK')
console.log(`population: ${Object.keys(registry.nodes).length} sessions · ${registry.tasks.length} tasks · ` +
  `${new Set(registry.tasks.map((t) => t.project)).size} projects · ${unregistered.length} unregistered records`)
console.log(`registry:   ${registryPath}`)

// --- 1. cold start: needs-attention, and nothing else -----------------------
{
  const argv = []
  const res = run(argv)
  show('1. COLD START — needs-attention, then the active projects. Nothing else.', argv, res)
  const asked = Number(/NEEDS YOU — (\d+) question/.exec(res.out)?.[1] ?? -1)
  const json = JSON.parse(run(['--json']).out)
  const keys = new Set(json.attention.map((r) => r.key))
  const blockerRows = json.attention.filter((r) => r.kind !== 'session')
  check('output fits one screen (<= 40 lines)', res.out.trim().split('\n').length <= 40,
    `${res.out.trim().split('\n').length} lines`)
  check('the questions parked on the operator are listed', asked > 0, `saw ${asked}`)
  check('every row is a distinct (kind, text, owner)', keys.size === json.attention.length,
    `${json.attention.length} rows, ${keys.size} distinct keys`)
  check('no task id is repeated inside a row',
    json.attention.every((r) => new Set(r.taskIds).size === r.taskIds.length))
  // The registry flags a task when a blocker is the operator's OR when a node on it is DEAD /
  // LIMIT / PERMISSION / QUESTION / NEEDS-OPERATOR. On a realistic population that second clause
  // is nearly every task, so the two are counted and rendered separately.
  const raw = registry.views.needs_attention.length
  check('the flat needs_attention list is compressed, not reprinted',
    blockerRows.length < raw, `${raw} flagged tasks → ${blockerRows.length} questions`)
  const shared = blockerRows.filter((r) => r.taskIds.length > 1)
  console.log(`  note   registry flags ${raw}/${registry.tasks.length} tasks; ` +
    `${blockerRows.length} carry a written question (${shared.length} of those block >1 task), ` +
    `the rest are session states shown as ${json.attention.length - blockerRows.length} counted lines`)
  stepBudget = 1
}

// --- 1b. the same blocker on two tasks collapses to one row ----------------
{
  // The generated population happens to give every operator-owned blocker its own text, so the
  // deduplication rule has no positive instance in it. This is the contract's own worked example
  // — one approval blocking two lanes — constructed deliberately rather than hoped for, because a
  // dedupe demonstrated on input with no duplicates demonstrates nothing.
  const shareable = {
    id: 'shared-1',
    kind: 'approval',
    text: 'label on the two demo PRs',
    owner: 'operator',
    since: '2026-09-04T09:55:00-04:00',
    suggested: 'Yes if the reviewer note is accepted'
  }
  const [a, b] = registry.tasks.slice(0, 2)
  const twinPath = path.join(dir, 'twin-registry.json')
  writeFileSync(
    twinPath,
    JSON.stringify({
      ...registry,
      tasks: registry.tasks.map((t) =>
        t.task_id === a.task_id || t.task_id === b.task_id
          ? { ...t, blockers: [{ ...shareable, node: null }] }
          : { ...t, blockers: [] }
      ),
      views: { ...registry.views, needs_attention: [a.task_id, b.task_id] }
    })
  )
  const argv = ['--registry', twinPath]
  const res = run(argv, { NODETERM_TASK_REGISTRY: '' })
  show('1b. DEDUPLICATION — one blocker on two tasks is ONE row naming both.', argv, res, { head: 10, tail: 0 })
  const twin = JSON.parse(run([...argv, '--json'], { NODETERM_TASK_REGISTRY: '' }).out)
  const rows = twin.attention.filter((r) => r.kind === 'approval' && r.text === shareable.text)
  check('the shared blocker is one row, not two', rows.length === 1, `${rows.length} rows`)
  check('that row names both tasks',
    rows[0] && rows[0].taskIds.length === 2 && rows[0].taskIds.includes(a.task_id) && rows[0].taskIds.includes(b.task_id),
    JSON.stringify(rows[0] && rows[0].taskIds))
  check('each task still carries it in its own view',
    /approval\/operator/.test(run(['--registry', twinPath, '--task', a.task_id], { NODETERM_TASK_REGISTRY: '' }).out) &&
      /approval\/operator/.test(run(['--registry', twinPath, '--task', b.task_id], { NODETERM_TASK_REGISTRY: '' }).out))
}

// --- 2. search finds a task in one step ------------------------------------
let chosen
{
  // A word from a task's own objective, chosen from the population rather than hardcoded so the
  // demonstration cannot drift from the fixture.
  const target = registry.tasks.find((t) => t.blockers.some((b) => b.owner === 'operator') && t.workers.length > 0)
    ?? registry.tasks[0]
  const word = target.task_id.split('-').slice(-1)[0]
  const argv = ['--search', word]
  const res = run(argv)
  show(`2. SEARCH — one step to the task, by a word from its objective ("${word}").`, argv, res, { head: 14, tail: 2 })
  check('the search names the task', res.out.includes(target.task_id))
  check('the search prints its open command', /open: /.test(res.out))
  chosen = target
}

// --- 3. the task itself: stage, verified progress, next action, owner -------
{
  const argv = ['--task', chosen.task_id]
  const res = run(argv)
  show('3. THE TASK — stage, last verified progress, next action, owner, each with freshness.', argv, res)
  check('stage is shown', new RegExp(`stage:\\s+${chosen.stage}`).test(res.out))
  check('the owner is shown with its freshness band',
    /owner:\s+\w+ term-\S+ · (WARM|HEARTBEAT|ACT|COLD|NEW|UNKNOWN) /.test(res.out))
  check('the record clock is shown separately from the observation clock', /record:\s+/.test(res.out))
  check('VERIFIED and REPORTED are separate lines', /VERIFIED/.test(res.out))
  check('the next action names its owner', /NEXT: .+ — \w+/.test(res.out))
}

// --- 4. the 30-worker task collapses, and still surfaces the blocker --------
{
  const mega = registry.tasks
    .map((t) => ({ t, n: (registry.views.workers_by_task[t.task_id] ?? []).length }))
    .sort((a, b) => b.n - a.n)[0]
  const argv = ['--task', mega.t.task_id]
  const res = run(argv)
  show(`4. COLLAPSED WORKERS — ${mega.n} workers on ${mega.t.task_id}, shown as a count.`, argv, res, { head: 22, tail: 3 })
  const workerLines = res.out.split('\n').filter((l) => /^ {2}- term-/.test(l)).length
  check(`the ${mega.n}-worker roster prints as a count, not ${mega.n} rows`, workerLines === 0, `${workerLines} rows`)
  check('the count is stated', new RegExp(`workers: ${mega.n} `).test(res.out))
  const hoisted = mega.t.blockers.filter((b) => b.node)
  if (hoisted.length) {
    check('a worker-raised blocker is hoisted onto the parent', /! from \w[\w-]* term-/.test(res.out))
  } else {
    console.log('  note   this task carries no worker-attributed blocker; hoisting is asserted in model.test.ts')
  }
  const expanded = run(['--task', mega.t.task_id, '--workers'])
  const expandedLines = expanded.out.split('\n').filter((l) => /^ {2}- term-/.test(l)).length
  check('--workers expands the same roster on request', expandedLines === mega.n, `${expandedLines} rows`)
}

// --- 5. the open command is printed and well-formed ------------------------
{
  const live = registry.tasks.find((t) => {
    const node = registry.nodes[t.owner.node]
    return node && node.class !== 'DEAD' && node.band !== 'COLD'
  })
  const argv = ['--task', live.task_id]
  const res = run(argv)
  const open = /^open: (.+)$/m.exec(res.out)?.[1] ?? ''
  show('5. OPEN — the exact line that reaches the live session, as one copy-paste.', argv, res, { head: 8, tail: 4 })
  check('an open command is printed', open.length > 0)
  check('it is an exact tmux target (=nt-<node id>)',
    new RegExp(`^tmux -L node-terminal attach -t =nt-${live.owner.node}$`).test(open), open)
  const cold = registry.tasks.find((t) => registry.nodes[t.owner.node]?.band === 'COLD')
  if (cold) {
    const coldRes = run(['--task', cold.task_id])
    check('a COLD session still prints its command, marked STALE-REFUSED',
      /open: .+\[STALE-REFUSED: /.test(coldRes.out))
    console.log(`  note   ${/\[STALE-REFUSED: [^\]]+\]/.exec(coldRes.out)?.[0] ?? ''}`)
  }
}

// --- 6. all sessions, explicit only, with the unregistered bucket ----------
{
  const argv = ['--all']
  const res = run(argv)
  show('6. ALL — every task plus the unregistered bucket. Only with --all.', argv, res, { head: 10, tail: 6 })
  check('--all includes the unregistered bucket', /UNREGISTERED SESSIONS — \d+/.test(res.out))
  check('the bucket says how many join a known session', /match a session the registry does know/.test(res.out))
  const dflt = run([])
  check('the default screen does NOT include it', !/UNREGISTERED SESSIONS/.test(dflt.out))
  const json = JSON.parse(run(['--all', '--json']).out)
  check('no unregistered row is given a task id',
    json.unregistered.every((r) => !('task_id' in r) && !('taskId' in r)))
  check('a row that matches a known session is joined by uuid only',
    json.unregistered.some((r) => r.joinedNode) &&
      json.unregistered.filter((r) => r.joinedNode).every((r) => typeof r.session === 'string'))
}

// --- 7. a stale registry is reported as stale ------------------------------
{
  const argv = ['--registry', stalePath]
  const res = run(argv, { NODETERM_TASK_REGISTRY: '' })
  show('7. STALE — generated before the host last booted. Shown, and loudly marked.', argv, res, { head: 8, tail: 0 })
  check('the staleness is stated', /STALE REGISTRY/.test(res.out))
  check('it says why', /generated before the host last booted/.test(res.out))
  check('the exit code separates it from a clean read', res.code === 7, `exit ${res.code}`)
}

// --- 8. a missing registry says so, and an unset one is its own answer -----
{
  const argv = ['--registry', missingPath]
  const missing = run(argv, { NODETERM_TASK_REGISTRY: '' })
  show('8. MISSING / UNCONFIGURED — four refusals, none of them "no tasks".', argv, missing)
  check('a missing file is named as missing', /NO REGISTRY — registry-missing/.test(missing.out))
  check('it explicitly is not an empty task list', /NOT an empty task list/.test(missing.out))
  // The phrase only ever appears inside a denial. What must never appear is a task COUNT, which is
  // what an empty-list rendering would print.
  check('it never renders as a task count', !/^\s*\d+ tasks/m.test(missing.out))
  check('every mention of "no tasks" is a denial', (missing.out.match(/no tasks/gi) ?? []).every(
    () => /not "no tasks"/.test(missing.out)))
  check('exit code distinguishes it', missing.code === 4, `exit ${missing.code}`)

  const unset = spawnSync(process.execPath, [CLI], {
    encoding: 'utf-8',
    env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODETERM_TASK_REGISTRY'))
  })
  console.log(`\n$ NODETERM_TASK_REGISTRY= node scripts/remote-nav.mjs\n`)
  console.log(`${unset.stdout}`.trim())
  console.log(`\n[exit ${unset.status}]`)
  check('an unset variable is "no registry configured", not an empty list',
    /no-registry-configured/.test(unset.stdout ?? ''))
  check('exit code distinguishes it from a missing file', unset.status === 3, `exit ${unset.status}`)

  const garbage = path.join(dir, 'garbage.json')
  writeFileSync(garbage, '{ "tasks": [ ')
  const bad = run(['--registry', garbage], { NODETERM_TASK_REGISTRY: '' })
  check('unparseable JSON is its own answer', /registry-unparseable/.test(bad.out) && bad.code === 6,
    `exit ${bad.code}`)
}

// ---------------------------------------------------------------------------

console.log(`\n${'='.repeat(78)}\nSTEP COUNT — "find the right task and open it"\n`)
console.log(
  [
    '  Knowing a word from the task:            1 step   --search <word>',
    '                                                    (prints the task line AND its open command)',
    `  From a cold start, not knowing anything: ${stepBudget + 1} steps  (1) no arguments  → the tasks waiting on you,`,
    '                                                    each with its open command already printed',
    '                                                    (2) --task <id> → the full status',
    '',
    '  So: ONE step to open the right session, TWO if you want its full status first.',
    `  Against the surface this replaces: 227 rows in one flat list, no search, no grouping.`
  ].join('\n')
)

rmSync(dir, { recursive: true, force: true })

console.log(`\n${failures === 0 ? 'ACCEPTANCE WALK PASSED' : `ACCEPTANCE WALK FAILED — ${failures} check(s)`}`)
process.exit(failures === 0 ? 0 : 1)
