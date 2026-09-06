import { useEffect, useState } from 'react'
import { appearanceStyleVars } from '@shared/appearance'
import { useSettings } from '../state/settings'
import { useProjects } from '../state/projects'
import {
  buildAppearanceEnv,
  setAppearanceEnv,
  useSystemReducedMotion,
  windowEdgeAppearance
} from '../state/appearance'

/**
 * The window/app edge, plus the publisher that keeps every node's appearance environment current.
 *
 * Mounted once at the app root, so BOTH shells get it: this is ordinary renderer code over the
 * existing `settings.load/save` and `workspace.save` channels, with no new bridge member to stub —
 * Desktop and Server Edition are identical here by construction.
 */

/** Track whether the window itself has focus, for the edge's `focusHighlight`.
 *
 *  Subscribed only when the edge actually asks for it: with the highlight off there is no listener
 *  and no state, which is the pre-feature behaviour for everyone who never opens the setting.
 *  `document.hasFocus()` is the initial read rather than an assumed `true` — a window restored
 *  behind another one would otherwise start lit and only correct itself on the next blur. */
function useWindowFocused(enabled: boolean): boolean {
  const [focused, setFocused] = useState(true)
  useEffect(() => {
    if (!enabled) return
    const sync = (): void => setFocused(document.hasFocus())
    sync()
    window.addEventListener('focus', sync)
    window.addEventListener('blur', sync)
    return () => {
      window.removeEventListener('focus', sync)
      window.removeEventListener('blur', sync)
    }
  }, [enabled])
  return enabled ? focused : true
}

/**
 * Publishes the resolver's environment and paints the window edge.
 *
 * The edge is a `pointer-events: none` overlay rather than a border on a real element: the app's
 * layout is a full-viewport flex column whose children already own their own borders, and giving
 * one of them a variable-width frame would reflow the canvas (and every terminal's cols/rows with
 * it) each time the thickness changed. An overlay costs one composited layer and moves nothing.
 */
export function AppearanceLayer(): React.JSX.Element | null {
  const settings = useSettings((s) => s.settings)
  const activeProject = useProjects((s) => s.projects.find((p) => p.id === s.activeProjectId))
  const systemReducedMotion = useSystemReducedMotion()

  // One environment for the whole canvas. `setAppearanceEnv` compares structurally, so the frequent
  // callers here (a settings keystroke, a canvas commit that replaces the project object) publish
  // nothing unless a preference or a rule actually changed.
  useEffect(() => {
    setAppearanceEnv(buildAppearanceEnv(settings, activeProject, systemReducedMotion))
  }, [settings, activeProject, systemReducedMotion])

  const edge = windowEdgeAppearance(settings, systemReducedMotion)

  // Machine-local reduce-motion as a document attribute, beside — never instead of — the
  // `prefers-reduced-motion` media queries the stylesheet already carries. Written on <html> so one
  // blanket rule can reach every animation in the app, including the ones inside portals.
  useEffect(() => {
    const root = document.documentElement
    if (edge.reducedMotion) root.dataset.reducedMotion = '1'
    else delete root.dataset.reducedMotion
  }, [edge.reducedMotion])

  const focused = useWindowFocused(edge.focusHighlight)
  // Nothing configured ⇒ nothing rendered. An empty overlay would be a harmless but real extra
  // element in every window, and "absent means the app you already had" is the contract.
  if (edge.color === null && edge.thickness === null) return null
  return (
    <div
      className={`window-edge${edge.glow ? ' window-edge--glow' : ''}${
        edge.focusHighlight && !focused ? ' window-edge--blurred' : ''
      }`}
      style={appearanceStyleVars(edge)}
      aria-hidden="true"
    />
  )
}
