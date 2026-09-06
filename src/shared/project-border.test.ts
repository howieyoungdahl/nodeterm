import { expect, it } from 'vitest'
import { withProjectBorder } from './project-border'

it('clearing the last border retains spawn, tray, version and future rules through a JSON round trip', () => {
  const rules = {
    version: 9, spawn: { size: 'compact' }, tray: { collapsed: true },
    future: { exclusions: ['my-workspace'] }, unknown: { next: true },
    appearance: { project: { color: '#123456' } }
  }
  const before = JSON.stringify(rules)
  expect(JSON.parse(JSON.stringify(withProjectBorder(rules, undefined)))).toEqual({
    version: 9, spawn: { size: 'compact' }, tray: { collapsed: true },
    future: { exclusions: ['my-workspace'] }, unknown: { next: true }
  })
  expect(JSON.stringify(rules)).toBe(before)
})

it('keeps provider, director, task and unknown appearance preferences when clearing the project tier', () => {
  const other = {
    byProvider: { codex: { color: '#abc' } }, byDirector: { owner: { thickness: 2 } },
    byTaskGroup: { task: { glow: true } }, future: { dim: false }
  }
  expect(withProjectBorder({ appearance: { ...other, project: { color: '#fff' } } }, undefined))
    .toEqual({ appearance: other })
})

it('setting a border preserves the existing version and does not add local preferences', () => {
  const rules = { version: 99, spawn: { size: 'normal' }, appearance: { byProvider: {} } }
  expect(withProjectBorder(rules, { color: '#fff' })).toEqual({
    ...rules, appearance: { byProvider: {}, project: { color: '#fff' } }
  })
  expect(withProjectBorder(undefined, undefined)).toBeUndefined()
})
