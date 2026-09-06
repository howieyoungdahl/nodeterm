// The ordering proof for `test/setup/private-tmux-socket.ts`: the setup file sets
// `NODETERM_TMUX_SOCKET` and THIS file's static import of `tmux-naming` — which reads the variable
// once, at module load — must already see it. If vitest ever imported a test file before running
// its `setupFiles`, `TMUX_SOCKET` here would be `node-terminal` and this test would fail, which is
// the whole point: an assumption about load order is exactly what a socket guard cannot rest on.
import { describe, expect, it } from 'vitest'
import { DEFAULT_TMUX_SOCKET, TMUX_SOCKET } from '../../src/core/tmux-naming'
import { LIVE_TMUX_SOCKETS, hasPrivateTmuxSocket } from '../../src/core/tmux-test-socket'

describe('vitest setup: private tmux socket per worker', () => {
  it('sets NODETERM_TMUX_SOCKET before the test file statically imports tmux-naming', () => {
    const env = process.env.NODETERM_TMUX_SOCKET
    expect(env).toBeTruthy()
    expect(TMUX_SOCKET).toBe(env)
  })

  it('never resolves to a live socket name, so every startServer boot owns its server', () => {
    expect(LIVE_TMUX_SOCKETS).toContain(DEFAULT_TMUX_SOCKET)
    expect(LIVE_TMUX_SOCKETS).not.toContain(TMUX_SOCKET)
    expect(hasPrivateTmuxSocket()).toBe(true)
  })

  it('mints nt-vitest-<pid> when nothing was set (an explicit name is left alone)', () => {
    const minted = `nt-vitest-${process.pid}`
    if (TMUX_SOCKET === minted) {
      expect(TMUX_SOCKET).toMatch(/^nt-vitest-\d+$/)
    } else {
      // The operator chose a socket for this run; the setup file must not have replaced it.
      expect(TMUX_SOCKET).not.toMatch(/^nt-vitest-/)
    }
  })
})
