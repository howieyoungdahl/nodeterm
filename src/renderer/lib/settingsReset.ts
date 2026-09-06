import { DEFAULT_SETTINGS, type Settings } from '@shared/types'

/**
 * Restoring a SECTION of settings to their shipped defaults.
 *
 * Deliberately per-section rather than one global "reset everything". `DEFAULT_SETTINGS` is the
 * state of a fresh install, which means a global reset would also empty `claudeAccounts` (logged-in
 * identities), `customAgents` and `disabledAgents`, and re-arm the first-run tour — destroying real
 * work to undo a font choice. A reset the user reaches for after fiddling with appearance should
 * put back exactly what they were fiddling with.
 */

/** The appearance settings the Terminal section owns. */
export const TERMINAL_RESET_KEYS = [
  'fontFamily',
  'fontSize',
  'terminalWordSeparator',
  'fontWeight',
  'fontWeightBold',
  'drawBoldTextInBrightColors',
  'terminalMinContrast',
  'terminalTheme',
  'cursorStyle',
  'cursorInactiveStyle',
  'cursorBlink',
  'terminalLineHeight',
  'terminalLetterSpacing',
  'terminalGpuRendering'
] as const satisfies readonly (keyof Settings)[]
// NOTE: `tmuxScrollback` is deliberately absent even though the terminal renders with it — it
// belongs to the tmux section, and resetting a history limit from an appearance button would be a
// surprise. Anything shared between sections stays with the section that PRESENTS it.

/** The appearance settings the Appearance section owns. */
export const APPEARANCE_RESET_KEYS = [
  'appTheme',
  'uiScale',
  'accent',
  'hiddenNodeMenuItems',
  'hiddenHeaderButtons',
  'showResumeCard',
  'windowTitleActiveSession',
  // The whole visual-preference block: window edge, the global node/group border defaults, and the
  // two accessibility switches. Resetting to the default means REMOVING the key (it is absent from
  // DEFAULT_SETTINGS on purpose — absent is "built-in defaults"), which `resetPatch` does by
  // reading `undefined` out of DEFAULT_SETTINGS.
  'appearance'
] as const satisfies readonly (keyof Settings)[]

/** The defaults for `keys`, as a patch for `useSettings.update`. */
export function resetPatch<K extends keyof Settings>(keys: readonly K[]): Pick<Settings, K> {
  const out = {} as Pick<Settings, K>
  for (const k of keys) out[k] = DEFAULT_SETTINGS[k]
  return out
}

/**
 * Is every one of `keys` already at its default?
 *
 * Drives the button's disabled state, which is doing two jobs: it keeps a destructive-ish control
 * from being clicked for nothing, and it ANSWERS the question the user opened the section with —
 * "have I changed anything here?" — which is otherwise unanswerable without remembering the
 * defaults. Structural compare, so list-valued keys (the hidden-row arrays) work too.
 */
export function isPristine<K extends keyof Settings>(
  keys: readonly K[],
  current: Pick<Settings, K>
): boolean {
  return keys.every((k) => JSON.stringify(current[k]) === JSON.stringify(DEFAULT_SETTINGS[k]))
}
