const queries = new Map<string, number>([
  ['\x1b[c', 0], ['\x1b[0c', 0],
  ['\x1b[>c', 1], ['\x1b[>0c', 1],
  ['\x1b[>q', 2], ['\x1b[>0q', 2],
  ['\x1b]10;?\x07', 3], ['\x1b]10;?\x1b\\', 3],
  ['\x1b]11;?\x07', 4], ['\x1b]11;?\x1b\\', 4]
])
const queryPattern = /\x1b(?:\[(?:0?c|>0?[cq])|\]1[01];\?(?:\x07|\x1b\\))/g
const queryPrefixes = new Set(
  [...queries.keys()].flatMap((query) =>
    Array.from({ length: query.length - 1 }, (_, length) => query.slice(0, length + 1))
  )
)
const longestPrefix = Math.max(...[...queryPrefixes].map((prefix) => prefix.length))

// Match complete xterm onData replies only. CPR is also used by modified F3.
const replyPatterns = [
  /^\x1b\[\?[\d;]*c(?![\s\S])/,
  /^\x1b\[>[\d;]*c(?![\s\S])/,
  /^\x1bP>\|[^\x1b]*\x1b\\(?![\s\S])/,
  /^\x1b\]10;rgb:[\da-fA-F/]+(?:\x07|\x1b\\)(?![\s\S])/,
  /^\x1b\]11;rgb:[\da-fA-F/]+(?:\x07|\x1b\\)(?![\s\S])/
]

/** One allowance per query emitted by this pty, shared by all its viewers. */
export class TerminalReplies {
  private readonly pending = replyPatterns.map(() => 0)
  private carry = ''

  observe(data: string): void {
    const output = this.carry + data
    let consumed = 0
    for (const match of output.matchAll(queryPattern)) {
      this.pending[queries.get(match[0])!]++
      consumed = match.index + match[0].length
    }

    this.carry = ''
    // Keep only an unfinished query. Bytes in a complete query, including its ST,
    // cannot be the start of a new query in the next chunk.
    for (let length = Math.min(longestPrefix, output.length - consumed); length > 0; length--) {
      const suffix = output.slice(-length)
      if (!queryPrefixes.has(suffix)) continue
      this.carry = suffix
      break
    }
  }

  static allow(data: string, replies?: TerminalReplies): boolean {
    const kind = replyPatterns.findIndex((pattern) => pattern.test(data))
    if (kind === -1) return true
    if (!replies || replies.pending[kind] === 0) return false
    replies.pending[kind]--
    return true
  }
}
