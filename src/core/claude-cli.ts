// Capability probe for the LOCAL Claude CLI. Version-gated behavior (`--permission-mode auto`,
// fullscreen TUI hooks) and help-advertised launch flags (`--session-id`, `--remote-control`) live
// in one memoized caps bag so callers never guess whether the installed binary accepts an option.
//
// Lives in core (not main) so the Server Edition boots it through the same CorePlatform seam.
// The remote (SSH) CLI is probed separately on its own host — see SshProjectManager.
import { execFile } from 'child_process'
import { promisify } from 'util'
import { supportsAutoPermissionMode, supportsFullscreenTui } from '../shared/agents/config'
import { IPC } from '../shared/ipc'
import { UNKNOWN_CLAUDE_CLI_CAPS, type ClaudeCliCaps } from '../shared/types'
import { findInLoginPath } from './pty-manager'
import { platform } from './platform'

const execFileP = promisify(execFile)
const PROBE_TIMEOUT_MS = 5000

export { UNKNOWN_CLAUDE_CLI_CAPS, type ClaudeCliCaps }

/**
 * Pure: probe output → caps. The impure probe below is just plumbing around it.
 *
 * Launch flags are FEATURE-detected from `--help` rather than gated on a version. Guessing a floor
 * is uniquely dangerous for these flags: an unrecognised flag makes the CLI exit, so a floor set
 * too low would kill the launch on machines below it. Reading help asks the binary in front of us
 * what it accepts. Absent help output ⇒ false ⇒ no optional flag.
 */
export function claudeCliCapsFrom(
  versionOutput: string | null | undefined,
  helpOutput?: string | null
): ClaudeCliCaps {
  const version = versionOutput?.trim() || null
  return {
    version,
    autoPermissionMode: supportsAutoPermissionMode(version),
    fullscreenTui: supportsFullscreenTui(version),
    // Exact option-token boundaries keep a longer option such as `--session-id-file` or
    // `--remote-control-session-name-prefix` from answering yes for the shorter flag.
    sessionIdFlag: /(^|\s)--session-id(\s|=|$)/m.test(helpOutput ?? ''),
    remoteControlFlag: /(^|\s)--remote-control(\s|=|$)/m.test(helpOutput ?? '')
  }
}

let cached: Promise<ClaudeCliCaps> | null = null

async function probe(): Promise<ClaudeCliCaps> {
  try {
    // GUI apps don't inherit the shell PATH — resolve through the login shell like every other
    // CLI lookup in the app (pty-manager, commit-message).
    const bin = await findInLoginPath('claude')
    if (!bin) return UNKNOWN_CLAUDE_CLI_CAPS
    const { stdout } = await execFileP(bin, ['--version'], { timeout: PROBE_TIMEOUT_MS })
    // `--help` is a second spawn, paid once per process (this whole probe is memoized). Its
    // failure must not cost us the version answer, so it degrades on its own: no help text just
    // means no help-advertised optional launch flags.
    const help = await execFileP(bin, ['--help'], { timeout: PROBE_TIMEOUT_MS })
      .then((r) => r.stdout)
      .catch(() => null)
    return claudeCliCapsFrom(stdout, help)
  } catch {
    // Missing CLI, timeout, non-zero exit — all mean "unknown", which means "omit the flag".
    return UNKNOWN_CLAUDE_CLI_CAPS
  }
}

/**
 * The local Claude CLI's capabilities. Memoized for the process lifetime: `claude --version`
 * spawns a login shell + node, and the answer only changes when the user upgrades the CLI (which a
 * relaunch picks up). Never rejects.
 */
export function claudeCliCaps(): Promise<ClaudeCliCaps> {
  if (!cached) cached = probe()
  return cached
}

/** Wire the probe onto the platform's RPC surface (Electron ipcMain / server WS-RPC alike). */
export function registerClaudeCliIpc(): void {
  platform().handle(IPC.claudeCliCaps, () => claudeCliCaps())
}
