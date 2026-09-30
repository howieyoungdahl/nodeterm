import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { conversationBlocksFromRecord } from './context-link-render'
import type { OperatorConversationItem, OperatorConversationPage, OperatorSessionTarget } from '../shared/operator-conversations'

const MAX_FILE_BYTES = 256 * 1024 * 1024
const MAX_RECORD_BYTES = 1024 * 1024
const MAX_ITEMS = 200_000
const MAX_ITEM_CHARS = 12_000
const MAX_SNAPSHOT_TEXT_BYTES = 96 * 1024 * 1024
const MAX_PAGE_BYTES = 128 * 1024
const MAX_PAGE_ITEMS = 200
const MAX_SNAPSHOTS = 128
const MAX_CACHED_TEXT_BYTES = 128 * 1024 * 1024
const MAX_CACHED_ITEMS = 300_000
const cursorKey = randomBytes(32)
type Snapshot = { target: OperatorSessionTarget; agentId: string; path: string; dev: number; ino: number; size: number; digest: string; redactionKey: string; textBytes: number; items: OperatorConversationItem[] }
const snapshots = new Map<string, Snapshot>()
let cachedTextBytes = 0
let cachedItems = 0

function dropSnapshot(id: string): void {
  const old = snapshots.get(id)
  if (old) { cachedTextBytes -= old.textBytes; cachedItems -= old.items.length; snapshots.delete(id) }
}

export class OperatorConversationError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); this.name = 'OperatorConversationError' }
}

function fail(code: string, status: number): never { throw new OperatorConversationError(code, status) }
function targetKey(t: OperatorSessionTarget): string { return JSON.stringify([t.projectId, t.nodeId, t.sessionId, t.generation]) }
function redactEnvAssignments(s: string): string {
  const edits: Array<{ start: number; end: number; replacement: string }> = []
  const keys = /\b[A-Z][A-Z0-9_]*\b/g
  for (const match of s.matchAll(keys)) {
    const key = match[0]
    if (!/(?:TOKEN|KEY|SECRET|PASSWORD)$/.test(key)) continue
    const start = match.index! + key.length
    const assignment = /^(\s*["']?\s*[:=]\s*)(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,;}]+)/.exec(s.slice(start))
    if (assignment) edits.push({ start: match.index!, end: start + assignment[0].length, replacement: `${key}=[REDACTED]` })
  }
  if (!edits.length) return s
  let result = ''
  let cursor = 0
  for (const edit of edits) {
    result += s.slice(cursor, edit.start) + edit.replacement
    cursor = edit.end
  }
  return result + s.slice(cursor)
}
function redactionKey(secrets: readonly string[]): string {
  return createHmac('sha256', cursorKey).update(JSON.stringify([...new Set(secrets)].sort())).digest('hex')
}
function redacted(s: string, secrets: readonly string[]): string {
  // Mask known current credentials BEFORE chunking, including those crossing a page boundary.
  for (const secret of secrets) if (secret) s = s.split(secret).join('[REDACTED CREDENTIAL]')
  return redactEnvAssignments(s)
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]')
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*$/g, '[REDACTED INCOMPLETE PRIVATE KEY]')
    .replace(/\b((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|https?|wss?):\/\/)[^/\s:@]+:[^/@\s]*@/gi, '$1[REDACTED]@')
    .replace(/\b(?:set-cookie|cookie)\s*:\s*[^\r\n]+/gi, (m) => `${m.slice(0, m.indexOf(':'))}: [REDACTED]`)
    .replace(/(["']?)(?:(?:__Host-|__Secure-)?session(?:[_-]?(?:id|token))?|sid|connect\.sid|auth(?:entication)?(?:token)?|jwt|next-auth\.session-token)\1\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;}]+)/gi, '[REDACTED SESSION TOKEN]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|AKIA[A-Z0-9]{16})\b/g, '[REDACTED KEY]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED JWT]')
    .replace(/\b[A-Za-z0-9+/_-]{48,}={0,2}/g, '[REDACTED LONG TOKEN]')
    .replace(/(["']?)(password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|secret)\1\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;}]+)/gi, '$2=[REDACTED]')
}
function encodeCursor(id: string, index: number, target: OperatorSessionTarget): string {
  const body = Buffer.from(JSON.stringify({ id, index, target: targetKey(target) })).toString('base64url')
  return `${body}.${createHmac('sha256', cursorKey).update(body).digest('base64url')}`
}
function decodeCursor(cursor: string, target: OperatorSessionTarget): { id: string; index: number } {
  if (cursor.length > 2048) fail('invalid_cursor', 400)
  const [body, mac, extra] = cursor.split('.')
  if (!body || !mac || extra) fail('invalid_cursor', 400)
  const expected = createHmac('sha256', cursorKey).update(body).digest()
  let got: Buffer
  try { got = Buffer.from(mac, 'base64url') } catch { fail('invalid_cursor', 400) }
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) fail('invalid_cursor', 400)
  try {
    const value = JSON.parse(Buffer.from(body, 'base64url').toString())
    if (typeof value.id !== 'string' || !Number.isInteger(value.index) || value.index < 0 || value.target !== targetKey(target)) fail('invalid_cursor', 400)
    return value
  } catch (e) { if (e instanceof OperatorConversationError) throw e; fail('invalid_cursor', 400) }
}

async function readSnapshot(filePath: string, target: OperatorSessionTarget, agentId: string, secrets: readonly string[]): Promise<Snapshot> {
  if (agentId !== 'claude' && agentId !== 'codex') fail('unsupported_provider', 422)
  const canonicalPath = await requireCanonicalFile(filePath)
  let fd: fs.promises.FileHandle
  try { fd = await fs.promises.open(canonicalPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)) } catch { fail('transcript_unavailable', 404) }
  try {
    const stat = await fd.stat()
    if (stat.size > MAX_FILE_BYTES) fail('transcript_too_large', 413)
    const digest = createHmac('sha256', cursorKey)
    const items: OperatorConversationItem[] = []
    let outputBytes = 0
    let identity: string | undefined
    const decoder = new StringDecoder('utf8')
    let carry = ''
    let readBytes = 0
    const consume = (raw: string) => {
      if (!raw.trim()) return
      if (Buffer.byteLength(raw) > MAX_RECORD_BYTES) fail('transcript_record_too_large', 413)
      try { JSON.parse(raw) } catch { fail('invalid_transcript', 409) }
      const blocks = conversationBlocksFromRecord(agentId, raw)
      for (const block of blocks) {
        if (block.sessionId) {
          if (identity && identity !== block.sessionId) fail('session_mismatch', 409)
          identity = block.sessionId
        }
        if (block.identityOnly || !block.text) continue
        const text = redacted(block.text, secrets)
        outputBytes += Buffer.byteLength(text)
        if (outputBytes > MAX_SNAPSHOT_TEXT_BYTES) fail('transcript_too_large', 413)
        for (let start = 0; start < text.length;) {
          let end = Math.min(start + MAX_ITEM_CHARS, text.length)
          if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end--
          const chunk = text.slice(start, end)
          items.push({ id: `${items.length}`, sequence: items.length, timestamp: block.timestamp, kind: block.kind, text: chunk, provenance: { source: 'transcript', agentId, submitted: true } })
          if (items.length > MAX_ITEMS) fail('transcript_too_large', 413)
          start = end
        }
      }
    }
    // Stream the complete bounded snapshot. The cap rejects oversized inputs; it never returns
    // a silent tail or a partial transcript as if it were complete.
    const buffer = Buffer.alloc(64 * 1024)
    while (readBytes < stat.size) {
      const { bytesRead } = await fd.read(buffer, 0, Math.min(buffer.length, stat.size - readBytes), readBytes)
      if (!bytesRead) fail('transcript_changed', 409)
      const b = buffer.subarray(0, bytesRead)
      readBytes += bytesRead
      digest.update(b)
      const text = carry + decoder.write(b)
      const lines = text.split('\n')
      carry = lines.pop() ?? ''
      if (Buffer.byteLength(carry) > MAX_RECORD_BYTES) fail('transcript_record_too_large', 413)
      for (const raw of lines) consume(raw.replace(/\r$/, ''))
    }
    carry += decoder.end()
    if (carry) consume(carry.replace(/\r$/, ''))
    const after = await fd.stat()
    if (readBytes !== stat.size || after.dev !== stat.dev || after.ino !== stat.ino || after.size < stat.size) fail('transcript_changed', 409)
    if (identity !== target.sessionId) fail('session_mismatch', 409)
    return { target: { ...target }, agentId, path: canonicalPath, dev: stat.dev, ino: stat.ino, size: stat.size, digest: digest.digest('hex'), redactionKey: redactionKey(secrets), textBytes: outputBytes, items }
  } finally { await fd.close() }
}

async function prefixUnchanged(snapshot: Snapshot): Promise<boolean> {
  let fd: fs.promises.FileHandle
  try {
    const canonical = await requireCanonicalFile(snapshot.path)
    if (canonical !== snapshot.path) return false
    fd = await fs.promises.open(canonical, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
  } catch { return false }
  try {
    const stat = await fd.stat()
    if (stat.dev !== snapshot.dev || stat.ino !== snapshot.ino || stat.size < snapshot.size) return false
    const h = createHmac('sha256', cursorKey)
    let pos = 0
    const buf = Buffer.alloc(64 * 1024)
    while (pos < snapshot.size) {
      const { bytesRead } = await fd.read(buf, 0, Math.min(buf.length, snapshot.size - pos), pos)
      if (!bytesRead) return false
      h.update(buf.subarray(0, bytesRead)); pos += bytesRead
    }
    return h.digest('hex') === snapshot.digest
  } catch { return false } finally { await fd.close() }
}

async function requireCanonicalFile(filePath: string): Promise<string> {
  const absolute = path.resolve(filePath)
  let canonical: string
  try { canonical = await fs.promises.realpath(absolute) } catch { fail('transcript_unavailable', 404) }
  if (canonical !== absolute) fail('unsafe_transcript_path', 403)
  try {
    const stat = await fs.promises.lstat(absolute)
    if (stat.isSymbolicLink() || !stat.isFile()) fail('unsafe_transcript_path', 403)
  } catch (e) { if (e instanceof OperatorConversationError) throw e; fail('transcript_unavailable', 404) }
  return canonical
}

/**
 * Reads only submitted transcript content. Terminal scrollback suggestions are not submitted
 * evidence and are intentionally absent. `transcriptPath` must come from the trusted server
 * resolver, never directly from a request body.
 */
export async function readOperatorConversation(
  target: OperatorSessionTarget, agentId: string, transcriptPath: string, cursor: string | undefined, limit: number,
  secrets: readonly string[] = []
): Promise<OperatorConversationPage> {
  if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_LIMIT) fail('invalid_limit', 400)
  let id: string, index = 0, snapshot: Snapshot
  if (cursor) {
    const decoded = decodeCursor(cursor, target); id = decoded.id; index = decoded.index
    snapshot = snapshots.get(id)!
    if (!snapshot || targetKey(snapshot.target) !== targetKey(target) || snapshot.agentId !== agentId || snapshot.redactionKey !== redactionKey(secrets) || path.resolve(transcriptPath) !== snapshot.path) fail('invalid_cursor', 400)
    if (!(await prefixUnchanged(snapshot))) { dropSnapshot(id); fail('transcript_changed', 409) }
  } else {
    snapshot = await readSnapshot(transcriptPath, target, agentId, secrets)
    id = randomBytes(18).toString('base64url')
    while (snapshots.size && (snapshots.size >= MAX_SNAPSHOTS || cachedTextBytes + snapshot.textBytes > MAX_CACHED_TEXT_BYTES || cachedItems + snapshot.items.length > MAX_CACHED_ITEMS)) {
      dropSnapshot(snapshots.keys().next().value!)
    }
    snapshots.set(id, snapshot)
    cachedTextBytes += snapshot.textBytes
    cachedItems += snapshot.items.length
  }
  if (index > snapshot.items.length) fail('invalid_cursor', 400)
  const items: OperatorConversationItem[] = []
  let bytes = 0
  for (const item of snapshot.items.slice(index, index + Math.min(limit, MAX_PAGE_ITEMS))) {
    const size = Buffer.byteLength(item.text)
    if (items.length && bytes + size > MAX_PAGE_BYTES) break
    items.push(item); bytes += size
  }
  const next = index + items.length
  return { version: 1, target: { ...target }, items, nextCursor: next < snapshot.items.length ? encodeCursor(id, next, target) : null }
}

const PAGE_LIMIT = 200
