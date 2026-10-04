// Pure helpers for the remote canvas mirror: turn a host's node snapshot into a
// wire-syncable form and apply mutations. No Electron, no sockets — shared by the
// host broadcast and the client mirror in later tasks.

import type { CanvasMutation, CanvasNodeState, CanvasState } from '@shared/types'
import { applyCanvasMutation } from '@shared/canvas-mutations'

export type { CanvasMutation, CanvasState } from '@shared/types'

// The mutation vocabulary itself lives in `@shared/canvas-mutations` (one implementation for the
// relay host, the renderer and src/core); only the host-authority policy below is local.
export { diffToMutations } from '@shared/canvas-mutations'

/** Back-compat alias: the relay host/client call this `applyMutation`. */
export const applyMutation = applyCanvasMutation

/**
 * R7 — sanitize a CLIENT-supplied mutation before the host applies it.
 *
 * A client may only (a) remove nodes and (b) update the layout/cosmetic fields of nodes the
 * host already has. Everything else stays host-authoritative, because upserted node state has
 * real authority on the host: a terminal node's `shell`/`cwd` feed the PTY spawn when the host
 * renderer mounts it (an approved client could otherwise spawn a shell in a cwd of its choice —
 * reopening the remote `pty.create` that R1 deliberately blocked), `cwd` also WIDENS the remote
 * fs jail (`rootsFromCanvas`), `ssh`/`sshRemoteTmux` retarget spawns at other hosts, and
 * `filePath`/`url` make the host open arbitrary files/pages. Brand-new node ids are rejected
 * outright — the client UI only ever moves/deletes existing nodes.
 *
 * Returns the safe mutation to apply, or null to drop it entirely.
 */
export function sanitizeClientMutation(
  m: CanvasMutation,
  current: CanvasState | null
): CanvasMutation | null {
  if (m.op === 'remove') return typeof m.id === 'string' && m.id &&
    !current?.nodes.find(n => n.id === m.id)?.cleanupArchiveId ? m : null
  if (m.op !== 'upsert' || !m.node || typeof m.node !== 'object') return null
  const incoming = m.node
  const existing = current?.nodes.find((n) => n.id === incoming.id)
  if (!existing) return null // clients may not CREATE nodes
  // Light shape checks on the layout fields so a malformed payload can't wedge React Flow.
  const pos = incoming.position
  const size = incoming.size
  if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) return null
  if (!size || !Number.isFinite(size.width) || !Number.isFinite(size.height)) return null
  const node: CanvasNodeState = {
    ...existing, // kind, shell, cwd, ssh, sshRemoteTmux, sshFs, agentId, filePath, url, worktree, …
    position: { x: pos.x, y: pos.y },
    size: { width: size.width, height: size.height },
    title: typeof incoming.title === 'string' ? incoming.title : existing.title,
    color: typeof incoming.color === 'string' ? incoming.color : existing.color,
    group: incoming.group ?? null,
    tags: incoming.tags,
    collapsed: incoming.collapsed,
    // Full-state semantics: an absent parentId means "ungrouped", so take it verbatim.
    parentId: incoming.parentId,
    text: typeof incoming.text === 'string' ? incoming.text : existing.text
  }
  return { op: 'upsert', node }
}
