// TEST-ONLY: choosing a private `TMUX_TMPDIR` for the `*.realtmux.test.ts` suites.
//
// Two things a real-tmux test has to get right about its socket, and each has bitten this repo:
//
// 1. **It must be private**, so `afterAll`'s `rm -rf` is the one cleanup path. `kill-server` stops
//    the server but never unlinks the socket file, so a per-pid name in the SHARED `/tmp/tmux-<uid>/`
//    leaves one dead entry behind per run, forever — measured at 14 stale `nt-envtest-*` sockets on
//    one dev machine before this module existed.
// 2. **It must be SHORT.** A unix socket path is bound into a fixed `sockaddr_un.sun_path`, and the
//    macOS per-user temp root is already 56 characters before anything is added to it. This is not
//    theoretical: `local-send-keys.realtmux.test.ts` came to 106 and every test in it failed with
//    `error connecting to …: File name too long`, which reads like a broken test rather than a
//    path-length limit. Its sibling passed at 97 — six characters from the same failure.
//
// Production is not exposed to (2): `PtyManager` binds `-L node-terminal` under the default
// `/tmp/tmux-<uid>/`, which is short on every platform we ship to.
import fs from 'fs'
import os from 'os'
import path from 'path'
import { DEFAULT_TMUX_SOCKET, TMUX_SOCKET } from './tmux-naming'
import { RMT_TMUX_SOCKET } from './remote-ssh/control-master'

/**
 * The two socket names that carry REAL user sessions on a developer's machine: the one this
 * machine's own nodeterm binds, and the one a nodeterm SSH-ing INTO it binds.
 */
export const LIVE_TMUX_SOCKETS: readonly string[] = [DEFAULT_TMUX_SOCKET, RMT_TMUX_SOCKET]

/**
 * Why this process must NOT run a suite that drives a real tmux server, or `null` when it may.
 *
 * The `*.realtmux.test.ts` suites each mint their own per-pid socket inside `makeTmuxTmpdir`, so
 * they were never the hazard. The hazard is the three `test/server/*-e2e` suites that spawn and
 * KILL sessions on the resolved `TMUX_SOCKET` itself — on a machine hosting a live nodeterm canvas
 * that is the live server's own socket, and `npm test` there reaches straight into it (a
 * `new-session` on the live socket, and `kill-session` on names derived from test node ids).
 *
 * The escape hatch is the same knob production uses: give this process a private socket with
 * `NODETERM_TMUX_SOCKET`. Then the suite runs, against a server it owns, and nothing it does can
 * name a session behind the live canvas.
 */
export function privateTmuxSocketReason(socket: string = TMUX_SOCKET): string | null {
  if (!LIVE_TMUX_SOCKETS.includes(socket)) return null
  return (
    `refusing to drive tmux on the shared socket "${socket}" — it carries this machine's real ` +
    `nodeterm sessions. Re-run with NODETERM_TMUX_SOCKET=nt-test-$$ (optionally TMUX_TMPDIR=<a ` +
    `private dir>) to run this suite against a tmux server of its own.`
  )
}

/** Convenience gate for `describe.skipIf`. */
export function hasPrivateTmuxSocket(socket: string = TMUX_SOCKET): boolean {
  return privateTmuxSocketReason(socket) === null
}

/**
 * The longest socket path that can be bound.
 *
 * macOS `sys/un.h` declares `sun_path[104]` — 103 characters plus the NUL. Linux allows 107. The
 * smaller number is the one to hold everywhere: a limit that only bites on a contributor's Mac is
 * worse than one that bites in CI, because it looks like the test is broken.
 */
export const SUN_PATH_MAX = 103

/** `mkdtemp` replaces a trailing `XXXXXX`, so the directory is always six characters longer. */
export const MKDTEMP_SUFFIX_LEN = 6

/** Where tmux binds for `-L <socket>` under `TMUX_TMPDIR=<dir>`. */
export function tmuxSocketPath(dir: string, uid: number, socket: string): string {
  return path.join(dir, `tmux-${uid}`, socket)
}

/**
 * The first base directory under which `mkdtemp(<base>/<prefix>XXXXXX)` still leaves room for the
 * socket, or `null` when none does. Bases are tried in the order given, so the caller states its
 * preference; `null` is a refusal, never a truncated path that would fail obscurely at bind time.
 */
export function pickTmuxTmpdirBase(
  bases: string[],
  uid: number,
  socket: string,
  prefix: string
): string | null {
  const dirName = prefix + 'X'.repeat(MKDTEMP_SUFFIX_LEN)
  return (
    bases.find((b) => tmuxSocketPath(path.join(b, dirName), uid, socket).length <= SUN_PATH_MAX) ??
    null
  )
}

/**
 * Create a private `TMUX_TMPDIR` that `-L <socket>` fits inside, and return it. Prefers the
 * platform temp dir and falls back to `/tmp`, which is what makes the difference on macOS: the
 * former resolves to `/private/var/folders/…` (56 characters), the latter to `/private/tmp` (12).
 *
 * Both candidates are resolved BEFORE they are measured — tmux resolves the symlink itself before
 * binding, so measuring the unresolved `/var/folders/…` under-counts by exactly the 8 characters
 * that overflowed.
 */
export function makeTmuxTmpdir(prefix: string, socket: string): string {
  // A private DIRECTORY around a live socket NAME is still a live socket to any client that also
  // sets TMUX_TMPDIR — and every one of these suites exports it to child shells. Refuse the name.
  if (LIVE_TMUX_SOCKETS.includes(socket)) {
    throw new Error(
      `makeTmuxTmpdir refuses the shared socket name "${socket}": pick a per-suite name, ` +
        `e.g. nt-<suite>-<pid>.`
    )
  }
  const uid = process.getuid?.() ?? 0
  const bases = [...new Set([os.tmpdir(), '/tmp'].map(realpathOrSelf))]
  const base = pickTmuxTmpdirBase(bases, uid, socket, prefix)
  if (base === null) {
    throw new Error(
      `no temp dir leaves room for a tmux socket: tried ${bases.join(', ')} with prefix ` +
        `"${prefix}" and socket "${socket}" against ${SUN_PATH_MAX} chars`
    )
  }
  const dir = realpathOrSelf(fs.mkdtempSync(path.join(base, prefix)))
  const bound = tmuxSocketPath(dir, uid, socket)
  // Belt and braces: the prediction above and the directory mkdtemp actually made must agree, or
  // the suite fails here naming the number rather than at bind time naming the errno.
  if (bound.length > SUN_PATH_MAX) {
    throw new Error(`tmux socket path is ${bound.length} > ${SUN_PATH_MAX} chars: ${bound}`)
  }
  return dir
}

function realpathOrSelf(p: string): string {
  try {
    return fs.realpathSync(p)
  } catch {
    return p
  }
}
