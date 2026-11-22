import { describe, it, expect } from 'vitest'
import { parseCardPanelOpen, useCardPanel } from './cardPanel'

describe('parseCardPanelOpen', () => {
  it('distinguishes an untouched layout from either explicit choice', () => {
    expect(parseCardPanelOpen(null)).toBeNull()
    expect(parseCardPanelOpen('true')).toBe(true)
    expect(parseCardPanelOpen('garbage')).toBeNull()
    expect(parseCardPanelOpen('false')).toBe(false)
  })
})

describe('setOpen', () => {
  it('remembers both choices in the store', () => {
    expect(useCardPanel.getState().open).toBeNull()
    useCardPanel.getState().setOpen(false)
    expect(useCardPanel.getState().open).toBe(false)
    useCardPanel.getState().setOpen(true)
    expect(useCardPanel.getState().open).toBe(true)
  })
})
