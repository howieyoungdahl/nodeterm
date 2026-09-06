// "Put away / Expand" — ONE action, in the node header's right-hand button group.
//
// A worker an agent opened arrives at the compact footprint (440×320), which is enough to see
// what it is doing and not enough to read it. This grows it to the configured working size in
// place, and puts it back at exactly the rect it had — size AND position, remembered rather than
// recomputed, so a card that grew past its neighbours returns to its slot instead of to a guess.
//
// It is a canvas-state change and nothing else: no respawn, no kill, no write to the pty. Putting
// a session away is filing it, not ending it. `state/workspace.ts` holds the transform (so a
// grouped node re-fits its ancestor frames in the same tick) and `compactToggleState` decides
// whether there is anything to offer at all — the button never renders as a no-op.

import { useReactFlow, useStore } from '@xyflow/react'
import { Tooltip } from '../components/Tooltip'
import { IconExpandCard, IconPutAwayCard } from '../components/icons'
import { markWorkspaceDirty } from '../state/workspaceDirty'
import { compactToggleState, toggleCompactNode, type CanvasNode } from '../state/workspace'

export function CompactButton({ id }: { id: string }) {
  const { setNodes } = useReactFlow()
  // Read the LIVE geometry from React Flow's own store: our copy of `measured` lands a render
  // later (it arrives through onNodesChange), and this button's whole job is to answer a question
  // about the node's current size.
  const state = useStore((s) => {
    const node = s.nodeLookup.get(id)
    return node ? compactToggleState(node as unknown as CanvasNode) : null
  })
  if (!state) return null
  const expanded = state === 'put-away'

  return (
    <Tooltip
      label={
        expanded
          ? 'Put away — back to the compact size and position it had'
          : 'Expand — grow this card to the working size'
      }
    >
      <button
        className="term-node__compact nodrag"
        aria-label={expanded ? 'Put node away' : 'Expand node'}
        aria-pressed={expanded}
        onClick={(e) => {
          e.stopPropagation()
          setNodes((ns) => toggleCompactNode(ns as CanvasNode[], id))
          // Direct setNodes bypasses handleNodesChange, so the project must be marked dirty
          // explicitly (same rule as MaximizeButton) — else the new rect is lost on restart.
          markWorkspaceDirty()
        }}
      >
        {expanded ? <IconPutAwayCard /> : <IconExpandCard />}
      </button>
    </Tooltip>
  )
}
