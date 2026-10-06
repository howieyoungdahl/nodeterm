import { organizationKey } from './kanban-organization'
import type { KanbanPriority } from './types'

export const TASK_CATEGORIES = ['implementation', 'design', 'research', 'operations', 'security',
  'release', 'customer', 'data', 'coordination', 'needs-classification'] as const
export type TaskCategory = typeof TASK_CATEGORIES[number]
/** Desktop control has no immutable creation admission. Never silently discard explicit intent. */
export function desktopPlanningRefusal(args: Record<string, string>): string | undefined {
  return args['task-planning'] === undefined ? undefined : 'task_planning_requires_managed_server_creation'
}
const priorities: KanbanPriority[] = ['low', 'medium', 'high', 'urgent']
const signalKinds = ['user-priority', 'deadline', 'live-privacy-security', 'customer-launch',
  'dependency-unblock', 'paid-spend-risk', 'stalled'] as const
export interface UrgencySignal {
  kind: typeof signalKinds[number]
  evidence: string
  at?: number
  priority?: KanbanPriority
}
export interface TaskPlanning {
  version: 1
  taskId: string
  category: TaskCategory
  categoryReason: string
  relationship: 'independent' | 'support'
  parentTaskId?: string
  urgency: { mode: 'auto' | 'manual'; level: KanbanPriority; reason: string; signals: UrgencySignal[] }
  stage?: 'planned' | 'active' | 'review' | 'done'
  blockedReason?: string
  deliverableUrl?: string
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 &&
  v.length <= 320 && !/[\u0000-\u001f\u007f]/.test(v)
const keys = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).every(k => allowed.includes(k))

/** Shared project content describes intent; it never grants session or creator authority. */
export function parseTaskPlanning(value: unknown): TaskPlanning | undefined {
  if (!object(value) || !keys(value, ['version', 'taskId', 'category', 'categoryReason', 'relationship',
    'parentTaskId', 'urgency', 'stage', 'blockedReason', 'deliverableUrl']) || value.version !== 1 ||
    !organizationKey(value.taskId) || !TASK_CATEGORIES.includes(value.category as TaskCategory) ||
    !text(value.categoryReason) || !['independent', 'support'].includes(value.relationship as string)) return
  if (value.relationship === 'support' ? !organizationKey(value.parentTaskId) || value.parentTaskId === value.taskId
    : value.parentTaskId !== undefined) return
  const urgency = value.urgency
  if (!object(urgency) || !keys(urgency, ['mode', 'level', 'reason', 'signals']) ||
    !['auto', 'manual'].includes(urgency.mode as string) || !priorities.includes(urgency.level as KanbanPriority) ||
    !text(urgency.reason) || !Array.isArray(urgency.signals) || urgency.signals.length > 16) return
  const signals: UrgencySignal[] = []
  for (const signal of urgency.signals) {
    if (!object(signal) || !keys(signal, ['kind', 'evidence', 'at', 'priority']) ||
      !signalKinds.includes(signal.kind as UrgencySignal['kind']) || !text(signal.evidence) ||
      (signal.at !== undefined && (typeof signal.at !== 'number' || !Number.isSafeInteger(signal.at) || signal.at < 0)) ||
      (signal.priority !== undefined && !priorities.includes(signal.priority as KanbanPriority)) ||
      (['deadline', 'customer-launch', 'stalled'].includes(signal.kind as string) && signal.at === undefined) ||
      (signal.kind === 'user-priority' && signal.priority === undefined)) return
    signals.push({ kind: signal.kind as UrgencySignal['kind'], evidence: signal.evidence,
      ...(signal.at !== undefined ? { at: signal.at as number } : {}),
      ...(signal.priority !== undefined ? { priority: signal.priority as KanbanPriority } : {}) })
  }
  if (value.stage !== undefined && !['planned', 'active', 'review', 'done'].includes(value.stage as string)) return
  if (value.blockedReason !== undefined && !text(value.blockedReason)) return
  if (value.deliverableUrl !== undefined && (typeof value.deliverableUrl !== 'string' || value.deliverableUrl.length > 2048 ||
    !/^https:\/\/[^\s\u0000-\u001f]+$/.test(value.deliverableUrl))) return
  if (value.deliverableUrl !== undefined) {
    try { const url = new URL(value.deliverableUrl as string); if (url.username || url.password || !url.hostname) return }
    catch { return }
  }
  return { version: 1, taskId: value.taskId, category: value.category as TaskCategory,
    categoryReason: value.categoryReason, relationship: value.relationship as TaskPlanning['relationship'],
    ...(value.parentTaskId ? { parentTaskId: value.parentTaskId as string } : {}),
    urgency: { mode: urgency.mode as 'auto' | 'manual', level: urgency.level as KanbanPriority, reason: urgency.reason, signals },
    ...(value.stage ? { stage: value.stage as TaskPlanning['stage'] } : {}),
    ...(value.blockedReason ? { blockedReason: value.blockedReason as string } : {}),
    ...(value.deliverableUrl ? { deliverableUrl: value.deliverableUrl as string } : {}) }
}

/** Only explicit role values are mapped. Titles, models and blocked status are never signals. */
const roleCategories: Record<string, TaskCategory> = {
  implementation: 'implementation', deliverable: 'implementation', design: 'design',
  research: 'research', evidence: 'research', ops: 'operations', security: 'security',
  cicd: 'release', review: 'release', qa: 'release', 'qa-explorer': 'release',
  directorychecks: 'data', data: 'data', customer: 'customer', intake: 'customer', coordination: 'coordination'
}
export function defaultTaskPlanning(taskId: string, functionalRole?: string): TaskPlanning {
  const category = functionalRole && Object.hasOwn(roleCategories, functionalRole)
    ? roleCategories[functionalRole] : 'needs-classification'
  return { version: 1, taskId, category,
    categoryReason: category === 'needs-classification' ? 'Explicit category is still required; no verified category mapping.'
      : `Explicit functional role: ${functionalRole}`,
    relationship: 'independent',
    urgency: { mode: 'auto', level: 'medium', reason: 'Routine work; no verified time-sensitive evidence supplied.', signals: [] } }
}

/** Re-evaluate explicit evidence as time passes; a declared user override always wins. */
export function assessTaskUrgency(planning: TaskPlanning, now: number): TaskPlanning['urgency'] {
  if (planning.urgency.mode === 'manual') return planning.urgency
  const user = planning.urgency.signals.filter(s => s.kind === 'user-priority').at(-1)
  if (user) return { ...planning.urgency, level: user.priority!, reason: user.evidence }
  let level: KanbanPriority = 'medium'
  let reason = 'Routine work; no verified time-sensitive evidence supplied.'
  const day = 86400000
  for (const signal of planning.urgency.signals) {
    let candidate: KanbanPriority = 'medium'
    if (signal.kind === 'live-privacy-security') candidate = 'urgent'
    if (signal.kind === 'dependency-unblock' || signal.kind === 'paid-spend-risk') candidate = 'high'
    if (signal.kind === 'stalled' && now - signal.at! >= 7 * day) candidate = 'high'
    if (signal.kind === 'deadline' || signal.kind === 'customer-launch') {
      if (signal.at! - now <= day) candidate = 'urgent'
      else if (signal.at! - now <= 3 * day) candidate = 'high'
    }
    if (priorities.indexOf(candidate) > priorities.indexOf(level)) { level = candidate; reason = signal.evidence }
  }
  return { ...planning.urgency, level, reason }
}

export function planningAtCreation(taskId: string, role: string | undefined, supplied?: TaskPlanning, now = Date.now()): TaskPlanning {
  const planning = supplied ?? defaultTaskPlanning(taskId, role)
  return { ...planning, urgency: assessTaskUrgency(planning, now) }
}
