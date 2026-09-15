// Electron shell for the usage service. Everything real — credential resolution, the OAuth
// fetch, the per-account cache, the RPC handlers — lives in src/core/usage/usage-service.ts so
// the Server Edition boots the same code. All that is left here is the one thing core cannot
// know: whether a desktop window is focused.
import type { BrowserWindow } from 'electron'
import type { ExternalUsageProfile } from '../shared/external-profile'
import {
  startUsageService,
  type RemoteUsageDeps,
  type UsageService
} from '../core/usage/usage-service'

export { resolveClaudeAccessToken } from '../core/usage/usage-service'

/** Extra usage-service wiring the shell owns: the local managed accounts to poll for the mobile
 *  `usage` mirror block, the mirror-flush callback fired on every cache update, and the SSH
 *  ControlMaster access remote-host usage is read over (desktop-only — the Server Edition has no
 *  SSH projects, so it passes none and `usage:remote` answers empty). */
export interface InitClaudeUsageOpts {
  localAccounts?: () => string[]
  /** Local managed Codex accounts (id + isolated home) to aggregate usage for, one row each and
   *  never merged. See UsageServiceOptions.codexAccounts. */
  codexAccounts?: () => Array<{ id: string; home: string; label: string; email?: string | null }>
  /** Existing Claude profile dirs to read usage from without adopting them. See
   *  UsageServiceOptions.externalUsageProfiles. */
  externalUsageProfiles?: () => readonly ExternalUsageProfile[]
  onCacheUpdate?: () => void
  remote?: RemoteUsageDeps
  /** "A phone may be reading the agent-status mirror" (paired / has a push grant). When true the
   *  background poll runs even while the window is unfocused, so the phone's `usage` block stays
   *  fresh instead of freezing into fossil bars. See UsageServiceOptions.mirrorMayBeRead. */
  mirrorMayBeRead?: () => boolean
}

/** Start the usage service on the focused-window poll gate and return it, so the caller can wire
 *  the agent-status mirror's `usage` provider off its `snapshot()`. */
export function initClaudeUsage(win: BrowserWindow, opts: InitClaudeUsageOpts = {}): UsageService {
  // Poll while the window is focused (for the pill) OR while a phone may be reading the mirror (for
  // the phone's `usage` block) — a focus-only gate froze the phone's bars into fossils whenever the
  // Mac was backgrounded, the same starvation the Server Edition avoids by polling ungated. The
  // usage endpoint has a tight budget, so a pure-desktop user with no phone still only polls on focus.
  const service = startUsageService({
    shouldPoll: () => win.isFocused(),
    mirrorMayBeRead: opts.mirrorMayBeRead,
    localAccounts: opts.localAccounts,
    codexAccounts: opts.codexAccounts,
    externalUsageProfiles: opts.externalUsageProfiles,
    onCacheUpdate: opts.onCacheUpdate,
    remote: opts.remote
  })

  const onFocus = (): void => service.refreshIfStale()
  win.on('focus', onFocus)
  win.on('closed', () => {
    // Both matter: the timer keeps firing otherwise, and the listener kept a dead window
    // referenced (the pre-core version cleared the interval but never removed this handler).
    win.off('focus', onFocus)
    service.dispose()
  })
  return service
}
