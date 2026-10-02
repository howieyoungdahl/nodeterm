import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import { promisify } from 'node:util'
import { cleanupHash, type CleanupEvidence } from './session-cleanup'
import { sessionName, TMUX_SOCKET } from './tmux-naming'
import type { CanvasNodeState, Project } from '../shared/types'
import type { NormalizedAgentEvent } from '../shared/agents/normalize'
import type { MirrorEntry } from './agent-status-mirror'

const exec = promisify(execFile)
const unknown = (reason: string): CleanupEvidence => ({ generation: '', activityAt: null,
  state: 'unknown', workChildren: null, pending: true, fingerprint: '', reason })

/** Current-boot child/recurring evidence. A completed parent does not finish its children. */
export class CleanupActivity {
  private revision = 0
  private readonly children = new Map<string, Set<string>>()
  private readonly recurring = new Set<string>()
  observe(e: NormalizedAgentEvent): void {
    this.revision++
    if (e.kind === 'session' && e.sessionPhase) { this.children.delete(e.nodeId); this.recurring.delete(e.nodeId) }
    if (e.kind === 'subagent-start') {
      const set = this.children.get(e.nodeId) ?? new Set<string>()
      set.add(e.toolUseId ?? 'unknown-child'); this.children.set(e.nodeId, set)
    }
    if (e.kind === 'subagent-end' && e.toolUseId) this.children.get(e.nodeId)?.delete(e.toolUseId)
    // A timer can wake after a quiet hour. No global recurring clear is inferred from Stop.
    if (e.kind === 'recurring' && !e.recurringEnd) this.recurring.add(e.nodeId)
  }
  pending(nodeId: string): number { return (this.children.get(nodeId)?.size ?? 0) + Number(this.recurring.has(nodeId)) }
  version(): number { return this.revision }
}

export interface CleanupProcess { pid: number; ppid: number; command: string; birth: string }
/** Unknown descendants, including an idle long-running job, count as work. Infrastructure
 * helpers are allowed only under a Codex client visibly at its completed empty prompt. */
export function cleanupProcessWork(root: number, rows: CleanupProcess[], completedCodex: boolean): number | null {
  if (rows.filter(r => r.pid === root).length !== 1) return null
  const descendants = new Set([root])
  for (let i = 0; i < rows.length; i++) {
    let changed = false
    for (const r of rows) if (descendants.has(r.ppid) && !descendants.has(r.pid)) { descendants.add(r.pid); changed = true }
    if (!changed) break
  }
  const rootAllowed = new Set(['bash', 'zsh', 'sh', 'fish', ...(completedCodex ? ['codex', 'nodeterm-codex'] : [])])
  const helpers = new Set(completedCodex ? ['codex', 'nodeterm-codex', 'codex-code-mode'] : [])
  // A descendant shell can itself be a silent job running builtins; only the pane root is
  // allowed to be an idle shell. Do not whitelist every bash/zsh in the process tree.
  return rows.filter(r => descendants.has(r.pid) && !(r.pid === root ? rootAllowed : helpers).has(r.command)).length
}

export function completedCodexScreen(screen: string): boolean {
  const lines = screen.split('\n').map(l => l.trimEnd())
  let lastPrompt = -1
  for (let i = 0; i < lines.length; i++) if (/^\s*›/.test(lines[i])) lastPrompt = i
  if (lastPrompt < 0 || !/^\s*› Ask Codex to do anything\s*$/.test(lines[lastPrompt])) return false
  // The CLI's completion footer and empty placeholder supply semantics; neither a card title
  // nor elapsed silence can supply them. Unknown CLI versions simply stay in the review list.
  const recent = lines.slice(Math.max(0, lastPrompt - 6)).join('\n')
  return /(?:^|\n)\s*Worked for [^\n]+[•·][^\n]+/.test(recent) &&
    !/esc to interrupt|waiting for|approve|allow once|permission required/i.test(lines.slice(lastPrompt).join('\n'))
}

export function createCleanupProbe(deps: { tmuxBin(): string | null; status(nodeId: string): MirrorEntry | undefined;
  lastActivity(nodeId: string): number | undefined; activity: CleanupActivity }) {
  return async (project: Project, node: CanvasNodeState): Promise<CleanupEvidence> => {
    if (project.ssh || process.platform !== 'linux') return unknown('local-linux-tmux-evidence-unavailable')
    const bin = deps.tmuxBin()
    if (!bin) return unknown('tmux-unavailable')
    try {
      const target = `=${sessionName(node.id)}`
      const { stdout } = await exec(bin, ['-L', TMUX_SOCKET, 'list-panes', '-s', '-t', target, '-F',
        '#{session_created}\t#{session_activity}\t#{window_activity}\t#{pane_id}\t#{pane_pid}\t#{pane_dead}\t#{pane_current_command}'], { timeout: 4000, maxBuffer: 64_000 })
      const panes = stdout.trim().split('\n')
      if (panes.length !== 1) return unknown('ambiguous-pane')
      const fields = panes[0].split('\t')
      if (fields.length !== 7) return unknown('invalid-pane-metadata')
      const [created, attachedAt, activity, pane, pid, dead, command] = fields
      if (!/^\d+$/.test(pid) || !/^\d+$/.test(created) || !/^\d+$/.test(activity)) return unknown('invalid-pane-metadata')
      if (dead !== '0') return { ...unknown('dead-pane-preserved'), state: 'dead' }
      const { stdout: screen } = await exec(bin, ['-L', TMUX_SOCKET, 'capture-pane', '-p', '-J', '-S', '-80', '-t', pane], { timeout: 4000, maxBuffer: 128_000 })
      const { stdout: processes } = await exec('ps', ['-eo', 'pid=,ppid=,comm='], { timeout: 4000, maxBuffer: 4 * 1024 * 1024 })
      const rows: CleanupProcess[] = processes.trim().split('\n').map(line => {
        const m = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line)
        if (!m) throw new Error('bad-process-table')
        return { pid: Number(m[1]), ppid: Number(m[2]), command: m[3], birth: '' }
      })
      const root = rows.find(r => r.pid === Number(pid))
      if (!root) return unknown('pane-process-unavailable')
      const stat = await fs.readFile(`/proc/${pid}/stat`, 'utf8')
      root.birth = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
      if (!/^\d+$/.test(root.birth)) return unknown('process-generation-unavailable')
      const status = deps.status(node.id)
      // A shell's punctuation cannot establish an empty input buffer or distinguish a quiet
      // read builtin. Require a live Codex foreground process, not a footer left in shell history.
      const foreground = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[5])
      const codexForeground = rows.some(r => r.pid === foreground &&
        ['codex', 'nodeterm-codex'].includes(r.command))
      const codexDone = codexForeground && completedCodexScreen(screen)
      const workChildren = cleanupProcessWork(Number(pid), rows, codexDone)
      const pending = !!status?.awaitingInput || deps.activity.pending(node.id) > 0 || !!node.pendingLaunch
      const actualState = status?.state === 'waiting' ? 'waiting' : status?.state === 'blocked' ? 'blocked' :
        status?.state === 'working' ? 'active' : pending ? 'waiting' :
        workChildren !== null && workChildren > 0 ? 'active' : codexDone ? 'completed' : 'unknown'
      const at = Math.max(Number(activity) * 1000, deps.lastActivity(node.id) ?? 0)
      const generation = `${TMUX_SOCKET}:${created}:${pane}:${pid}:${root.birth}`
      const check = await exec(bin, ['-L', TMUX_SOCKET, 'list-panes', '-s', '-t', target, '-F',
        '#{session_created}\t#{session_activity}\t#{window_activity}\t#{pane_id}\t#{pane_pid}\t#{pane_dead}\t#{pane_current_command}'], { timeout: 4000, maxBuffer: 64_000 })
      const lastScreen = await exec(bin, ['-L', TMUX_SOCKET, 'capture-pane', '-p', '-J', '-S', '-80', '-t', pane], { timeout: 4000, maxBuffer: 128_000 })
      if (check.stdout !== stdout || lastScreen.stdout !== screen) return unknown('activity-during-probe')
      return { generation, activityAt: at, state: actualState, workChildren, pending,
        fingerprint: cleanupHash({ generation, at, attachedAt, screen, status, pending, workChildren,
          children: rows.filter(r => r.ppid === Number(pid)).map(r => [r.pid, r.command]) }),
        reason: codexDone ? 'codex-completion-footer-and-empty-prompt' : actualState === 'unknown' &&
          ['bash', 'zsh', 'sh', 'fish'].includes(command) ? 'shell-input-boundary-unproven' : `observed-${actualState}` }
    } catch { return unknown('probe-unavailable') }
  }
}
