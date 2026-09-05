// The display name nodeterm gives a session it LAUNCHES — pure, deterministic, and shaped for a
// list a human has to scan.
//
// Why it exists: an agent CLI that is not told a name generates one, and the generated names are
// exactly the ones that collide. Claude Code derives a local name from the working directory's
// basename plus two hex characters, and its Remote Control entry from
// `--remote-control-session-name-prefix`, whose documented default is the machine's HOSTNAME.
// Measured on one account (2026-09-04): a single peer listing returned 227 sessions — 216 of them
// offline, 60 hostname-named from two other machines — and on a second account four of six live
// sessions read as `claude-XX` because they shared one working directory. That listing offers no
// grouping, no filter and no search, so the NAME is the only thing separating one session from
// another, and the name is the half we own.
//
// Everything here is pure: no clock, no randomness, no environment. The same inputs always produce
// the same name, so the same node launched from the same place is always called the same thing.

import { argvHasFlag, shellSingleQuote } from '../shell-quote'
import { namesSession, type AgentId } from './config'

/**
 * Segment separator: U+00B7 MIDDLE DOT. Chosen because it reads as a separator at a glance and is
 * excluded from the segment charset below, so it can never appear INSIDE a segment and the shape
 * stays unambiguous. It is the only non-ASCII character a name may contain — and it introduces no
 * new class of risk on the typed launch line, which already carries arbitrary UTF-8 prompt text.
 */
export const SESSION_NAME_SEP = '·'

/**
 * Hard cap on the whole name.
 *
 * The name is shown in the CLI's prompt box, its `/resume` picker and the terminal title — three
 * places that are a single line wide — so it has to stay scannable rather than merely fit. 64 is
 * the smallest bound that holds the full shape without truncating in the common case: a project
 * and a task at the per-segment cap (24 each), a role (~8), the discriminator (6) and three
 * separators come to 65, so the tail of the descriptive part is trimmed only once every segment is
 * at its own maximum. Names are also the payload of a listing, and a listing of 227 of them is
 * read by eye.
 */
export const SESSION_NAME_MAX = 64

/** Per-segment cap. Applied BEFORE the whole-name cap so one very long segment (a pasted prompt)
 *  cannot crowd out the segments after it. */
export const SESSION_NAME_SEGMENT_MAX = 24

/** How many trailing characters of the node id become the discriminator. Six hex-ish characters is
 *  ~24 bits of the id's random half — enough that two nodes on one canvas do not collide, short
 *  enough not to dominate a name a human is scanning. */
export const SESSION_NAME_DISCRIMINATOR_CHARS = 6

/** Used when every descriptive segment sanitises away, so a name is never empty and never just a
 *  number — a bare `9afef0` in a picker tells the reader nothing at all. */
export const SESSION_NAME_FALLBACK = 'nodeterm'

export interface SessionNameInputs {
  /** The project this session belongs to — a canvas/project name, or the working directory's
   *  basename when that is all the launcher knows. */
  project?: string
  /** What this session is FOR: the launch prompt at creation, the node's own title later. */
  task?: string
  /** Which agent is running — the agent's label ("Claude"). */
  role?: string
  /** The canvas node id. The ONLY input guaranteed distinct per session, and therefore the only
   *  thing that makes the name collision-proof; see `buildSessionName`. */
  nodeId?: string
}

/**
 * Restrict a segment to characters that survive the round trip to a shell command line unchanged.
 *
 * Anything outside `[A-Za-z0-9._-]` becomes a `-`: whitespace (a newline would submit the
 * half-typed launch line), quotes, shell metacharacters, control characters and non-ASCII text all
 * collapse to a separator rather than being carried through. A project named `café` becomes
 * `caf-`, which is a cosmetic loss and the price of a charset the interpolation site can
 * re-validate in one expression.
 */
function sanitizeSegment(raw: string | undefined): string {
  if (!raw) return ''
  return raw
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-._]+/, '')
    .slice(0, SESSION_NAME_SEGMENT_MAX)
    .replace(/[-._]+$/, '')
}

/** Trailing punctuation left behind by a truncation — never part of the name a reader sees. */
function trimTail(s: string): string {
  return s.replace(/[-._·]+$/, '')
}

function discriminator(nodeId: string | undefined): string {
  const safe = (nodeId ?? '').replace(/[^A-Za-z0-9]+/g, '')
  return safe.slice(-SESSION_NAME_DISCRIMINATOR_CHARS)
}

/** Last path segment, in either dialect. The launcher knows a POSIX path for an SSH project and a
 *  local one otherwise, and it is not worth asking which — a `\` is a separator on the machine
 *  that would produce one, and legal filename text nowhere a name is built from. */
function basename(p: string | undefined): string {
  if (!p) return ''
  const parts = p.split(/[\\/]+/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : ''
}

/**
 * `<project>·<task>·<role>·<id>` — each descriptive segment dropped when it is absent or sanitises
 * away, so the shape degrades to `<project>·<role>·<id>`, `<project>·<id>` and finally
 * `nodeterm·<id>` without ever going empty.
 *
 * The trailing discriminator is what makes the name usable, and it is NOT decoration. Every other
 * input can be shared: two agent nodes opened in one working directory have the same project, the
 * same role and (until someone renames them) the same task, which is precisely how the CLI's own
 * derived names produce `claude-XX` four times over. The node id cannot be shared, so appending a
 * slice of it makes collisions impossible instead of unlikely.
 *
 * Truncation eats the TAIL of the descriptive part and never the discriminator: a name that has
 * been shortened into a duplicate of its neighbour is worth less than no name at all.
 */
export function buildSessionName(inputs: SessionNameInputs): string {
  const disc = discriminator(inputs.nodeId)
  const segments: string[] = []
  for (const raw of [inputs.project, inputs.task, inputs.role]) {
    const s = sanitizeSegment(raw)
    if (!s) continue
    // A node whose title is still its agent's label would otherwise read `…·Claude·Claude·9afef0`.
    if (segments.some((prev) => prev.toLowerCase() === s.toLowerCase())) continue
    segments.push(s)
  }
  const budget = SESSION_NAME_MAX - (disc ? disc.length + SESSION_NAME_SEP.length : 0)
  const body = trimTail(segments.join(SESSION_NAME_SEP).slice(0, budget)) || SESSION_NAME_FALLBACK
  return disc ? `${body}${SESSION_NAME_SEP}${disc}` : body
}

export interface NodeSessionNameInputs {
  /** The canvas node id — the discriminator's source. */
  nodeId: string
  /** The agent's display label ("Claude"), used as the role segment. */
  agentLabel?: string
  /** The node's working directory. Its basename is the project segment when no project name is
   *  known, which is every caller today: the factories are handed a project ID, not its name. */
  cwd?: string
  /** An explicit project name, preferred over the cwd basename when a caller has one. */
  project?: string
  /** What this session is for. Callers know different things at different moments and each passes
   *  its best: at creation that is the launch prompt, and on a cold restore — where the prompt is
   *  long gone — the node's own title. */
  task?: string
}

/**
 * The canvas-node adapter: which of a node's facts become which segment, defined ONCE so the fresh
 * launch and the cold restore cannot answer differently. Both call sites pass a node, not a name.
 */
export function sessionNameForNode(inputs: NodeSessionNameInputs): string {
  return buildSessionName({
    project: inputs.project?.trim() || basename(inputs.cwd),
    task: inputs.task,
    role: inputs.agentLabel,
    nodeId: inputs.nodeId
  })
}

/**
 * The charset a name must still match at the moment it is interpolated into a command line.
 *
 * `buildSessionName` already produces only this, so re-testing it here looks redundant — it is not.
 * A name can reach this function from a caller that did not build it (a persisted node title, a
 * hand-edited `.nodeterm/project.json`, a future call site), and the argument's TYPE is a
 * compile-time promise, not a runtime one. This is the same rule `SAFE_SESSION_ID` and
 * `permissionModeFlag` follow, for the same reason: the value ends up on a line typed into a live
 * shell.
 */
const SAFE_SESSION_NAME = /^[A-Za-z0-9][A-Za-z0-9._·-]*$/

/**
 * Append the launch-line display-name flag for an agent in `SESSION_NAME_CAPABLE`. Anything else —
 * another agent, an empty name, a name that fails the charset or the length cap — returns `cmd`
 * unchanged, so a command line that had no business carrying the flag stays byte-identical.
 *
 * FIRST LAUNCH ONLY, like `withSessionId`: the name is a property of the session being created, and
 * a `--resume <id>` joins a session that already has one.
 *
 * Skipped when the line already carries the flag, in either spelling. A per-agent launch-command
 * override (`settings.agentLaunchCommands`) is a wrapper the user wrote, and a wrapper is entitled
 * to name the session itself — appending ours would produce a duplicate option whose winner the
 * user cannot see (issue #601, the same trap `withPermissionMode` guards).
 *
 * Quoted even though the charset above needs no quoting: the quoting and the validation are two
 * independent guards, and only one of them has to survive a future widening of the charset.
 */
export function withSessionName(cmd: string, id: AgentId, name: string): string {
  if (!namesSession(id)) return cmd
  const n = name.trim()
  if (!n || n.length > SESSION_NAME_MAX || !SAFE_SESSION_NAME.test(n)) return cmd
  if (argvHasFlag(cmd, '--name') || argvHasFlag(cmd, '-n')) return cmd
  return `${cmd} --name ${shellSingleQuote(n)}`
}
