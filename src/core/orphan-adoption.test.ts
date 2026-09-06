import path from 'path'
import { describe, expect, it } from 'vitest'

import {
  ADOPTED_NODE_SIZE,
  ADOPTION_PITCH_X,
  RECOVERED_TITLE,
  planOrphanAdoption,
  type OrphanMirrorEntry
} from './orphan-adoption'
import type { CanvasNodeState, Project } from '../shared/types'

/**
 * The mirror image of the boot dead-card classification: a live `nt-<id>` session that no project
 * still lists gets its card back. Everything here is pure — the tmux listing, the pane cwds, the
 * workspace and the agent-status mirror all arrive as data, so no tmux server is involved.
 */

const abs = (...parts: string[]): string => path.resolve(path.sep, ...parts)

const node = (id: string, over: Partial<CanvasNodeState> = {}): CanvasNodeState => ({
  id,
  kind: 'terminal',
  position: { x: 0, y: 0 },
  size: { width: 640, height: 440 },
  title: id,
  color: '#0a84ff',
  group: null,
  ...over
})

const project = (over: Partial<Project> = {}): Project => ({
  id: 'p1',
  name: 'repo',
  color: '#7aa2f7',
  viewport: { x: 0, y: 0, zoom: 1 },
  cwd: abs('srv', 'repo'),
  nodes: [],
  ...over
})

const plan = (over: {
  projects?: Project[]
  sessionNames?: string[]
  paneCwds?: Record<string, string>
  mirror?: (nodeId: string) => OrphanMirrorEntry | undefined
}) =>
  planOrphanAdoption({
    projects: over.projects ?? [project()],
    sessionNames: over.sessionNames ?? [],
    paneCwdBySession: new Map(Object.entries(over.paneCwds ?? {})),
    mirror: over.mirror
  })

describe('planOrphanAdoption', () => {
  it('adopts a live session with no card into the project that owns its pane cwd', () => {
    const result = plan({
      sessionNames: ['nt-term-a'],
      paneCwds: { 'nt-term-a': abs('srv', 'repo', 'src') }
    })
    expect(result.skipped).toEqual([])
    expect(result.adopt).toHaveLength(1)
    expect(result.adopt[0]).toMatchObject({ projectId: 'p1', sessionName: 'nt-term-a' })
    expect(result.adopt[0].node).toMatchObject({
      id: 'term-a',
      kind: 'terminal',
      title: RECOVERED_TITLE,
      titleAuto: false,
      group: null,
      tags: [],
      collapsed: false,
      cwd: '.',
      size: { ...ADOPTED_NODE_SIZE }
    })
    expect(result.adopt[0].node.agentId).toBeUndefined()
  })

  it('picks the NEAREST ancestor project, not merely a containing one', () => {
    // A worktree nested inside its main clone. A `startsWith` test would hand the pane to the
    // parent repo and the operator would look for their session on the wrong canvas.
    const main = project({ id: 'main', name: 'main', cwd: abs('srv', 'repo') })
    const wt = project({ id: 'wt', name: 'worktree', cwd: abs('srv', 'repo', 'wt', 'feature') })
    const result = plan({
      projects: [main, wt],
      sessionNames: ['nt-term-a'],
      paneCwds: { 'nt-term-a': abs('srv', 'repo', 'wt', 'feature', 'src') }
    })
    expect(result.adopt.map((a) => a.projectId)).toEqual(['wt'])
  })

  it('does not treat a sibling folder that shares a name prefix as containment', () => {
    const result = plan({
      projects: [project({ cwd: abs('srv', 'repo') })],
      sessionNames: ['nt-term-a'],
      paneCwds: { 'nt-term-a': abs('srv', 'repo-two', 'src') }
    })
    expect(result.adopt).toEqual([])
    expect(result.skipped).toEqual([
      {
        nodeId: 'term-a',
        sessionName: 'nt-term-a',
        cwd: abs('srv', 'repo-two', 'src'),
        reason: 'unmatched-cwd'
      }
    ])
  })

  it('leaves a pane whose cwd matches no project alone, and says so', () => {
    const result = plan({
      sessionNames: ['nt-term-a'],
      paneCwds: { 'nt-term-a': abs('elsewhere') }
    })
    expect(result.adopt).toEqual([])
    expect(result.skipped[0].reason).toBe('unmatched-cwd')
  })

  it('reports a session tmux could give no pane cwd for rather than guessing a project', () => {
    const result = plan({ sessionNames: ['nt-term-a'], paneCwds: {} })
    expect(result.adopt).toEqual([])
    expect(result.skipped).toEqual([
      { nodeId: 'term-a', sessionName: 'nt-term-a', cwd: null, reason: 'no-pane-cwd' }
    ])
  })

  it('never adopts a session that already has a card', () => {
    const result = plan({
      projects: [project({ nodes: [node('term-a')] })],
      sessionNames: ['nt-term-a'],
      paneCwds: { 'nt-term-a': abs('srv', 'repo') }
    })
    expect(result).toEqual({ adopt: [], skipped: [] })
  })

  it('recognises a carded node whose id the tmux name cannot round-trip', () => {
    // `sessionName()` sanitises `.` to `_`, so the card id `term.a` lives in `nt-term_a` and the
    // reverse mapping would invent `term_a`. Matching the session name too keeps that from
    // becoming a duplicate card for one live pane.
    const result = plan({
      projects: [project({ nodes: [node('term.a')] })],
      sessionNames: ['nt-term_a'],
      paneCwds: { 'nt-term_a': abs('srv', 'repo') }
    })
    expect(result).toEqual({ adopt: [], skipped: [] })
  })

  it('ignores tmux sessions this app did not name', () => {
    const result = plan({
      sessionNames: ['scratch', 'ssh-tunnel', '0'],
      paneCwds: { scratch: abs('srv', 'repo') }
    })
    expect(result).toEqual({ adopt: [], skipped: [] })
  })

  it('never adopts into an SSH project — local tmux says nothing about another host', () => {
    // The fixture deliberately gives the ssh project a LOCAL-looking `cwd` too. Without it the
    // `!project.cwd` half of the filter alone would satisfy this test and the `project.ssh` half
    // could be deleted with the suite still green (mutation-checked, 2026-09-01).
    const remote = project({
      id: 'p-ssh',
      name: 'remote',
      cwd: abs('srv', 'repo'),
      ssh: { server: { host: 'h', user: 'u' }, remoteCwd: abs('srv', 'repo') }
    })
    const result = plan({
      projects: [remote],
      sessionNames: ['nt-term-a'],
      paneCwds: { 'nt-term-a': abs('srv', 'repo', 'src') }
    })
    expect(result.adopt).toEqual([])
    expect(result.skipped[0].reason).toBe('unmatched-cwd')
  })

  it('titles a recovered card from the agent-status mirror when it has one', () => {
    const result = plan({
      sessionNames: ['nt-term-a', 'nt-term-b'],
      paneCwds: { 'nt-term-a': abs('srv', 'repo'), 'nt-term-b': abs('srv', 'repo') },
      mirror: (id) => (id === 'term-a' ? { name: 'wp-e implementation', agentId: 'claude' } : undefined)
    })
    expect(result.adopt[0].node).toMatchObject({
      title: 'wp-e implementation',
      titleAuto: true,
      agentId: 'claude'
    })
    // No mirror entry: a placeholder title that must NOT auto-track (it would be pushed back to
    // the agent as a /rename).
    expect(result.adopt[1].node).toMatchObject({ title: RECOVERED_TITLE, titleAuto: false })
    expect(result.adopt[1].node.agentId).toBeUndefined()
  })

  it('lays the recovered cards out in a row to the right of everything already there', () => {
    const existing = project({
      nodes: [
        node('kept-1', { position: { x: 0, y: 40 } }),
        node('kept-2', { position: { x: 1_000, y: 120 } })
      ]
    })
    const result = plan({
      projects: [existing],
      sessionNames: ['nt-term-a', 'nt-term-b'],
      paneCwds: { 'nt-term-a': abs('srv', 'repo'), 'nt-term-b': abs('srv', 'repo') }
    })
    expect(result.adopt.map((a) => a.node.position)).toEqual([
      { x: 1_000 + ADOPTION_PITCH_X, y: 120 },
      { x: 1_000 + 2 * ADOPTION_PITCH_X, y: 120 }
    ])
  })

  it('measures the row from ROOT nodes only — a framed child is in frame coordinates', () => {
    const framed = project({
      nodes: [
        node('frame-1', { kind: 'group', position: { x: 100, y: 0 } }),
        node('child', { position: { x: 9_000, y: 0 }, parentId: 'frame-1' })
      ]
    })
    const result = plan({
      projects: [framed],
      sessionNames: ['nt-term-a'],
      paneCwds: { 'nt-term-a': abs('srv', 'repo') }
    })
    expect(result.adopt[0].node.position.x).toBe(100 + ADOPTION_PITCH_X)
  })

  it('starts at the origin for a project with no cards left at all', () => {
    const result = plan({
      sessionNames: ['nt-term-a'],
      paneCwds: { 'nt-term-a': abs('srv', 'repo') }
    })
    expect(result.adopt[0].node.position).toEqual({ x: 0, y: 0 })
  })

  it('is deterministic in session order regardless of what tmux listed first', () => {
    const forward = plan({
      sessionNames: ['nt-term-a', 'nt-term-b'],
      paneCwds: { 'nt-term-a': abs('srv', 'repo'), 'nt-term-b': abs('srv', 'repo') }
    })
    const reversed = plan({
      sessionNames: ['nt-term-b', 'nt-term-a'],
      paneCwds: { 'nt-term-a': abs('srv', 'repo'), 'nt-term-b': abs('srv', 'repo') }
    })
    expect(reversed.adopt).toEqual(forward.adopt)
  })
})
