import { describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createExternalTaskBoard } from './external-task-board'

describe('configured task board', () => {
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
      payload.cards.push({...card, task: 'conflicting-task'})
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
