import { describe, expect, it } from 'vitest'
import type { CanvasNodeState, Project } from '../shared/types'
import type { NodeOrganization } from '../shared/kanban-organization'
import { planOrganization } from './kanban-organization'

const metadata = { owner: 'Assistant', projectId: 'p', workstream: 'ics', functionalRole: 'ops' }
const state: NodeOrganization = { version: 1, mode: 'auto', metadata, columnId: 'a', sequence: 1 }
const node: CanvasNodeState = { id: 'test', kind: 'terminal', role: 'worker', organization: state,
  title: 'Security (irrelevant title)', color: '#fff', group: 'legacy-group', parentId: 'canvas-parent',
  position: { x: 9, y: 8 }, size: { width: 640, height: 440 } }
const project: Project = { id: 'p', name: 'Test', color: '#fff', nodes: [node], viewport: { x: 0, y: 0, zoom: 1 },
  kanban: { columns: [{ id: 'a', title: 'Ops', color: '#fff' }, { id: 'b', title: 'Security', color: '#fff' }],
    assignments: [{ nodeId: 'test', columnId: 'a' }] },
  kanbanOrganization: { version: 1, projectId: 'p', roles: { ops: 'a', security: 'b' } } }
const desired = { ...metadata, functionalRole: 'security' }
const authority = { attested: true, managed: state }

describe('organization preservation guards', () => {
  it('needs attestation independently of descriptive owner and saved metadata', () => {
    expect(planOrganization(project, node, desired, { ...authority, attested: false }).action).toBe('skip')
    expect(planOrganization(project, node, desired, authority).to).toBe('b')
  })
  it('treats absent role as primary and preserves pins and hand placement', () => {
    for (const extra of [{ role: undefined }, { role: 'primary' as const }, { pinned: true }, { manualPlacement: true }]) {
      expect(planOrganization(project, { ...node, ...extra }, desired, authority).action).toBe('skip')
    }
  })
  it('refuses a durable manual tombstone even if the saved auto marker still agrees', () => {
    expect(planOrganization({ ...project, kanban: { ...project.kanban!, manualAssignments: { test: true } } }, node, desired, authority).reason).toBe('manual_choice')
    const manual = { ...state, mode: 'manual' as const }
    expect(planOrganization(project, { ...node, organization: manual }, desired, { ...authority, managed: manual }).reason).toBe('manual_choice')
  })
  it('never adopts unknown, changed or dangling assignment provenance', () => {
    expect(planOrganization(project, { ...node, organization: undefined }, desired, authority).action).toBe('skip')
    expect(planOrganization(project, node, desired, { attested: true }).action).toBe('skip')
    expect(planOrganization(project, { ...node, organization: { ...state, metadata: { ...metadata, owner: 'claim' } } }, desired, authority).action).toBe('skip')
    const drift = { ...project, kanban: { ...project.kanban!, assignments: [{ nodeId: node.id, columnId: 'removed' }] } }
    expect(planOrganization(drift, node, desired, authority).reason).toBe('assignment_drift')
  })
  it('never treats a non-null existing assignment as newly created', () => {
    expect(planOrganization(project, { ...node, organization: undefined }, desired, { attested: true, creating: true }).action).toBe('skip')
  })
  it('does not infer routing from a title, a different project or different case', () => {
    expect(planOrganization(project, node, { ...desired, functionalRole: 'SECURITY' }, authority).to).toBeNull()
    expect(planOrganization(project, node, { ...desired, projectId: 'other' }, authority).action).toBe('skip')
  })
})
