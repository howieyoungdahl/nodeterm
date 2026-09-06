// Moved to @shared/canvas-layout so the renderer — which cannot import `src/core` — can derive the
// same set from its own live `agentStatus` map. Re-exported here so the engine's own consumers
// keep one import surface.
export { loopOwnedFrameIds, type FrameChainNode } from '../../shared/canvas-layout'
