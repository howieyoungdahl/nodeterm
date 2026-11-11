// WHEEL FORWARDING TO FULL-SCREEN APPS, PROVEN AGAINST A REAL TMUX WITH A REAL ATTACHED CLIENT.
//
// Field report (2026-11-10): "i cant scroll up in terminals". Claude Code runs with
// `"tui": "fullscreen"`: alternate screen, mouse tracking on, its OWN history (tmux holds none).
// xterm.js sends one wheel report per wheel event, stock tmux forwards that one report, and Claude
// scrolls one line per report — one line a notch. `tmuxConf` now forwards `APP_WHEEL_REPORTS`
// reports to a mouse-tracking pane app and leaves copy-mode / plain-shell scrolling as it was.
//
// What only a real tmux can answer: does it PARSE the bind lines (a failing line in `source-file`
// silently drops everything after it), and does one wheel event from the CLIENT terminal reach the
// app as N reports while a plain shell still drops into copy-mode and scrolls tmux's 5 lines.
//
// The client is `tmux attach` under util-linux `script`, which gives it a pty; the test writes SGR
// wheel bytes (`ESC [ < 64 ; x ; y M` = wheel up) to that pty exactly as xterm.js would.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync, spawn, type ChildProcess } from 'child_process'
import fs from 'fs'
import path from 'path'
import { APP_WHEEL_REPORTS, tmuxConf } from './pty-manager'
import { makeTmuxTmpdir } from './tmux-test-socket'

const SOCKET = `nt-wheel-${process.pid}`
const WHEEL_UP = '\x1b[<64;20;10M'
const WHEEL_DOWN = '\x1b[<65;20;10M'

let tmp: string
let ok = false

function tmux(args: string[]): string {
  return execFileSync('tmux', ['-L', SOCKET, ...args], {
    env: { ...process.env, TMUX_TMPDIR: tmp },
    stdio: ['ignore', 'pipe', 'pipe']
  }).toString()
}

function pane(session: string, fmt: string): string {
  return tmux(['display-message', '-p', '-t', `${session}:0.0`, fmt]).trim()
}

async function until(test: () => boolean, ms = 4000): Promise<boolean> {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (test()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return test()
}

/** Attach a real client on its own pty; returns the process whose stdin is the client's keyboard. */
function attach(session: string): ChildProcess {
  const cmd = `stty rows 40 cols 120; exec tmux -L ${SOCKET} attach -t ${session}`
  return spawn('script', ['-qfec', cmd, '/dev/null'], {
    env: { ...process.env, TMUX_TMPDIR: tmp, TERM: 'xterm-256color' },
    stdio: ['pipe', 'ignore', 'ignore']
  })
}

/** A minimal full-screen app: alt screen + SGR mouse tracking, logging every wheel report. */
function writeMouseApp(log: string): string {
  const file = path.join(tmp, 'mouse-app.cjs')
  fs.writeFileSync(
    file,
    `const fs = require('fs')
process.stdin.setRawMode(true)
process.stdout.write('\\x1b[?1049h\\x1b[?1000h\\x1b[?1006h\\x1b[2J\\x1b[Hready')
process.stdin.on('data', (b) => {
  const m = b.toString('latin1').match(/\\x1b\\[<6[45];\\d+;\\d+M/g) || []
  for (const r of m) fs.appendFileSync(${JSON.stringify(log)}, r.slice(3, 5) + '\\n')
})
`
  )
  return file
}

function reports(log: string): string[] {
  return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : []
}

beforeAll(() => {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' })
    execFileSync('script', ['--version'], { stdio: 'ignore' })
    ok = true
  } catch {
    return // no tmux or util-linux script on this host: every test below self-skips
  }
  tmp = makeTmuxTmpdir('ntwheel-', SOCKET)
  const conf = path.join(tmp, 'tmux.conf')
  fs.writeFileSync(conf, tmuxConf(2000))
  tmux(['-f', conf, 'new-session', '-d', '-x', '120', '-y', '40', '-s', 'boot', 'sleep 300'])
})

afterAll(() => {
  if (!ok) return
  try {
    tmux(['kill-server'])
  } catch {
    /* already gone */
  }
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('wheel over a real tmux client', () => {
  it('the generated conf parses: both wheel bindings are live in the root table', () => {
    if (!ok) return
    const keys = tmux(['list-keys', '-T', 'root'])
    expect(keys).toMatch(/WheelUpPane\s+if-shell -F "#\{pane_in_mode\}"/)
    expect(keys).toMatch(/WheelDownPane\s+if-shell -F/)
  })

  it(`a full-screen mouse app gets ${APP_WHEEL_REPORTS} reports per wheel event, both directions`, async () => {
    if (!ok) return
    const log = path.join(tmp, 'wheel.log')
    const app = writeMouseApp(log)
    tmux(['new-session', '-d', '-x', '120', '-y', '40', '-s', 'app', `node ${app}; sleep 300`])
    expect(await until(() => pane('app', '#{mouse_any_flag}') === '1')).toBe(true)
    const client = attach('app')
    try {
      expect(await until(() => tmux(['list-clients', '-t', 'app']).trim() !== '')).toBe(true)
      client.stdin!.write(WHEEL_UP)
      expect(await until(() => reports(log).length >= APP_WHEEL_REPORTS)).toBe(true)
      client.stdin!.write(WHEEL_DOWN)
      expect(await until(() => reports(log).length >= 2 * APP_WHEEL_REPORTS)).toBe(true)
      await new Promise((r) => setTimeout(r, 200)) // nothing extra trails in
      expect(reports(log)).toEqual([
        ...Array(APP_WHEEL_REPORTS).fill('64'),
        ...Array(APP_WHEEL_REPORTS).fill('65')
      ])
      // The app keeps the pane: no copy-mode was entered on its behalf.
      expect(pane('app', '#{pane_in_mode}')).toBe('0')
    } finally {
      client.kill()
    }
  })

  it('a plain shell still scrolls tmux history in copy-mode, 5 lines per event as stock', async () => {
    if (!ok) return
    tmux(['new-session', '-d', '-x', '120', '-y', '40', '-s', 'sh', 'seq 1 400; sleep 300'])
    expect(await until(() => Number(pane('sh', '#{history_size}')) > 300)).toBe(true)
    const client = attach('sh')
    try {
      expect(await until(() => tmux(['list-clients', '-t', 'sh']).trim() !== '')).toBe(true)
      client.stdin!.write(WHEEL_UP) // enters copy-mode (-e)
      expect(await until(() => pane('sh', '#{pane_in_mode}') === '1')).toBe(true)
      const before = Number(pane('sh', '#{scroll_position}'))
      client.stdin!.write(WHEEL_UP)
      expect(await until(() => Number(pane('sh', '#{scroll_position}')) === before + 5)).toBe(true)
    } finally {
      client.kill()
    }
  })
})
