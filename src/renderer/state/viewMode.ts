import { create } from 'zustand'
import { readLocal, writeLocal } from '../lib/localStore'

// Which view each project shows (canvas or kanban) — PERSONAL, per machine: persisted in
// localStorage, deliberately never in the git-shared .nodeterm/project.json (spec rule).
//
// A project with an EXPLICIT entry uses it; a project with NONE follows `defaultView` (the
// Settings → "Default view" choice, synced in from settings). So changing the default flips every
// project the user hasn't explicitly toggled, while their explicit choices stick.

export const PROJECT_VIEW_KEY = 'nodeterm.projectView'

export const PROJECT_KANBAN_SORT_KEY = 'nodeterm.projectKanbanSort'
export type KanbanSort = 'manual' | 'priority'
export function parseKanbanSortMap(raw: string | null): Record<string, KanbanSort> {
  try {
    const parsed: unknown = raw ? JSON.parse(raw) : {}
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(Object.entries(parsed).filter(([, value]) => value === 'manual' || value === 'priority'))
  } catch { return {} }
}

export type ProjectView = 'canvas' | 'kanban'

/** Parses the persisted map, keeping only valid canvas/kanban entries. Exported for tests. */
export function parseViewMap(raw: string | null): Record<string, ProjectView> {
  try {
    const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, ProjectView> = {}
    for (const [id, v] of Object.entries(parsed)) if (v === 'kanban' || v === 'canvas') out[id] = v
    return out
  } catch {
    return {}
  }
}

function save(v: Record<string, ProjectView>): void {
  try {
    writeLocal(PROJECT_VIEW_KEY, JSON.stringify(v))
  } catch {
    /* quota/private-mode: the view choice is a nicety, never fail the UI */
  }
}

interface ViewModeState {
  kanbanSortByProject: Record<string, KanbanSort>
  setKanbanSort(projectId: string, mode: KanbanSort): void
  viewByProject: Record<string, ProjectView>
  /** The fallback view for projects with no explicit entry (Settings → Default view). */
  defaultView: ProjectView
  setDefaultView(v: ProjectView): void
  toggle(projectId: string): void
  /**
   * A node whose CARD should be opened on the board, set by anything that "goes to" a node while
   * the board is up — the notch HUD's Go, a notification click, ⌘K, the sessions sidebar. Those
   * all funnel through `focusNodeById`, which frames the node on the CANVAS; with the board's
   * opaque overlay on top, that looked like the button did nothing at all (field report: "kanban
   * view'de notch'ın Go tuşu işe yaramıyor").
   *
   * KanbanView consumes it and clears it (one-shot, so re-requesting the same node works).
   */
  requestedCardNodeId: string | null
  requestCard(nodeId: string): void
  clearCardRequest(): void
}

/** The resolved view for a project: its explicit entry, or the default. */
export function viewFor(s: Pick<ViewModeState, 'viewByProject' | 'defaultView'>, projectId: string): ProjectView {
  return s.viewByProject[projectId] ?? s.defaultView
}

export const useViewMode = create<ViewModeState>((set) => ({
  kanbanSortByProject: parseKanbanSortMap(readLocal(PROJECT_KANBAN_SORT_KEY)),
  setKanbanSort: (projectId, mode) => set(s => {
    if (mode !== 'manual' && mode !== 'priority') return s
    const next = { ...s.kanbanSortByProject, [projectId]: mode }
    try { writeLocal(PROJECT_KANBAN_SORT_KEY, JSON.stringify(next)) } catch { /* Personal preference only. */ }
    return { kanbanSortByProject: next }
  }),
  viewByProject: parseViewMap(readLocal(PROJECT_VIEW_KEY)),
  defaultView: 'canvas',
  setDefaultView: (v) => set((s) => (s.defaultView === v ? s : { defaultView: v })),
  requestedCardNodeId: null,
  requestCard: (nodeId) => set({ requestedCardNodeId: nodeId }),
  clearCardRequest: () => set({ requestedCardNodeId: null }),
  toggle: (projectId) =>
    set((s) => {
      // Flip the RESOLVED view and store it EXPLICITLY, so this choice now overrides the default.
      const cur = s.viewByProject[projectId] ?? s.defaultView
      const next: Record<string, ProjectView> = {
        ...s.viewByProject,
        [projectId]: cur === 'kanban' ? 'canvas' : 'kanban'
      }
      save(next)
      // Leaving the board (or entering it) drops any unconsumed request — it belonged to the view
      // the user just left, and firing it later would pop a card out of nowhere.
      return { viewByProject: next, requestedCardNodeId: null }
    })
}))

/** True when the given project currently shows the kanban board (read outside React —
 *  keydown handlers use this so they need no store subscription/deps). */
export function isKanbanOpen(projectId: string): boolean {
  return !!projectId && viewFor(useViewMode.getState(), projectId) === 'kanban'
}
