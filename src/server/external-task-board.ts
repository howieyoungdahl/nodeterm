import { readFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { isSafeNodeId } from '../shared/safe-id'
import type { ExternalTask, ExternalTaskBoard } from '../shared/external-task-board'

interface BoardConfig {
  url: string
  feed: string
  tokenFile: string
}
interface Feed {
  asOf: string
  cards: ExternalTask[]
}
const bounded = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= max
const optional = (v: unknown, max: number) => v === null || bounded(v, max)
function validCard(c: ExternalTask) {
  return (
    c &&
    isSafeNodeId(c.nodeId) &&
    bounded(c.task, 100) &&
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

/** Only the operator's server config can supply a destination or a credential path. */
export function createExternalTaskBoard(
  dataDir: string,
  nodesFor: (projectId: string) => Set<string> | null,
  fetchFeed: typeof fetch = fetch
) {
  const cache = new Map<string, { signature: string; until: number; feed: Promise<ExternalTask[]> }>()
  async function load(config: BoardConfig): Promise<ExternalTask[]> {
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
    return feed.cards.filter(card => !ambiguous.has(card.nodeId))
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
    try {
      const ids = nodesFor(projectId)
      if (!ids) return null
      const signature = JSON.stringify(config)
      let entry = cache.get(projectId)
      if (!entry || entry.signature !== signature || Date.now() >= entry.until) {
        entry = { signature, until: Date.now() + 15000, feed: load(config) }
        cache.set(projectId, entry)
      }
      const cards = (await entry.feed)
        .filter((card) => ids.has(card.nodeId))
        .map((c) => ({
          nodeId: c.nodeId,
          task: c.task,
          workflow: c.workflow,
          stage: c.stage,
          urgency: c.urgency,
          urgent: c.urgent,
          reason: c.reason,
          priority: c.priority
        }))
      return { url: config.url, available: true, cards }
    } catch {
      return { url: config.url, available: false, cards: [] }
    }
  }
}
