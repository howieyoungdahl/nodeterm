import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SCREEN_LINES,
  capLines,
  formatAge as renderFormatAge,
  openLine,
  pad,
  renderAll,
  renderAttention,
  renderDefault,
  renderHeader,
  renderReadFailure,
  renderSearch,
  renderTask,
  renderUnregistered,
  renderView,
  taskLine,
  truncate,
  workerSummaryLine
} from './render'
import {
  buildNavigator,
  classifyRegistryPayload,
  formatAge as modelFormatAge,
  resolveView,
  searchTasks
} from './model'
import type { RegistryRead } from './model'
import { FIXTURE_BASE_EPOCH, UNICODE_LONG_TITLE, generateFixture } from './fixture'

const { registry, unregistered } = generateFixture()
const NOW_MS = FIXTURE_BASE_EPOCH * 1000
const nav = buildNavigator({ registry, unregistered, nowMs: NOW_MS, path: '/state/registry.json' })

function failureOf(text: string, path = '/state/registry.json'): Extract<RegistryRead, { ok: false }> {
  const read = classifyRegistryPayload({ kind: 'text', path, text }, NOW_MS)
  if (read.ok) throw new Error('expected a failure')
  return read
}

describe('a refusal is a sentence, never an empty list', () => {
  const kinds: Array<[string, Extract<RegistryRead, { ok: false }>]> = [
    ['no-registry-configured', classifyRegistryPayload({ kind: 'unset' }, NOW_MS) as Extract<RegistryRead, { ok: false }>],
    [
      'registry-missing',
      classifyRegistryPayload({ kind: 'missing', path: '/r.json' }, NOW_MS) as Extract<RegistryRead, { ok: false }>
    ],
    [
      'registry-unreadable',
      classifyRegistryPayload({ kind: 'unreadable', path: '/r.json', detail: 'EACCES' }, NOW_MS) as Extract<
        RegistryRead,
        { ok: false }
      >
    ],
    ['registry-unparseable', failureOf('{ oops')]
  ]

  it.each(kinds)('%s names itself and says what would fix it', (kind, read) => {
    const lines = renderReadFailure(read)
    expect(lines[0]).toContain(kind)
    expect(lines.join('\n').length).toBeGreaterThan(60)
  })

  it('never renders a task count', () => {
    for (const [, read] of kinds) {
      expect(renderReadFailure(read).some((l) => /^\s*\d+ tasks/.test(l))).toBe(false)
    }
  })

  it('the four refusals do not print the same guidance', () => {
    const bodies = kinds.map(([, read]) => renderReadFailure(read).slice(4).join('\n'))
    expect(new Set(bodies).size).toBe(bodies.length)
  })
})

describe('the header carries provenance and both attention numbers', () => {
  it('names the file, the generation instant and the source generation', () => {
    const head = renderHeader(nav).join('\n')
    expect(head).toContain('/state/registry.json')
    expect(head).toContain(registry.generated_at)
    expect(head).toContain(`gen ${registry.source.generation}`)
  })

  it('separates "asking you" from the registry’s much larger flagged count', () => {
    // `views.needs_attention` includes every task holding a DEAD node, which is most of a real
    // host. Printing only that number teaches the reader to ignore it.
    const head = renderHeader(nav).join('\n')
    expect(head).toMatch(/\d+ asking you \(\d+ flagged\)/)
    const asking = Number(/(\d+) asking you/.exec(head)?.[1])
    const flagged = Number(/\((\d+) flagged\)/.exec(head)?.[1])
    expect(asking).toBeLessThan(flagged)
  })

  it('puts the staleness banner above everything when the registry predates the boot', () => {
    const stale = buildNavigator({
      registry: { ...registry, host_boot_epoch: FIXTURE_BASE_EPOCH + 3600 },
      nowMs: NOW_MS,
      path: '/r.json'
    })
    expect(renderHeader(stale)[1]).toMatch(/STALE REGISTRY/)
  })
})

describe('a task line shows stage, freshness, next action and owner', () => {
  const row = nav.tasks[0]

  it('the one-line form carries stage, band, age and owner kind', () => {
    const line = taskLine(row)
    expect(line).toContain(row.stage)
    expect(line).toContain(row.owner.freshness.band)
    expect(line).toContain(row.owner.kind)
  })

  it('the next action and its owner are on the detail lines', () => {
    const detail = renderTask(nav, row.taskId).join('\n')
    expect(detail).toContain(row.nextAction.text)
    expect(detail).toMatch(new RegExp(`NEXT: .* — ${row.nextAction.owner}`))
  })

  it('marks a pinned task and a stale record', () => {
    const pinned = nav.tasks.find((t) => t.pinned)
    if (pinned) expect(taskLine(pinned).startsWith('*')).toBe(true)
    const stale = nav.tasks.find((t) => t.freshness.mayBeStale)
    if (stale) expect(taskLine(stale)).toContain('[stale]')
  })

  it('keeps the verified and reported slots apart', () => {
    const both = nav.tasks.find((t) => t.progress.verified && t.progress.reported)
    expect(both).toBeTruthy()
    const out = renderTask(nav, both!.taskId).join('\n')
    expect(out).toMatch(/VERIFIED .*:/)
    expect(out).toMatch(/REPORTED .*: .*\(unverified\)/)
    expect(out).toContain(both!.progress.verified!.proof)
  })

  it('says plainly when nothing has been verified', () => {
    const none = nav.tasks.find((t) => !t.progress.verified)
    expect(renderTask(nav, none!.taskId).join('\n')).toContain('nothing has been verified')
  })

  it('offers near matches instead of an empty screen for an unknown task id', () => {
    const out = renderTask(nav, nav.tasks[0].project).join('\n')
    expect(out).toMatch(/No task/)
    expect(out).toMatch(/Did you mean|--search/)
  })
})

describe('workers collapse to a count', () => {
  const mega = nav.tasks.slice().sort((a, b) => b.workers.total - a.workers.total)[0]

  it('the population really does hold a task with 30+ workers', () => {
    expect(mega.workers.total).toBeGreaterThanOrEqual(30)
  })

  it('the summary line states the count, the live count and the per-class tally', () => {
    const line = workerSummaryLine(mega)
    expect(line).toContain(`workers: ${mega.workers.total}`)
    expect(line).toContain(`${mega.workers.live} live`)
    expect(line).toMatch(/\[\d+ \w/)
  })

  it('the collapsed view prints no per-worker row', () => {
    const out = renderTask(nav, mega.taskId)
    expect(out.filter((l) => /^ {2}- term-/.test(l))).toHaveLength(0)
    expect(out.join('\n')).toContain('--workers to list them')
  })

  it('--workers expands the same roster exactly', () => {
    const out = renderTask(nav, mega.taskId, { expandWorkers: true })
    expect(out.filter((l) => /^ {2}- term-/.test(l))).toHaveLength(mega.workers.total)
  })

  it('a worker-raised blocker is hoisted even while collapsed', () => {
    const hoisting = nav.tasks.find((t) => t.workers.hoistedBlockers.length > 0)
    expect(hoisting).toBeTruthy()
    expect(renderTask(nav, hoisting!.taskId).join('\n')).toMatch(/! from \S+ term-/)
  })

  it('says "none" rather than an empty tally for a task with no workers', () => {
    const bare = nav.tasks.find((t) => t.workers.total === 0)
    if (bare) expect(workerSummaryLine(bare)).toBe('workers: none')
  })
})

describe('the open command', () => {
  it('is printed for every task in a view', () => {
    const view = resolveView(registry, nav.tasks, 'active')
    const out = renderView(nav, 'active', view.taskIds, view.source).join('\n')
    for (const id of view.taskIds) expect(out).toContain(id)
    expect((out.match(/open: /g) ?? []).length).toBe(view.taskIds.length)
  })

  it('a COLD session is printed AND marked STALE-REFUSED', () => {
    const cold = nav.tasks.find((t) => t.open.requiresOverride)
    expect(cold).toBeTruthy()
    const line = openLine(cold!.open)
    expect(line).toContain('open: ')
    expect(line).toContain('[STALE-REFUSED:')
  })

  it('says what is missing when there is nothing to open', () => {
    expect(
      openLine({ command: null, kind: 'none', typingAllowed: false, refusal: null, requiresOverride: false, note: 'no session id recorded' })
    ).toContain('no session id recorded')
  })
})

describe('the default screen', () => {
  const out = renderDefault(nav)

  it('fits on one screen', () => {
    expect(out.length).toBeLessThanOrEqual(DEFAULT_SCREEN_LINES)
  })

  it('leads with what is parked on the operator', () => {
    expect(out.slice(0, 6).join('\n')).toMatch(/NEEDS YOU/)
  })

  it('does not reach the unregistered bucket without --all', () => {
    expect(out.join('\n')).not.toContain('UNREGISTERED SESSIONS')
  })

  it('says how to see the rest instead of implying it showed everything', () => {
    expect(out.join('\n')).toMatch(/--view|more lines/)
  })

  it('collapses session-state flags into counted lines rather than naming every id', () => {
    // The first draft of this printed one row naming 25 task ids and 95 node ids. That row is the
    // flat list this whole feature exists to replace.
    const body = out.join('\n')
    expect(body).toMatch(/SESSION STATES/)
    const longest = Math.max(...out.map((l) => l.length))
    expect(longest).toBeLessThan(200)
  })
})

describe('renderAttention', () => {
  it('says so plainly when nothing is parked on the operator', () => {
    expect(renderAttention([])[0]).toMatch(/nothing/i)
  })

  it('names the first few ids and counts the rest', () => {
    const rows = renderAttention([
      {
        key: 'k',
        kind: 'approval',
        text: 'a shared approval',
        owner: 'operator',
        taskIds: ['a', 'b', 'c', 'd', 'e', 'f'],
        raisedBy: [],
        since: null,
        quote: null,
        suggested: null,
        where: null
      }
    ])
    expect(rows.join('\n')).toContain('a, b, c, d +2 more')
  })

  it('keeps ask rows and session-state rows in separate sections', () => {
    const out = renderAttention(nav.attention)
    const askIndex = out.findIndex((l) => l.startsWith('NEEDS YOU'))
    const stateIndex = out.findIndex((l) => l.startsWith('SESSION STATES'))
    expect(askIndex).toBeLessThan(stateIndex)
  })
})

describe('--all and the unregistered bucket', () => {
  const out = renderAll(nav).join('\n')

  it('lists every task', () => {
    expect(out).toContain(`ALL TASKS — ${nav.tasks.length}`)
  })

  it('shows the bucket, marked, with the join count', () => {
    expect(out).toContain('UNREGISTERED SESSIONS')
    expect(out).toMatch(/match a session the registry does know/)
  })

  it('never prints a task id on an unregistered row', () => {
    const rows = renderUnregistered(nav.unregistered)
    for (const row of rows.slice(2)) {
      for (const task of nav.tasks) expect(row).not.toContain(task.taskId)
    }
  })

  it('says "none reported" rather than nothing at all for an empty bucket', () => {
    expect(renderUnregistered([])[0]).toMatch(/none reported/)
  })
})

describe('search output', () => {
  it('prints the task line, why it matched and the open command', () => {
    const target = nav.tasks[3]
    const hits = searchTasks(nav, target.taskId, registry.nodes)
    const out = renderSearch(nav, target.taskId, hits).join('\n')
    expect(out).toContain(target.taskId)
    expect(out).toMatch(/matched on: /)
    expect(out).toMatch(/open: /)
  })

  it('an empty result says what was searched instead of printing nothing', () => {
    const out = renderSearch(nav, 'zzzz-no-such-thing', []).join('\n')
    expect(out).toMatch(/No task matches/)
    expect(out).toMatch(/session ids/)
  })
})

describe('an empty view is a real answer, not a failure', () => {
  it('says the registry lists nothing in this view', () => {
    expect(renderView(nav, 'inactive', [], 'registry').join('\n')).toMatch(/not a failed read/)
  })
})

describe('text helpers', () => {
  it('truncates by code point, so a surrogate pair is never split', () => {
    const cut = truncate(UNICODE_LONG_TITLE, 10)
    expect(Array.from(cut)).toHaveLength(10)
    expect(cut).not.toContain('�')
    expect(cut.startsWith('📊')).toBe(true)
  })

  it('pads to a width counted the same way', () => {
    expect(Array.from(pad('📊', 4))).toHaveLength(4)
    expect(Array.from(pad(UNICODE_LONG_TITLE, 8))).toHaveLength(8)
  })

  it('caps truthfully, saying how many lines it withheld', () => {
    const capped = capLines(['a', 'b', 'c', 'd', 'e'], 3, '--all')
    expect(capped).toHaveLength(3)
    expect(capped[2]).toContain('3 more lines')
    expect(capped[2]).toContain('--all')
  })

  it('does not cap when it does not need to', () => {
    expect(capLines(['a', 'b'], 5, '--all')).toEqual(['a', 'b'])
    expect(capLines(['a', 'b'], 0, '--all')).toEqual(['a', 'b'])
  })

  it('formats ages exactly as the model does', () => {
    // The two copies exist because neither module may import the other at runtime (see their
    // headers); this is the guard that keeps them equal.
    for (const s of [0, 1, 59, 60, 599, 3599, 3600, 3661, 86399, 86400, 90061, 1000000]) {
      expect(renderFormatAge(s)).toBe(modelFormatAge(s))
    }
  })
})
