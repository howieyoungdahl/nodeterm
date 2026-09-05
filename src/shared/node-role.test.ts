import { describe, expect, it } from 'vitest'

import { DEFAULT_NODE_ROLE, isNodeRole, isWorkerNode, resolveNodeRole } from './node-role'

describe('node role', () => {
  it('reads an absent role as primary — every canvas saved before the field exists', () => {
    expect(DEFAULT_NODE_ROLE).toBe('primary')
    expect(resolveNodeRole(undefined)).toBe('primary')
    expect(isWorkerNode({})).toBe(false)
    expect(isWorkerNode(undefined)).toBe(false)
  })

  it('reads an unrecognized value as primary rather than rejecting it', () => {
    // project.json is git-shared and hand-editable, and "leave this node alone" is the safe
    // answer for a value this build does not know.
    expect(resolveNodeRole('director')).toBe('primary')
    expect(resolveNodeRole(7)).toBe('primary')
    expect(resolveNodeRole(null)).toBe('primary')
    expect(isWorkerNode({ role: 'Worker' })).toBe(false)
  })

  it('only an explicit worker is a worker', () => {
    expect(isNodeRole('worker')).toBe(true)
    expect(isNodeRole('primary')).toBe(true)
    expect(isNodeRole('other')).toBe(false)
    expect(isWorkerNode({ role: 'worker' })).toBe(true)
    expect(isWorkerNode({ role: 'primary' })).toBe(false)
  })
})
