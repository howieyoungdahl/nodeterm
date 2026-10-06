import { describe, expect, it } from 'vitest'
import { assessTaskUrgency, defaultTaskPlanning, desktopPlanningRefusal, parseTaskPlanning, planningAtCreation } from './task-planning'
import { completeCreationPlanning, creationFromArgs, parseAssistantCreation } from './assistant-creation'

const now = 1800000000000, day = 86400000
const task = () => defaultTaskPlanning('task-1234', 'implementation')
describe('creation-time work planning', () => {
  it('refuses unsupported desktop intent without changing ordinary desktop creation', () => {
    expect(desktopPlanningRefusal({ model: 'gpt-6.1-sol' })).toBeUndefined()
    for (const value of ['', '{}', JSON.stringify(task())]) {
      expect(desktopPlanningRefusal({ 'task-planning': value })).toBe('task_planning_requires_managed_server_creation')
    }
  })
  it('records explicit role categories and an explained routine assessment without title inference', () => {
    expect(task()).toMatchObject({ category: 'implementation', relationship: 'independent', urgency: { level: 'medium', reason: expect.any(String) } })
    expect(defaultTaskPlanning('task-1234', 'UnknownSecurityTitle').category).toBe('needs-classification')
    expect(defaultTaskPlanning('task-1234', 'design').category).toBe('design')
    expect(defaultTaskPlanning('task-1234', 'coordination').category).toBe('coordination')
  })
  it.each([
    ['deadline', now + day, 'urgent'], ['deadline', now + 2 * day, 'high'],
    ['customer-launch', now + 10 * day, 'medium'], ['live-privacy-security', undefined, 'urgent'],
    ['dependency-unblock', undefined, 'high'], ['paid-spend-risk', undefined, 'high'],
    ['stalled', now - 8 * day, 'high'], ['stalled', now - day, 'medium']
  ] as const)('assesses %s from recorded evidence without making every task urgent', (kind, at, level) => {
    const planning = task()
    planning.urgency.signals = [{ kind, evidence: 'Exact observed request or incident reference', ...(at === undefined ? {} : { at }) }]
    expect(planningAtCreation(planning.taskId, 'implementation', planning, now).urgency.level).toBe(level)
    expect(assessTaskUrgency(planning, now).level).toBe(level)
  })
  it('keeps blocked status independent and respects explicit user priority over computed pressure', () => {
    const planning = task()
    planning.blockedReason = 'Waiting for deploy approval'
    planning.urgency.signals = [{ kind: 'live-privacy-security', evidence: 'Verified live incident' },
      { kind: 'user-priority', evidence: 'User explicitly set low for this task', priority: 'low' }]
    expect(assessTaskUrgency(planning, now).level).toBe('low')
    planning.urgency = { ...planning.urgency, mode: 'manual', level: 'high', reason: 'Explicit user override' }
    expect(assessTaskUrgency(planning, now).level).toBe('high')
  })
  it('rejects missing reasons, unsupported keys, self parents and evidence-free time triggers', () => {
    for (const value of [{ ...task(), categoryReason: '' }, { ...task(), relationship: 'support' },
      { ...task(), relationship: 'support', parentTaskId: 'task-1234' }, { ...task(), hiddenAuthority: true },
      { ...task(), urgency: { ...task().urgency, reason: '' } },
      { ...task(), urgency: { ...task().urgency, signals: [{ kind: 'deadline', evidence: 'Deadline' }] } }]) {
      expect(parseTaskPlanning(value)).toBeUndefined()
    }
  })
  it('keeps historical envelopes readable and fingerprints stable across urgency thresholds', () => {
    const creation = { version: 1 as const, taskId: 'task-1234', creationId: 'create-1234', declaredOwner: 'Owner' }
    const organization = { owner: 'Owner', projectId: 'project-id', workstream: 'feature', functionalRole: 'implementation' }
    expect(parseAssistantCreation(creation)).toEqual(creation)
    const planning = task()
    planning.urgency.signals = [{ kind: 'deadline', at: now + day, evidence: 'Due tomorrow' }]
    const declared = { ...creation, planning }
    expect(completeCreationPlanning(declared, organization).planning).toEqual(planning)
    expect(parseAssistantCreation({ ...declared, planning: { ...planning, taskId: 'different-task' } })).toBeUndefined()
    expect(creationFromArgs({ 'task-id': creation.taskId, 'creation-id': creation.creationId, owner: 'Owner',
      'organization-project': 'project-id', workstream: 'feature', 'functional-role': 'implementation' }).creation?.planning?.category).toBe('implementation')
  })
})
