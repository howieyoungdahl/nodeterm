// Shared app-server hooks have a session_id in stdin but can lack the TUI's entire
// identity environment. Execute the installed shell, including its real stdin pipe.
import { afterEach, describe, expect, it } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildManagedScript } from './managed-script'

const THREAD = 'fixture-payload-thread'
const NODE = 'fixture-payload-node'
const SECRET = 'fixture-private-payload-marker'
const HOOK_TOKEN = 'fixture-private-hook-token'
const NODE_TOKEN = 'fixture-private-node-token'
const cleanup: string[] = []

afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixture(ambient: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nodeterm-codex-payload-'))
  cleanup.push(dir)
  const root = join(dir, 'codex-thread-nodes')
  const bin = join(dir, 'bin')
  const tokens = join(dir, 'node-tokens')
  const endpoint = join(dir, 'hook-endpoint.env')
  const script = join(dir, 'hook.sh')
  const capture = join(dir, 'curl-argv')
  const parserArgv = join(dir, 'parser-argv')
  const headers = join(dir, 'curl-headers')
  const body = join(dir, 'curl-payload')
  const sourced = join(dir, 'endpoint-sourced')
  for (const path of [root, bin, tokens]) mkdirSync(path)
  writeFileSync(endpoint,
    `printf sourced > "$NT_SOURCED"\nNODETERM_HOOK_PORT=54321\n` +
    `NODETERM_HOOK_TOKEN=${HOOK_TOKEN}\nNODETERM_HOOK_VERSION=2\nNODETERM_NODE_TOKEN_DIR=${tokens}\n`,
    { mode: 0o600 })
  writeFileSync(join(tokens, NODE), `${NODE_TOKEN}\n`, { mode: 0o600 })
  // Only wait for this shell's owned background POST, so assertions never poll or
  // race fixture cleanup. Production hooks remain asynchronous.
  writeFileSync(script, "#!/bin/sh\ntrap 'wait' EXIT\n" + buildManagedScript('codex', root), { mode: 0o755 })
  writeFileSync(join(bin, 'curl'), String.raw`#!/bin/sh
printf '%s\n' "$@" >> "$NT_CAPTURE"
cat > "$NT_HEADERS"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --data-urlencode)
      shift
      case "$1" in
        payload@*) nt_file=$(printf %s "$1" | sed 's/^payload@//'); cat "$nt_file" > "$NT_BODY" ;;
      esac
      ;;
  esac
  shift
done
exit 0
`, { mode: 0o755 })
  // Record the parser's actual argv as well as curl's: parsing must not expose a
  // prompt to process listings or trip Linux's ~128 KiB per-argument limit.
  writeFileSync(join(bin, 'node'), String.raw`#!/bin/sh
printf '%s\n' "$@" >> "$NT_PARSER_ARGV"
exec "$NT_REAL_NODE" "$@"
`, { mode: 0o755 })
  const jq = ['/usr/bin/jq', '/bin/jq', '/opt/homebrew/bin/jq', '/usr/local/bin/jq'].find(existsSync)
  if (jq) writeFileSync(join(bin, 'jq'), String.raw`#!/bin/sh
printf '%s\n' "$@" >> "$NT_PARSER_ARGV"
exec "$NT_REAL_JQ" "$@"
`, { mode: 0o755 })
  const env: Record<string, string> = {
    HOME: dir,
    TMPDIR: dir,
    PATH: `${bin}:/usr/bin:/bin`,
    NT_REAL_NODE: process.execPath,
    NT_REAL_JQ: jq ?? '',
    NT_CAPTURE: capture,
    NT_PARSER_ARGV: parserArgv,
    NT_HEADERS: headers,
    NT_BODY: body,
    NT_SOURCED: sourced,
    ...ambient
  }
  const f = { dir, root, endpoint, script, capture, parserArgv, headers, body, sourced, env }
  bind(f)
  return f
}

type Fixture = ReturnType<typeof fixture>

function bind(f: Pick<Fixture, 'root' | 'endpoint'>, account = '', thread = THREAD, node = NODE) {
  const directory = account ? join(f.root, account) : f.root
  mkdirSync(directory, { recursive: true })
  // This layer validates record shape/scope; server HMAC verification belongs to
  // the identity-proxy tests. All identities and credentials here are synthetic.
  writeFileSync(join(directory, thread),
    `accountId=${account}\nnodeId=${node}\nendpoint=${f.endpoint}\nsignature=fixture_signature\n`,
    { mode: 0o600 })
}

function complete(f: Fixture, node = NODE) {
  Object.assign(f.env, {
    NODETERM_NODE_ID: node,
    NODETERM_HOOK_ENDPOINT: f.endpoint,
    NODETERM_CANVAS_CONTROL: '1'
  })
}

function parserPath(f: Fixture, parser: 'node' | 'none') {
  const bin = join(f.dir, 'bin')
  // An isolated PATH selects the fallback deterministically on hosts with jq.
  // Keep only the shell utilities the generated hook needs; never mutate a
  // developer's installed parsers or let fallback reach a real curl.
  for (const command of ['awk', 'cat', 'date', 'dirname', 'head', 'mkdir', 'rm', 'sed', 'tr']) {
    const usr = join('/usr/bin', command)
    symlinkSync(existsSync(usr) ? usr : join('/bin', command), join(bin, command))
  }
  if (existsSync(join(bin, 'jq'))) rmSync(join(bin, 'jq'))
  if (parser === 'none') rmSync(join(bin, 'node'))
  f.env.PATH = bin
}

function payload(session: unknown = THREAD) {
  return JSON.stringify({ hook_event_name: 'PostToolUse', session_id: session, tool_input: SECRET })
}

function readOptional(path: string) {
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

function observed(f: Fixture, result: { status: number | null; stdout: string; stderr: string }) {
  return {
    ...result,
    called: existsSync(f.capture),
    sourced: existsSync(f.sourced),
    argv: readOptional(f.capture) + readOptional(f.parserArgv),
    headers: readOptional(f.headers),
    body: readOptional(f.body)
  }
}

function run(f: Fixture, input: string) {
  const result = spawnSync('/bin/sh', [f.script], {
    env: f.env, input, encoding: 'utf8', timeout: 4000, maxBuffer: 64 * 1024
  })
  expect(result.error).toBeUndefined()
  return observed(f, result)
}

type Result = ReturnType<typeof run>

function expectPrivate(result: Result) {
  expect(result.status).toBe(0)
  expect(result.stdout).toBe('')
  for (const secret of [SECRET, HOOK_TOKEN, NODE_TOKEN]) {
    expect(result.argv + result.stdout + result.stderr).not.toContain(secret)
  }
}

function expectPosted(result: Result, input: string) {
  expectPrivate(result)
  expect(result.stderr).toBe('')
  expect(result.called).toBe(true)
  expect(result.argv.split('\n')).toContain(`nodeId=${NODE}`)
  expect(result.argv.split('\n')).toContain('http://127.0.0.1:54321/hook/codex')
  expect(result.headers).toContain(`X-Nodeterm-Hook-Token: ${HOOK_TOKEN}`)
  expect(result.headers).toContain(`X-Nodeterm-Node-Token: ${NODE_TOKEN}`)
  expect(result.body).toBe(input)
}

function expectRefused(result: Result, reason?: string) {
  expectPrivate(result)
  expect(result.called).toBe(false)
  expect(result.sourced).toBe(false)
  expect(result.body).toBe('')
  if (reason) expect(result.stderr).toContain(reason)
}

describe('managed Codex hook payload session identity', () => {
  it('recovers a payload-only session before the NODETERM gate and forwards the original body', () => {
    const input = `{\n "hook_event_name": "PostToolUse", "session_id": "${THREAD}",\n` +
      ` "tool_input": {"session_id":"fixture-wrong-nested-thread","text":"${SECRET} \\\"quoted\\\""}\n}`
    expectPosted(run(fixture(), input), input)
  })

  it('uses parsed top-level JSON keys, including JSON escapes', () => {
    const input = `{"hook_event_name":"Stop","session\\u005fid":"${THREAD}","message":"${SECRET}"}`
    expectPosted(run(fixture(), input), input)
  })

  it('recovers through the Node fallback when jq is absent', () => {
    const f = fixture()
    parserPath(f, 'node')
    expectPosted(run(f, payload()), payload())
    expect(readOptional(f.parserArgv)).not.toBe('')
  })

  it('does not use a nested-only identity through the Node fallback', () => {
    const f = fixture()
    parserPath(f, 'node')
    expectRefused(run(f, JSON.stringify({ tool_input: { session_id: THREAD }, message: SECRET })))
  })

  it('refuses payload-only recovery when neither JSON parser exists', () => {
    const f = fixture()
    parserPath(f, 'none')
    expectRefused(run(f, payload()))
  })

  it('preserves an existing direct launch when neither JSON parser exists', () => {
    const f = fixture()
    parserPath(f, 'none')
    complete(f)
    expectPosted(run(f, payload()), payload())
  })

  it('accepts a matching environment thread and complete context', () => {
    const f = fixture({ CODEX_THREAD_ID: THREAD })
    complete(f)
    expectPosted(run(f, payload()), payload())
  })

  it('retains environment-thread recovery for older hook payloads without session_id', () => {
    const input = JSON.stringify({ hook_event_name: 'Stop', message: SECRET })
    expectPosted(run(fixture({ CODEX_THREAD_ID: THREAD }), input), input)
  })

  it('uses only the explicitly selected managed account', () => {
    const f = fixture({ NODETERM_CODEX_ACCOUNT_ID: 'fixture-managed' })
    bind(f, 'fixture-managed')
    writeFileSync(join(f.root, THREAD), 'malformed foreign-scope record')
    expectPosted(run(f, payload()), payload())
  })

  it('keeps explicit empty account scope on the system record', () => {
    const f = fixture({ NODETERM_CODEX_ACCOUNT_ID: '' })
    bind(f, 'fixture-managed', THREAD, 'fixture-foreign-node')
    expectPosted(run(f, payload()), payload())
  })

  it('finds a unique managed record when account scope is absent', () => {
    const f = fixture()
    bind(f, 'fixture-managed')
    rmSync(join(f.root, THREAD))
    expectPosted(run(f, payload()), payload())
  })

  it('refuses a missing binding without contacting an endpoint', () => {
    const f = fixture()
    rmSync(join(f.root, THREAD))
    expectRefused(run(f, payload()), 'missing-binding')
  })

  it('refuses ambiguous system and managed bindings', () => {
    const f = fixture()
    bind(f, 'fixture-managed', THREAD, 'fixture-foreign-node')
    expectRefused(run(f, payload()), 'ambiguous-binding')
  })

  it('refuses malformed binding evidence even with complete ambient context', () => {
    const f = fixture()
    complete(f)
    writeFileSync(join(f.root, THREAD), 'broken')
    expectRefused(run(f, payload()), 'invalid-binding')
  })

  it.each([
    ['malformed JSON', `{"session_id":"${THREAD}","message":"${SECRET}"`],
    ['nested-only ID', JSON.stringify({ tool_input: { session_id: THREAD }, message: SECRET })],
    ['stringified ID', JSON.stringify({ message: JSON.stringify({ session_id: THREAD }) })],
    ['array root', JSON.stringify([{ session_id: THREAD }])],
    ['primitive root', JSON.stringify(THREAD)]
  ])('does not derive identity from %s', (_name, input) => {
    expectRefused(run(fixture(), input))
  })

  it.each(['', '.', '..', '../fixture-thread', 'fixture thread', 'line\nbreak', 'x'.repeat(129), null, 42, {}, []])(
    'refuses an invalid top-level session_id (%j)', (id) => {
      // A valid env thread must not hide explicit invalid payload identity.
      expectRefused(run(fixture({ CODEX_THREAD_ID: THREAD }), payload(id)))
    }
  )

  it('refuses malformed JSON even with a valid environment thread and complete context', () => {
    const f = fixture({ CODEX_THREAD_ID: THREAD })
    complete(f)
    expectRefused(run(f, `{"session_id":"${THREAD}","message":"${SECRET}"`))
  })

  it('does not accept multiple JSON roots as one hook envelope', () => {
    expectRefused(run(fixture(), payload() + '\n{}'))
  })

  it('does not hide an invalid explicit session_id in the Node fallback', () => {
    const f = fixture({ CODEX_THREAD_ID: THREAD })
    parserPath(f, 'node')
    expectRefused(run(f, payload(null)))
  })

  it('never evaluates shell syntax from session_id', () => {
    const f = fixture()
    const marker = join(f.dir, 'must-not-exist')
    expectRefused(run(f, payload(`$(touch ${marker})`)))
    expect(existsSync(marker)).toBe(false)
  })

  it.each([false, true])('refuses conflicting payload and environment threads (complete context: %s)', (isComplete) => {
    const f = fixture({ CODEX_THREAD_ID: 'fixture-other-thread' })
    bind(f, '', 'fixture-other-thread', 'fixture-foreign-node')
    if (isComplete) complete(f, 'fixture-foreign-node')
    expectRefused(run(f, payload()))
  })

  it.each(['node', 'endpoint'])('refuses a complete ambient %s mismatch before sourcing its endpoint', (field) => {
    const f = fixture()
    complete(f)
    if (field === 'node') f.env.NODETERM_NODE_ID = 'fixture-foreign-node'
    if (field === 'endpoint') {
      f.env.NODETERM_HOOK_ENDPOINT = join(f.dir, 'foreign-endpoint.env')
      writeFileSync(f.env.NODETERM_HOOK_ENDPOINT, 'printf sourced > "$NT_SOURCED"\n')
    }
    expectRefused(run(f, payload()), 'complete-context-conflict')
  })

  it.each(['recovery', 'node-recovery', 'missing-binding', 'ambiguous-binding', 'complete-context-conflict'])(
    'drains a 2 MB writer without EPIPE or truncation on %s', async (outcome) => {
      const f = fixture()
      if (outcome === 'node-recovery') parserPath(f, 'node')
      if (outcome === 'missing-binding') rmSync(join(f.root, THREAD))
      if (outcome === 'ambiguous-binding') bind(f, 'fixture-managed', THREAD, 'fixture-foreign-node')
      if (outcome === 'complete-context-conflict') complete(f, 'fixture-foreign-node')
      const input = JSON.stringify({ session_id: THREAD, hook_event_name: 'PostToolUse',
        tool_input: SECRET + 'x'.repeat(2_000_000), tail: 'fixture-body-end' })
      const child = spawn('/bin/sh', [f.script], { env: f.env, stdio: ['pipe', 'pipe', 'pipe'], timeout: 4000 })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk) => { stdout += chunk })
      child.stderr.on('data', (chunk) => { stderr += chunk })
      const exit = new Promise<number | null>((resolve, reject) => {
        child.on('error', reject)
        child.on('close', resolve)
      })
      const writeError = new Promise<Error | null>((resolve) => {
        child.stdin.on('error', resolve)
        child.stdin.end(input, (error?: Error | null) => resolve(error ?? null))
      })
      const [error, status] = await Promise.all([writeError, exit])
      expect(error).toBeNull()
      const result = observed(f, { status, stdout, stderr })
      if (outcome === 'recovery' || outcome === 'node-recovery') expectPosted(result, input)
      else expectRefused(result, outcome)
    }
  )
})
