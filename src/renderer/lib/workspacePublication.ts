import type { Project, WorkspacePublication } from '@shared/types'
import { reconcileEntityOrder } from '@shared/project-reconciliation'

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const equal = (a: unknown, b: unknown): boolean => {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => equal(v, b[i]))
  return object(a) && object(b) && Object.keys(a).length === Object.keys(b).length &&
    Object.keys(a).every(k => Object.hasOwn(b, k) && equal(a[k], b[k]))
}
const clean = (p: Project): Project => {
  const { revision: _revision, loadedKanban: _baseline, workspaceChange: _change, organizationChange: _organization, deletedEntities: _deletions, ...content } = p
  return content
}

/** Merge every field, not only new nodes. Arrays without entity IDs are atomic choices, so
 * conflicting manual order/columns/pins are retained behind the conflict bar. */
function merge(base: unknown, local: unknown, incoming: unknown, key = ''): unknown {
  if (equal(base, incoming) || equal(local, incoming)) return local
  if (equal(base, local)) return incoming
  if (object(base) && object(local) && object(incoming)) {
    const result: Record<string, unknown> = {}
    for (const k of new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(incoming)])) {
      const value = merge(base[k], local[k], incoming[k], k)
      if (value !== undefined) result[k] = value
    }
    return result
  }
  if (['nodes', 'ropes', 'bridges', 'columns', 'assignments'].includes(key) && Array.isArray(base) && Array.isArray(local) && Array.isArray(incoming)) {
    const identity = (v: unknown) => (v as Record<string, string>)[key === 'assignments' ? 'nodeId' : 'id']
    const index = (items: unknown[]) => {
      if (!items.every(v => object(v) && typeof identity(v) === 'string') || new Set(items.map(identity)).size !== items.length)
        throw new Error('ambiguous-entity')
      return new Map(items.map(v => [identity(v), v]))
    }
    const b = index(base), l = index(local), r = index(incoming)
    const merged = new Map<string, unknown>()
    for (const id of new Set([...b.keys(), ...l.keys(), ...r.keys()])) merged.set(id, merge(b.get(id), l.get(id), r.get(id)))
    const alive = [...merged.keys()].filter(id => merged.get(id) !== undefined)
    // Shared retained-document ordering keeps each side's insertion and manual relations.
    // Selecting one side's list and appending the other's new rows silently loses those relations.
    const order = reconcileEntityOrder(alive, [...b.keys()], [...l.keys()], [...r.keys()])
    if (!order) throw new Error('overlapping-order')
    return order.map(id => merged.get(id))
  }
  throw new Error('overlapping-content')
}

export function mergeWorkspacePublication(revision: string | undefined, projects: Project[], change: WorkspacePublication | undefined):
  { kind: 'adopt'; projects: Project[]; revision: string } | { kind: 'duplicate' } | { kind: 'conflict'; reason: string } {
  if (!change || !/^[a-f0-9]{64}$/.test(change.before) || !/^[a-f0-9]{64}$/.test(change.after) || !Array.isArray(change.changes))
    return { kind: 'conflict', reason: 'revision-acknowledgment-missing' }
  if (revision === change.after) return { kind: 'duplicate' }
  if (revision !== change.before) return { kind: 'conflict', reason: 'revision-chain-broken' }
  if (!change.changes.length && change.before !== change.after)
    return { kind: 'conflict', reason: 'publication-content-missing' }
  try {
    const ids = new Set<string>(), result = [...projects]
    for (const delta of change.changes) {
      if (!delta.before || !delta.after || delta.before.id !== delta.after.id || ids.has(delta.after.id)) throw new Error('invalid-publication')
      ids.add(delta.after.id)
      const i = result.findIndex(p => p.id === delta.after.id)
      if (i < 0 || result.filter(p => p.id === delta.after.id).length !== 1) throw new Error('foreign-project')
      result[i] = { ...merge(clean(delta.before), clean(result[i]), clean(delta.after)) as Project,
        revision: delta.after.revision, deletedEntities: delta.after.deletedEntities, loadedKanban: delta.after.kanban ?? null }
    }
    return { kind: 'adopt', projects: result, revision: change.after }
  } catch (error) { return { kind: 'conflict', reason: (error as Error).message } }
}
