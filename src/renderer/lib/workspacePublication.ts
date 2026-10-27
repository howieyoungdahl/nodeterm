import type { Project, WorkspacePublication } from '@shared/types'
import { reconcileEntityOrder } from '@shared/project-reconciliation'

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const equal = (a: unknown, b: unknown): boolean => {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => equal(v, b[i]))
  // RPC/disk JSON omits undefined object fields, while Flow serialization materializes
  // them. Compare the persisted values so an untouched node is not an edit-vs-delete
  // conflict. Only own values participate; inherited prototype fields are not persisted JSON.
  // Null, array order and every defined field still participate in equality.
  return object(a) && object(b) &&
    [...new Set([...Object.keys(a), ...Object.keys(b)])].every(k => equal(Object.hasOwn(a, k) ? a[k] : undefined, Object.hasOwn(b, k) ? b[k] : undefined))
}
const clean = (p: Project): Project => {
  const { revision: _revision, loadedKanban: _baseline, workspaceChange: _change, organizationChange: _organization, deletedEntities: _deletions, ...content } = p
  // Only the documented renderer defaults are equivalent to omission. Keep all other
  // defined metadata, geometry and drafts in the three-way comparison.
  return { ...content, nodes: content.nodes.map(n => ({ ...n,
    titleAuto: n.titleAuto === undefined ? true : n.titleAuto,
    collapsed: n.collapsed === undefined ? false : n.collapsed
  })) }
}

/** Merge every field, not only new nodes. Arrays without entity IDs are atomic choices, so
 * conflicting manual order/columns/pins are retained behind the conflict bar. */
function merge(base: unknown, local: unknown, incoming: unknown, path: string[] = []): unknown {
  const key = path.at(-1) ?? ''
  if (equal(base, incoming) || equal(local, incoming)) return local
  if (equal(base, local)) return incoming
  if (object(base) && object(local) && object(incoming)) {
    const result: Record<string, unknown> = {}
    for (const k of new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(incoming)])) {
      const value = merge(base[k], local[k], incoming[k], [...path, k])
      if (value !== undefined) result[k] = value
    }
    return result
  }
  // Only the canonical project board metadata rows have nodeId entity semantics.
  // Arbitrary nested/opaque meta arrays, card labels and assignees remain atomic.
  const cardMeta = (path.length === 2 || path.length === 4 && path[0] === 'projects') && path.at(-2) === 'kanban' && path.at(-1) === 'meta'
  if ((['projects', 'nodes', 'ropes', 'bridges', 'columns', 'assignments'].includes(key) || cardMeta) &&
    (Array.isArray(base) || cardMeta && base === undefined) &&
    (Array.isArray(local) || cardMeta && local === undefined) &&
    (Array.isArray(incoming) || cardMeta && incoming === undefined)) {
    const identity = (v: unknown) => (v as Record<string, string>)[key === 'assignments' || cardMeta ? 'nodeId' : 'id']
    const index = (items: unknown[]) => {
      if (!items.every(v => object(v) && typeof identity(v) === 'string') || new Set(items.map(identity)).size !== items.length)
        throw new Error('ambiguous-entity')
      return new Map(items.map(v => [identity(v), v]))
    }
    const b = index((base ?? []) as unknown[]), l = index((local ?? []) as unknown[]), r = index((incoming ?? []) as unknown[])
    const merged = new Map<string, unknown>()
    for (const id of new Set([...b.keys(), ...l.keys(), ...r.keys()])) merged.set(id, merge(b.get(id), l.get(id), r.get(id), [...path, id]))
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
  { kind: 'adopt'; projects: Project[]; revision: string; localEditsRemain: boolean } | { kind: 'duplicate' } | { kind: 'conflict'; reason: string } {
  if (!change || !/^[a-f0-9]{64}$/.test(change.before) || !/^[a-f0-9]{64}$/.test(change.after) || !Array.isArray(change.changes))
    return { kind: 'conflict', reason: 'revision-acknowledgment-missing' }
  if (revision === change.after) return { kind: 'duplicate' }
  if (revision !== change.before) return { kind: 'conflict', reason: 'revision-chain-broken' }
  if (!change.changes.length && change.before !== change.after)
    return { kind: 'conflict', reason: 'publication-content-missing' }
  try {
    const ids = new Set<string>(), result = [...projects]
    let localEditsRemain = false
    for (const delta of change.changes) {
      if (!delta.before || !delta.after || delta.before.id !== delta.after.id || ids.has(delta.after.id)) throw new Error('invalid-publication')
      ids.add(delta.after.id)
      const i = result.findIndex(p => p.id === delta.after.id)
      if (i < 0 || result.filter(p => p.id === delta.after.id).length !== 1) throw new Error('foreign-project')
      result[i] = { ...merge(clean(delta.before), clean(result[i]), clean(delta.after)) as Project,
        revision: delta.after.revision, deletedEntities: delta.after.deletedEntities, loadedKanban: delta.after.kanban ?? null }
      // The same persisted equality/default semantics used by the merge decide whether
      // adoption retained local content that still needs a save. Durable incoming content does not.
      if (!equal(clean(result[i]), clean(delta.after))) localEditsRemain = true
    }
    return { kind: 'adopt', projects: result, revision: change.after, localEditsRemain }
  } catch (error) { return { kind: 'conflict', reason: (error as Error).message } }
}

/** A full read repairs a missing chain using the last durable base, never the dirty store. */
export function mergeWorkspaceSnapshot(base: Project[], local: Project[], incoming: Project[], revision: string): ReturnType<typeof mergeWorkspacePublication> {
  if (!/^[a-f0-9]{64}$/.test(revision)) return { kind: 'conflict', reason: 'revision-acknowledgment-missing' }
  try {
    const projects = merge(base.map(clean), local.map(clean), incoming.map(clean), ['projects']) as Project[]
    const durable = new Map(incoming.map(p => [p.id, p]))
    return { kind: 'adopt', revision, localEditsRemain: !equal(projects, incoming.map(clean)),
      projects: projects.map(p => ({ ...p, revision: durable.get(p.id)?.revision,
        deletedEntities: durable.get(p.id)?.deletedEntities, loadedKanban: durable.get(p.id)?.kanban ?? null })) }
  } catch (error) { return { kind: 'conflict', reason: (error as Error).message } }
}
