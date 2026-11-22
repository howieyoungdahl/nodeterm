import { create } from 'zustand'
import { readLocal, writeLocal } from '../lib/localStore'

// Remembered size of the kanban card modal — PERSONAL, per machine (localStorage), never in the
// git-shared .nodeterm/project.json (same rule as the view mode and the comments panel). The modal
// stays centred; resize is symmetric about the centre, which is what lets every edge/corner handle
// track the cursor 1:1 with `Δsize = 2·Δcursor` and needs no left/top bookkeeping.
//
// Issue #389: the modal was a fixed min(1040,…)×min(680,…) box — too small on a large display and
// not resizable. We remember an explicit width/height (and a maximized flag) instead.

export const CARD_MODAL_SIZE_KEY = 'nodeterm.cardModalSize'

/** Smallest usable modal — below this the header actions and the two panes stop fitting. */
export const CARD_MODAL_MIN_W = 480
export const CARD_MODAL_MIN_H = 340
/** Breathing room kept to the viewport edge (total across both sides of each axis). */
export const CARD_MODAL_MARGIN_X = 48
export const CARD_MODAL_MARGIN_Y = 64
/** Default when nothing is remembered — bigger than the old cap, and it scales with the window. */
export const CARD_MODAL_PREF_W = 1400
export const CARD_MODAL_PREF_H = 940

export interface CardModalSize {
  width: number | null
  height: number | null
  maximized: boolean | null
}

/** value clamped into [min, max]; when the viewport is so small that max < min, max (fit the
 *  viewport) wins over min. */
export function clampAxis(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/** The largest freehand size, leaving room for its resize handles. */
export function maxModalSize(vw: number, vh: number): { width: number; height: number } {
  return {
    width: Math.max(1, vw - CARD_MODAL_MARGIN_X),
    height: Math.max(1, vh - CARD_MODAL_MARGIN_Y)
  }
}

/** The default (unremembered) size: the preferred size, but never larger than the viewport allows. */
export function defaultModalSize(vw: number, vh: number): { width: number; height: number } {
  const max = maxModalSize(vw, vh)
  return {
    width: Math.min(CARD_MODAL_PREF_W, max.width),
    height: Math.min(CARD_MODAL_PREF_H, max.height)
  }
}

/** The size to actually render, given what's remembered and the current viewport. Maximized fills
 *  the viewport; an explicit remembered size is clamped into range; otherwise the scaling default. */
export function resolveModalSize(
  saved: CardModalSize,
  vw: number,
  vh: number
): { width: number; height: number } {
  if (saved.maximized) return { width: vw, height: vh }
  const max = maxModalSize(vw, vh)
  if (saved.width != null && saved.height != null) {
    return {
      width: clampAxis(saved.width, CARD_MODAL_MIN_W, max.width),
      height: clampAxis(saved.height, CARD_MODAL_MIN_H, max.height)
    }
  }
  return defaultModalSize(vw, vh)
}

/** Parse the persisted blob; anything missing/unparseable means "no memory" (use the default). */
export function parseCardModalSize(raw: string | null): CardModalSize {
  if (!raw) return { width: null, height: null, maximized: null }
  try {
    const v = JSON.parse(raw) as Partial<CardModalSize>
    const width = typeof v.width === 'number' && v.width > 0 ? v.width : null
    const height = typeof v.height === 'number' && v.height > 0 ? v.height : null
    const maximized = typeof v.maximized === 'boolean' ? v.maximized : width && height ? false : null
    return { width, height, maximized }
  } catch {
    return { width: null, height: null, maximized: null }
  }
}

function save(size: CardModalSize): void {
  try {
    writeLocal(CARD_MODAL_SIZE_KEY, JSON.stringify(size))
  } catch {
    /* quota/private-mode: a remembered size is a nicety, never fail the UI */
  }
}

interface CardModalSizeState extends CardModalSize {
  /** Record a user-chosen size (a resize drag ended). Clears maximized — a manual resize exits it. */
  remember(width: number, height: number): void
  setMaximized(maximized: boolean): void
}

export const useCardModalSize = create<CardModalSizeState>((set, get) => ({
  ...parseCardModalSize(readLocal(CARD_MODAL_SIZE_KEY)),
  remember: (width, height) => {
    const next = { width, height, maximized: false }
    save(next)
    set(next)
  },
  setMaximized: (maximized) => {
    const next = { width: get().width, height: get().height, maximized }
    save(next)
    set({ maximized })
  }
}))
