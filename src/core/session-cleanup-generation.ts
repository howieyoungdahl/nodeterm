import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import { promisify } from 'node:util'
import { TMUX_SOCKET, sessionName } from './tmux-naming'

const exec = promisify(execFile)
const paneFormat = '#{session_created}\t#{pane_id}\t#{pane_pid}\t#{pane_dead}'
const tail = (stat: string) => stat.slice(stat.lastIndexOf(')') + 2).split(' ')
export const validCleanupProcess = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() === value && /^[1-9]\d{0,9}:\d{1,20}$/.test(value)

export interface CleanupGenerationWitness { generation: string; process: string }
export type CleanupStartupWitness = (nodeId: string, process: string) => Promise<CleanupGenerationWitness | undefined>

/** The sender's pre-dispatch PID/birth must still be the sole pane's foreground CLI.
 * Read twice so a replacement during this asynchronous probe cannot enroll itself. */
export function createCleanupStartupWitness(tmuxBin: () => string | null, bootId: string): CleanupStartupWitness {
  return async (nodeId, claim) => {
    if (process.platform !== 'linux' || !validCleanupProcess(claim)) return undefined
    const bin = tmuxBin()
    if (!bin) return undefined
    try {
      const panes = async () => (await exec(bin, ['-L', TMUX_SOCKET, 'list-panes', '-s', '-t', `=${sessionName(nodeId)}`,
        '-F', paneFormat], { timeout: 4000, maxBuffer: 64_000 })).stdout
      const first = await panes(), lines = first.trim().split('\n')
      if (lines.length !== 1) return undefined
      const [created, pane, pid, dead] = lines[0].split('\t')
      if (!/^\d+$/.test(created) || !/^%\d+$/.test(pane) || !/^\d+$/.test(pid) || dead !== '0') return undefined
      const rootStat = await fs.readFile(`/proc/${pid}/stat`, 'utf8')
      const root = tail(rootStat), foreground = root[5]
      if (!/^\d+$/.test(root[19]) || !/^\d+$/.test(foreground)) return undefined
      const foregroundStat = await fs.readFile(`/proc/${foreground}/stat`, 'utf8')
      const birth = tail(foregroundStat)[19]
      if (`${foreground}:${birth}` !== claim) return undefined
      const command = (await fs.readFile(`/proc/${foreground}/comm`, 'utf8')).trim()
      if (!['codex', 'nodeterm-codex'].includes(command)) return undefined
      const environment = await fs.readFile(`/proc/${foreground}/environ`, 'utf8')
      if (!environment.split('\0').includes(`NODETERM_CLEANUP_BOOT=${bootId}`)) return undefined
      if (await panes() !== first || await fs.readFile(`/proc/${pid}/stat`, 'utf8').then(s => {
        const latest = tail(s); return latest[19] !== root[19] || latest[5] !== foreground
      }) || tail(await fs.readFile(`/proc/${foreground}/stat`, 'utf8'))[19] !== birth) return undefined
      return { generation: `${TMUX_SOCKET}:${created}:${pane}:${pid}:${root[19]}:${foreground}:${birth}`, process: claim }
    } catch { return undefined }
  }
}
