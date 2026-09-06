import type { ProjectDocument } from './project-reconciliation'

/** Fields this renderer can actually serialize. Unknown entity fields stay exclusively in the
 * retained raw document; absence from a lossy React Flow view is never an intentional deletion.
 * The acceptance test round-trips the real Flow serializer to guard this boundary. */
export const projectNodeViewKeys = new Set([
  'id', 'kind', 'position', 'size', 'title', 'titleAuto', 'color', 'group', 'tags', 'collapsed',
  'hideFanout', 'icon', 'parentId', 'shell', 'cwd', 'text', 'textUpdatedAt', 'textUpdatedBy',
  'filePath', 'fileMissing', 'url', 'partition', 'diffStaged', 'commitOid', 'highScore', 'agentId',
  'agentModel', 'accountId', 'agentSessionId', 'pendingLaunch', 'ssh', 'sshRemoteTmux', 'sshFs',
  'worktree', 'trigger', 'premaxRect', 'controlSize', 'role', 'taskSummary', 'taskFrame',
  'pinned', 'manualPlacement', 'compactRect', 'appearance'
])
export function projectEntityView(document: ProjectDocument): ProjectDocument {
  const result = { ...document }
  for (const key of ['nodes', 'bridges', 'ropes']) {
    const values = result[key]
    if (!Array.isArray(values)) continue
    const keys = key === 'nodes' ? projectNodeViewKeys : new Set(['id', 'source', 'target'])
    result[key] = values.map((value) => value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).filter(([key]) => keys.has(key))) : value)
  }
  return result
}
