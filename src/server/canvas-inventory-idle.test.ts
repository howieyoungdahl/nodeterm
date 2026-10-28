import { describe, expect, it } from 'vitest'
import type { Project } from '../shared/types'
import { inventoryEntries } from './canvas-inventory'

describe('canvas inventory idle facts', () => {
  it('reports idle only with a positive fact and keeps a real state authoritative', () => {
    const project = { nodes: [
      { id: 'idle', kind: 'terminal', title: 'Idle', agentId: 'claude' },
      { id: 'unknown', kind: 'terminal', title: 'Unknown', agentId: 'claude' },
      { id: 'busy', kind: 'terminal', title: 'Busy', agentId: 'claude' }
    ] } as Project
    const entries = inventoryEntries(project, {
      stateOf: (id) => id === 'busy' ? 'working' : undefined,
      idleOf: (id) => id !== 'unknown',
      openedByCaller: () => false
    })
    expect(entries.map((entry) => entry.status)).toEqual(['idle', 'unknown', 'working'])
  })
})
