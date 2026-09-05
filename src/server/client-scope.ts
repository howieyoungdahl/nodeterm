import { IPC } from '../shared/ipc'
import type { ServerPlatform } from './platform-server'

/**
 * How a browser connection tells this server which canvas it is looking at, so the per-node pushes
 * in `agent-status.ts` can skip the connections that have no canvas to draw them on.
 *
 * FILTERING IS NOT AN ACCESS-CONTROL BOUNDARY — see `ServerPlatform.setClientScope` for the full
 * statement. A declaration narrows what the server VOLUNTEERS. It grants nothing and withholds
 * nothing: the same connection can still `workspace.load()` the whole index and `pty:subscribe` to
 * any session id, and neither consults this.
 *
 * ── WHY `presence:project` AND NOT A NEW CHANNEL ────────────────────────────────────────────────
 * The renderer already casts `presence:project` from Canvas's active-project effect — on connect
 * and on every project switch (`renderer/state/presence.ts` `reportProject`) — and its dedup latch
 * is RESET when the connection is torn down, so a reconnect re-announces from scratch. That is
 * exactly the reconnect-safe declaration this needs, on both shells' existing wire, with no new IPC
 * channel, no preload member and no bridge stub to keep in step. A second channel carrying the same
 * fact would be a second thing to keep true.
 *
 * The presence hub listens on the same channel and rate-limits what it BROADCASTS to peers. This
 * listener is registered separately and therefore runs whether or not the hub's bucket admitted
 * that cast (`ServerPlatform.cast` fires every listener independently), so a client cannot lose its
 * scope to someone else's rate limiter — the one failure this path must not have, since a stale
 * scope is the only way a client here can end up receiving LESS than it should.
 *
 * ── DEGRADES TOWARDS MORE TRAFFIC, NEVER TOWARDS SILENCE ────────────────────────────────────────
 * A connection that never declares is not in the map and receives everything, exactly as before
 * scoping existed. `null` clears. A scope naming a project that has since been deleted still
 * matches that project's own events, so a client watching a canvas that vanished keeps its badges
 * rather than going quiet with nothing on screen to explain it.
 */
export function registerClientScope(platform: ServerPlatform): void {
  platform.onWithSender(IPC.presenceProject, (senderId: number, projectId: unknown) => {
    // Cast payloads arrive off the wire, so this is a re-validation at the use site and not a type
    // assertion: anything that is not a non-empty string clears the declaration (= everything),
    // which is the safe direction for a display filter.
    platform.setClientScope(senderId, typeof projectId === 'string' ? projectId : null)
  })
}
