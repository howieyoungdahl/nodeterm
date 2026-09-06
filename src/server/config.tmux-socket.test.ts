import { describe, it, expect } from 'vitest'
import { assertTmuxSocketBound, resolveConfig, type ServerConfig } from './config'

const base = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ ...extra })

describe('resolveConfig: tmuxSocket', () => {
  it('defaults to the historical socket, so an existing install is unchanged', () => {
    expect(resolveConfig(base(), []).tmuxSocket).toBe('node-terminal')
  })

  it('takes the socket from the environment (the systemd knob)', () => {
    expect(resolveConfig(base({ NODETERM_TMUX_SOCKET: 'nodeterm-live' }), []).tmuxSocket).toBe(
      'nodeterm-live'
    )
  })

  it('lets argv win over the environment, like every other option', () => {
    expect(
      resolveConfig(base({ NODETERM_TMUX_SOCKET: 'from-env' }), ['--tmux-socket', 'from-argv'])
        .tmuxSocket
    ).toBe('from-argv')
  })

  it('fails the boot on a bad name rather than falling back to the shared socket', () => {
    expect(() => resolveConfig(base({ NODETERM_TMUX_SOCKET: '../escape' }), [])).toThrow(
      /invalid tmux socket name/
    )
  })
})

describe('assertTmuxSocketBound', () => {
  const cfg = (tmuxSocket?: string): ServerConfig => ({
    port: 0,
    host: '127.0.0.1',
    dataDir: '/tmp/nt-cfg-test',
    rendererDir: '/tmp/nt-cfg-test/renderer',
    insecureHttp: false,
    headless: false,
    tmuxSocket
  })

  it('passes when the configured socket is the one the process bound', () => {
    expect(() => assertTmuxSocketBound(cfg('nodeterm-live'), 'nodeterm-live')).not.toThrow()
    expect(() => assertTmuxSocketBound(cfg(undefined), 'node-terminal')).not.toThrow()
  })

  // A flag parsed after module load cannot move the socket. Saying so is the difference between an
  // instance that is isolated and one that only reports that it is.
  it('refuses a flag that arrived too late, naming the env var that works', () => {
    expect(() => assertTmuxSocketBound(cfg('nodeterm-live'), 'node-terminal')).toThrow(
      /NODETERM_TMUX_SOCKET=nodeterm-live/
    )
  })
})
