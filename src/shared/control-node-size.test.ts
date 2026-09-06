import { describe, expect, it } from 'vitest'

import {
  COMPACT_CONTROL_NODE_SIZE,
  controlNodeSizeError,
  isControlNodeSizeName,
  resolveControlNodeSize,
  resolveControlNodeSizeName
} from './control-node-size'

describe('canvas-control node sizes', () => {
  const normal = { width: 640, height: 440 }

  it('uses a compact default with exactly half the stock terminal footprint', () => {
    expect(resolveControlNodeSize(undefined, normal)).toEqual({ width: 440, height: 320 })
    expect(COMPACT_CONTROL_NODE_SIZE.width * COMPACT_CONTROL_NODE_SIZE.height).toBe(
      (normal.width * normal.height) / 2
    )
  })

  it('resolves explicit compact and normal choices to concrete copies', () => {
    expect(resolveControlNodeSize('compact', normal)).toEqual({ width: 440, height: 320 })
    expect(resolveControlNodeSize('normal', normal)).toEqual(normal)
    expect(resolveControlNodeSize('normal', normal)).not.toBe(normal)
  })

  it('rejects every unknown spelling instead of silently choosing a size', () => {
    expect(isControlNodeSizeName('compact')).toBe(true)
    expect(isControlNodeSizeName('normal')).toBe(true)
    expect(isControlNodeSizeName('small')).toBe(false)
    expect(resolveControlNodeSizeName(undefined)).toBe('compact')
    expect(resolveControlNodeSizeName('normal')).toBe('normal')
    expect(resolveControlNodeSizeName('small')).toBeNull()
    expect(resolveControlNodeSize('small', normal)).toBeNull()
    expect(controlNodeSizeError('resize')).toBe('resize: --size must be compact or normal')
  })
})
