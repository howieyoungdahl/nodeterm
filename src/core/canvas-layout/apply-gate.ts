// Moved to @shared/canvas-layout: the renderer is the caller that matters here (it is the side
// that applies a plan), and it cannot import `src/core`. Re-exported so the engine keeps one
// import surface.
export { gateLayoutPlan, type ApplyGateDeps } from '../../shared/canvas-layout'
