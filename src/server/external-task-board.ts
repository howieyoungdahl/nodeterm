import { constants } from 'node:fs'
import { open, readFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { isSafeNodeId, NODE_ID_MAX } from '../shared/safe-id'
import type { ExternalTask, ExternalTaskBoard, ExternalTaskColumns } from '../shared/external-task-board'

interface NodePointer {
  nodeIdFile: string
  nodeIdField?: string
}
interface BoardConfig {
  url: string
  feed: string
  tokenFile: string
  featuredSession?: NodePointer & { label: string }
  backgroundSessions?: NodePointer[]
}
interface Feed extends Partial<ExternalTaskColumns> {
  asOf: string
  linkPage?: string
  cards: ExternalTask[]
}
const bounded = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= max
const optional = (v: unknown, max: number) => v === null || bounded(v, max)
const validNames = (names: unknown): names is string[] =>
  Array.isArray(names) && names.length > 0 && names.length <= 100 && names.every(name => bounded(name, 160))
function validCard(c: ExternalTask) {
  return (
    c &&
    isSafeNodeId(c.nodeId) &&
    bounded(c.task, 100) &&
    (c.displayName === undefined || optional(c.displayName, 240)) &&
    (c.taskTitle === undefined || optional(c.taskTitle, 500)) &&
    bounded(c.stage, 100) &&
    optional(c.workflow, 160) &&
    optional(c.urgency, 100) &&
    (c.urgent === undefined || typeof c.urgent === 'boolean') &&
    optional(c.reason, 1000) &&
    optional(c.priority, 100)
  )
}
function secureUrl(value: string) {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Invalid task board URL')
  return url
}

/** Resolve a host-published identity against this project's terminals before exposing it. */
async function readProjectNode(pointer: NodePointer, nodes: Set<string>): Promise<string | null> {
  if (!pointer || !bounded(pointer.nodeIdFile, 4096) || !isAbsolute(pointer.nodeIdFile)) return null
  const field = pointer.nodeIdField
  if (field !== undefined && !bounded(field, 64)) return null
  const limit = field ? 4096 : NODE_ID_MAX + 2
  try {
    const file = await open(pointer.nodeIdFile, constants.O_RDONLY | constants.O_NONBLOCK)
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.size > limit) return null
      const bytes = Buffer.alloc(limit + 1)
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
      if (bytesRead > limit) return null
      const value = bytes.toString('utf8', 0, bytesRead).trim()
      let id: unknown = value
      if (field) {
        const record = JSON.parse(value)
        if (!record || typeof record !== 'object' || Array.isArray(record) || !Object.hasOwn(record, field)) return null
        id = record[field]
      }
      return typeof id === 'string' && isSafeNodeId(id) && nodes.has(id) ? id : null
    } finally {
      await file.close()
    }
  } catch {
    return null
  }
}

async function readSessionRoles(config: BoardConfig, nodes: Set<string>) {
  const featured = config.featuredSession
  const featuredSession = featured && bounded(featured.label, 80) && bounded(featured.nodeIdFile, 4096) && isAbsolute(featured.nodeIdFile)
    ? { label: featured.label, nodeId: await readProjectNode(featured, nodes) } : undefined
  const pointers = config.backgroundSessions
  if (!Array.isArray(pointers) || pointers.length > 32) return { featuredSession }
  const ids = await Promise.all(pointers.map(pointer => readProjectNode(pointer, nodes)))
  const verified = ids.filter((id): id is string => id !== null && id !== featuredSession?.nodeId)
  return { featuredSession, backgroundNodeIds: [...new Set(verified)] }
}

/** Only the operator's server config can supply a destination or a credential path. */
export function createExternalTaskBoard(
  dataDir: string,
  nodesFor: (projectId: string) => Set<string> | null,
  fetchFeed: typeof fetch = fetch
) {
  type Snapshot = Pick<ExternalTaskBoard, 'cards' | 'columns' | 'linkPage'>
  const cache = new Map<string, { signature: string; until: number; feed: Promise<Snapshot> }>()
  async function load(config: BoardConfig): Promise<Snapshot> {
    const endpoint = secureUrl(config.feed)
    if (endpoint.origin !== secureUrl(config.url).origin || !isAbsolute(config.tokenFile))
      throw new Error('Invalid task board feed')
    endpoint.searchParams.set('host', hostname())
    const token = (await readFile(config.tokenFile, 'utf8')).trim()
    if (!bounded(token, 4096)) throw new Error('Invalid task board credential')
    const response = await fetchFeed(endpoint, {
      headers: { Authorization: 'Bearer ' + token },
      redirect: 'error',
      signal: AbortSignal.timeout(5000)
    })
    if (!response.ok) throw new Error('Task board unavailable')
    const feed = (await response.json()) as Feed
    const age = Date.now() - Date.parse(feed.asOf)
    if (
      !Number.isFinite(age) ||
      age < -5000 ||
      age > 120000 ||
      !Array.isArray(feed.cards) ||
      feed.cards.length > 10000 ||
      !feed.cards.every(validCard)
    )
      throw new Error('Invalid task board snapshot')
    const seen = new Set<string>()
    const ambiguous = new Set<string>()
    for (const card of feed.cards) {
      if (seen.has(card.nodeId)) ambiguous.add(card.nodeId)
      seen.add(card.nodeId)
    }
    const cards = feed.cards.filter(card => !ambiguous.has(card.nodeId))
    const snapshot: Snapshot = { cards }
    if (validNames(feed.workflows) && validNames(feed.stages))
      snapshot.columns = { workflows: [...new Set(feed.workflows)], stages: [...new Set(feed.stages)] }
    if (bounded(feed.linkPage, 512) && /^\/[a-zA-Z0-9/_-]+$/.test(feed.linkPage) && !feed.linkPage.startsWith('//')) {
      const page = new URL(feed.linkPage, endpoint.origin)
      page.searchParams.set('host', hostname())
      snapshot.linkPage = page.toString()
    }
    return snapshot
  }
  return async function read(projectId: string): Promise<ExternalTaskBoard | null> {
    if (!isSafeNodeId(projectId)) return null
    let config: BoardConfig
    try {
      const configs = JSON.parse(await readFile(join(dataDir, 'external-task-boards.json'), 'utf8'))
      if (!Object.hasOwn(configs, projectId)) return null
      config = configs[projectId]
      secureUrl(config.url)
    } catch {
      return null
    }
    let roles: Pick<ExternalTaskBoard, 'featuredSession' | 'backgroundNodeIds'> = {}
    try {
      const ids = nodesFor(projectId)
      if (!ids) return null
      roles = await readSessionRoles(config, ids)
      const signature = JSON.stringify(config)
      let entry = cache.get(projectId)
      if (!entry || entry.signature !== signature || Date.now() >= entry.until) {
        entry = { signature, until: Date.now() + 15000, feed: load(config) }
        cache.set(projectId, entry)
      }
      const snapshot = await entry.feed
      const cards = snapshot.cards
        .filter((card) => ids.has(card.nodeId))
        .map((c) => ({
          nodeId: c.nodeId,
          task: c.task,
          ...(c.manual === true ? { manual: true } : {}),
          ...(c.displayName ? { displayName: c.displayName } : {}),
          ...(c.taskTitle ? { taskTitle: c.taskTitle } : {}),
          workflow: c.workflow,
          stage: c.stage,
          urgency: c.urgency,
          urgent: c.urgent,
          reason: c.reason,
          priority: c.priority
        }))
      return { ...snapshot, url: config.url, available: true, cards, ...roles }
    } catch {
      return { url: config.url, available: false, cards: [], ...roles }
    }
  }
}
