import { describe, it, expect } from 'vitest'

import { ACCOUNT_SCOPE_UPDATE_ENV, APP_WHEEL_REPORTS, tmuxConf } from './pty-manager'
import { leadPaneHookLines } from '../shared/tmux-lead-pane'

describe('tmuxConf', () => {
  const c = tmuxConf(50000)

  it('leaves the mouse ON — tmux owns scrolling and selection', () => {
    // The wheel scrolls tmux's own history and the pane stays on the alternate screen (so a TUI's
    // input box stays put). The previous design (mouse off, emulator-owned scrollback) leaked
    // tmux's repaints into the scrollback as black bands and duplicated screens.
    expect(c).toContain('set -g mouse on')
    expect(c).not.toContain('set -g mouse off')
  })

  it('does not blank smcup/rmcup/indn — the alternate screen is the native, wanted behavior', () => {
    expect(c).not.toContain('smcup@')
    expect(c).not.toContain('rmcup@')
    expect(c).not.toContain('indn@')
  })

  it('enables OSC 52 via terminal-features, NOT the Ms= override (a no-op on tmux 3.2+)', () => {
    // Measured on tmux 3.4: with `terminal-overrides ,xterm*:Ms=...` a copy emitted ZERO OSC 52 to
    // the attached client; with the `clipboard` terminal-feature it emitted the correct payload.
    expect(c).toContain('set -g set-clipboard on')
    expect(c).toContain('set -as terminal-features ",*:clipboard"')
    expect(c).not.toContain('Ms=')
  })

  it('declares RGB via terminal-features so truecolor is not clamped to 256 colors (issue #78)', () => {
    // Without an RGB terminal-features (or Tc) entry for the outer terminal, tmux quantizes every
    // 24-bit SGR to the 256-color palette — canvas terminals never match the user's real terminal.
    expect(c).toContain('set -as terminal-features ",*:RGB"')
    // Only via terminal-features: the overrides array must stay unset (see the MIGRATION note).
    expect(c).not.toMatch(/set -a[gs]? terminal-overrides/)
  })

  it('declares hyperlinks via terminal-features so OSC 8 links reach the renderer', () => {
    // tmux strips the OSC 8 escape unless the outer terminal declares support, leaving only the
    // label text — a link whose URL is not also printed can then never be opened.
    expect(c).toContain('set -as terminal-features ",*:hyperlinks"')
  })

  it('copies mouse selections through tmux (OSC 52), with no macOS-only pbcopy pipe', () => {
    expect(c).toContain('bind -T copy-mode    MouseDragEnd1Pane send-keys -X copy-pipe-and-cancel')
    expect(c).toContain('bind -T copy-mode-vi MouseDragEnd1Pane send-keys -X copy-pipe-and-cancel')
    expect(c).toContain('DoubleClick1Pane send-keys -X select-word')
    expect(c).toContain('TripleClick1Pane send-keys -X select-line')
    // pbcopy is macOS-only — half of why copying never worked elsewhere or over SSH.
    expect(c).not.toContain('pbcopy')
  })

  it('floors history-limit at 1000', () => {
    expect(tmuxConf(10)).toContain('set -g history-limit 1000')
    expect(c).toContain('set -g history-limit 50000')
  })

  it('lead-pane width OFF (default/0/invalid) is byte-identical and carries no set-hook (issue #119)', () => {
    // The opt-in guarantee enes set for the feature: with the setting off, the generated conf is
    // bit-for-bit the pre-feature output — nodeterm ships no tmux hooks unless asked to.
    expect(tmuxConf(50000, 0)).toBe(c)
    expect(tmuxConf(50000, NaN)).toBe(c)
    expect(tmuxConf(50000, -3)).toBe(c)
    expect(c).not.toContain('set-hook')
  })

  it('lead-pane width ON only APPENDS the shared guarded hook pair — nothing above changes', () => {
    const on = tmuxConf(50000, 72)
    expect(on.startsWith(c)).toBe(true)
    expect(on).toContain(leadPaneHookLines(72))
    // Same builder as remoteTmuxConf, so the local and SSH sockets cannot drift.
    expect(on).toContain('set-hook -g after-resize-pane')
    expect(on).toContain('set-hook -g after-split-window')
  })

  it('lists every account-scope env name in update-environment (issue #419)', () => {
    // The REMOVAL half of update-environment's contract is the fix: the shared server's global
    // env is inherited from whichever client STARTED it, so without these names a server seeded
    // by a managed-account client leaked that account's CLAUDE_CONFIG_DIR into every session
    // created without a `-e` override — system-account nodes silently ran as a managed account.
    const line = c.split('\n').find((l) => l.startsWith('set -g update-environment '))
    expect(line).toBeDefined()
    for (const name of ACCOUNT_SCOPE_UPDATE_ENV) expect(line).toContain(name)
    // Deduped: the overlap names (ANTHROPIC_AUTH_TOKEN is in the gateway list AND the claude
    // auth strip; OPENAI_API_KEY likewise) must appear exactly once.
    for (const dup of ['ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY']) {
      expect(line!.split(dup).length - 1).toBe(1)
    }
  })
  it('repeats the forwarded wheel report for full-screen mouse apps, nowhere else', () => {
    // xterm.js sends one wheel report per wheel event and Claude Code's fullscreen TUI scrolls
    // one line per report, so stock tmux moved it one line a notch. Measured on a real tmux in
    // tmux-wheel.realtmux.test.ts; here only the shape is pinned.
    expect(APP_WHEEL_REPORTS).toBe(3)
    const up = c.split('\n').find((l) => l.startsWith('bind -T root WheelUpPane'))
    const down = c.split('\n').find((l) => l.startsWith('bind -T root WheelDownPane'))
    expect(up).toBe(
      'bind -T root WheelUpPane   if -F "#{pane_in_mode}" { send -M } { if -F "#{mouse_any_flag}" { send -M ; send -M ; send -M } { copy-mode -e } }'
    )
    expect(down).toBe(
      'bind -T root WheelDownPane if -F "#{&&:#{mouse_any_flag},#{?pane_in_mode,0,1}}" { send -M ; send -M ; send -M } { send -M }'
    )
  })
})
