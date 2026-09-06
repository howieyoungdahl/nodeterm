import { create } from 'zustand'
import {
  applyRendererMemoryPolicyMigration,
  DEFAULT_SETTINGS,
  type Settings
} from '@shared/types'

interface SettingsState {
  settings: Settings
  /** True once settings have been loaded from disk (so first-run logic can wait). */
  hydrated: boolean
  hydrate(): Promise<void>
  update(patch: Partial<Settings>): void
}

// Coalesce disk writes: the settings inputs fire update() per keystroke/step-click, and each
// save is a full temp-file write + rename in main. The in-memory store stays synchronous (UI
// and xterm/Monaco react immediately); only the persistence trails, at most one write per
// window, always with the latest snapshot.
const SAVE_COALESCE_MS = 300
let saveTimer: ReturnType<typeof setTimeout> | null = null
let pendingSave: Settings | null = null
function scheduleSave(next: Settings): void {
  // Same guard as the beforeunload flush below: this module is transitively imported by
  // node-environment unit tests, where `window` doesn't exist and the timer would throw.
  if (typeof window === 'undefined') return
  pendingSave = next
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    if (pendingSave) void window.nodeTerminal.settings.save(pendingSave)
    pendingSave = null
  }, SAVE_COALESCE_MS)
}
// Reload/quit inside the coalesce window must not lose the last edit. (Guarded: this module
// is transitively imported by node-environment unit tests, where `window` doesn't exist.)
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    if (pendingSave) void window.nodeTerminal.settings.save(pendingSave)
    pendingSave = null
  })
}

export const useSettings = create<SettingsState>((set, get) => ({
  settings: DEFAULT_SETTINGS,
  hydrated: false,

  async hydrate() {
    const s = await window.nodeTerminal.settings.load()
    const merged = { ...DEFAULT_SETTINGS, ...s }
    const migrated = applyRendererMemoryPolicyMigration(s, merged)
    set({ settings: merged, hydrated: true })
    // Static Server Edition assets can update without replacing the running server process. Save
    // from the renderer too so a tab reload gets the one-minute release policy immediately and
    // stamps it for the still-old SettingsStore; the new SettingsStore runs the same shared helper.
    if (migrated) void window.nodeTerminal.settings.save(merged)
  },

  update(patch) {
    const next = { ...get().settings, ...patch }
    set({ settings: next })
    scheduleSave(next)
  }
}))
