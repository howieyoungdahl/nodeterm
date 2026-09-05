// Loop ownership is SUPPLIED, never inferred from a frame's name. This is the one derivation the
// app itself may make: a node carrying a live loop / schedule / cron card is a fact the hook layer
// already established, and every frame above it is that loop's.
import { describe, it, expect } from 'vitest'
import { loopOwnedFrameIds } from './loop-frames'

const nodes = [
  { id: 'outer', kind: 'group' },
  { id: 'inner', kind: 'group', parentId: 'outer' },
  { id: 'loopNode', kind: 'terminal', parentId: 'inner' },
  { id: 'tray', kind: 'group' },
  { id: 'worker', kind: 'terminal', parentId: 'tray' }
]

describe('loopOwnedFrameIds', () => {
  it('returns nothing when no node is loop-driven', () => {
    expect(loopOwnedFrameIds(nodes, [])).toEqual([])
  })

  it('claims the WHOLE ancestor chain, so a nested loop still owns its members', () => {
    expect(loopOwnedFrameIds(nodes, ['loopNode']).sort()).toEqual(['inner', 'outer'])
  })

  it('does not claim an unrelated tray', () => {
    expect(loopOwnedFrameIds(nodes, ['loopNode'])).not.toContain('tray')
  })

  it('a top-level loop node owns no frame — there is nothing above it', () => {
    expect(loopOwnedFrameIds([{ id: 'solo', kind: 'terminal' }], ['solo'])).toEqual([])
  })

  it('survives a parent CYCLE from a hand-edited file', () => {
    const cyclic = [
      { id: 'a', kind: 'group', parentId: 'b' },
      { id: 'b', kind: 'group', parentId: 'a' },
      { id: 'n', kind: 'terminal', parentId: 'a' }
    ]
    expect(loopOwnedFrameIds(cyclic, ['n']).sort()).toEqual(['a', 'b'])
  })

  it('de-duplicates when two loop nodes share a frame', () => {
    expect(
      loopOwnedFrameIds(
        [
          { id: 'f', kind: 'group' },
          { id: 'x', kind: 'terminal', parentId: 'f' },
          { id: 'y', kind: 'terminal', parentId: 'f' }
        ],
        ['x', 'y']
      )
    ).toEqual(['f'])
  })
})
