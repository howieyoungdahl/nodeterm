import type { Project, WorkspacePublication } from '@shared/types'
import { reconcileEntityOrder } from '@shared/project-reconciliation'
import { applyDeletedEntities } from './deletedEntities'

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

/** How a card looks and where it sits. A local change confined to these says nothing worth keeping
 * once the card is closed; text drafts, urls, files and launch state are content and still ask. */
const PRESENTATION = new Set(['position', 'size', 'compactRect', 'controlSize', 'title', 'titleAuto', 'color', 'group',
  'parentId', 'collapsed', 'pinned', 'manualPlacement', 'tags', 'hideFanout', 'taskFrame'])

/** A host can restore a terminal the tab already holds but has not saved yet. The same ID
 * names a single terminal in this project. Keep the tab's current presentation and retain
 * complementary fields from the restore. Conflicting launch data or drafts still need recovery. */
function mergeRestoredTerminal(local: Record<string, unknown>, incoming: Record<string, unknown>): Record<string, unknown> {
  const fields: Array<[string, unknown]> = []
  for (const key of new Set([...Object.keys(local), ...Object.keys(incoming)])) {
    const current = Object.hasOwn(local, key) ? local[key] : undefined
    const restored = Object.hasOwn(incoming, key) ? incoming[key] : undefined
    const presentation = PRESENTATION.has(key)
    if (!presentation && current !== undefined && restored !== undefined && !equal(current, restored))
      throw new Error('overlapping-content')
    const value = presentation ? current : current === undefined ? restored : current
    if (value !== undefined) fields.push([key, value])
  }
  return Object.fromEntries(fields)
}

/** A close recorded with the incoming file (`deletedEntities`) beats a local presentation edit of
 * that card. Field 2026-11-17: the server closed a card the tab had just retitled, edit-vs-delete
 * raised the conflict bar, autosave stayed suspended for 64 minutes and a card opened meanwhile
 * was never saved. Only nodes the base also held qualify, so nothing local-only is dropped. */
function closeRecordedDeletions(base: Project | undefined, local: Project, incoming: Project | undefined): Project {
  const recorded = incoming?.id === local.id ? incoming.deletedEntities : undefined
  if (!base || !recorded?.nodes.length) return local
  const baseNodes = new Map(base.nodes.map(n => [n.id, n as unknown as Record<string, unknown>]))
  const nodes = recorded.nodes.filter(id => {
    const was = baseNodes.get(id), now = local.nodes.find(n => n.id === id) as unknown as Record<string, unknown> | undefined
    if (!was || !now) return false
    return [...new Set([...Object.keys(was), ...Object.keys(now)])].every(k => PRESENTATION.has(k) || equal(was[k], now[k]))
  })
  return nodes.length ? applyDeletedEntities(local, { ...incoming!, deletedEntities: { ...recorded, nodes } }) : local
}

/** Merge every field, not only new nodes. Arrays without entity IDs are atomic choices, so
 * conflicting manual order/columns/pins are retained behind the conflict bar. */
function merge(base: unknown, local: unknown, incoming: unknown, path: string[] = []): unknown {
  const key = path.at(-1) ?? ''
  if (equal(base, incoming) || equal(local, incoming)) return local
  if (equal(base, local)) return incoming
  const projectNode = path.length === 2 && path[0] === 'nodes' ||
    path.length === 4 && path[0] === 'projects' && path[2] === 'nodes'
  if (projectNode && base === undefined && object(local) && object(incoming) &&
    local.kind === 'terminal' && incoming.kind === 'terminal' && local.id === key && incoming.id === key)
    return mergeRestoredTerminal(local, incoming)
  if (object(base) && object(local) && object(incoming)) {
    // An automatic title update can race with a hand rename. Resolve the title
    // and its mode together, while merging unrelated edits as usual.
    const handTitle = projectNode && base.kind === 'terminal' && local.kind === 'terminal' &&
      incoming.kind === 'terminal' && base.titleAuto === true && local.titleAuto !== incoming.titleAuto
      ? local.titleAuto === false ? local : incoming
      : undefined
    const result: Record<string, unknown> = {}
    for (const k of new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(incoming)])) {
      const value = handTitle && (k === 'title' || k === 'titleAuto')
        ? handTitle[k]
        : merge(base[k], local[k], incoming[k], [...path, k])
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
      result[i] = { ...merge(clean(delta.before), clean(closeRecordedDeletions(delta.before, result[i], delta.after)), clean(delta.after)) as Project,
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
    const closed = (p: Project) => closeRecordedDeletions(base.find(b => b.id === p.id), p, incoming.find(r => r.id === p.id))
    const projects = merge(base.map(clean), local.map(p => clean(closed(p))), incoming.map(clean), ['projects']) as Project[]
    const durable = new Map(incoming.map(p => [p.id, p]))
    return { kind: 'adopt', revision, localEditsRemain: !equal(projects, incoming.map(clean)),
      projects: projects.map(p => ({ ...p, revision: durable.get(p.id)?.revision,
        deletedEntities: durable.get(p.id)?.deletedEntities, loadedKanban: durable.get(p.id)?.kanban ?? null })) }
  } catch (error) { return { kind: 'conflict', reason: (error as Error).message } }
}
