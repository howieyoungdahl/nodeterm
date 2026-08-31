import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  createDeliveryQueue,
  deliverFromControl,
  messagingEnabledVia,
  onMessagingAgentEvent,
  type AgentMessagingDeps
} from '../core/agents/agent-messaging'
import { paneOwnerProject } from '../core/agents/pane-ownership'
import {
  mirrorEntry,
  nodeState
} from '../core/agent-status-mirror'
import type { BoardLogHandlers } from '../core/board-log-handlers'
import {
  buildControlShimScript,
  buildCanvasControlInstructions,
  buildCanvasSkillBody,
  mergeCanvasControlBlock
} from '../core/canvas-control-core'
import { codexIdentityCaps } from '../core/codex-identity-caps'
import { codexThreadIdentityRoot } from '../core/codex-identity-proxy'
import { claudeCliCaps, type ClaudeCliCaps } from '../core/claude-cli'
import { installHooksIntoLocalAccounts } from '../core/claude-accounts-service'
import { platform } from '../core/platform'
import type { PtyManager } from '../core/pty-manager'
import type { WorkspaceStore } from '../core/workspace-store'
import type { NormalizedAgentEvent } from '../shared/agents/normalize'
import { IPC } from '../shared/ipc'
import type { Project, Settings } from '../shared/types'
import {
  createServerEditionControlHandler,
  type ServerEditionControlActions
} from './control-unsupported'
import { HeadlessNodeFactory } from './headless-node-factory'
import { sendSettledEnvelope } from './settled-envelope'

export interface ServerCanvasControlDeps {
  workspaceStore: WorkspaceStore
  ptyManager: PtyManager
  settings(): Settings
  boardLog: BoardLogHandlers
  cliCaps?: () => Promise<ClaudeCliCaps>
  /** Test seam for the boot-populated shared Codex capability answer. */
  codexSharedIdentity?: () => Promise<boolean>
  /** The server's installHooks gate. False keeps every real agent config directory untouched. */
  installAgentIntegrations?: boolean
}

export interface ServerCanvasControl {
  handler: ReturnType<typeof createServerEditionControlHandler>
  onAgentEvent(event: NormalizedAgentEvent): void
  installSkillInto(configDir: string): void
  stop(): void
}

function canvasControlDir(): string {
  return path.join(platform().userDataDir, 'canvas-control')
}

function shimPath(): string {
  return path.join(canvasControlDir(), 'nodeterm.sh')
}

function skillPathIn(configDir: string): string {
  return path.join(configDir, 'skills', 'manage-nodeterm-canvas', 'SKILL.md')
}

function writeShim(): void {
  const dir = canvasControlDir()
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(shimPath(), buildControlShimScript(codexThreadIdentityRoot()), 'utf8')
  try {
    fs.chmodSync(shimPath(), 0o755)
  } catch {
    /* best effort on filesystems without POSIX modes */
  }
  // Same upgrade sweep as desktop: the POSIX shim replaced this Electron-as-Node script.
  try {
    fs.rmSync(path.join(dir, 'canvas-control-cli.mjs'), { force: true })
  } catch {
    /* best effort */
  }
}

function installInstructions(file: string, body: string): void {
  try {
    let existing = ''
    try {
      existing = fs.readFileSync(file, 'utf8')
    } catch {
      /* first install */
    }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, mergeCanvasControlBlock(existing, body), 'utf8')
  } catch (error) {
    console.warn('[server-canvas-control] instruction install failed', file, error)
  }
}

/**
 * Boot the Server Edition canvas runtime and install its discovery surface.
 *
 * The shim itself always lives under the configured server dataDir, never under a hard-coded
 * `~/.nodeterm-server`. Writes to real Claude/Codex/Gemini homes are separately controlled by the
 * existing `installHooks` gate, exactly like `initServerContextLink`.
 */
export async function initServerCanvasControl(
  deps: ServerCanvasControlDeps
): Promise<ServerCanvasControl> {
  try {
    writeShim()
  } catch (error) {
    // The HTTP runtime remains useful even if discovery files cannot be written; fail open and loud.
    console.warn('[server-canvas-control] shim install failed', error)
  }

  const skillBody = buildCanvasSkillBody(shimPath())
  const instructions = buildCanvasControlInstructions(shimPath())
  const installSkillInto = (configDir: string): void => {
    const file = skillPathIn(configDir)
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, skillBody, 'utf8')
    } catch (error) {
      console.warn('[server-canvas-control] skill install failed', file, error)
    }
  }

  if (deps.installAgentIntegrations !== false) {
    installSkillInto(path.join(os.homedir(), '.claude'))
    installInstructions(path.join(os.homedir(), '.codex', 'AGENTS.md'), instructions)
    installInstructions(path.join(os.homedir(), '.gemini', 'GEMINI.md'), instructions)
    // Managed accounts resolve skills relative to their own CLAUDE_CONFIG_DIR.
    installHooksIntoLocalAccounts(deps.settings().claudeAccounts ?? [], installSkillInto)
  }

  const factory = new HeadlessNodeFactory({
    workspaceStore: deps.workspaceStore,
    ptyManager: deps.ptyManager,
    settings: deps.settings,
    cliCaps: deps.cliCaps ?? claudeCliCaps,
    codexSharedIdentity:
      deps.codexSharedIdentity ?? (() => codexIdentityCaps().then((caps) => caps.shared)),
    stateOf: nodeState,
    agentIdOf: (nodeId) => mirrorEntry(nodeId)?.agentId,
    publishProject: (project: Project) => platform().broadcast(IPC.workspaceExternalChange, project)
  })

  const messaging: AgentMessagingDeps = {
    paneOwner: (nodeId) => deps.ptyManager.paneOwner(nodeId),
    // Server delivery has no renderer/xterm echo stream. Capture the headless pane instead and
    // separate paste from Enter so a fresh TUI cannot swallow the first submit keystroke.
    sendEnvelope: (nodeId, envelope) =>
      sendSettledEnvelope(deps.ptyManager, nodeId, envelope),
    hasLiveSession: (nodeId) => deps.ptyManager.hasLiveSession(nodeId),
    mirrorEntry,
    projects: () => deps.workspaceStore.persistedCanvases(),
    isRemoteNode: () => false,
    messagingEnabled: messagingEnabledVia((projectId) =>
      deps.workspaceStore.capabilityProjectFor(projectId)),
    paneOwnerProject,
    callerOwnsTarget: (sourceNodeId, targetNodeId) =>
      factory.ownsSpawn(sourceNodeId, targetNodeId),
    customAgents: () => deps.settings().customAgents,
    appendBoardLog: (projectId, entry) => deps.boardLog.append(projectId, entry)
  }
  const queue = createDeliveryQueue(messaging)
  messaging.queue = queue

  const actions: ServerEditionControlActions = {
    openProject: (sourceNodeId, args, verified) =>
      factory.openProject(sourceNodeId, args, verified),
    openTerminal: (sourceNodeId, args, verified) =>
      factory.openTerminal(sourceNodeId, args, verified),
    openAgent: (sourceNodeId, args, verified) => factory.openAgent(sourceNodeId, args, verified),
    close: (sourceNodeId, args, verified) => factory.close(sourceNodeId, args, verified),
    link: (sourceNodeId, args, verified) => factory.link(sourceNodeId, args, verified),
    group: (sourceNodeId, args) => factory.group(sourceNodeId, args),
    rename: (sourceNodeId, args) => factory.rename(sourceNodeId, args),
    resize: (sourceNodeId, args, verified) => factory.resize(sourceNodeId, args, verified),
    color: (sourceNodeId, args) => factory.color(sourceNodeId, args),
    sticky: (sourceNodeId, args) => factory.sticky(sourceNodeId, args),
    // `runDelivery` applies caller→target creator proof before any pane probe or write, and
    // re-applies it when a queued delivery flushes.
    deliver: async (input) => (await deliverFromControl(input, messaging)).reply
  }

  // Boot deliberately performs no canvas/session adoption. Creator proof is process-local and a
  // restart clears it, so an owner request or browser view is the only cold-spawn authority.
  await factory.start()

  return {
    handler: createServerEditionControlHandler(actions),
    onAgentEvent: (event) => {
      onMessagingAgentEvent(event, queue)
      factory.onAgentEvent(event)
    },
    installSkillInto,
    stop: () => {
      factory.stop()
      queue.resetForTests()
    }
  }
}
