import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createExternalTaskBoard } from './external-task-board'

describe('configured task board', () => {
  it('follows the local featured terminal through handoffs and omits pointers outside the project', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nt-featured-'))
    try {
      const nodeIdFile = join(dir, 'current-node')
      const tokenFile = join(dir, 'token')
      const url = 'https://board.example/view'
      const featuredSession = { label: 'Coordinator', nodeIdFile }
      await writeFile(tokenFile, 'test-token')
      await writeFile(join(dir, 'external-task-boards.json'), JSON.stringify({
        one: { url, feed: 'https://board.example/feed', tokenFile, featuredSession }
      }))
      const nodes = new Set(['first', 'second'])
      const feed = vi.fn(async () => Response.json({ asOf: new Date().toISOString(), cards: [] }))
      const board = createExternalTaskBoard(dir, () => nodes, feed)
      const handoffs = [['first\n', 'first'], ['second\n', 'second'], ['another-project', null], ['first\nsecond', null]] as const
      for (const [content, expected] of handoffs) {
        await writeFile(nodeIdFile, content)
        expect((await board('one'))?.featuredSession).toEqual({ label: 'Coordinator', nodeId: expected })
      }
      expect(feed).toHaveBeenCalledTimes(1)
      await rm(nodeIdFile)
      expect((await board('one'))?.featuredSession).toEqual({ label: 'Coordinator', nodeId: null })
      await writeFile(nodeIdFile, 'second')
      const offline = createExternalTaskBoard(dir, () => nodes, async () => Response.error())
      expect(await offline('one')).toEqual({
        url, available: false, cards: [], featuredSession: { label: 'Coordinator', nodeId: 'second' }
      })
      expect(await board('unconfigured')).toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('resolves background helpers from exact local fields, including while the feed is offline', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nt-background-'))
    try {
      const file = join(dir, 'helper.json')
      const text = join(dir, 'primary')
      const pointer = { nodeIdFile: file, nodeIdField: 'helper' }
      const primary = { nodeIdFile: text, label: 'Coordinator' }
      await writeFile(text, 'lead')
      await writeFile(join(dir, 'external-task-boards.json'), JSON.stringify({ one: {
        url: 'https://board.example/view', feed: 'https://board.example/feed', tokenFile: join(dir, 'absent'),
        featuredSession: primary, backgroundSessions: [pointer, pointer, primary]
      } }))
      const nodes = new Set(['lead', 'job-one', 'job-two'])
      const read = createExternalTaskBoard(dir, () => nodes)
      const readings: Array<[string, string[]]> = [
        [JSON.stringify({ primary: 'lead', helper: 'job-one' }), ['job-one']],
        [JSON.stringify({ primary: 'lead', helper: 'job-two' }), ['job-two']],
        [JSON.stringify({ primary: 'lead', helper: 'foreign' }), []],
        [JSON.stringify({ primary: 'lead', helper: 'lead' }), []],
        [JSON.stringify({ primary: 'lead' }), []],
        [JSON.stringify({ helper: ['job-one'] }), []],
        ['broken', []], [' '.repeat(4096) + '{"helper":"job-one"}', []]
      ]
      for (const [receipt, expected] of readings) {
        await writeFile(file, receipt)
        expect(await read('one')).toEqual({
          url: 'https://board.example/view', available: false, cards: [],
          featuredSession: { label: 'Coordinator', nodeId: 'lead' }, backgroundNodeIds: expected
        })
      }
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('keeps the credential on the server, returns only this project’s bindings, and drops stale readings', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nt-task-board-'))
    try {
      const key = join(dir, 'test-read-token')
      await writeFile(key, 'test-only-read-token')
      const config = {
        url: 'https://board.example/view',
        feed: 'https://board.example/lanes',
        tokenFile: key
      }
      await writeFile(join(dir, 'external-task-boards.json'), JSON.stringify({ one: config }))
      const card = {
        nodeId: 'node-one',
        task: 'task-10',
        workflow: 'Product',
        stage: 'In progress',
        urgency: 'Now',
        priority: 'P2',
        reason: 'Due tomorrow'
      }
      const payload = {
        asOf: new Date().toISOString(),
        cards: [card, { ...card, nodeId: 'another-project' }]
      }
      const request = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-only-read-token')
        return Response.json(payload)
      })
      const get = createExternalTaskBoard(dir, (id) => (id === 'one' ? new Set(['node-one']) : null), request)
      expect(await get('different')).toBeNull()
      expect(await get('one')).toEqual({ url: config.url, available: true, cards: [card] })
      expect(await get('one')).toEqual({ url: config.url, available: true, cards: [card] })
      expect(request).toHaveBeenCalledTimes(1)
      const columns = { workflows: ['Product', 'Operations'], stages: ['In progress', 'Done'] }
      const withColumns = createExternalTaskBoard(dir, () => new Set(), async () =>
        Response.json({ ...payload, ...columns }))
      expect(await withColumns('one')).toEqual({ url: config.url, available: true, cards: [], columns })
      payload.cards.push({...card, task: 'conflicting-task'})
      const operator = (linkPage: string) => createExternalTaskBoard(dir, () => new Set(['node-one']),
        async () => Response.json({ ...payload, cards: [{ ...card, manual: true }], linkPage }))
      const picker = await operator('/work/lanes/link')('one')
      expect(new URL(picker!.linkPage!).origin).toBe('https://board.example')
      expect(new URL(picker!.linkPage!).searchParams.get('host')).toBe(hostname())
      expect(picker?.cards[0].manual).toBe(true)
      expect((await operator('//foreign.example/link')('one'))?.linkPage).toBeUndefined()
      const conflicting = createExternalTaskBoard(dir, () => new Set(['node-one']), request)
      expect(await conflicting('one')).toEqual({ url: config.url, available: true, cards: [] })
      payload.asOf = '2000-01-01T00:00:00Z'
      const reload = createExternalTaskBoard(dir, () => new Set(['node-one']), request)
      expect(await reload('one')).toEqual({ url: config.url, available: false, cards: [] })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
