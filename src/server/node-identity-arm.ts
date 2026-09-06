// The Server Edition's boot-time node-identity arming, extracted from `startServer` so it is REAL
// production code a test can drive directly (constraint 8: the pin must exercise the shipped path,
// not a re-implementation of it). Headless Linux has no OS keychain, so the secret is raw 0600 bytes
// (node-auth-key.bin); the loader handles the at-rest format. Fail-open/loud is the CALLER's job —
// this throws if the secret can't be loaded, and `startServer` catches it into legacy mode.
import { loadOrCreateNodeAuthSecret } from '../core/agents/node-auth-secret'
import { setCodexThreadIdentityAuthSecret } from '../core/codex-identity-proxy'
import { initNodeTokens } from '../core/agents/node-token-service'

type Canvases = Parameters<typeof initNodeTokens>[0]['canvases']
type RetainMissing = NonNullable<Parameters<typeof initNodeTokens>[0]['retainMissing']>

/**
 * Arm node identity for the Server Edition: load/create the raw node-auth secret, hand it to the
 * hook server, arm the Codex thread→node→account record secret with the SAME secret (S6 Decision 1,
 * the both-shells half — desktop arms its twin in src/main/index.ts), and materialise a token file
 * for every persisted node. `startServer` awaits this inside its fail-open try; the codex boot test
 * drives this exact function so deleting the codex arming below REDS the pin.
 */
export async function armServerNodeIdentity(
  hookServer: { setNodeAuthSecret(secret: Uint8Array): void },
  canvases: Canvases,
  retainMissing?: RetainMissing
): Promise<void> {
  const nodeAuthSecret = await loadOrCreateNodeAuthSecret()
  hookServer.setNodeAuthSecret(nodeAuthSecret)
  // Managed Codex accounts on a headless host can then sign/verify their ownership records instead
  // of throwing "identity authentication is unavailable". The server's shared-app-server wiring
  // and headless launch factory consume this same identity spine after boot.
  setCodexThreadIdentityAuthSecret(nodeAuthSecret)
  // Already-running sessions become verified at their next hook event with no restart. No-ops into
  // legacy mode without a secret.
  initNodeTokens({ canvases, retainMissing })
}
