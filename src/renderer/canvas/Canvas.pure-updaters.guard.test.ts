import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

/**
 * Guard: a canvas node is minted exactly once per user action, OUTSIDE any state updater.
 *
 * React treats a `setState(fn)` updater as a pure function it may call more than once —
 * notably when it rebases a queued update against a lower-priority update pending in the
 * same queue. `createTerminalNode` and its siblings mint an id from `Date.now()` + random,
 * so calling one inside `setNodes((ns) => …)` can mint TWO different nodes for a single
 * click. That was observed live: a right-click "New terminal" produced twin terminal nodes
 * with ids 12–24 ms apart; the first was committed and mounted (its tmux pane spawned) and
 * was then replaced by the re-applied updater's node, so it vanished with no delete change
 * and therefore no `pty.kill` — one orphaned `bash` pane per creation.
 *
 * The rule this test enforces: build the node (and anything else that mints an id or a
 * token) before `setNodes`, and let the updater only append/replace an already-built node.
 * Pure transforms of existing objects (`parentInto`, layout helpers, `ns.map`) stay allowed.
 */
const CANVAS = path.resolve(__dirname, 'Canvas.tsx')

/** Calls that mint fresh identity and therefore must never run inside an updater. */
const MINTING_CALL = /\b(create[A-Za-z]*Node|nextId)\s*\(/g

/**
 * Blank out comments and string/template/regex literal CONTENT (keeping length and
 * newlines) so the bracket scan below never trips over a `)` or a quote inside text.
 */
function maskLiterals(src: string): string {
  const out = src.split('')
  const blank = (from: number, to: number) => {
    for (let k = from; k < to && k < out.length; k++) if (out[k] !== '\n') out[k] = ' '
  }
  // Context stack: a template literal, or a `${…}` interpolation inside one (real code).
  const stack: Array<{ kind: 'tpl' } | { kind: 'expr'; depth: number }> = []
  // Last significant character; if it cannot END an expression, a `/` starts a regex literal.
  let prev = ''
  let i = 0
  while (i < src.length) {
    const top = stack[stack.length - 1]
    const c = src[i]
    const next = src[i + 1]
    if (top && top.kind === 'tpl') {
      if (c === '\\') {
        blank(i, i + 2)
        i += 2
      } else if (c === '`') {
        stack.pop()
        prev = '`'
        i++
      } else if (c === '$' && next === '{') {
        stack.push({ kind: 'expr', depth: 0 })
        prev = '{'
        i += 2
      } else {
        if (c !== '\n') out[i] = ' '
        i++
      }
      continue
    }
    if (c === '/' && next === '/') {
      const end = src.indexOf('\n', i)
      const stop = end === -1 ? src.length : end
      blank(i, stop)
      i = stop
      continue
    }
    if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2)
      const stop = end === -1 ? src.length : end + 2
      blank(i, stop)
      i = stop
      continue
    }
    if (c === '`') {
      stack.push({ kind: 'tpl' })
      i++
      continue
    }
    if (c === '"' || c === "'") {
      let j = i + 1
      while (j < src.length && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1
      blank(i + 1, j)
      i = src[j] === c ? j + 1 : j
      prev = c
      continue
    }
    // A `/` that cannot be division and is not JSX (`</tag>`) opens a regex literal.
    if (c === '/' && prev && !/[)\]}A-Za-z0-9_$<>]/.test(prev)) {
      let j = i + 1
      let inClass = false
      for (; j < src.length && src[j] !== '\n'; j++) {
        if (src[j] === '\\') j++
        else if (src[j] === '[') inClass = true
        else if (src[j] === ']') inClass = false
        else if (src[j] === '/' && !inClass) break
      }
      if (src[j] === '/') {
        blank(i + 1, j)
        i = j + 1
        prev = '/'
        continue
      }
    }
    if (top && top.kind === 'expr') {
      if (c === '{') top.depth++
      else if (c === '}') {
        if (top.depth === 0) {
          stack.pop()
          prev = '}'
          i++
          continue
        }
        top.depth--
      }
    }
    if (!/\s/.test(c)) prev = c
    i++
  }
  return out.join('')
}

/** Offsets of every `setNodes(` callback body, as [openParen, matchingCloseParen). */
function updaterSpans(masked: string): Array<[number, number]> {
  const spans: Array<[number, number]> = []
  const call = /\bsetNodes\s*\(/g
  let m: RegExpExecArray | null
  while ((m = call.exec(masked))) {
    const open = m.index + m[0].length - 1
    let depth = 0
    for (let i = open; i < masked.length; i++) {
      const c = masked[i]
      if (c === '(' || c === '[' || c === '{') depth++
      else if (c === ')' || c === ']' || c === '}') {
        depth--
        if (depth === 0) {
          spans.push([open, i])
          break
        }
      }
    }
  }
  return spans
}

/** Every minting call that sits lexically inside a `setNodes(...)` callback. */
export function mintingInsideUpdaters(source: string): string[] {
  const masked = maskLiterals(source)
  const spans = updaterSpans(masked)
  const lineOf = (offset: number) => source.slice(0, offset).split('\n').length
  const hits: string[] = []
  let m: RegExpExecArray | null
  MINTING_CALL.lastIndex = 0
  while ((m = MINTING_CALL.exec(masked))) {
    const at = m.index
    if (spans.some(([open, close]) => at > open && at < close)) {
      hits.push(`Canvas.tsx:${lineOf(at)} ${m[1]}(`)
    }
  }
  return hits
}

const HOWTO =
  'Compute the index from `nodesRef.current.length`, build the node BEFORE `setNodes`, and ' +
  'let the updater only append or replace it: `setNodes((ns) => [...ns, node])`. Pure ' +
  'transforms of an already-built node (parentInto, layout helpers) may stay inside.'

describe('Canvas state updaters are pure', () => {
  it('mints no node id inside a setNodes() callback', () => {
    const hits = mintingInsideUpdaters(fs.readFileSync(CANVAS, 'utf8'))
    expect(hits, `Node minted inside a React state updater. ${HOWTO}\n${hits.join('\n')}`).toEqual(
      []
    )
  })
})
