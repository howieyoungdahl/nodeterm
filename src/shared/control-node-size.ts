export interface NodeSize {
  width: number
  height: number
}

export type ControlNodeSizeName = 'compact' | 'normal'

/**
 * Canvas-control agents are orchestration stations, not primary work surfaces. This is exactly
 * half the area of the stock 640×440 terminal while keeping both dimensions comfortably above
 * the renderer's terminal minimum.
 */
export const COMPACT_CONTROL_NODE_SIZE: Readonly<NodeSize> = Object.freeze({
  width: 440,
  height: 320
})

export function isControlNodeSizeName(value: string | undefined): value is ControlNodeSizeName {
  return value === 'compact' || value === 'normal'
}

export function resolveControlNodeSizeName(
  value: string | undefined,
  defaultName: ControlNodeSizeName = 'compact'
): ControlNodeSizeName | null {
  const name = value ?? defaultName
  return isControlNodeSizeName(name) ? name : null
}

/** Resolve a canvas-control size name to concrete geometry that can be persisted on the node. */
export function resolveControlNodeSize(
  value: string | undefined,
  normal: NodeSize,
  defaultName: ControlNodeSizeName = 'compact'
): NodeSize | null {
  const name = resolveControlNodeSizeName(value, defaultName)
  if (name === 'compact') return { ...COMPACT_CONTROL_NODE_SIZE }
  if (name === 'normal') return { width: normal.width, height: normal.height }
  return null
}

export function controlNodeSizeError(verb: string): string {
  return `${verb}: --size must be compact or normal`
}
