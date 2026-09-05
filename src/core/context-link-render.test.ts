// Parser tests for the context-link transcript renderers.
//
// FIXTURE PROVENANCE — `__fixtures__/grok/chat_history.jsonl` is REAL. It was cut from a live grok
// 1.0.13 session (576 messages, a logged-in account) on 2026-09-01: 21 lines chosen to cover all
// eight line shapes that session contains, with home paths, usernames and session UUIDs redacted
// and long text truncated. NO KEY WAS ALTERED and no line was authored by hand — except one
// deliberately truncated JSON line, added to exercise the malformed-line counter.
//
// It is real for a reason this project paid for: in task03 the grok hook tests asserted against
// payloads WE had written from grok's shipped docs, so they pinned our reading of the documentation
// instead of the agent's behaviour, and a feature that was dead on every real payload stayed green
// through TDD, an independent review and a QA sign-off. A fixture the agent produced cannot agree
// with us out of politeness.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import path from 'path'
import {
  TRANSCRIPT_DEFAULT_LINES,
  linesFromGrok,
  parseTranscriptCount,
  renderContextLink,
  renderFullTranscript,
  renderTranscriptLines
} from './context-link-render'
import type { LinkDoc, LinkDocEntry } from './context-link-core'

const buf = readFileSync(path.join(__dirname, '__fixtures__/grok/chat_history.jsonl'), 'utf8')

describe('linesFromGrok over a real chat_history.jsonl', () => {
  it('renders user prompts and assistant text in file order', () => {
    const lines = linesFromGrok(buf)
    expect(lines.length).toBeGreaterThan(0)
    expect(lines.some((l) => l.startsWith('user: '))).toBe(true)
    expect(lines.some((l) => l.startsWith('assistant: '))).toBe(true)
    // Order is the file's own: the first rendered line comes from the first renderable record.
    const firstRenderable = buf
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l) as { type?: string }
        } catch {
          return undefined
        }
      })
      .find((o) => o && (o.type === 'user' || o.type === 'assistant' || o.type === 'system'))
    expect(firstRenderable).toBeDefined()
    expect(lines[0].startsWith(`${firstRenderable!.type === 'assistant' ? 'assistant' : firstRenderable!.type}: `)).toBe(
      true
    )
  })

  it('reads `content` in BOTH shapes: a bare string and an array of parts carrying `.text`', () => {
    const arrayLine = buf
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l) as { type?: string; content?: unknown }
        } catch {
          return undefined
        }
      })
      .find((o) => o && Array.isArray(o.content))
    expect(arrayLine, 'the fixture must contain an array-content line or this test proves nothing').toBeDefined()
    const text = (arrayLine!.content as { text?: string }[])[0].text!.slice(0, 24)
    expect(linesFromGrok(buf).some((l) => l.includes(text))).toBe(true)
  })

  it('never attributes harness-injected text to the human', () => {
    // grok files these under `type: 'user'` and marks them with `synthetic_reason`. Measured
    // vocabulary across every local session: system_reminder, compaction_meta,
    // project_instructions, task_completed — 60 lines, all of them `user`, none of them typed by
    // a person. This reader feeds context-link and transfer, so "the other agent's user said X"
    // has to mean a human said X.
    const lines = linesFromGrok(buf)
    expect(lines.some((l) => l.startsWith('user: <system-reminder>'))).toBe(false)
    expect(lines.some((l) => l.includes('<system-reminder>') && l.startsWith('user: '))).toBe(false)
  })

  it('labels each injected line with its own reason, including one it has never seen', () => {
    const lines = linesFromGrok(buf)
    for (const reason of ['system_reminder', 'compaction_meta', 'project_instructions', 'task_completed']) {
      expect(lines.some((l) => l.startsWith(`${reason}: `)), `no line rendered for ${reason}`).toBe(true)
    }
    // The rule is "carries synthetic_reason ⇒ not the human", not a table of the four values we
    // happened to observe: an unmeasured future reason must still not land on `user`.
    const future = JSON.stringify({ type: 'user', content: 'x', synthetic_reason: 'not_yet_invented' })
    expect(linesFromGrok(future)).toEqual(['not_yet_invented: x'])
  })

  it('renders tool calls and tool results, distinctly from prose', () => {
    const lines = linesFromGrok(buf)
    expect(lines.some((l) => l.startsWith('  $ '))).toBe(true)
    expect(lines.some((l) => l.startsWith('  = '))).toBe(true)
  })

  it('renders a backend tool call (web search) by its query', () => {
    expect(linesFromGrok(buf).some((l) => l.startsWith('  $ web_search'))).toBe(true)
  })

  it('never emits the encrypted reasoning payload', () => {
    expect(buf).toContain('encrypted_content')
    expect(linesFromGrok(buf).join('\n')).not.toContain('encrypted_content')
  })

  it('counts malformed lines instead of dropping them silently', () => {
    expect(linesFromGrok.skipped(buf)).toBe(1)
    // A malformed line must not cost the lines around it.
    expect(linesFromGrok(buf).length).toBeGreaterThan(5)
  })

  it('is routed by agent id, with no call-site comparison', () => {
    expect(renderTranscriptLines('grok', buf)).toEqual(linesFromGrok(buf))
  })
})

// ── The `transcript` cap ─────────────────────────────────────────────────────────────────────────
// `transcript` used to return the WHOLE conversation. Nothing was leaking — it is a pull, and the
// document is chosen by the requester's own node id — but an unbounded on-demand read is the exact
// opposite of "start with compact metadata and retrieve evidence on demand"
// (docs/remote-session-scoping.md). These pin the three things that make a cap safe: the bound, the
// override, and that the notice fires ONLY when something was really dropped.
const NODE: LinkDocEntry = { id: 'n1', title: 'Worker', agent: 'claude' } as LinkDocEntry
const many = (n: number): string[] => Array.from({ length: n }, (_, i) => `line ${i + 1}`)

describe('renderFullTranscript cap', () => {
  it('renders a short transcript unchanged — header, every line, and NO notice', () => {
    const out = renderFullTranscript(NODE, many(3))
    expect(out).toBe('=== Worker — full transcript (3 lines) ===\nline 1\nline 2\nline 3')
    expect(out).not.toContain('omitted')
  })

  it('emits nothing extra at exactly the cap (the boundary is not off by one)', () => {
    const out = renderFullTranscript(NODE, many(TRANSCRIPT_DEFAULT_LINES))
    expect(out).not.toContain('omitted')
    expect(out.split('\n')).toHaveLength(TRANSCRIPT_DEFAULT_LINES + 1) // + the header
  })

  it('keeps the LAST lines and says how many it dropped and how to get them', () => {
    const out = renderFullTranscript(NODE, many(TRANSCRIPT_DEFAULT_LINES + 25))
    // The tail is what a linked reader needs: what the node has been doing lately.
    expect(out).toContain(`line ${TRANSCRIPT_DEFAULT_LINES + 25}`)
    expect(out).not.toContain('\nline 1\n')
    // The truncation is VISIBLE, counts what it dropped, and names the exact flag to undo itself.
    expect(out).toContain(`… 25 earlier lines omitted (showing the last ${TRANSCRIPT_DEFAULT_LINES})`)
    expect(out).toContain(`re-run with -n ${TRANSCRIPT_DEFAULT_LINES + 25}`)
    // The full length is still stated in the header, so the reader can see what it is inside.
    expect(out).toContain(`(${TRANSCRIPT_DEFAULT_LINES + 25} lines)`)
  })

  it('says "line", not "lines", when exactly one was dropped', () => {
    expect(renderFullTranscript(NODE, many(TRANSCRIPT_DEFAULT_LINES + 1))).toContain(
      '… 1 earlier line omitted'
    )
  })

  it('an explicit limit overrides the default in both directions', () => {
    expect(renderFullTranscript(NODE, many(10), 3)).toContain('… 7 earlier lines omitted')
    // Raised above the line count: everything comes back and the notice disappears.
    const all = renderFullTranscript(NODE, many(TRANSCRIPT_DEFAULT_LINES + 5), TRANSCRIPT_DEFAULT_LINES + 5)
    expect(all).not.toContain('omitted')
    expect(all).toContain('line 1')
  })
})

describe('parseTranscriptCount', () => {
  it('defaults to the cap, and refuses junk or non-positive values rather than going unlimited', () => {
    expect(parseTranscriptCount(undefined)).toBe(TRANSCRIPT_DEFAULT_LINES)
    expect(parseTranscriptCount('')).toBe(TRANSCRIPT_DEFAULT_LINES)
    expect(parseTranscriptCount('all')).toBe(TRANSCRIPT_DEFAULT_LINES)
    expect(parseTranscriptCount('0')).toBe(TRANSCRIPT_DEFAULT_LINES)
    expect(parseTranscriptCount('-5')).toBe(TRANSCRIPT_DEFAULT_LINES)
  })
  it('takes a positive integer as-is', () => {
    expect(parseTranscriptCount('12')).toBe(12)
    expect(parseTranscriptCount('99999')).toBe(99999)
  })
})

describe('renderContextLink transcript verb', () => {
  // `-n` was already plumbed end to end for `summary` (the shim's arg loop is verb-agnostic), so
  // the override reaches `transcript` with no change on the wire. This pins that it is actually
  // read there — a cap with an override nothing forwards is a cap with no override.
  const doc = { nodeId: 'me', links: [NODE] } as unknown as LinkDoc
  const fetch = {
    transcript: async () =>
      many(TRANSCRIPT_DEFAULT_LINES + 3)
        .map((l) => JSON.stringify({ type: 'user', message: { role: 'user', content: l } }))
        .join('\n'),
    terminal: async () => '',
    opencodeExport: async () => null
  }

  it('caps by default', async () => {
    expect(await renderContextLink(doc, 'transcript', {}, fetch)).toContain('3 earlier lines omitted')
  })

  it('honours -n from the caller', async () => {
    const out = await renderContextLink(doc, 'transcript', { n: String(TRANSCRIPT_DEFAULT_LINES + 3) }, fetch)
    expect(out).not.toContain('omitted')
  })
})
