import { IPC } from './ipc'

/**
 * HOST-ONLY channels: the RPC methods a relay GUEST may never reach, in ONE list both shells read.
 *
 * A relay peer (a paired phone, another desktop over 4c) is a first-class client of this machine's
 * core — that is the point of the peer registry — but it is NOT the host's user. A small set of
 * methods are the host's own control plane, and admitting one of them from a guest hands over
 * something the guest could not otherwise have:
 *
 *  - `githubControl:*` — the token/approval plane for the host's GitHub credentials.
 *  - `project-setup:run` — starts a script ON the host, in the host's shell, as the host's user.
 *  - `project-setup:consent-submit` — the ANSWER to the host's own trust prompt. Admitting `run`
 *    and this one together is the whole attack: a guest raises the prompt and then approves it
 *    itself, so a shared `.nodeterm/project.json` script executes with no human ever looking at a
 *    dialog. Either one alone is much weaker; the pair is a complete self-approval loop.
 *  - `project-setup:cancel` — the other side of the same run's control: a guest must not be able to
 *    kill the host's setup mid-write.
 *  - `project-setup:request-trust` — RAISES the host's own consent dialog for a project's launch
 *    settings. Alone it is prompt spam on someone else's screen; paired with an admitted
 *    consent-submit it is the same self-approval loop as run+consent-submit, ending in a shared
 *    `launchCmd`/`env` (or shell) approved for the host's own agent launches.
 *
 * DELIBERATELY NOT LISTED: `project-setup:subscribe`/`unsubscribe` and the `project-setup:event:*`
 * push. They neither start nor authorize anything, and a peer that can see the canvas can already
 * see that a setup is running. The gate is on ACTION, not on the namespace — which is also why
 * this is an explicit list rather than a `project-setup:` prefix.
 *
 * This lives in `shared/` because it is a policy question, not a shell mechanism: two shells each
 * carrying their own `startsWith` is exactly how one of them ends up a release behind the other.
 */
export const HOST_ONLY_CHANNEL_PREFIXES: readonly string[] = ['githubControl:']

export const HOST_ONLY_CHANNELS: ReadonlySet<string> = new Set([
  // Task context has operator read scope. A relay guest has no authenticated task assignment.
  IPC.taskContextRead,
  IPC.taskContextFocus,
  IPC.projectSetupRun,
  IPC.projectSetupCancel,
  IPC.projectSetupConsentSubmit,
  IPC.projectSetupRequestTrust
])

/** What a refused peer is told. One wording, so the two shells answer identically. */
export const HOST_ONLY_REFUSAL = 'host-control method is not available to relay peers'

export function isHostOnlyChannel(channel: string): boolean {
  if (HOST_ONLY_CHANNELS.has(channel)) return true
  return HOST_ONLY_CHANNEL_PREFIXES.some((prefix) => channel.startsWith(prefix))
}
