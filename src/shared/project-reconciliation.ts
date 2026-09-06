/** Pure portable-document reconciliation. Call AFTER separating machine-local overlays and
 * BEFORE sanitizing known fields: an older client's serializer must not erase unknown fields.
 * This module grants no execution authority and makes no filesystem publication/CAS claim. */
export type ProjectJson = null | boolean | number | string | ProjectJson[] | ProjectDocument
export interface ProjectDocument { [key: string]: ProjectJson }

export type ProjectValue = { present: false } | { present: true; value: ProjectJson }
export interface ProjectConflict {
  path: string[]
  kind: 'value' | 'delete-edit' | 'deleted-node' | 'order' | 'identity'
  base: ProjectValue
  local: ProjectValue
  incoming: ProjectValue
}
export interface ProjectMerge {
  kind: 'merged' | 'conflict'
  /** Preview only while conflicts exist. Never publish it as an implicit Keep Local. */
  document: ProjectDocument
  conflicts: ProjectConflict[]
}
export interface ProjectRecoveryBytes { base: string; local: string; incoming: string }
export type ProjectByteMerge =
  | (ProjectMerge & { recovery: ProjectRecoveryBytes })
  | { kind: 'unavailable'; invalid: (keyof ProjectRecoveryBytes)[]; recovery: ProjectRecoveryBytes }

const missing: ProjectValue = { present: false }
const present = (value: ProjectJson): ProjectValue => ({ present: true, value })
const isObject = (value: ProjectJson): value is ProjectDocument =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const field = (object: ProjectDocument, key: string): ProjectValue =>
  Object.hasOwn(object, key) ? present(object[key]) : missing

/** JSON key ordering is not an edit. Array ordering is, including arrays this client cannot name. */
export function sameProjectJson(a: ProjectJson, b: ProjectJson): boolean {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b))
    return a.length === b.length && a.every((value, i) => sameProjectJson(value, b[i]))
  if (!isObject(a) || !isObject(b)) return false
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length &&
    keys.every((key) => Object.hasOwn(b, key) && sameProjectJson(a[key], b[key]))
}
const equal = (a: ProjectValue, b: ProjectValue): boolean =>
  a.present ? b.present && sameProjectJson(a.value, b.value) : !b.present

/** Only the project schema's entity lists have ID semantics. Future/unknown arrays stay atomic. */
const entityLists = new Set(['nodes', 'bridges', 'ropes'])
function entities(value: ProjectValue): Map<string, ProjectDocument> | null {
  if (!value.present) return new Map()
  if (!Array.isArray(value.value)) return null
  const entries = new Map<string, ProjectDocument>()
  for (const item of value.value) {
    if (!isObject(item) || typeof item.id !== 'string' || !item.id || entries.has(item.id)) return null
    entries.set(item.id, item)
  }
  return entries
}

/** Merge the relative ordering each writer actually knew. Concurrent insertions with no shared
 * relation get a deterministic local-first order; a cycle is a real ordering conflict, not a
 * license to throw away entity edits. Pair comparisons also retain inserted-before-parent order. */
function entityOrder(ids: string[], base: string[], local: string[], incoming: string[]): string[] | null {
  const alive = new Set(ids)
  const sequences = [base, local, incoming].map((list) => list.filter((id) => alive.has(id)))
  const sameOrder = (a: string[], b: string[]): boolean => a.length === b.length && a.every((id, i) => id === b[i])
  const [bOrder, lOrder, rOrder] = sequences
  if (lOrder.length === ids.length && (sameOrder(lOrder, rOrder) || sameOrder(bOrder, rOrder))) return lOrder
  if (rOrder.length === ids.length && sameOrder(bOrder, lOrder)) return rOrder
  const ranks = [base, local, incoming].map((list) => new Map(list.map((id, i) => [id, i])))
  const next = new Map(ids.map((id) => [id, new Set<string>()]))
  const indegree = new Map(ids.map((id) => [id, 0]))
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = ids[i], b = ids[j]
      const [before, ours, theirs] = ranks.map((rank) =>
        rank.has(a) && rank.has(b) ? rank.get(a)! < rank.get(b)! : undefined)
      let relation: boolean | undefined
      if (ours === theirs) relation = ours
      else if (ours === before) relation = theirs
      else if (theirs === before) relation = ours
      else if (ours === undefined) relation = theirs
      else if (theirs === undefined) relation = ours
      else return null
      if (relation === undefined) continue
      const from = relation ? a : b, to = relation ? b : a
      next.get(from)!.add(to)
      indegree.set(to, indegree.get(to)! + 1)
    }
  }
  const ready = ids.filter((id) => indegree.get(id) === 0)
  const ordered: string[] = []
  while (ready.length) {
    const id = ready.shift()!
    ordered.push(id)
    for (const to of next.get(id)!) {
      indegree.set(to, indegree.get(to)! - 1)
      if (indegree.get(to) === 0) ready.push(to)
    }
  }
  return ordered.length === ids.length ? ordered : null
}

export function reconcileProjectDocuments(
  base: ProjectDocument,
  local: ProjectDocument,
  incoming: ProjectDocument,
  deletedNodeIds: ReadonlySet<string> = new Set()
): ProjectMerge {
  const conflicts: ProjectConflict[] = []
  const conflict = (path: string[], kind: ProjectConflict['kind'], b: ProjectValue,
    l: ProjectValue, r: ProjectValue): ProjectValue => {
    conflicts.push({ path, kind, base: b, local: l, incoming: r })
    return l
  }
  const merge = (b: ProjectValue, l: ProjectValue, r: ProjectValue, path: string[]): ProjectValue => {
    // Entity identity and tombstones are checked even on equal snapshots. An unchanged delayed
    // registration cannot be accepted simply because the latest base no longer knows its ID.
    if (path.length === 1 && entityLists.has(path[0])) {
      const maps = [b, l, r].map(entities)
      if (maps.some((map) => map === null)) return conflict(path, 'identity', b, l, r)
      const [bm, lm, rm] = maps as Map<string, ProjectDocument>[]
      const ids = [...new Set([...lm.keys(), ...rm.keys(), ...bm.keys()])]
      const merged = new Map<string, ProjectJson>()
      for (const id of ids) {
        const values = [bm, lm, rm].map((map) => map.has(id) ? present(map.get(id)!) : missing)
        if (path[0] === 'nodes' && deletedNodeIds.has(id) && (lm.has(id) || rm.has(id))) {
          conflict([...path, id], 'deleted-node', values[0], values[1], values[2])
          continue
        }
        if (!bm.has(id) && lm.has(id) && rm.has(id) && !equal(values[1], values[2])) {
          conflict([...path, id], 'identity', values[0], values[1], values[2])
          merged.set(id, lm.get(id)!)
          continue
        }
        const value = merge(values[0], values[1], values[2], [...path, id])
        if (value.present) merged.set(id, value.value)
      }
      const order = entityOrder([...merged.keys()], [...bm.keys()], [...lm.keys()], [...rm.keys()])
      if (!order) conflict(path, 'order', present([...bm.keys()]), present([...lm.keys()]), present([...rm.keys()]))
      // Absence is meaningful for optional lists, distinct from an explicitly empty array.
      if (merged.size === 0 && !l.present && (!b.present || equal(b, r))) return missing
      if (merged.size === 0 && !r.present && equal(b, l)) return missing
      return present((order ?? [...merged.keys()]).map((id) => merged.get(id)!))
    }
    // Traverse objects BEFORE equality shortcuts so entity tombstones are always examined.
    if (l.present && r.present && isObject(l.value) && isObject(r.value) &&
      (!b.present || isObject(b.value))) {
      const bo = b.present ? b.value as ProjectDocument : {}
      const lo = l.value, ro = r.value
      const keys = [...new Set([...Object.keys(bo), ...Object.keys(lo), ...Object.keys(ro)])]
      const entries: [string, ProjectJson][] = []
      for (const key of keys) {
        const value = merge(field(bo, key), field(lo, key), field(ro, key), [...path, key])
        if (value.present) entries.push([key, value.value])
      }
      // Object.fromEntries keeps a literal __proto__ field as data, never an assignment trap.
      return present(Object.fromEntries(entries))
    }
    if (equal(l, r)) return l
    if (equal(b, l)) return r
    if (equal(b, r)) return l
    return conflict(path, !l.present || !r.present ? 'delete-edit' : 'value', b, l, r)
  }
  const result = merge(present(base), present(local), present(incoming), [])
  // Detach results from mutable caller inputs, including every conflicting alternative.
  return structuredClone({
    kind: conflicts.length ? 'conflict' : 'merged',
    document: result.present ? result.value as ProjectDocument : {},
    conflicts
  })
}

/** Keep original whitespace, unknown fields and partial/invalid input for a recovery writer.
 * Returning these bytes is not a claim that they have been durably stored. */
export function reconcileProjectBytes(
  recovery: ProjectRecoveryBytes, deletedNodeIds?: ReadonlySet<string>
): ProjectByteMerge {
  const parsed: Partial<Record<keyof ProjectRecoveryBytes, ProjectDocument>> = {}
  const invalid: (keyof ProjectRecoveryBytes)[] = []
  for (const side of ['base', 'local', 'incoming'] as const) {
    try {
      const value = JSON.parse(recovery[side]) as ProjectJson
      if (!isObject(value)) throw new Error('Expected a project object')
      parsed[side] = value
    } catch { invalid.push(side) }
  }
  if (invalid.length) return { kind: 'unavailable', invalid, recovery: { ...recovery } }
  return { ...reconcileProjectDocuments(parsed.base!, parsed.local!, parsed.incoming!, deletedNodeIds),
    recovery: { ...recovery } }
}

/** Apply edits from a typed/older view onto the retained raw base before commit planning. A field
 * absent from BOTH views is unknown, not deleted. A field in viewBase but absent from viewLocal
 * is an intentional deletion. This prevents a typed serializer from pruning a newer fork's keys. */
export function applyProjectViewEdits(rawBase: string, viewBase: ProjectDocument,
  viewLocal: ProjectDocument): ProjectByteMerge {
  return reconcileProjectBytes({ base: JSON.stringify(viewBase), local: JSON.stringify(viewLocal), incoming: rawBase })
}
