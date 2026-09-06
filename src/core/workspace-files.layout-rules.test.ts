// The shared layout-rule block at the project-file boundary.
//
// This block reaches the layout engine — the thing allowed to move the operator's cards — off a
// git-shared, hand-editable file, so it gets `sanitizeNodeTriggers`' treatment: validated on the
// way IN and on the way OUT, and never written as though this build had authored a shape it
// cannot read.
//
// The unknown-key rule is the one worth a test of its own. Two machines on different builds read
// and REWRITE this same file; a sanitizer that dropped what it did not recognise would make the
// older one silently delete the newer one's rules on its next save.
import { describe, it, expect } from 'vitest'
import type { CanvasNodeState, Project } from '../shared/types'
import { projectToFile, fileToProject, type ProjectFileV1 } from './workspace-files'

const node = (): CanvasNodeState => ({
  id: 'term-abc',
  kind: 'terminal',
  position: { x: 0, y: 0 },
  size: { width: 400, height: 300 },
  title: 't',
  color: '#fff',
  group: null
})
const project = (over: Partial<Project> = {}): Project => ({
  id: 'p1',
  name: 'foo',
  color: '#7aa2f7',
  viewport: { x: 0, y: 0, zoom: 1 },
  nodes: [node()],
  ...over
})

describe('layoutRules at the project-file boundary', () => {
  it('round-trips a valid block', () => {
    const rules = { version: 1, spawn: { place: 'tray' as const }, tray: { collapsed: true } }
    const file = projectToFile(project({ layoutRules: rules }), 3, 't')
    expect(file.layoutRules).toEqual(rules)
    expect(fileToProject(file, { id: 'p1' }).layoutRules).toEqual(rules)
  })

  it('adds no bytes to the committed file when there are no rules', () => {
    expect('layoutRules' in projectToFile(project(), 3, 't')).toBe(false)
  })

  it('drops a hand-edited garbage block on READ rather than handing it to the engine', () => {
    const file = { ...projectToFile(project(), 3, 't'), layoutRules: 'off' } as ProjectFileV1
    expect(fileToProject(file, { id: 'p1' }).layoutRules).toBeUndefined()
  })

  it('normalises on WRITE too — a bad shape that reached the live project is never committed', () => {
    const file = projectToFile(
      project({ layoutRules: { spawn: { place: 'wherever' }, tray: { collapsed: 1 } } as never }),
      3,
      't'
    )
    expect(file.layoutRules).toBeUndefined()
  })

  it('keeps BOTH halves of the block through a whole read/write cycle', () => {
    // `appearance` is no longer a foreign key: the two halves now share one sanitizer, so it is
    // validated and kept at the TOP level rather than parked in the unknown bag. What must not
    // change is the guarantee — neither half erases the other's keys on an ordinary save.
    const both = {
      version: 2,
      spawn: { place: 'tray' as const },
      appearance: { byProvider: { claude: { color: '#0a84ff' } } }
    }
    const loaded = fileToProject(
      { ...projectToFile(project(), 3, 't'), layoutRules: both } as ProjectFileV1,
      { id: 'p1' }
    )
    expect(loaded.layoutRules).toEqual(both)
    const written = projectToFile(loaded, 4, 't')
    expect(written.layoutRules).toEqual(both)
  })

  it('lifts a key an older build had parked in the unknown bag back to the top level', () => {
    // A build that shipped only the layout half nested everything foreign under `unknown`. Reading
    // that file must find `appearance` where the appearance half looks, or the border rules read as
    // absent and the next save writes them away for good.
    const parked = {
      version: 2,
      unknown: { appearance: { byProvider: { claude: { color: '#0a84ff' } } } }
    }
    const loaded = fileToProject(
      { ...projectToFile(project(), 3, 't'), layoutRules: parked } as ProjectFileV1,
      { id: 'p1' }
    )
    expect(loaded.layoutRules).toEqual({
      version: 2,
      appearance: { byProvider: { claude: { color: '#0a84ff' } } }
    })
  })

  it('still carries a key NEITHER half knows, at the top level', () => {
    const future = { version: 2, someThirdHalf: { mode: 'x' } }
    const loaded = fileToProject(
      { ...projectToFile(project(), 3, 't'), layoutRules: future } as ProjectFileV1,
      { id: 'p1' }
    )
    expect(loaded.layoutRules).toEqual(future)
    expect(projectToFile(loaded, 4, 't').layoutRules).toEqual(future)
  })

  it('is byte-identical for a pre-feature project — an existing canvas gains nothing', () => {
    const before = projectToFile(project(), 3, 't')
    const after = fileToProject(before, { id: 'p1' })
    expect(after.layoutRules).toBeUndefined()
    expect(projectToFile(after, 3, 't')).toEqual(before)
  })
})
