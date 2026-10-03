import type { CorePlatform } from './platform'
import { BoardLogStore, type RemoteLogExec } from './board-log'
import { IPC } from '../shared/ipc'
import type { BoardLogEntry, BoardLogReadOpts, BoardLogReadResult } from '../shared/types'

// Board-log RPC surface, registered ONCE for every shell (Electron main + Server Edition) through
// CorePlatform — the same seam fs-handlers.ts uses, so the two can never drift. The pure log I/O is
// already in core/board-log.ts; this only wires request/response + the per-project change push, and
// delegates the "where does this project's log live?" question to an injected BoardLogRouter (the one
// piece that differs per shell: desktop resolves SSH connections, the server never does).

/** Where a project's board log lives, resolved per call by the shell.
 *  - `local`  → node:fs under `cwd/.nodeterm/board-log.jsonl`.
 *  - `remote` → desktop SSH: `exec` does the append/tail over the ControlMaster; `fingerprint`
 *               returns a cheap size/hash (`wc -c`) the change-poll compares every 5s.
 *  - `unsupported` → inline/no-cwd canvas, a disconnected SSH project, or an SSH project on the
 *               Server Edition (v1). Reads answer `{ entries: [], unsupported: true }`; appends `false`. */
export type BoardLogRoute =
  | { kind: 'local'; cwd: string }
  | { kind: 'remote'; remoteCwd: string; exec: RemoteLogExec; fingerprint: () => Promise<string> }
  | { kind: 'unsupported' }

export interface BoardLogRouter {
  route(projectId: string): BoardLogRoute
}

const POLL_MS = 5000

/** Registers boardLogAppend / boardLogRead / boardLogSubscribe / boardLogUnsubscribe and drives the
 *  per-project `boardLogChanged` push. Ref-counted per project: the first subscriber starts a watch
 *  (local fs.watch) or a poll (desktop SSH), the last one stops it. */
/**
 * Append one entry through a router — the same routing the `boardLogAppend` IPC handler performs,
 * exported so an in-process writer (the agent-messaging delivery trace) appends through the
 * identical local/remote/unsupported decision instead of restating it. `false` covers both "no
 * reachable log" (a cwd-less inline project, a disconnected SSH project) and a failed write —
 * exactly the answer `recordDelivery` treats as "ring only".
 */
export function appendBoardLogVia(
  router: BoardLogRouter,
  projectId: string,
  entry: BoardLogEntry,
  localStore = new BoardLogStore({})
): Promise<boolean> {
  const r = router.route(projectId)
  if (r.kind === 'local') return localStore.append(r.cwd, entry)
  if (r.kind === 'remote') return new BoardLogStore({ remote: r.exec }).append(r.remoteCwd, entry)
  return Promise.resolve(false)
}

/** What `registerBoardLogHandlers` hands back: an in-process `append` that a MAIN-side caller (the
 *  `browser --cookies` trace, PR 9 Task 9.2) uses to write a board-log line WITHOUT an IPC round-trip
 *  through the renderer — the same local/remote/unsupported routing the `boardLogAppend` handler
 *  performs, sharing the one `localStore`. */
export interface BoardLogHandlers {
  append(projectId: string, entry: BoardLogEntry): Promise<boolean>
  appendOnce?(projectId: string, entry: BoardLogEntry): Promise<boolean>
}

export function registerBoardLogHandlers(platform: CorePlatform, router: BoardLogRouter): BoardLogHandlers {
  const localStore = new BoardLogStore({})

  platform.handle(IPC.boardLogAppend, async (projectId: string, entry: BoardLogEntry): Promise<boolean> => {
    return appendBoardLogVia(router, projectId, entry, localStore)
  })

  platform.handle(
    IPC.boardLogRead,
    async (projectId: string, opts?: BoardLogReadOpts): Promise<BoardLogReadResult> => {
      const r = router.route(projectId)
      if (r.kind === 'local') return { entries: await localStore.read(r.cwd, opts) }
      if (r.kind === 'remote')
        return { entries: await new BoardLogStore({ remote: r.exec }).read(r.remoteCwd, opts) }
      return { entries: [], unsupported: true }
    }
  )

  // Change subscription, ref-counted per project id (the renderer subscribes/unsubscribes as its
  // board panel mounts/unmounts; a leaked subscription is at worst one idle fs.watch/poll).
  interface Sub {
    count: number
    stop: () => void
  }
  const subs = new Map<string, Sub>()

  const startWatch = (projectId: string): (() => void) => {
    const emit = (): void => platform.broadcast(IPC.boardLogChanged(projectId), projectId)
    const r = router.route(projectId)
    if (r.kind === 'local') return localStore.watch(r.cwd, emit)
    if (r.kind === 'remote') {
      let last: string | undefined
      let alive = true
      const tick = async (): Promise<void> => {
        if (!alive) return
        try {
          const fp = await r.fingerprint()
          if (last !== undefined && fp !== last) emit()
          last = fp
        } catch {
          /* transient ssh failure: keep the last fingerprint, retry next tick */
        }
      }
      void tick()
      const timer = setInterval(() => void tick(), POLL_MS)
      return () => {
        alive = false
        clearInterval(timer)
      }
    }
    return () => {}
  }

  platform.on(IPC.boardLogSubscribe, (projectId: string) => {
    const existing = subs.get(projectId)
    if (existing) {
      existing.count++
      return
    }
    subs.set(projectId, { count: 1, stop: startWatch(projectId) })
  })

  platform.on(IPC.boardLogUnsubscribe, (projectId: string) => {
    const existing = subs.get(projectId)
    if (!existing) return
    existing.count--
    if (existing.count <= 0) {
      existing.stop()
      subs.delete(projectId)
    }
  })

  // The in-process append: shares this registration's router + localStore, so a main-side writer and
  // the IPC handler can never route a project's log differently.
  return {
    appendOnce: (projectId, entry) => {
      const route = router.route(projectId)
      return route.kind === 'local' ? localStore.appendOnce(route.cwd, entry) : Promise.resolve(false)
    },
    append: (projectId: string, entry: BoardLogEntry): Promise<boolean> =>
      appendBoardLogVia(router, projectId, entry, localStore)
  }
}
