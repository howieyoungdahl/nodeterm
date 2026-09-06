/** Bounded read adapter for the canonical D15 publication. No collector, ledger writer,
 * evidence reader, terminal lifecycle call, or agent-principal inference lives here. */
import { execFile } from 'node:child_process'
import path from 'node:path'
import { IPC } from '../shared/ipc'
import { adaptContextPage, validateOpenTarget, type ContextPage, type RemoteOpenTarget } from '../shared/remote-nav/context-page'
import type { TaskContextApi, TaskContextQuery, TaskFocusResult } from '../shared/remote-nav/task-context'
import { platform } from './platform'

export interface TaskContextSource { script: string; ledger: string; python: string }
type CurrentTarget = Parameters<typeof validateOpenTarget>[1]
export interface TaskContextDeps {
  source?: TaskContextSource
  /** Shell-owned principal check. A UI cookie never becomes an assigned agent principal. */
  authorizedOperator(sender: number): boolean
  now?: () => number
  /** Optional trusted shell integration; D15 compact records alone cannot implement this.
   * Must atomically validate current host/project/account/session/task/node/boot/epoch and
   * existing focus authorization, and apply ONLY viewport focus to an already attached node.
   * Returning a permit to a later browser callback would race transfers, so do not do that. */
  focusCurrent?: (sender: number, target: RemoteOpenTarget,
    validate: (current: CurrentTarget) => TaskFocusResult) => Promise<TaskFocusResult>
}
const denied = (code: string) => ({ ok: false as const, code, controlGranted: false as const })
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Only host startup configuration can select paths. No ambient default or source discovery. */
export function configuredTaskContextSource(env: NodeJS.ProcessEnv = process.env): TaskContextSource | undefined {
  const script = env.NODETERM_TASK_CONTEXT_SCRIPT
  const ledger = env.NODETERM_TASK_CONTEXT_LEDGER
  const python = env.NODETERM_TASK_CONTEXT_PYTHON
  return script && ledger && python && [script, ledger, python].every((p) => path.isAbsolute(p))
    ? { script, ledger, python } : undefined
}

function validQuery(raw: unknown): raw is TaskContextQuery {
  if (!object(raw) || Object.keys(raw).some((k) => !['operation', 'scope', 'cursor', 'previousSources', 'limit'].includes(k))) return false
  try {
    if (Buffer.byteLength(JSON.stringify(raw)) > 8192 || !object(raw.scope) ||
        Object.keys(raw.scope).some((k) => !['task_id', 'project_id', 'node'].includes(k)) ||
        Object.values(raw.scope).some((v) => typeof v !== 'string' || !v.trim() || v.length > 512) ||
        !['overview', 'task', 'owner', 'attention', 'handoff', 'changes', 'summary', 'observation', 'policy'].includes(String(raw.operation)) ||
        (raw.limit !== undefined && (!Number.isInteger(raw.limit) || Number(raw.limit) < 1 || Number(raw.limit) > 100)) ||
        (raw.cursor != null && (!object(raw.cursor) || Object.keys(raw.cursor).length !== 1 || typeof raw.cursor.canonical !== 'string')) ||
        (raw.previousSources !== undefined && (!Array.isArray(raw.previousSources) || raw.previousSources.length !== 1 || !object(raw.previousSources[0])))) return false
    return true
  } catch { return false }
}

class CursorInteger {
  constructor(readonly literal: string) {}
}
/** D15 fingerprints include nanosecond integers, beyond JS Number precision. Keep the
 * canonical cursor as opaque JSON text across browser transport; Python checks its complete
 * structure/fingerprint on use. No cursor field is interpreted as a path or authority here. */
export function decodeCanonicalTaskContext(stdout: string): unknown {
  const precise = JSON.parse(stdout, (_key, value, context?: { source: string }) => {
    if (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value)) {
      if (!context?.source || !/^-?\d+$/.test(context.source)) throw new Error('cursor precision unavailable')
      return new CursorInteger(context.source)
    }
    return value
  })
  const encode = (value: unknown): string => {
    if (value instanceof CursorInteger) return value.literal
    if (Array.isArray(value)) return `[${value.map(encode).join(',')}]`
    if (object(value)) return `{${Object.entries(value).map(([key, entry]) => `${JSON.stringify(key)}:${encode(entry)}`).join(',')}}`
    return JSON.stringify(value)
  }
  const payload = JSON.parse(stdout)
  if (object(payload) && object(precise) && precise.continuation != null) {
    payload.continuation = { canonical: encode(precise.continuation) }
  }
  return payload
}

/** Execute only the configured canonical query CLI. Its nonzero result can be a useful typed
 * refusal (stale publication/reset); never discard that stdout or substitute an empty list. */
export function readCanonicalTaskContext(source: TaskContextSource, query: TaskContextQuery): Promise<unknown> {
  const args = ['-B', source.script, query.operation, '--ledger', source.ledger,
    '--scope', JSON.stringify(query.scope), '--limit', String(query.limit ?? 25),
    '--max-bytes', '49152', '--max-read-bytes', '65536']
  if (query.cursor != null) args.push('--cursor', query.cursor.canonical as string)
  return new Promise((resolve) => {
    execFile(source.python, args, { timeout: 5000, killSignal: 'SIGKILL', maxBuffer: 65536, encoding: 'utf8', windowsHide: true }, (error, stdout) => {
      if (error && (error.killed || error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')) {
        resolve({ schema: 1, ok: false, code: error.killed ? 'source_timeout' : 'output_limit' }); return
      }
      try { resolve(decodeCanonicalTaskContext(stdout)) }
      catch { resolve({ schema: 1, ok: false, code: 'source_unavailable' }) }
    })
  })
}
export function createTaskContextService(deps: TaskContextDeps): (sender: number) => TaskContextApi {
  let activeReads = 0
  return (sender) => ({
    async read(raw): Promise<ContextPage> {
      if (!deps.authorizedOperator(sender)) return denied('not_authorized')
      if (!validQuery(raw)) return denied('invalid_query')
      if (!deps.source) return denied('source_unavailable')
      if (activeReads >= 2) return denied('source_busy')
      activeReads++
      try {
        const payload = await readCanonicalTaskContext(deps.source, raw)
        if (!deps.authorizedOperator(sender)) return denied('not_authorized')
        return adaptContextPage(payload, { ...raw, nowMs: deps.now?.() ?? Date.now(), maxBytes: 65536 })
      } finally { activeReads-- }
    },
    async focus(target) {
      if (!deps.authorizedOperator(sender)) return denied('not_authorized')
      if (!object(target)) return denied('target_unknown')
      if (!deps.focusCurrent) return denied('focus_authority_unavailable')
      return deps.focusCurrent(sender, target, (current) => {
        if (!deps.authorizedOperator(sender)) return denied('not_authorized')
        return validateOpenTarget(target, current, deps.now?.() ?? Date.now())
      }).catch(() => denied('focus_authority_unavailable'))
    }
  })
}

export function registerTaskContextIpc(): void {
  const host = platform()
  const service = createTaskContextService({ source: configuredTaskContextSource(),
    authorizedOperator: (sender) => host.clientIds().includes(sender) })
  host.handleWithSender(IPC.taskContextRead, (sender, query) => service(sender).read(query))
  host.handleWithSender(IPC.taskContextFocus, (sender, target) => service(sender).focus(target))
}
