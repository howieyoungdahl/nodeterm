import { expect, it } from 'vitest'
import { latestLifecycleTurn } from './lifecycle-transcript'
const at = Date.parse('2026-10-14T21:00:00Z')
const line = (row: object) => JSON.stringify({ timestamp: new Date(at).toISOString(), ...row })
it('uses newest Claude assistant timestamp and ignores unrelated later records', () => {
  expect(latestLifecycleTurn([line({ type: 'assistant' }), line({ type: 'progress' }), 'broken'].join('\n'), 'claude', at))
    .toEqual({ at, clean: false })
})
it('a newer user prompt does not resurrect an old completed turn', () => {
  expect(latestLifecycleTurn([line({ type: 'assistant' }), line({ type: 'user' })].join('\n'), 'claude', at)).toBeNull()
})
it('Codex only uses task_complete, not tokens or tool output', () => {
  expect(latestLifecycleTurn([line({ type: 'event_msg', payload: { type: 'task_complete' } }),
    line({ type: 'event_msg', payload: { type: 'token_count' } })].join('\n'), 'codex', at)).toEqual({ at, clean: true })
  expect(latestLifecycleTurn(line({ type: 'response_item', payload: { role: 'assistant' } }), 'codex', at)).toBeNull()
})
it('a newer Codex task_started makes the restored state unknown', () => {
  expect(latestLifecycleTurn([line({ type: 'event_msg', payload: { type: 'task_complete' } }),
    line({ type: 'event_msg', payload: { type: 'task_started' } })].join('\n'), 'codex', at)).toBeNull()
})
it.each([undefined, 'invalid', '2099-01-01T00:00:00Z', -1])('rejects invalid or future timestamp %s', timestamp => {
  expect(latestLifecycleTurn(line({ type: 'assistant', timestamp }), 'claude', at)).toBeNull()
})
