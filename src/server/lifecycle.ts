import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { MirrorEntry } from '../core/agent-status-mirror'
import { deriveLifecycle, lifecycleConfigFromEnv, type BlockedOn, type Lifecycle, type LifecycleConfig, type LifecycleInput } from '../core/lifecycle'
import { detectLifecyclePrompt } from '../core/lifecycle-prompt'
import { latestLifecycleTurn } from '../core/lifecycle-transcript'
import { readSmallTail, resolveTranscriptPath } from '../core/transcript-reader'
import { isSafeLocalTranscriptPath } from '../core/claude-accounts-core'
import { linkedClaudeConfigDirs } from '../core/claude-config-dir'
import { resolveCodexHomeRouting } from '../core/codex-home-routing'
import { codexThreadForNode, SYSTEM_ACCOUNT_SCOPE } from '../core/codex-identity-proxy'
import { isShellCommand } from '../shared/agents/pane'
import { isAgentPane, type PaneOwner } from '../shared/agents/pane-owner-predicate'

export const PROMPT_PROBE_INTERVAL_MS = 30_000
export const SILENT_HOOK_MS = 60_000
interface Observation { provider?: string | null; at: number; eventAt?: number; sessionId?: string; prompt: BlockedOn | null }
interface LifecycleReaderDeps {
  entry(nodeId: string): MirrorEntry | undefined
  paneCommand(nodeId: string): Promise<string | null>
  paneOwner(nodeId: string): Promise<PaneOwner | null>
  capture(nodeId: string): Promise<string>
  userDataDir: string
  now?: () => number
  config?: LifecycleConfig
  transcriptDone?(nodeId: string, entry: MirrorEntry): Promise<{ at: number; clean: boolean } | null>
}

/** Read-only observation. Never sends input, adopts a backend, or changes the compatibility mirror state. */
export class ServerLifecycleReader {
  private observations = new Map<string, Observation>()
  private inflight = new Map<string, Promise<Lifecycle>>()
  private fallback = new Map<string, { entry: MirrorEntry; at: number; done: LifecycleInput['transcriptDone'] }>()
  private hookless = new Map<string, { at: number; provider: string | null; savedSessionId?: string | null; entry?: MirrorEntry }>()
  private readonly now: () => number
  private readonly config: LifecycleConfig
  constructor(private readonly deps: LifecycleReaderDeps) {
    this.now = deps.now ?? Date.now
    this.config = deps.config ?? lifecycleConfigFromEnv(process.env)
  }
  forget(nodeId: string): void {
    this.observations.delete(nodeId)
    this.fallback.delete(nodeId)
    this.hookless.delete(nodeId)
  }
  read(nodeId: string, input: LifecycleInput): Promise<Lifecycle> {
    // Concurrent polls share a capture, so a slow tmux command cannot defeat the 30 s cap.
    const current = this.inflight.get(nodeId)
    if (current) return current
    const promise = this.observe(nodeId, input).finally(() => this.inflight.delete(nodeId))
    this.inflight.set(nodeId, promise)
    return promise
  }
  private async observe(nodeId: string, input: LifecycleInput): Promise<Lifecycle> {
    const now = this.now()
    const entry = this.deps.entry(nodeId)
    let evidence = entry
    if (input.paneState === 'alive' && !entry) {
      let owner: PaneOwner | null = null
      try { owner = await this.deps.paneOwner(nodeId) } catch { /* unknown */ }
      const providers = ['codex', 'claude'].filter(provider => isAgentPane(owner, provider) === 'agent')
      const provider = providers.length === 1 ? providers[0] : null
      const cached = this.hookless.get(nodeId)
      const savedSessionId = input.sessionId
      if (cached && cached.provider === provider && cached.savedSessionId === savedSessionId && now - cached.at < PROMPT_PROBE_INTERVAL_MS) evidence = cached.entry
      else {
        if (provider === 'codex') {
          const binding = codexThreadForNode(nodeId, path.join(this.deps.userDataDir, 'codex-thread-nodes'))
          if (binding) {
            try {
              const route = resolveCodexHomeRouting(undefined, binding.scope === SYSTEM_ACCOUNT_SCOPE ? undefined : binding.scope)
              evidence = { agentId: provider, sessionId: binding.threadId, codexHome: route.home, codexAccountId: route.accountId, restored: true, updatedAt: 0 }
            } catch { /* Unsupported account evidence stays unknown. */ }
          }
        } else if (provider === 'claude' && savedSessionId) {
          evidence = { agentId: provider, sessionId: savedSessionId, restored: true, updatedAt: 0 }
        }
        this.hookless.set(nodeId, { at: now, provider, savedSessionId, entry: evidence })
      }
      // Kernel evidence supplies the provider. Only a signed binding supplies a Codex session.
      input = { ...input, provider, isAgent: provider !== null || input.isAgent, sessionId: evidence?.sessionId ?? null, restored: evidence?.restored ?? false }
    }
    let shell = false
    let detectedPrompt: BlockedOn | null = null
    let transcriptDone: LifecycleInput['transcriptDone'] = null
    if (input.paneState === 'alive' && input.isAgent) {
      try { shell = isShellCommand(await this.deps.paneCommand(nodeId)) } catch { /* unknown */ }
      const silent = !entry?.state || (entry.state === 'working' && now - (entry.lastEventAt ?? entry.updatedAt) > SILENT_HOOK_MS)
      if (!shell && silent) {
        const previous = this.observations.get(nodeId)
        if (previous && (previous.eventAt !== entry?.lastEventAt || previous.sessionId !== evidence?.sessionId || previous.provider !== input.provider)) previous.prompt = null
        if (!previous || now - previous.at >= PROMPT_PROBE_INTERVAL_MS) {
          const observation: Observation = { provider: input.provider, at: now, eventAt: entry?.lastEventAt, sessionId: evidence?.sessionId, prompt: null }
          this.observations.set(nodeId, observation)
          try {
            const hit = detectLifecyclePrompt(input.provider ?? null, await this.deps.capture(nodeId))
            if (hit) observation.prompt = { ...hit, since: previous?.prompt?.kind === hit.kind && previous.sessionId === evidence?.sessionId &&
              previous.eventAt === entry?.lastEventAt ? previous.prompt.since : now }
          } catch { /* Failed capture is unknown, never positive prompt evidence. */ }
        }
        const observed = this.observations.get(nodeId)
        if (observed?.eventAt === entry?.lastEventAt && observed?.sessionId === evidence?.sessionId) detectedPrompt = observed?.prompt ?? null
      }
      if (!silent || shell) {
        const previous = this.observations.get(nodeId)
        if (previous) previous.prompt = null
      }
      if (!shell && evidence?.restored) {
        const cached = this.fallback.get(nodeId)
        if (cached?.entry === evidence && now - cached.at < PROMPT_PROBE_INTERVAL_MS) transcriptDone = cached.done
        else {
          try { transcriptDone = await (this.deps.transcriptDone?.(nodeId, evidence) ?? this.readTranscript(evidence, now)) } catch { /* unknown */ }
          this.fallback.set(nodeId, { entry: evidence, at: now, done: transcriptDone })
        }
      }
    }
    // A hook arriving during a capture/read wins over the older observation.
    const fresh = this.deps.entry(nodeId)
    if (fresh !== entry) return deriveLifecycle({ ...input, ...fresh, restored: fresh?.restored ?? false,
      provider: fresh?.agentId ?? input.provider, sessionId: fresh?.sessionId ?? input.sessionId, detectedPrompt: null, shell }, this.now(), this.config)
    return deriveLifecycle({ ...input, ...evidence, shell, detectedPrompt, transcriptDone }, now, this.config)
  }
  private async readTranscript(entry: MirrorEntry, now: number): Promise<LifecycleInput['transcriptDone']> {
    const sid = entry.sessionId
    if (!sid || !/^[a-zA-Z0-9-]+$/.test(sid)) return null
    let file = entry.transcriptPath
    let roots: string[] = []
    if (entry.agentId === 'claude') {
      file ??= await resolveTranscriptPath(sid, entry.account?.accountId ?? undefined)
      if (!file || path.basename(file) !== `${sid}.jsonl`) return null
      const linked = linkedClaudeConfigDirs()
      if (!isSafeLocalTranscriptPath(path.resolve(file), os.homedir(), this.deps.userDataDir, undefined, linked)) return null
      roots = [path.join(os.homedir(), '.claude', 'projects'), ...linked.map(dir => path.join(dir, 'projects'))]
      if (entry.account?.accountId) roots.push(path.join(this.deps.userDataDir, 'claude-accounts', entry.account.accountId, 'projects'))
    } else if (entry.agentId === 'codex') {
      // Resolve the account from server settings, never use an arbitrary persisted directory as a jail.
      const home = resolveCodexHomeRouting(entry.codexHome, entry.codexAccountId ?? undefined).home
      const root = path.join(home, 'sessions')
      roots = [root]
      file ??= await findRollout(root, sid)
      if (!file || !path.resolve(file).startsWith(root + path.sep) || !path.basename(file).endsWith(`-${sid}.jsonl`)) return null
    } else return null
    const root = roots.find(root => path.resolve(file!).startsWith(root + path.sep))
    if (!root) return null
    // A persisted path may have become a symlink since the hook's jail check.
    const [realFile, realRoot] = await Promise.all([fs.realpath(file), fs.realpath(root)])
    if (!realFile.startsWith(realRoot + path.sep)) return null
    const text = await readSmallTail(realFile, 1024 * 1024)
    return text ? latestLifecycleTurn(text, entry.agentId, now) : null
  }
}

/** Legacy mirrors lack a transcript binding. Walk only the dated rollout tree, with a work cap. */
async function findRollout(root: string, sid: string): Promise<string | undefined> {
  let budget = 2_000
  const walk = async (dir: string, depth: number): Promise<string | undefined> => {
    if (budget <= 0) return undefined
    let entries
    try { entries = await fs.readdir(dir, { withFileTypes: true }) } catch { return undefined }
    for (const entry of entries.sort((a, b) => b.name.localeCompare(a.name))) {
      if (--budget < 0) return undefined
      if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith(`-${sid}.jsonl`)) return path.join(dir, entry.name)
      if (depth > 0 && entry.isDirectory() && /^\d{2,4}$/.test(entry.name)) {
        const found = await walk(path.join(dir, entry.name), depth - 1)
        if (found) return found
      }
    }
    return undefined
  }
  return walk(root, 3)
}
