import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  recordDelivery,
  recentDeliveries,
  resetAgentMessageTraceForTests,
  TRACE_RING_CAPACITY
} from './agent-message-trace'
import { BoardLogStore, MAX_BOARD_LOG_BYTES, buildLine, parseLines } from '../board-log'
import type { BoardLogEntry } from '../../shared/types'

let work: string

beforeEach(() => {
  resetAgentMessageTraceForTests()
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'ntmsgtrace-'))
})
afterEach(() => {
  fs.rmSync(work, { recursive: true, force: true })
})

const input = (over: Partial<Parameters<typeof recordDelivery>[0]> = {}): Parameters<typeof recordDelivery>[0] => ({
  sourceNodeId: 'n-src',
  sourceTitle: 'Alpha',
  targetNodeId: 'n-dst',
  outcome: 'delivered',
  receipt: 'newTurn',
  bodyChars: 12,
  ...over
})

describe('recordDelivery — the durable leg', () => {
  it('a cwd-bearing project appends ONE line to <cwd>/.nodeterm/board-log.jsonl', async () => {
    const store = new BoardLogStore({})
    const r = await recordDelivery(input(), {
      appendBoardLog: (e: BoardLogEntry) => store.append(work, e),
      now: () => 1_700_000_000_000
    })
    expect(r.traced).toBe('board-log')
    const raw = fs.readFileSync(path.join(work, '.nodeterm', 'board-log.jsonl'), 'utf8')
    expect(raw.split('\n').filter(Boolean).length).toBe(1)
    const [entry] = parseLines(raw)
    expect(entry.event).toEqual({
      type: 'agent-message',
      from: 'n-src',
      to: 'n-dst',
      title: 'delivered'
    })
    expect(entry.id).toBe(r.traceId)
    expect(entry.nodeId).toBe('n-dst')
  })

  it('records the OUTCOME, not the attempt — a refused-after-write delivery says so', async () => {
    const lines: BoardLogEntry[] = []
    for (const outcome of ['delivered', 'stalled', 'deliveredToReplacedTarget'] as const) {
      await recordDelivery(input({ outcome }), {
        appendBoardLog: async (e) => {
          lines.push(e)
          return true
        },
        now: () => 1
      })
    }
    expect(lines.map((l) => l.event?.title)).toEqual([
      'delivered',
      'stalled',
      'deliveredToReplacedTarget'
    ])
  })

  it('never traces the BODY — only its size', async () => {
    let seen: BoardLogEntry | undefined
    await recordDelivery(input({ bodyChars: 4096 }), {
      appendBoardLog: async (e) => {
        seen = e
        return true
      },
      now: () => 1
    })
    expect(JSON.stringify(seen)).not.toMatch(/body/i)
    expect(recentDeliveries(1)[0].bodyChars).toBe(4096)
  })

  it('records operator as a principal, never as a node identity', async () => {
    let seen: BoardLogEntry | undefined
    const result = await recordDelivery(input({ sourceNodeId: undefined, sourcePrincipal: 'operator' }), {
      appendBoardLog: async (entry) => { seen = entry; return true },
      now: () => 2
    })
    expect(seen?.event).toMatchObject({ from: 'operator', to: 'n-dst' })
    expect(recentDeliveries(1)[0]).toMatchObject({ sourcePrincipal: 'operator', targetNodeId: 'n-dst' })
    expect(recentDeliveries(1)[0]).not.toHaveProperty('sourceNodeId')
    expect(result.traced).toBe('board-log')
  })
})

describe('recordDelivery — the memory leg (Global Constraint 10)', () => {
  it('an UNSUPPORTED project still records, into the ring, and reports traced: memory', async () => {
    // board-log-handlers answers `unsupported` for an inline/no-cwd canvas, a disconnected SSH
    // project, and any SSH project on the Server Edition. The delivery is NOT refused there.
    const r = await recordDelivery(input(), { appendBoardLog: async () => false, now: () => 7 })
    expect(r.traced).toBe('memory')
    expect(recentDeliveries()).toEqual([
      {
        traceId: r.traceId,
        ts: 7,
        sourceNodeId: 'n-src',
        targetNodeId: 'n-dst',
        outcome: 'delivered',
        receipt: 'newTurn',
        bodyChars: 12,
        traced: 'memory'
      }
    ])
  })

  it('a THROWING appender is the same fact as a false one — never a failed delivery', async () => {
    const r = await recordDelivery(input(), {
      appendBoardLog: async () => {
        throw new Error('ssh master went away')
      },
      now: () => 9
    })
    expect(r.traced).toBe('memory')
    expect(recentDeliveries()).toHaveLength(1)
  })

  it('the ring is bounded and evicts the OLDEST', async () => {
    for (let i = 0; i < TRACE_RING_CAPACITY + 25; i++) {
      await recordDelivery(input({ targetNodeId: `n-${i}` }), {
        appendBoardLog: async () => false,
        now: () => i
      })
    }
    // Ask for MORE than the capacity, deliberately. `recentDeliveries()`'s default limit is the
    // capacity itself, so reading with it cannot tell an evicting ring from an unbounded array —
    // that read would slice the last 200 of 225 and look identical. It is the same shape as the
    // board-log's 500 (`slice` after `reverse`, a read cap mistaken for eviction) which this very
    // file rotates around, and this assertion was green with the eviction removed until it asked
    // the question properly.
    const all = recentDeliveries(10_000)
    expect(all).toHaveLength(TRACE_RING_CAPACITY)
    expect(all[0].targetNodeId).toBe(`n-${TRACE_RING_CAPACITY + 24}`) // newest first
    expect(all.at(-1)!.targetNodeId).toBe('n-25') // 0..24 evicted
  })

  it('the ring is written even when the board log took it — Settings reads the ring', async () => {
    const r = await recordDelivery(input(), { appendBoardLog: async () => true, now: () => 3 })
    expect(r.traced).toBe('board-log')
    expect(recentDeliveries(1)[0].traced).toBe('board-log')
  })
})

describe('board-log truncation — the 500 was a READ cap, not an eviction', () => {
  it('rotates to board-log.jsonl.1 past MAX_BOARD_LOG_BYTES and starts a fresh file', async () => {
    const store = new BoardLogStore({})
    const dir = path.join(work, '.nodeterm')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'board-log.jsonl')
    // One byte under the bound: the next append must rotate.
    fs.writeFileSync(file, 'x'.repeat(MAX_BOARD_LOG_BYTES - 1))
    expect(await store.append(work, entry('after-rotate'))).toBe(true)
    expect(fs.existsSync(`${file}.1`)).toBe(true)
    expect(fs.statSync(`${file}.1`).size).toBe(MAX_BOARD_LOG_BYTES - 1)
    const fresh = fs.readFileSync(file, 'utf8')
    expect(fresh.split('\n').filter(Boolean).length).toBe(1)
    expect(parseLines(fresh)[0].text).toBe('after-rotate')
  })

  it('does NOT rotate below the bound', async () => {
    const store = new BoardLogStore({})
    await store.append(work, entry('one'))
    await store.append(work, entry('two'))
    const file = path.join(work, '.nodeterm', 'board-log.jsonl')
    expect(fs.existsSync(`${file}.1`)).toBe(false)
    expect(parseLines(fs.readFileSync(file, 'utf8')).map((e) => e.text)).toEqual(['two', 'one'])
  })

  it('a read spans the rotation boundary, so the panel does not go blank at rotation', async () => {
    const store = new BoardLogStore({})
    const dir = path.join(work, '.nodeterm')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'board-log.jsonl')
    // Two real entries in the generation that is about to be rotated away.
    fs.writeFileSync(file, buildLine(entry('old-1')) + buildLine(entry('old-2')))
    fs.appendFileSync(file, 'x'.repeat(MAX_BOARD_LOG_BYTES))
    await store.append(work, entry('new-1'))
    expect(fs.existsSync(`${file}.1`)).toBe(true)
    const read = await store.read(work)
    // Newest first, across both generations — the fresh file's line, then the rotated ones.
    expect(read.map((e) => e.text)).toEqual(['new-1', 'old-2', 'old-1'])
  })

  it('a capped read never returns more than the cap, even spanning generations', async () => {
    const store = new BoardLogStore({})
    const dir = path.join(work, '.nodeterm')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'board-log.jsonl')
    fs.writeFileSync(file, [1, 2, 3].map((n) => buildLine(entry(`old-${n}`))).join(''))
    fs.appendFileSync(file, 'x'.repeat(MAX_BOARD_LOG_BYTES))
    await store.append(work, entry('new-1'))
    expect((await store.read(work, { cap: 2 })).map((e) => e.text)).toEqual(['new-1', 'old-3'])
    expect((await store.read(work, { all: true })).map((e) => e.text)).toEqual([
      'new-1',
      'old-3',
      'old-2',
      'old-1'
    ])
  })

  it('keeps exactly ONE generation — a second rotation replaces the first', async () => {
    const store = new BoardLogStore({})
    const dir = path.join(work, '.nodeterm')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, 'board-log.jsonl')
    fs.writeFileSync(file, 'a'.repeat(MAX_BOARD_LOG_BYTES))
    await store.append(work, entry('gen-1'))
    fs.appendFileSync(file, 'b'.repeat(MAX_BOARD_LOG_BYTES))
    await store.append(work, entry('gen-2'))
    expect(fs.existsSync(`${file}.2`)).toBe(false)
    expect(fs.readFileSync(`${file}.1`, 'utf8')).toContain('gen-1')
  })
})

function entry(text: string): BoardLogEntry {
  return { id: `id-${text}`, ts: 1, author: { name: 'a', color: '#fff' }, kind: 'comment', text }
}
