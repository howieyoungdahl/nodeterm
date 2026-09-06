import { describe, it, expect } from 'vitest'
import { DEFAULT_TMUX_SOCKET, TMUX_SOCKET, resolveTmuxSocketName } from './tmux-naming'
import {
  LIVE_TMUX_SOCKETS,
  hasPrivateTmuxSocket,
  makeTmuxTmpdir,
  privateTmuxSocketReason
} from './tmux-test-socket'

describe('resolveTmuxSocketName', () => {
  it('is the historical name when nothing is configured', () => {
    expect(DEFAULT_TMUX_SOCKET).toBe('node-terminal')
    expect(resolveTmuxSocketName(undefined)).toBe('node-terminal')
    expect(resolveTmuxSocketName(null)).toBe('node-terminal')
    expect(resolveTmuxSocketName('')).toBe('node-terminal')
    expect(resolveTmuxSocketName('   ')).toBe('node-terminal')
  })

  it('accepts a plain private name', () => {
    expect(resolveTmuxSocketName('nodeterm-live')).toBe('nodeterm-live')
    expect(resolveTmuxSocketName(' nt-test-42 ')).toBe('nt-test-42')
    expect(resolveTmuxSocketName('a')).toBe('a')
    expect(resolveTmuxSocketName('x'.repeat(64))).toHaveLength(64)
  })

  // The fallback direction is the whole point: a typo that degraded to the default would put the
  // instance back on the socket it was configured away from.
  it.each([
    ['../../tmp/other'],
    ['a/b'],
    ['-L'],
    ['live socket'],
    ['sock;rm -rf'],
    ['x'.repeat(65)]
  ])('throws on %s instead of silently defaulting', (name) => {
    expect(() => resolveTmuxSocketName(name)).toThrow(/invalid tmux socket name/)
  })

  it('binds the module constant from the environment exactly once', () => {
    expect(TMUX_SOCKET).toBe(resolveTmuxSocketName(process.env.NODETERM_TMUX_SOCKET))
  })
})

describe('privateTmuxSocketReason', () => {
  it('refuses both sockets that carry real sessions', () => {
    expect(LIVE_TMUX_SOCKETS).toEqual(['node-terminal', 'nodeterm-rmt'])
    for (const live of LIVE_TMUX_SOCKETS) {
      expect(privateTmuxSocketReason(live)).toMatch(/refusing to drive tmux on the shared socket/)
      expect(hasPrivateTmuxSocket(live)).toBe(false)
    }
  })

  it('names the escape hatch so a developer can actually run the suite', () => {
    expect(privateTmuxSocketReason('node-terminal')).toContain('NODETERM_TMUX_SOCKET')
  })

  it('allows any private name', () => {
    expect(privateTmuxSocketReason('nt-test-123')).toBeNull()
    expect(hasPrivateTmuxSocket('nodeterm-live')).toBe(true)
  })
})

describe('makeTmuxTmpdir', () => {
  it('refuses to host a live socket name even inside a private dir', () => {
    for (const live of LIVE_TMUX_SOCKETS) {
      expect(() => makeTmuxTmpdir('nt-guard-', live)).toThrow(/refuses the shared socket name/)
    }
  })
})
