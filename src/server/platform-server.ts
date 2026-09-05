import type { CorePlatform } from '../core/platform'
import type { FlowOwner } from '../core/pty-manager'
import { UiSinkRegistry, type UiSink } from '../core/ui-sink-registry'
import { E_NO_HANDLER, type RpcErr, type RpcOk, type RpcRequest } from '../shared/rpc'

// The sink interface + all of the per-(client, session) WS backpressure (pause/resume watermarks,
// the WS_DROP_WATER ceiling, the drain sweep and the tmux resync) used to live in this file. It now
// lives ONCE in core/ui-sink-registry.ts, because the desktop shell needs the same machinery for its
// relay peers (docs/remote-sessions.md 4b). Re-exported so the server's callers are unchanged.
export type { UiSink }

type Handler = { fn: (...args: any[]) => unknown; withSender: boolean }
type Listener = { fn: (...args: any[]) => void; withSender: boolean }

/** The Linux-server CorePlatform: RPC registries + a WS-connection (UiSink) registry.
 *  One instance per server process; each authenticated WebSocket attaches as one UI. */
export class ServerPlatform implements CorePlatform {
  readonly userDataDir: string
  readonly appVersion: string
  readonly isPackaged = true

  private handlers = new Map<string, Handler>()
  // One registry for both on() and onWithSender(), so cast fires listeners in REGISTRATION
  // order across the two — same as Electron's ipcMain.on. A Set preserves insertion order.
  private listeners = new Map<string, Set<Listener>>()

  /** Every attached WebSocket, plus its backpressure state. The registry does not mint ids (the
   *  desktop shell registers under webContents ids), so this shell owns the counter. */
  private registry = new UiSinkRegistry()
  private nextUiId = 1

  /** uiId → the project that connection last said it was viewing. ABSENT means "undeclared", which
   *  is the default-open case — see `setClientScope`. Never holds an entry for a detached id. */
  private scopes = new Map<number, string>()

  constructor(opts: { userDataDir: string; appVersion: string }) {
    this.userDataDir = opts.userDataDir
    this.appVersion = opts.appVersion
  }

  handle(channel: string, fn: (...args: any[]) => unknown): void {
    this.handlers.set(channel, { fn, withSender: false })
  }

  handleWithSender(channel: string, fn: (senderId: number, ...args: any[]) => unknown): void {
    this.handlers.set(channel, { fn, withSender: true })
  }

  on(channel: string, fn: (...args: any[]) => void): void {
    this.addListener(channel, { fn, withSender: false })
  }

  onWithSender(channel: string, fn: (senderId: number, ...args: any[]) => void): void {
    this.addListener(channel, { fn, withSender: true })
  }

  private addListener(channel: string, listener: Listener): void {
    let set = this.listeners.get(channel)
    if (!set) {
      set = new Set()
      this.listeners.set(channel, set)
    }
    set.add(listener)
  }

  setFlowController(
    fn: (uiId: number, sessionId: string, resume: boolean, owner: FlowOwner) => void
  ): void {
    this.registry.setFlowController(fn)
  }

  /** How a desynced client is brought back: the session's CURRENT screen, captured from tmux
   *  (PtyManager.captureForResync). See UiSinkRegistry for the full contract. */
  setResyncProvider(fn: (sessionId: string) => Promise<string>): void {
    this.registry.setResyncProvider(fn)
  }

  /** What to run for a connection whose sink has proven DEAD (it threw on consecutive sends): the
   *  same teardown its 'close' runs — presence leave + PtyManager.dropClient + detach. Wired in
   *  ws.ts, which owns that teardown. */
  setSinkGoneHandler(fn: (uiId: number) => void): void {
    this.registry.setSinkGoneHandler(fn)
  }

  sendTo(uiId: number, channel: string, ...args: any[]): void {
    this.registry.sendTo(uiId, channel, ...args)
  }

  broadcast(channel: string, ...args: any[]): void {
    if (this.registry.size === 0) return // no connection: no ids() array, no loop
    for (const uiId of this.registry.ids()) this.registry.sendTo(uiId, channel, ...args)
  }

  /**
   * Declare which project a connection is LOOKING AT, so per-node pushes can skip the clients that
   * have no canvas to draw them on. `null` (or an empty id) clears the declaration.
   *
   * ────────────────────────────────────────────────────────────────────────────────────────────
   *  FILTERING IS NOT AN ACCESS-CONTROL BOUNDARY.
   *
   *  A scope narrows what this server VOLUNTEERS to a connection. It is a display filter and
   *  nothing else. Every client here has already passed the single-user auth in `auth.ts`, and a
   *  client that can connect can still REQUEST any project — `workspace.load()` returns the whole
   *  index, `pty:subscribe` attaches to any session id, and none of that consults this map. What
   *  actually gates control is creator ownership (`HeadlessNodeOwnership`), which fails closed;
   *  what gates the transport is the cookie. Do not add a rule here and describe it as a
   *  permission — a reviewer who believes this is a boundary will stop looking for the real one.
   *  See docs/remote-session-scoping.md.
   * ────────────────────────────────────────────────────────────────────────────────────────────
   *
   * DEFAULT-OPEN, deliberately. An undeclared connection is in NO map entry and therefore receives
   * everything, exactly as it did before scoping existed. This is a live multi-client system: a
   * client starved of `agent:status` shows dead badges with no error anywhere and nothing to
   * diagnose, so every failure mode on this path — a client that never declares, a declaration lost
   * to a rate limiter, a reconnect under a fresh uiId, a scope naming a project that has since gone
   * — degrades to MORE traffic, never to silence.
   */
  setClientScope(uiId: number, projectId: string | null | undefined): void {
    if (typeof projectId === 'string' && projectId) this.scopes.set(uiId, projectId)
    else this.scopes.delete(uiId)
  }

  /** The declared scope of a connection, or undefined when it has not declared one. */
  clientScope(uiId: number): string | undefined {
    return this.scopes.get(uiId)
  }

  /**
   * Broadcast an event that BELONGS to one project, skipping connections that have declared they
   * are looking at a different one. See `setClientScope` for why this is presentation, not policy.
   *
   * `projectId` is what we KNOW about the event, and unknown means deliver. The resolvers feeding
   * this (pane ownership; see agent-status.ts) are fail-closed by design — they answer `undefined`
   * for a pane this run did not freshly spawn — so "I could not attribute this event" must mean
   * "send it to everyone", or a restart would silently blank every scoped client's badges.
   */
  broadcastScoped(channel: string, projectId: string | undefined, ...args: any[]): void {
    if (this.registry.size === 0) return
    if (!projectId) return this.broadcast(channel, ...args)
    for (const uiId of this.registry.ids()) {
      const scope = this.scopes.get(uiId)
      // No declaration ⇒ everything. A declaration that matches ⇒ this event. A declaration for
      // some other project ⇒ skipped, and only here.
      if (scope === undefined || scope === projectId) this.registry.sendTo(uiId, channel, ...args)
    }
  }

  /** Every attached connection, in attach order (detach removes). */
  clientIds(): number[] {
    return this.registry.ids()
  }

  openExternal(_url: string): Promise<void> {
    return Promise.reject(new Error('openExternal is not available on a headless server'))
  }

  attach(sink: UiSink): number {
    const id = this.nextUiId++
    this.registry.register(id, sink)
    return id
  }

  detach(uiId: number): void {
    this.registry.unregister(uiId)
    // uiIds come from a monotonic counter, so a stale entry could never be re-matched — but a map
    // that only ever grows is a leak on a long-lived service, and a reconnect must start undeclared
    // (= everything) rather than inherit whatever the previous connection was looking at.
    this.scopes.delete(uiId)
  }

  async dispatch(uiId: number, req: RpcRequest): Promise<RpcOk | RpcErr> {
    const h = this.handlers.get(req.method)
    if (!h) {
      return {
        t: 'res', id: req.id, ok: false,
        error: { code: E_NO_HANDLER, message: `no handler for ${req.method}` }
      }
    }
    try {
      const result = h.withSender ? await h.fn(uiId, ...req.args) : await h.fn(...req.args)
      return { t: 'res', id: req.id, ok: true, result: result ?? null }
    } catch (err) {
      return {
        t: 'res', id: req.id, ok: false,
        error: { code: 'E_HANDLER', message: err instanceof Error ? err.message : String(err) }
      }
    }
  }

  cast(uiId: number, method: string, args: unknown[]): void {
    const set = this.listeners.get(method)
    if (!set) return
    for (const l of set) {
      // A cast has no reply channel (unlike dispatch, which returns E_HANDLER), so isolate each
      // listener: one throw must not skip the rest — e.g. a broken pty:write attribution listener
      // would otherwise swallow the user's keystrokes. Log it, keep going.
      try {
        if (l.withSender) l.fn(uiId, ...args)
        else l.fn(...args)
      } catch (err) {
        console.warn(
          `[nodeterm-server] cast listener for ${method} threw`,
          err instanceof Error ? err.message : String(err)
        )
      }
    }
  }
}
