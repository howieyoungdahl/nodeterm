import { describe, it, expect, beforeEach } from 'vitest'
import { parseViewMap, parseKanbanSortMap, useViewMode, isKanbanOpen, viewFor } from './viewMode'

describe('parseViewMap', () => {
  it('keeps canvas/kanban entries, tolerates garbage', () => {
    expect(parseViewMap(null)).toEqual({})
    expect(parseViewMap('not json')).toEqual({})
    expect(parseViewMap('[1,2]')).toEqual({})
    expect(parseViewMap(JSON.stringify({ p1: 'kanban', p2: 'canvas', p3: 42 }))).toEqual({ p1: 'kanban', p2: 'canvas' })
  })
})

describe('toggle + default', () => {
  beforeEach(() => useViewMode.setState({ viewByProject: {}, defaultView: 'canvas' }))
  it('flips a project explicitly (stores canvas/kanban, overriding the default)', () => {
    useViewMode.getState().toggle('p1')
    expect(useViewMode.getState().viewByProject.p1).toBe('kanban')
    useViewMode.getState().toggle('p1')
    expect(useViewMode.getState().viewByProject.p1).toBe('canvas') // explicit, not deleted
  })
  it('an unset project follows the default; toggling flips FROM the resolved default', () => {
    const s = useViewMode.getState()
    expect(viewFor(s, 'x')).toBe('canvas')
    expect(isKanbanOpen('x')).toBe(false)
    useViewMode.setState({ defaultView: 'kanban' })
    expect(isKanbanOpen('x')).toBe(true) // now follows the kanban default
    // toggling an unset project flips off the resolved default → explicit 'canvas'
    useViewMode.getState().toggle('x')
    expect(useViewMode.getState().viewByProject.x).toBe('canvas')
    expect(isKanbanOpen('x')).toBe(false) // explicit choice beats the kanban default
  })
})

describe('card requests (board-aware "go to node")', () => {
  it('carries a one-shot request the board consumes', () => {
    useViewMode.setState({ requestedCardNodeId: null })
    useViewMode.getState().requestCard('term-1')
    expect(useViewMode.getState().requestedCardNodeId).toBe('term-1')
    useViewMode.getState().clearCardRequest()
    expect(useViewMode.getState().requestedCardNodeId).toBeNull()
    // Re-requesting the SAME node must work — it is a fresh "go to", not a state to dedupe.
    useViewMode.getState().requestCard('term-1')
    expect(useViewMode.getState().requestedCardNodeId).toBe('term-1')
  })

  it('a view toggle drops an unconsumed request', () => {
    useViewMode.setState({ viewByProject: {}, defaultView: 'canvas', requestedCardNodeId: null })
    useViewMode.getState().toggle('p9')
    expect(isKanbanOpen('p9')).toBe(true)
    useViewMode.getState().requestCard('term-2')
    // Leaving the board: the request belonged to the view we just left; firing it later would
    // pop a card open out of nowhere.
    useViewMode.getState().toggle('p9')
    expect(isKanbanOpen('p9')).toBe(false)
    expect(useViewMode.getState().requestedCardNodeId).toBeNull()
  })
})

it('validates personal per-project sort preferences and isolates projects', () => {
  for (const raw of [null, 'broken', 'null', '[]', '42']) expect(parseKanbanSortMap(raw)).toEqual({})
  expect(parseKanbanSortMap('{"a":"priority","b":"manual","c":"urgent"}')).toEqual({ a: 'priority', b: 'manual' })
  useViewMode.setState({ kanbanSortByProject: {} })
  expect(useViewMode.getState().kanbanSortByProject.a ?? 'manual').toBe('manual')
  useViewMode.getState().setKanbanSort('a', 'priority')
  useViewMode.getState().setKanbanSort('b', 'manual')
  expect(useViewMode.getState().kanbanSortByProject).toEqual({ a: 'priority', b: 'manual' })
  useViewMode.getState().setKanbanSort('a', 'manual')
  expect(useViewMode.getState().kanbanSortByProject).toEqual({ a: 'manual', b: 'manual' })
})
