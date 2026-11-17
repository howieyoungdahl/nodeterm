// The local transcript jail with the filesystem consulted: `isSafeLocalTranscriptPath` (pure, in
// claude-accounts-core) decides by path TEXT, which refuses a profile whose `projects` dir is a
// symlink into an allowed root. That is the common multi-account setup: `~/.claude-3/projects ->
// ~/.claude/projects`, so every hook from a `CLAUDE_CONFIG_DIR=~/.claude-3` pane reports
// `~/.claude-3/projects/<slug>/<sid>.jsonl`, the text check refuses it, and the context meter
// (model + fill) and subagent cards never start for that pane.
//
// This admits a path when its REAL location is inside an allowed root. It widens nothing a forged
// POST could use: the file read is the same file the real path names, and the real path must pass
// the very same predicate. The text check is still tried first, so every path admitted before is
// admitted now.
import fs from 'fs'
import path from 'path'
import { isSafeLocalTranscriptPath } from './claude-accounts-core'

/**
 * Real path of `abs`, resolving symlinks in the deepest ancestor that exists. A transcript can be
 * named by a SessionStart hook before Claude has written it, so the file itself may not exist yet;
 * its project dir (or `projects` itself) does. Returns undefined only when no ancestor resolves.
 */
export function realPathOfDeepestAncestor(
  abs: string,
  realpath: (p: string) => string = fs.realpathSync.native
): string | undefined {
  const rest: string[] = []
  let cur = abs
  for (;;) {
    try {
      return rest.length ? path.join(realpath(cur), ...rest.reverse()) : realpath(cur)
    } catch {
      const parent = path.dirname(cur)
      if (parent === cur) return undefined
      rest.push(path.basename(cur))
      cur = parent
    }
  }
}

/** `isSafeLocalTranscriptPath`, also admitting a path whose real location passes it. */
export function isSafeLocalTranscriptPathFollowingLinks(
  abs: string,
  homeDir: string,
  userDataPath: string,
  codexHomeDir?: string,
  linkedDirs?: readonly string[],
  realpath?: (p: string) => string
): boolean {
  if (isSafeLocalTranscriptPath(abs, homeDir, userDataPath, codexHomeDir, linkedDirs)) return true
  const real = realPathOfDeepestAncestor(abs, realpath)
  if (!real || real === abs) return false
  // The roots are compared in their real form too: a home dir that is itself reached through a
  // link (WSL mounts, a relocated $HOME) must not make every real path look foreign.
  const realHome = realPathOfDeepestAncestor(homeDir, realpath) ?? homeDir
  const realUserData = realPathOfDeepestAncestor(userDataPath, realpath) ?? userDataPath
  const realCodex = codexHomeDir ? realPathOfDeepestAncestor(codexHomeDir, realpath) ?? codexHomeDir : undefined
  return isSafeLocalTranscriptPath(real, realHome, realUserData, realCodex, linkedDirs)
}
