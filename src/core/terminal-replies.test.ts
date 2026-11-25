import { expect, it } from 'vitest'
import { TerminalReplies } from './terminal-replies'

it.each([
  ['\x1b[0c', '\x1b[?1;2c'],
  ['\x1b[>0c', '\x1b[>0;276;0c'],
  ['\x1b[>q', '\x1bP>|tmux 3.4\x1b\\'],
  ['\x1b]10;?\x1b\\', '\x1b]10;rgb:ffff/ffff/ffff\x07'],
  ['\x1b]11;?\x07', '\x1b]11;rgb:0000/0000/0000\x1b\\']
])('allows one reply per %j query, even across output chunks', (query, reply) => {
  const replies = new TerminalReplies()
  const allow = () => TerminalReplies.allow(reply, replies)

  expect(allow()).toBe(false)
  for (const byte of query) replies.observe(byte)
  expect(allow()).toBe(true)
  expect(allow()).toBe(false)
  replies.observe(query + query)
  expect([allow(), allow(), allow()]).toEqual([true, true, false])
})

it('keeps typed input and modified F3 on the released-session path', () => {
  expect(TerminalReplies.allow('\x1b[?1;2c')).toBe(false)
  expect(TerminalReplies.allow('\x1b[?1;2c\n')).toBe(true)
  expect(TerminalReplies.allow('\x1b[1;5R')).toBe(true)
  expect(TerminalReplies.allow('hello')).toBe(true)
})
