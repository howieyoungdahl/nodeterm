import { createContext } from 'react'
import { create } from 'zustand'

/** Standard canvas selection and navigation for controls inside a node. */
export const CanvasNodeNavigation = createContext<((id: string) => void) | undefined>(undefined)

// Focus mode (issue #78): ONE terminal/agent node fills the window; the canvas chrome gets out
// of the way and reappears on hover. Session-only on purpose — no localStorage: restoring into
// focus mode after a relaunch would hide the whole canvas behind a node the user may not
// remember focusing, and unlike the canvas/kanban choice there is no affordance that explains
// the state on sight.

interface FocusNodeState {
  focusedId: string | null
  focus(id: string): void
  clear(): void
  toggle(id: string): void
}

export const useFocusNode = create<FocusNodeState>((set) => ({
  focusedId: null,
  focus: (id) => set({ focusedId: id }),
  clear: () => set({ focusedId: null }),
  toggle: (id) => set((s) => ({ focusedId: s.focusedId === id ? null : id }))
}))

/**
 * Imperative pair for render-time reads (the `nodeIsOpaque`/`subscribeOpaqueSet` shape from
 * SharedGlyphLayer, for the same reason): TerminalNode must read this DURING render so the
 * `glyphOff` term it computes agrees with the DOM it is about to commit — mirrored into state it
 * lags by a commit, and the shared-glyph teardown then runs one pass behind the reparent.
 */
export function focusedNodeId(): string | null {
  return useFocusNode.getState().focusedId
}

export function subscribeFocusedNode(cb: () => void): () => void {
  return useFocusNode.subscribe(cb)
}

/**
 * The element the focused node reparents into. Looked up live (never cached): the surface is a
 * stable always-mounted child of `.canvas-root`, but Canvas can remount across project switches.
 */
export const FOCUS_SURFACE_ID = 'focus-surface'

export function focusSurfaceEl(): HTMLElement | null {
  return document.getElementById(FOCUS_SURFACE_ID)
}
