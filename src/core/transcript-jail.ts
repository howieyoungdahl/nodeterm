// The local transcript jail with the filesystem consulted: `isSafeLocalTranscriptPath` (pure, in
// claude-accounts-core) decides by path TEXT, which refuses a profile whose `projects` dir is a
// symlink into an allowed root. That is the common multi-account setup: `~/.claude-3/projects ->
// ~/.claude/projects`, so every hook from a `CLAUDE_CONFIG_DIR=~/.claude-3` pane reports
// `~/.claude-3/projects/<slug>/<sid>.jsonl`, the text check refuses it, and the context meter
// (model + fill) and subagent cards never start for that pane.
//
// This admits a path when its REAL location is inside an allowed root, and hands the tails that
// real path (see safeLocalTranscriptPathFollowingLinks for why never the link). The text check is
// still tried first, so every path admitted before is admitted, and read, exactly as before.
import fs from 'fs'
import path from 'path'
import { isSafeLocalTranscriptPath } from './claude-accounts-core'

/** Ancestors tried before giving up (see realPathOfDeepestAncestor). */
const MAX_ANCESTOR_WALK = 8

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
  // Bounded: a forged path with thousands of segments must not cost thousands of syscalls on the
  // hook hot path. A real transcript is a handful of segments below an existing project dir.
  for (let tries = 0; tries < MAX_ANCESTOR_WALK; tries++) {
    try {
      return rest.length ? path.join(realpath(cur), ...rest.reverse()) : realpath(cur)
    } catch {
      const parent = path.dirname(cur)
      if (parent === cur) return undefined
      rest.push(path.basename(cur))
      cur = parent
    }
  }
  return undefined
}

/**
 * The path the tails may read, or undefined when refused. A text-admitted path is returned as is
 * (the behavior before this module). A path admitted through a link is returned in its RESOLVED
 * form, never as given: the tails reopen the path on every poll, so handing back the link would let
 * whoever owns it (`/tmp/d/x -> ~/.claude/projects`, then repointed at `~/.ssh`) change what is
 * read after the check passed. The resolved path sits inside an allowed root, so changing what it
 * names needs write access there, exactly as for a text-admitted path.
 */
export function safeLocalTranscriptPathFollowingLinks(
  abs: string,
  homeDir: string,
  userDataPath: string,
  codexHomeDir?: string,
  linkedDirs?: readonly string[],
  realpath?: (p: string) => string
): string | undefined {
  if (isSafeLocalTranscriptPath(abs, homeDir, userDataPath, codexHomeDir, linkedDirs)) return abs
  const real = realPathOfDeepestAncestor(abs, realpath)
  if (!real || real === abs) return undefined
  // The roots are compared in their real form too: a home dir that is itself reached through a
  // link (WSL mounts, a relocated $HOME) must not make every real path look foreign.
  const realHome = realPathOfDeepestAncestor(homeDir, realpath) ?? homeDir
  const realUserData = realPathOfDeepestAncestor(userDataPath, realpath) ?? userDataPath
  const realCodex = codexHomeDir ? realPathOfDeepestAncestor(codexHomeDir, realpath) ?? codexHomeDir : undefined
  return isSafeLocalTranscriptPath(real, realHome, realUserData, realCodex, linkedDirs) ? real : undefined
}
