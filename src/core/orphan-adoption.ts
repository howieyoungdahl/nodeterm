import path from 'path'

import { NODE_COLORS } from '../shared/node-colors'
import { isSafeNodeId } from '../shared/safe-id'
import type { AgentId } from '../shared/agents/config'
import type { CanvasNodeState, Project } from '../shared/types'
import { isSessionName, sessionName } from './tmux-naming'

/**
 * ORPHAN ADOPTION — a card for a backend that provably exists.
 *
 * The counterpart of the boot dead-card classification (`PtyManager.protectPersistedSessionsAtBoot`),
 * pointed the other way. That one starts from a saved card and asks whether its session survived;
 * this one starts from a surviving `nt-<id>` session and asks whether any project still has a card
 * for it. Both losses are real and neither used to be repaired: on 2026-09-01 a stale client kept
 * republishing a truncated node list, eight live panes fell out of `project.json`, and the restart
 * that followed rendered two terminals over eleven running sessions. `WorkspaceStore`'s save rescue
 * stops the leak; this closes the gap for sessions that already leaked out.
 *
 * CONSISTENCY WITH THE INERT-BOOT RULE. Adoption creates a CARD ONLY. It never creates, attaches,
 * spawns, kills or types anything, and it grants no fresh-spawn authority — the id is not one this
 * Server run created, so `bootPersisted` still classifies it attach-only and the browser reaches it
 * through the same attach-only path a persisted card takes on mount. The evidence bar is the
 * opposite of the reaper's: the reaper needs two DEFINITE absences before it removes a card, and
 * adoption needs one definite PRESENCE (a live session plus a pane cwd) before it adds one. Neither
 * acts on `unknown`.
 *
 * This module is pure: sessions, pane cwds, the workspace and the agent-status mirror all arrive as
 * data, and the answer is a list of appends. The shells own every side effect.
 */

/** Recovered cards get the manual-open rectangle, not the compact canvas-control one. */
export const ADOPTED_NODE_SIZE = { width: 640, height: 440 } as const
/** Horizontal pitch of the recovered row. Wider than the card, so nothing overlaps. */
export const ADOPTION_PITCH_X = 720
/** Title for a pane the agent-status mirror knows nothing about. Deliberately not "Terminal": the
 *  operator must be able to tell a recovered card from one they opened. */
export const RECOVERED_TITLE = 'Terminal (recovered)'

/** What the mirror can tell us about an orphan (`mirrorEntry` in agent-status-mirror.ts). */
export interface OrphanMirrorEntry {
  /** The agent's own session name, published by the session-name sweep. */
  name?: string
  agentId?: AgentId
}

export interface OrphanAdoptionInput {
  /** The workspace as loaded. SSH projects are read (to recognise their node ids) but never
   *  adopted into: this Server's local tmux says nothing about another host's sessions. */
  projects: readonly Project[]
  /** Live session names on the local socket (`PtyManager.listNodetermSessions`). */
  sessionNames: readonly string[]
  /** Session name → that session's working directory (`PtyManager.listNodetermPaneCwds`). */
  paneCwdBySession: ReadonlyMap<string, string>
  mirror?: (nodeId: string) => OrphanMirrorEntry | undefined
}

export interface OrphanAdoption {
  projectId: string
  projectName: string
  sessionName: string
  node: CanvasNodeState
}

/**
 * Why an orphan was left alone. Every one of these is a "degrade to nothing" outcome — a pane we
 * cannot place is reported, never guessed at.
 */
export type OrphanSkipReason =
  /** tmux answered no `pane_current_path` for the session (probe failed, or it has no pane). */
  | 'no-pane-cwd'
  /** The pane's cwd is not inside any local project folder. */
  | 'unmatched-cwd'
  /** `nt-<rest>` whose `<rest>` is not a usable node id — it would become a persisted card id. */
  | 'unsafe-node-id'

export interface OrphanSkip {
  nodeId: string
  sessionName: string
  cwd: string | null
  reason: OrphanSkipReason
}

export interface OrphanAdoptionPlan {
  adopt: OrphanAdoption[]
  skipped: OrphanSkip[]
}

/**
 * Is `paneCwd` inside `projectCwd`, and how deep? `null` = not contained.
 *
 * `path.relative` rather than `startsWith`: it is the separator- and case-correct containment test
 * on the filesystem that owns both paths (and both DO come from this host — the tmux socket and the
 * workspace index are the same machine). A bare prefix test says `/srv/repo-two` is inside
 * `/srv/repo`, which would adopt a pane into the wrong project.
 */
function containmentDepth(projectCwd: string, paneCwd: string): number | null {
  const rel = path.relative(path.resolve(projectCwd), path.resolve(paneCwd))
  if (rel === '') return 0
  // Only a real escape counts: a directory legitimately NAMED `..foo` is not one.
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null
  return rel.split(path.sep).length
}

/** The local project whose folder is the pane's NEAREST ancestor, or undefined. */
function nearestProject(
  projects: readonly Project[],
  paneCwd: string
): Project | undefined {
  let best: { project: Project; depth: number } | undefined
  for (const project of projects) {
    if (!project.cwd || project.ssh) continue
    const depth = containmentDepth(project.cwd, paneCwd)
    if (depth === null) continue
    // Nearest wins: a worktree nested inside its main clone must adopt its own panes.
    if (!best || depth < best.depth) best = { project, depth }
  }
  return best?.project
}

/** Root-level nodes only: a node inside a frame has FRAME-relative coordinates, and the frame that
 *  contains it is itself a root node covering the same span. */
function rootNodes(project: Project): CanvasNodeState[] {
  return project.nodes.filter((node) => !node.parentId)
}

/**
 * Plan the adoption. Deterministic in its inputs — session names are sorted, so the recovered row
 * comes out in a stable order (nodeterm ids are time-prefixed, so that is also roughly chronological).
 */
export function planOrphanAdoption(input: OrphanAdoptionInput): OrphanAdoptionPlan {
  // Both keys, because `sessionName()` is LOSSY: a node id containing `.` (legal per isSafeNodeId)
  // becomes `_` in the tmux name, so `nt-a_b` cannot be reversed to the card id `a.b`. Matching on
  // the session name too means such a session is correctly recognised as ALREADY carded — the one
  // case where the lossiness would otherwise create a duplicate card for a live pane.
  const knownIds = new Set(input.projects.flatMap((p) => p.nodes.map((n) => n.id)))
  const knownSessions = new Set([...knownIds].map((id) => sessionName(id)))
  const adopt: OrphanAdoption[] = []
  const skipped: OrphanSkip[] = []
  /** project id → how many cards this plan has already appended to it (row index + color index). */
  const appended = new Map<string, number>()

  for (const name of [...new Set(input.sessionNames)].sort()) {
    // Not a session this app named. Somebody else's tmux session on our socket is not ours to card.
    if (!isSessionName(name)) continue
    if (knownSessions.has(name)) continue
    const nodeId = name.slice('nt-'.length)
    if (knownIds.has(nodeId)) continue
    if (!isSafeNodeId(nodeId)) {
      skipped.push({ nodeId, sessionName: name, cwd: null, reason: 'unsafe-node-id' })
      continue
    }
    const cwd = input.paneCwdBySession.get(name)
    if (!cwd) {
      skipped.push({ nodeId, sessionName: name, cwd: null, reason: 'no-pane-cwd' })
      continue
    }
    const project = nearestProject(input.projects, cwd)
    if (!project) {
      skipped.push({ nodeId, sessionName: name, cwd, reason: 'unmatched-cwd' })
      continue
    }

    const roots = rootNodes(project)
    const already = appended.get(project.id) ?? 0
    // A row to the RIGHT of everything the project already has, so an adopted card never lands on
    // top of the user's layout. The rightmost card's y keeps the row reading as a continuation.
    const rightmost = roots.reduce<CanvasNodeState | undefined>(
      (best, node) => (!best || node.position.x > best.position.x ? node : best),
      undefined
    )
    const startX = rightmost ? rightmost.position.x + ADOPTION_PITCH_X : 0
    const y = rightmost ? rightmost.position.y : 0

    const entry = input.mirror?.(nodeId)
    const node: CanvasNodeState = {
      id: nodeId,
      kind: 'terminal',
      position: { x: startX + already * ADOPTION_PITCH_X, y },
      size: { ...ADOPTED_NODE_SIZE },
      title: entry?.name ?? RECOVERED_TITLE,
      // Only a mirror-supplied name keeps auto-tracking; the placeholder must not be pushed back
      // to the agent as a rename.
      titleAuto: !!entry?.name,
      color: NODE_COLORS[(roots.length + already) % NODE_COLORS.length],
      group: null,
      tags: [],
      collapsed: false,
      // The project root. The pane's real cwd is whatever the shell is in; this is the card's
      // RESTART directory, and the project folder is the only defensible answer for a pane whose
      // original node config is gone.
      cwd: '.',
      ...(entry?.agentId ? { agentId: entry.agentId } : {})
    }
    appended.set(project.id, already + 1)
    adopt.push({ projectId: project.id, projectName: project.name, sessionName: name, node })
  }

  return { adopt, skipped }
}
