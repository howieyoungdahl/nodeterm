import { mkdtemp, writeFile, appendFile, rm, mkdir, symlink, unlink, realpath } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { OperatorConversationError, readOperatorConversation } from './operator-conversation'

let dir = ''
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = '' })
async function fixture(agent: 'claude' | 'codex', records: unknown[]) {
  dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'operator-conversation-')))
  const file = path.join(dir, 'synthetic.jsonl')
  await writeFile(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n')
  const target = { projectId: 'p1', nodeId: 'n1', sessionId: 'session-123', generation: 'g1' }
  return { file, target, agent }
}
const claude = (type: string, content: unknown, more = {}) => ({ type, sessionId: 'session-123', timestamp: '2026-09-30T10:00:00Z', message: { content }, ...more })
const codex = (type: string, payload: unknown, more = {}) => ({ type, payload, ...more })
// Synthetic marker assembled at runtime; no key material is present in source fixtures.
const keyMarker = (edge: 'BEGIN' | 'END', kind: string) => ['-----', edge, ' ', kind, ' PRIVATE KEY-----'].join('')

describe('readOperatorConversation', () => {
  it('keeps submitted message/tool distinctions, ordering, timestamps and provenance; excludes private records', async () => {
    const f = await fixture('claude', [
      claude('user', [{ type: 'text', text: 'hello' }]),
      claude('assistant', [{ type: 'thinking', thinking: 'secret thoughts' }, { type: 'text', text: 'working' }, { type: 'tool_use', name: 'Bash', input: { command: 'echo ok' } }]),
      claude('user', [{ type: 'tool_result', content: 'ok' }]),
      { type: 'system', sessionId: 'session-123', message: { content: 'private metadata' } }
    ])
    const page = await readOperatorConversation(f.target, f.agent, f.file, undefined, 20)
    expect(page.items.map((i) => [i.kind, i.text])).toEqual([
      ['user', 'hello'], ['agent', 'working'], ['tool_call', 'Bash {"command":"echo ok"}'], ['tool_result', 'ok']
    ])
    expect(page.items[0]).toMatchObject({ timestamp: '2026-09-30T10:00:00Z', provenance: { source: 'transcript', agentId: 'claude', submitted: true } })
    expect(JSON.stringify(page)).not.toContain('secret thoughts')
    expect(JSON.stringify(page)).not.toContain('private metadata')
  })

  it('reads Codex structured messages while ignoring reasoning and system metadata', async () => {
    const f = await fixture('codex', [
      codex('session_meta', { id: 'session-123', base_instructions: 'do not reveal' }),
      codex('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'question' }] }),
      codex('response_item', { type: 'reasoning', summary: 'private' }),
      codex('response_item', { type: 'message', role: 'assistant', channel: 'analysis', content: [{ type: 'output_text', text: 'private analysis output_text' }] }),
      codex('response_item', { type: 'message', role: 'assistant', channel: 'summary', content: [{ type: 'output_text', text: 'private summary output_text' }] }),
      codex('response_item', { type: 'function_call', name: 'shell', arguments: '{"command":"echo ok"}' }),
      codex('response_item', { type: 'custom_tool_call', name: 'handoff', input: { target: 'worker' } }),
      codex('response_item', { type: 'custom_tool_call_output', output: 'worker acknowledged' }),
      codex('response_item', { type: 'function_call_output', output: 'done' }),
      codex('response_item', { type: 'message', role: 'assistant', channel: 'final', content: [{ type: 'output_text', text: 'answer' }] })
    ])
    const page = await readOperatorConversation(f.target, f.agent, f.file, undefined, 20)
    expect(page.items.map((i) => i.kind)).toEqual(['user', 'tool_call', 'tool_call', 'tool_result', 'tool_result', 'agent'])
    expect(JSON.stringify(page)).not.toContain('private')
    expect(JSON.stringify(page)).not.toContain('do not reveal')
    expect(page.items.map((i) => i.text)).toContain('worker acknowledged')
  })

  it('redacts secrets in user text, tool arguments and tool results', async () => {
    const f = await fixture('claude', [
      claude('user', [{ type: 'text', text: 'Bearer abc.def password=hunter2 sk-abcdefghijklmnop postgres://dbuser:dbpass@db.example.test/app NODETERM_HOOK_TOKEN=hooksecret PROD_DB_PASSWORD=envpass unknown-token-' + 'A'.repeat(56) }]),
      claude('assistant', [{ type: 'tool_use', name: 'Bash', input: { command: 'api_key=supersecret' } }]),
      claude('user', [{ type: 'tool_result', content: `{"refresh_token":"token-value"} ${keyMarker('BEGIN', 'RSA')}\nprivate-material\n${keyMarker('END', 'RSA')}` }]),
      claude('user', [{ type: 'tool_result', content: `${keyMarker('BEGIN', 'OPENSSH')}\nincomplete-material` }]),
      claude('user', [{ type: 'tool_result', content: 'Cookie: session=cookiesess' }])
    ])
    const page = await readOperatorConversation(f.target, f.agent, f.file, undefined, 20)
    const all = page.items.map((i) => i.text).join('\n')
    for (const secret of ['abc.def', 'hunter2', 'sk-abcdefghijklmnop', 'dbuser:dbpass', 'dbpass', 'hooksecret', 'envpass', 'cookiesess', 'supersecret', 'token-value', 'private-material', 'incomplete-material', 'A'.repeat(56)]) expect(all).not.toContain(secret)
  })

  it('does not return an untrusted timestamp string as metadata', async () => {
    const f = await fixture('claude', [claude('user', [{ type: 'text', text: 'safe message' }], { timestamp: 'sk-secret-looking-token-value' })])
    const page = await readOperatorConversation(f.target, f.agent, f.file, undefined, 10)
    expect(page.items[0].timestamp).toBeNull()
    expect(JSON.stringify(page)).not.toContain('sk-secret-looking-token-value')
  })

  it('masks an exact credential before chunking and binds continuation to its redaction context', async () => {
    const secret = '-'.repeat(43)
    const text = 'ordinary phrase '.repeat(800).slice(0, 11_990) + secret + ' trailing text'.repeat(50)
    const f = await fixture('claude', [claude('user', [{ type: 'text', text }])])
    let page = await readOperatorConversation(f.target, f.agent, f.file, undefined, 1, [secret])
    const all: string[] = page.items.map((item) => item.text)
    expect(page.nextCursor).toBeTruthy()
    await expect(readOperatorConversation(f.target, f.agent, f.file, page.nextCursor!, 1, ['different-secret']))
      .rejects.toMatchObject({ code: 'invalid_cursor' })
    while (page.nextCursor) {
      page = await readOperatorConversation(f.target, f.agent, f.file, page.nextCursor, 1, [secret])
      all.push(...page.items.map((item) => item.text))
    }
    expect(all.join('')).not.toContain(secret)
    expect(all.join('')).toContain('[REDACTED CREDENTIAL]')
  })

  it.skipIf(process.platform === 'win32')('rejects final and intermediate symlink transcript paths', async () => {
    const f = await fixture('claude', [claude('user', [{ type: 'text', text: 'synthetic outside data' }]), claude('assistant', [{ type: 'text', text: 'second page' }])])
    const finalLink = path.join(dir, 'final-link.jsonl')
    await symlink(f.file, finalLink)
    await expect(readOperatorConversation(f.target, f.agent, finalLink, undefined, 10)).rejects.toMatchObject({ code: 'unsafe_transcript_path' })

    const realDir = path.join(dir, 'real-dir')
    const aliasDir = path.join(dir, 'alias-dir')
    await mkdir(realDir)
    await writeFile(path.join(realDir, 'transcript.jsonl'), JSON.stringify(claude('user', [{ type: 'text', text: 'synthetic outside data' }])) + '\n')
    await symlink(realDir, aliasDir)
    await expect(readOperatorConversation(f.target, f.agent, path.join(aliasDir, 'transcript.jsonl'), undefined, 10)).rejects.toMatchObject({ code: 'unsafe_transcript_path' })

    const firstPage = await readOperatorConversation(f.target, f.agent, f.file, undefined, 1)
    const replacement = path.join(dir, 'replacement.jsonl')
    await writeFile(replacement, JSON.stringify(claude('user', [{ type: 'text', text: 'synthetic replacement' }])) + '\n')
    await unlink(f.file)
    await symlink(replacement, f.file)
    await expect(readOperatorConversation(f.target, f.agent, f.file, firstPage.nextCursor!, 1)).rejects.toMatchObject({ code: 'transcript_changed' })
  })

  it('paginates a public record over 1 MiB without losing text', async () => {
    const text = 'public phrase with unicode 🦉 '.repeat(45_000)
    const f = await fixture('claude', [claude('user', [{ type: 'text', text }])])
    const parts: string[] = []
    let cursor: string | undefined
    do {
      const page = await readOperatorConversation(f.target, f.agent, f.file, cursor, 200)
      parts.push(...page.items.map((item) => item.text))
      cursor = page.nextCursor ?? undefined
    } while (cursor)
    expect(parts.join('')).toBe(text)
    expect(parts.length).toBeGreaterThan(100)
  })

  it('rejects records beyond the bounded large-record budget explicitly', async () => {
    const f = await fixture('claude', [claude('user', [{ type: 'text', text: 'x'.repeat(16 * 1024 * 1024 + 1) }])])
    await expect(readOperatorConversation(f.target, f.agent, f.file, undefined, 10)).rejects.toMatchObject({ code: 'transcript_record_too_large', status: 413 })
  })

  it('bounds nesting and structure before parsing both public and private records', async () => {
    const f = await fixture('claude', [claude('user', 'public')])
    const nested = '['.repeat(65) + '0' + ']'.repeat(65)
    for (const raw of [
      `{"type":"system","sessionId":"session-123","metadata":${nested}}`,
      JSON.stringify(claude('user', Array.from({ length: 26_000 }, () => ({ type: 'text', text: 'public' }))))
    ]) {
      await writeFile(f.file, raw + '\n')
      await expect(readOperatorConversation(f.target, f.agent, f.file, undefined, 10))
        .rejects.toMatchObject({ code: 'transcript_record_too_complex', status: 413 })
    }
  })

  it('validates malformed large records instead of treating them as empty content', async () => {
    const f = await fixture('claude', [claude('user', 'public')])
    for (const raw of [
      JSON.stringify(claude('user', 'ordinary phrase '.repeat(80_000))).slice(0, -1),
      '{"sessionId":"session-123","metadata":"escaped \\" text","oops":}',
      '{"type":"system","sessionId":"session-123","metadata":[' + '1,'.repeat(100) + ']}'
    ]) {
      await writeFile(f.file, raw + '\n')
      await expect(readOperatorConversation(f.target, f.agent, f.file, undefined, 10))
        .rejects.toMatchObject({ code: 'invalid_transcript', status: 409 })
    }
  })

  it('filters large private records and nested private channels before emitting public pages', async () => {
    const privateText = 'private reasoning marker '.repeat(50_000)
    const f = await fixture('claude', [
      claude('assistant', [{ type: 'thinking', thinking: privateText }, { type: 'text', text: 'public final' }]),
      claude('assistant', [{ type: 'text', text: privateText }], { channel: 'analysis' }),
      claude('assistant', [{ type: 'text', channel: 'summary', text: privateText }]),
      claude('user', [{ type: 'tool_result', content: [{ type: 'text', channel: 'analysis', text: privateText }, { type: 'text', text: 'public result' }] }])
    ])
    const page = await readOperatorConversation(f.target, f.agent, f.file, undefined, 20)
    expect(page.items.map((item) => item.text)).toEqual(['public final', 'public result'])
    await writeFile(f.file, [
      codex('session_meta', { id: 'session-123', base_instructions: privateText }),
      codex('response_item', { type: 'message', role: 'assistant', channel: 'analysis', content: [{ type: 'output_text', text: privateText }] }),
      codex('response_item', { type: 'message', role: 'assistant', channel: 'final', content: [
        { type: 'output_text', channel: 'analysis', text: privateText }, { type: 'output_text', text: 'codex public final' }
      ] })
    ].map((row) => JSON.stringify(row)).join('\n'))
    const codexPage = await readOperatorConversation(f.target, 'codex', f.file, undefined, 20)
    expect(codexPage.items.map((item) => item.text)).toEqual(['codex public final'])
  })

  it('redacts a large tool result across input read, item and page boundaries', async () => {
    const secret = 'synthetic-current-credential-'.repeat(3)
    const meta = codex('session_meta', { id: 'session-123' })
    const empty = JSON.stringify(meta) + '\n' + JSON.stringify(codex('response_item', { type: 'function_call_output', output: '' }))
    const contentStart = empty.indexOf('"output":"') + '"output":"'.length
    const prefix = 'public tool output '.repeat(4000).slice(0, 64 * 1024 - contentStart - 12)
    const text = prefix + secret + ' public suffix '.repeat(80_000) +
      ' API_KEY="synthetic quoted secret" Cookie: sid=synthetic-cookie\n' +
      keyMarker('BEGIN', 'RSA') + '\nsynthetic-key-material\n' + keyMarker('END', 'RSA')
    const f = await fixture('codex', [meta,
      codex('response_item', { type: 'function_call_output', output: text })])
    expect(contentStart + prefix.length).toBeLessThan(64 * 1024)
    expect(contentStart + prefix.length + secret.length).toBeGreaterThan(64 * 1024)
    let cursor: string | undefined
    const parts: string[] = []
    do {
      const page = await readOperatorConversation(f.target, f.agent, f.file, cursor, 200, [secret])
      expect(page.items.every((item) => item.kind === 'tool_result')).toBe(true)
      expect(Buffer.byteLength(page.items.map((item) => item.text).join(''))).toBeLessThanOrEqual(128 * 1024)
      parts.push(...page.items.map((item) => item.text))
      cursor = page.nextCursor ?? undefined
    } while (cursor)
    const output = parts.join('')
    for (const marker of [secret, 'synthetic quoted secret', 'synthetic-cookie', 'synthetic-key-material'])
      expect(output).not.toContain(marker)
    expect(output).toContain('[REDACTED CREDENTIAL]')
    expect(output).toContain('[REDACTED PRIVATE KEY]')
    expect(output.startsWith(prefix)).toBe(true)
    expect(parts.length).toBeGreaterThan(100)
  })

  it('paginates from the head, tolerates append without changing the captured ordering, rejects replacement and tampering', async () => {
    const f = await fixture('claude', [claude('user', [{ type: 'text', text: 'one' }]), claude('assistant', [{ type: 'text', text: 'two' }])])
    const first = await readOperatorConversation(f.target, f.agent, f.file, undefined, 1)
    expect(first.items[0].text).toBe('one')
    await appendFile(f.file, JSON.stringify(claude('assistant', [{ type: 'text', text: 'three' }])) + '\n')
    const second = await readOperatorConversation(f.target, f.agent, f.file, first.nextCursor!, 1)
    expect(second.items[0].text).toBe('two')
    await expect(readOperatorConversation(f.target, f.agent, f.file, `${first.nextCursor}x`, 1)).rejects.toMatchObject({ code: 'invalid_cursor' })
    await expect(readOperatorConversation({ ...f.target, nodeId: 'n2' }, f.agent, f.file, first.nextCursor!, 1)).rejects.toMatchObject({ code: 'invalid_cursor' })
    await writeFile(f.file, JSON.stringify(claude('user', [{ type: 'text', text: 'replacement' }])) + '\n')
    await expect(readOperatorConversation(f.target, f.agent, f.file, first.nextCursor!, 1)).rejects.toMatchObject({ code: 'transcript_changed' })
  })

  it('reconstructs a long tool result across bounded cursor pages without dropping text', async () => {
    const resultText = 'long result phrase '.repeat(1_800)
    const f = await fixture('claude', [
      claude('user', [{ type: 'tool_result', content: resultText }])
    ])
    const chunks = []
    let page = await readOperatorConversation(f.target, f.agent, f.file, undefined, 1)
    chunks.push(...page.items)
    while (page.nextCursor) {
      page = await readOperatorConversation(f.target, f.agent, f.file, page.nextCursor, 1)
      chunks.push(...page.items)
    }
    expect(chunks.length).toBeGreaterThan(1)
    expect(chunks.map((item) => item.text).join('')).toBe(resultText)
    expect(chunks.every((item) => item.kind === 'tool_result' && item.timestamp === '2026-09-30T10:00:00Z' && item.provenance.agentId === 'claude')).toBe(true)
  })

  it('rejects raw transcript session identity mismatch and unsupported provider', async () => {
    const f = await fixture('claude', [{ ...claude('user', [{ type: 'text', text: 'wrong' }]), sessionId: 'other-session' }])
    await expect(readOperatorConversation(f.target, f.agent, f.file, undefined, 10)).rejects.toMatchObject({ code: 'session_mismatch' })
    await expect(readOperatorConversation(f.target, 'gemini', f.file, undefined, 10)).rejects.toBeInstanceOf(OperatorConversationError)
  })

  it('rejects a concatenated second session after valid records', async () => {
    const f = await fixture('claude', [
      claude('user', [{ type: 'text', text: 'belongs to first' }]),
      claude('assistant', [{ type: 'text', text: 'belongs elsewhere' }], { sessionId: 'other-session' }),
      { type: 'system', sessionId: 'third-session', message: { content: 'must not be emitted' } }
    ])
    await expect(readOperatorConversation(f.target, f.agent, f.file, undefined, 10)).rejects.toMatchObject({ code: 'session_mismatch' })
  })

  it('preserves full pagination for a valid transcript larger than the former 16 MiB cap', async () => {
    dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'operator-conversation-large-')))
    const file = path.join(dir, 'large.jsonl')
    const records = Array.from({ length: 19 }, (_, i) => claude('user', [{ type: 'text', text: `part-${i}-` + 'x'.repeat(900 * 1024) }]))
    await writeFile(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n')
    const target = { projectId: 'p1', nodeId: 'large', sessionId: 'session-123', generation: 'g1' }
    const page = await readOperatorConversation(target, 'claude', file, undefined, 20)
    expect(page.items).toHaveLength(19)
    expect(page.items[0].text).toContain('[REDACTED LONG TOKEN]')
    expect(page.nextCursor).toBeNull()
  })

  it('rejects invalid page sizes', async () => {
    const f = await fixture('claude', [claude('user', [{ type: 'text', text: 'hi' }])])
    await expect(readOperatorConversation(f.target, f.agent, f.file, undefined, 201)).rejects.toMatchObject({ code: 'invalid_limit' })
  })
})
