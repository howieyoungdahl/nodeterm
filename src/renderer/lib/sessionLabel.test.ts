import { expect, it } from 'vitest'
import { normalizeSessionLabel } from './sessionLabel'

it('keeps the same session label through spinner frames and preserves real title text', () => {
  const title = 'Compare outputs | first draft'
  for (const prefix of ['⠋ ', '⠇ ', '✻ ', '']) {
    expect(normalizeSessionLabel(`${prefix}${title} | nodeterm`)).toBe(title)
  }
  expect(normalizeSessionLabel(title)).toBe(title)
  expect(normalizeSessionLabel('Project | Tools | nodeterm')).toBe('Project | Tools')
  expect(normalizeSessionLabel('Review | C:\\projects\\nodeterm')).toBe('Review | C:\\projects\\nodeterm')
})
