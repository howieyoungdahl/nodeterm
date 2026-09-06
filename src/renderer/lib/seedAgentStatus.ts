import { E_UNSUPPORTED } from '@shared/rpc'
import type { AgentStatusSnapshot } from '@shared/types'
import type { AgentStatusStore } from '../state/agentStatus'

/**
 * Pull the shell's last-known agent status and paint the badges with it, once, at bootstrap.
 *
 * The renderer deliberately does not persist the live `state` (a stamp off disk would be stale on
 * relaunch — see state/agentStatus.ts), but the HOST's mirror does keep it across a Server/app
 * restart. After a Server restart the browser does a full `location.reload()`: terminals reattach
 * on mount, yet every badge read idle until that pane's next hook event — and a session sitting on
 * `waiting`/`blocked` has no next event, because it is waiting on the very user looking at the
 * blank canvas. This closes exactly that gap, and only that: the store applies its own freshness
 * cut and never overwrites a state this run already heard about.
 *
 * NEVER THROWS, and a missing snapshot is a normal outcome, not an error: an older host has no
 * handler at all, the Server Edition browser bridge rejects `E_UNSUPPORTED`, and a socket that
 * dropped between reload and this call rejects too. All three degrade to "no seed" — which is
 * precisely the behavior before this existed.
 */
export interface AgentStatusSnapshotApi {
  /** Optional on purpose: a relay/stub api may not carry the member at all, and `in`-style
   *  narrowing at the call site is what keeps this a fact about the surface rather than a crash. */
  agentStatusSnapshot?: () => Promise<AgentStatusSnapshot>
}

/** The narrowest shape of the store this needs — so a test can pass a hand-built fake rather than
 *  standing up a zustand store (a real `UseBoundStore<StoreApi<AgentStatusStore>>` satisfies it). */
export interface SeedableAgentStatusStore {
  getState(): Pick<AgentStatusStore, 'seedFromSnapshot'>
}

/** Returns whether a snapshot was actually applied — for tests and for a caller that wants to
 *  know, never as a gate: nothing in the UI may depend on the seed having happened. */
export async function seedAgentStatusFromHost(
  api: AgentStatusSnapshotApi | null | undefined,
  store: SeedableAgentStatusStore,
  now?: number
): Promise<boolean> {
  if (typeof api?.agentStatusSnapshot !== 'function') return false
  let snapshot: AgentStatusSnapshot
  try {
    snapshot = await api.agentStatusSnapshot()
  } catch (err) {
    // E_UNSUPPORTED is a fact about the SURFACE (an older host / a stubbed namespace), so it is
    // silent; anything else is worth one line in the debug ring, because a seed that quietly never
    // runs looks exactly like the bug it fixes.
    if ((err as { code?: string } | null)?.code !== E_UNSUPPORTED)
      console.warn('[agent-status] snapshot seed failed', err)
    return false
  }
  if (!snapshot?.nodes) return false
  store.getState().seedFromSnapshot(snapshot, now)
  return true
}
