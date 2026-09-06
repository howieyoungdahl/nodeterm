// vitest `setupFiles` entry: give every test worker a PRIVATE tmux socket by default.
//
// Why this exists: 13 `test/server/*` suites call `startServer`, which boots a real `PtyManager`
// plus the session reaper and the memory-pressure monitor against the RESOLVED `TMUX_SOCKET`. Only
// three of them are gated by `describe.skipIf(!hasPrivateTmuxSocket())`; the other ten used to run
// `npm test` straight against `node-terminal` — on a machine hosting a live nodeterm canvas, that
// is the socket carrying the operator's real sessions (C3 of the 2026-09-06 canvas-wipe loop).
//
// The mechanism is the same knob production uses (`NODETERM_TMUX_SOCKET`, read ONCE at module load
// by `src/core/tmux-naming.ts`). That load-time read is the whole ordering question: this file
// must set the variable BEFORE any test file's static imports evaluate `tmux-naming`, which is
// what vitest's `setupFiles` guarantee (they run in the worker, before the test file is imported)
// and what `test/setup/private-tmux-socket.test.ts` measures rather than assumes. So this module
// must NOT import anything that (transitively) imports `tmux-naming` — every path below is
// computed inline on purpose.
//
// Scope: a name is minted only when the variable is UNSET, so an explicit
// `NODETERM_TMUX_SOCKET=nt-test-$$ npx vitest run …` still wins. The default pool is `forks`, so
// `process.pid` is one worker; every test file in that worker shares the socket and each file's
// `afterAll` below kills the server and unlinks the socket file — `kill-server` alone never
// unlinks it, and a per-pid name in the shared `/tmp/tmux-<uid>/` would otherwise leave one dead
// entry behind per run, forever (see `src/core/tmux-test-socket.ts`).
import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { afterAll } from 'vitest'

const MINTED = `nt-vitest-${process.pid}`

if (!process.env.NODETERM_TMUX_SOCKET) process.env.NODETERM_TMUX_SOCKET = MINTED

/** Where tmux binds `-L <name>`: `$TMUX_TMPDIR` (else `/tmp`) + `tmux-<uid>/<name>`. */
function mintedSocketPath(): string | null {
  const uid = process.getuid?.()
  if (uid === undefined) return null
  return path.join(process.env.TMUX_TMPDIR || '/tmp', `tmux-${uid}`, MINTED)
}

/** Stop the server on the socket WE minted; a user-supplied name is theirs to tear down. */
function killMintedServer(): void {
  if (process.env.NODETERM_TMUX_SOCKET !== MINTED) return
  // GUI-less test workers usually have tmux on PATH; the fixed paths cover a PATH that does not,
  // since `findTmux` would still have found the binary for the code under test. Stop at the first
  // binary that runs at all — "no server running" is the common, fine outcome.
  for (const bin of ['tmux', '/usr/bin/tmux', '/usr/local/bin/tmux', '/opt/homebrew/bin/tmux']) {
    try {
      execFileSync(bin, ['-L', MINTED, 'kill-server'], { stdio: 'ignore', timeout: 5000 })
      break
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue
      break
    }
  }
  const sock = mintedSocketPath()
  if (sock) {
    try {
      fs.rmSync(sock, { force: true })
    } catch {
      /* best effort: a leftover socket file is inert, and the next run's name differs anyway */
    }
  }
}

afterAll(killMintedServer)
