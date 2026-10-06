import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { cleanupHash } from './session-cleanup'
import { TMUX_SOCKET, sessionName } from './tmux-naming'
import type { CanvasNodeState, Project } from '../shared/types'

export interface ReviewedFence { generation: string; fingerprint: string; ownerDigest: string; admissible: boolean; reason: string }
const exec = promisify(execFile)
/** This witness proves identity and unchanged activity, never task usefulness or completion.
 * Only an authenticated operator's separately recorded exact disposition supplies those semantics. */
export function createReviewedCleanupProbe(deps: { tmuxBin(): string | null; owner(nodeId: string): unknown;
  status(nodeId: string): unknown; activity(nodeId: string): number | undefined }) {
  const boot = randomUUID()
  return async (project: Project, node: CanvasNodeState): Promise<ReviewedFence> => {
    const denied = (reason: string): ReviewedFence => ({ generation: '', fingerprint: '', ownerDigest: '', admissible: false, reason })
    if (project.ssh || project.remote || project.unavailable || process.platform !== 'linux' || !deps.tmuxBin() || node.pendingLaunch)
      return denied('local-linux-reviewed-fence-unavailable')
    const owner = deps.owner(node.id) as { projectId?: string } | undefined
    if (!owner || owner.projectId !== project.id) return denied('owner-scope-unproven')
    const ownerDigest = cleanupHash(owner), target = `=${sessionName(node.id)}`, bin = deps.tmuxBin()!
    const pane = async () => {
      // Listing the exact private socket proves absence only when the complete list is readable.
      const { stdout } = await exec(bin, ['-L', TMUX_SOCKET, 'list-panes', '-a', '-F',
        '#{session_name}\t#{session_created}\t#{session_activity}\t#{window_activity}\t#{pane_id}\t#{pane_pid}\t#{pane_dead}'], { timeout: 4000, maxBuffer: 1024 * 1024 })
      const rows = stdout.trim().split('\n').filter(r => r.split('\t')[0] === sessionName(node.id))
      if (rows.length > 1) throw new Error('ambiguous-pane')
      return rows[0] ?? 'absent'
    }
    try {
      const status = deps.status(node.id) as { state?: string } | undefined
      if (status?.state === 'working') return denied('observed-working-task')
      const activity = deps.activity(node.id), first = await pane()
      let generation = `${boot}:absent:${cleanupHash(node)}`, screen = '', processes: unknown[] = []
      if (first !== 'absent') {
        const fields = first.split('\t'), pid = Number(fields[5]), paneId = fields[4]
        if (fields.length !== 7 || !/^%\d+$/.test(paneId) || !Number.isSafeInteger(pid) || pid <= 0 || fields[6] !== '0') return denied('invalid-or-dead-pane')
        screen = (await exec(bin, ['-L', TMUX_SOCKET, 'capture-pane', '-p', '-J', '-S', '-', '-t', paneId], { timeout: 4000, maxBuffer: 4 * 1024 * 1024 })).stdout
        const table = (await exec('ps', ['-eo', 'pid=,ppid='], { timeout: 4000, maxBuffer: 4 * 1024 * 1024 })).stdout
        const rows = table.trim().split('\n').map(line => {
          const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(line)
          if (!m) throw new Error('invalid-process-table')
          return { pid: Number(m[1]), ppid: Number(m[2]) }
        })
        const children = new Set([pid])
        for (let i = 0; i < rows.length; i++) { let changed = false
          for (const row of rows) if (children.has(row.ppid) && !children.has(row.pid)) { children.add(row.pid); changed = true }
          if (!changed) break
        }
        const stats = await Promise.all([...children].sort((a,b) => a-b).map(async id => {
          const raw = await fs.readFile(`/proc/${id}/stat`, 'utf8'), tail = raw.slice(raw.lastIndexOf(')') + 2).split(' ')
          if (!/^\d+$/.test(tail[19])) throw new Error('birth-unavailable')
          // CPU time, foreground group and process birth fence quiet process work as well as output.
          return [id, tail[1], tail[5], tail[11], tail[12], tail[19]]
        }))
        processes = stats
        generation = `${boot}:${TMUX_SOCKET}:${target}:${first}:${cleanupHash(stats.map(s => [s[0],s[5]]))}`
        const again = (await exec(bin, ['-L', TMUX_SOCKET, 'capture-pane', '-p', '-J', '-S', '-', '-t', paneId], { timeout: 4000, maxBuffer: 4 * 1024 * 1024 })).stdout
        if (screen !== again) return denied('activity-during-reviewed-probe')
      }
      if (first !== await pane() || cleanupHash(deps.owner(node.id)) !== ownerDigest ||
        cleanupHash(deps.status(node.id)) !== cleanupHash(status) || deps.activity(node.id) !== activity) return denied('identity-or-activity-during-reviewed-probe')
      return { generation, ownerDigest, admissible: true, reason: 'operator-task-disposition-required',
        fingerprint: cleanupHash({ node, owner, first, screen, processes, status, activity }) }
    } catch { return denied('reviewed-fence-unavailable') }
  }
}
