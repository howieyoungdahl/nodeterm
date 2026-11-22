import { create } from 'zustand'
import { readLocal, writeLocal } from '../lib/localStore'

// Whether the kanban card modal opens with its comments & activity panel expanded — PERSONAL,
// per machine: persisted in localStorage, deliberately never in the git-shared
// .nodeterm/project.json (same rule as the view mode).
//
// An untouched preference leaves the default to the card kind.

export const CARD_PANEL_KEY = 'nodeterm.cardCommentsOpen'

export function parseCardPanelOpen(raw: string | null): boolean | null {
  if (raw === 'true') return true
  if (raw === 'false') return false
  return null
}

function save(open: boolean): void {
  try {
    writeLocal(CARD_PANEL_KEY, open ? 'true' : 'false')
  } catch {
    /* quota/private-mode: the panel state is a nicety, never fail the UI */
  }
}

interface CardPanelState {
  open: boolean | null
  setOpen(open: boolean): void
}

export const useCardPanel = create<CardPanelState>((set) => ({
  open: parseCardPanelOpen(readLocal(CARD_PANEL_KEY)),
  setOpen: (open) => {
    save(open)
    set({ open })
  }
}))
