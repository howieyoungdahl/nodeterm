// A shared Codex app-server can fork tool shells with missing OR stale NODETERM_* environment.
// Exercise the generated local shims under real /bin/sh: an exact current-thread record must
// recover the request identity before the shim's environment gate or transport runs.
import { afterEach, describe, expect, it } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { buildControlShimScript } from './canvas-control-core'
import { buildContextShimScript } from './context-link-core'
import { buildManagedScript } from './agents/hooks/managed-script'

const cleanup: string[] = []
const buildCodexHook = (root: string) => buildManagedScript('codex', root)
const consumers = [
  ['canvas control', buildControlShimScript],
  ['linked context', buildContextShimScript],
  ['managed Codex hook', buildCodexHook]
] as const

afterEach(() => {
  for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixture(build: (root: string) => string, ambient: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'nodeterm-codex-local-shim-'))
  cleanup.push(dir)
  const root = join(dir, 'codex-thread-nodes')
  const bin = join(dir, 'bin')
  const endpoint = join(dir, 'hook-endpoint.env')
  const tokens = join(dir, 'node-tokens')
  const capture = join(dir, 'curl-args')
  const headers = join(dir, 'curl-stdin')
  const response = join(dir, 'curl-response')
  const agent = join(dir, 'curl-agent')
  const payload = join(dir, 'curl-payload')
  const script = join(dir, 'shim.sh')
  mkdirSync(root)
  mkdirSync(bin)
  mkdirSync(tokens)
  // Only disposable identities and a synthetic signing key. The shell checks record shape and
  // scope, not its HMAC; this fixture does not claim to test server-side signature verification.
  const signature = createHmac('sha256', Buffer.alloc(32, 7))
    .update(['fixture-thread-current', 'system', 'fixture-node-current', endpoint].join('\0'))
    .digest('base64url')
  writeFileSync(
    join(root, 'fixture-thread-current'),
    `accountId=\nnodeId=fixture-node-current\nendpoint=${endpoint}\nsignature=${signature}\n`,
    { mode: 0o600 }
  )
  writeFileSync(
    endpoint,
    `NODETERM_HOOK_PORT=54321\nNODETERM_HOOK_TOKEN=fixture-hook-token\n` +
      `NODETERM_HOOK_VERSION=2\nNODETERM_NODE_TOKEN_DIR=${tokens}\n`,
    { mode: 0o600 }
  )
  writeFileSync(join(tokens, 'fixture-node-current'), 'fixture-current-node-token\n', { mode: 0o600 })
  const isHook = build === buildCodexHook
  // Synchronize only this disposable shell's own background POST on exit; the canonical hook
  // remains unchanged and asynchronous. This makes its captured fake request deterministic.
  const ownedJobDrain = isHook ? "#!/bin/sh\ntrap 'wait' EXIT\n" : ''
  writeFileSync(script, ownedJobDrain + build(root), { mode: 0o755 })
  writeFileSync(
    join(bin, 'curl'),
    String.raw`#!/bin/sh
printf '%s\n' "$@" > "$NT_CAPTURE"
nt_headers=$(cat)
printf '%s\n' "$nt_headers" > "$NT_HEADERS"
printf '%s\n' "$NODETERM_AGENT_ID" > "$NT_AGENT"
nt_out=''
nt_config=''
nt_node=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) shift; nt_out="$1" ;;
    --config) shift; nt_config="$1" ;;
    --data-urlencode)
      shift
      case "$1" in
        nodeId=*) nt_node="$1" ;;
        payload@*) nt_payload_path=$(printf %s "$1" | sed 's/^payload@//'); cat "$nt_payload_path" > "$NT_PAYLOAD" ;;
      esac
      ;;
  esac
  shift
done
nt_code=200
nt_body=ok
if [ "$nt_node" != 'nodeId=fixture-node-current' ]; then
  nt_code=422
  nt_body=fixture-node-mismatch
elif [ "$nt_config" != '-' ]; then
  nt_code=403
  nt_body=fixture-auth-refused
else
  case "$nt_headers" in
    *'header = "X-Nodeterm-Hook-Token: fixture-hook-token"'*) ;;
    *) nt_code=403; nt_body=fixture-auth-refused ;;
  esac
  case "$nt_headers" in
    *'header = "X-Nodeterm-Node-Token: fixture-current-node-token"'*) ;;
    *) nt_code=403; nt_body=fixture-auth-refused ;;
  esac
fi
[ -n "$nt_out" ] && printf '%s\n' "$nt_body" > "$nt_out"
printf '%s' "$nt_code"
printf '%s' "$nt_code" > "$NT_RESPONSE"
`,
    { mode: 0o755 }
  )

  const env: Record<string, string> = {
    HOME: dir,
    TMPDIR: dir,
    PATH: `${bin}:/usr/bin:/bin`,
    CODEX_THREAD_ID: 'fixture-thread-current',
    NT_CAPTURE: capture,
    NT_HEADERS: headers,
    NT_RESPONSE: response,
    NT_AGENT: agent,
    NT_PAYLOAD: payload,
    ...ambient
  }
  return { dir, root, endpoint, tokens, script, capture, headers, response, agent, payload, env, isHook }
}

type Fixture = ReturnType<typeof fixture>

function runShim(
  build: (root: string) => string,
  ambient: Record<string, string> = {},
  configure: (f: Fixture) => void = () => {}
) {
  const f = fixture(build, ambient)
  configure(f)
  const result = spawnSync('/bin/sh', [f.script, 'list'], {
    // No ambient provider/node variables or real homes: even token/endpoint fallback is jailed
    // to this fixture, and every curl invocation resolves to the fake transport above.
    env: f.env,
    input: f.isHook ? '{"hook_event_name":"PostToolUse","fixture":"private-hook-payload"}' : '',
    encoding: 'utf8',
    timeout: 3000,
    maxBuffer: 64 * 1024
  })
  expect(result.error, 'The disposable /bin/sh fixture must start and finish without a timeout').toBeUndefined()
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    isHook: f.isHook,
    transportCalled: existsSync(f.capture),
    argv: existsSync(f.capture) ? readFileSync(f.capture, 'utf8') : '',
    headers: existsSync(f.headers) ? readFileSync(f.headers, 'utf8') : '',
    response: existsSync(f.response) ? readFileSync(f.response, 'utf8') : '',
    agent: existsSync(f.agent) ? readFileSync(f.agent, 'utf8').trim() : '',
    payload: existsSync(f.payload) ? readFileSync(f.payload, 'utf8') : ''
  }
}

function expectCurrentThreadRequest(result: ReturnType<typeof runShim>) {
  const stage = !result.transportCalled && result.stderr.includes('not a nodeterm agent node')
    ? 'early NODETERM_CANVAS_CONTROL gate; fake curl was never called'
    : result.transportCalled ? 'fake transport reached' : 'before fake transport'
  expect(result.status, `Expected current-thread recovery; ${stage}. stderr: ${result.stderr.trim()}`).toBe(0)
  expect(result.stdout).toBe(result.isHook ? '' : 'ok\n')
  expect(result.stderr).toBe('')
  expect(result.transportCalled).toBe(true)
  expect(result.response).toBe('200')
  expect(result.argv.split('\n')).toContain('nodeId=fixture-node-current')
  expect(result.argv).not.toContain('fixture-node-stale')
  expect(result.argv).toContain('http://127.0.0.1:54321/')
  expect(result.headers).toContain('X-Nodeterm-Hook-Token: fixture-hook-token')
  expect(result.headers).toContain('X-Nodeterm-Node-Token: fixture-current-node-token')
  for (const token of ['fixture-hook-token', 'fixture-current-node-token']) {
    expect(result.argv + result.stdout + result.stderr).not.toContain(token)
  }
  expect(result.argv + result.stdout + result.stderr).not.toContain('private-hook-payload')
  if (result.isHook) expect(result.payload).toContain('private-hook-payload')
}

function complete(f: Fixture, nodeId = 'fixture-node-current'): void {
  Object.assign(f.env, {
    NODETERM_NODE_ID: nodeId,
    NODETERM_HOOK_ENDPOINT: f.endpoint,
    NODETERM_CANVAS_CONTROL: '1'
  })
}

function expectRefusal(result: ReturnType<typeof runShim>, reason: string): void {
  expect(result.status).toBe(result.isHook ? 0 : 1)
  expect(result.stdout).toBe('')
  expect(result.stderr).toBe(`Nodeterm Codex identity refused: ${reason}.\n`)
  expect(result.transportCalled).toBe(false)
  expect(result.headers).toBe('')
  expect(result.response).toBe('')
}

describe('local Codex tool-shell identity recovery', () => {
  for (const [name, build] of consumers) {
    it(`${name} resolves CODEX_THREAD_ID before its NODETERM_* gate`, () => {
      expectCurrentThreadRequest(runShim(build))
    })

    it(`${name} recovers incomplete identity and discards stale endpoint transport and role`, () => {
      const result = runShim(build, { NODETERM_NODE_ID: 'fixture-node-stale' }, (f) => {
        Object.assign(f.env, {
          NODETERM_HOOK_ENDPOINT: join(f.dir, 'retired-endpoint.env'),
          NODETERM_HOOK_SOCK: join(f.dir, 'retired.sock'),
          NODETERM_HOOK_PORT: '54322',
          NODETERM_HOOK_TOKEN: 'fixture-stale-hook-token',
          NODETERM_NODE_TOKEN_DIR: join(f.dir, 'retired-tokens'),
          NODETERM_AGENT_ID: 'claude'
        })
        mkdirSync(f.env.NODETERM_NODE_TOKEN_DIR)
        writeFileSync(join(f.env.NODETERM_NODE_TOKEN_DIR, 'fixture-node-current'), 'fixture-stale-node-token\n')
      })
      expectCurrentThreadRequest(result)
      expect(result.agent).toBe('codex')
      expect(result.argv).not.toContain('--unix-socket')
      expect(result.argv + result.headers).not.toContain('retired')
      expect(result.argv + result.headers).not.toContain('fixture-stale')
    })

    it(`${name} accepts matching complete context without agent-role metadata`, () => {
      expectCurrentThreadRequest(runShim(build, {}, (f) => complete(f)))
    })

    it(`${name} preserves a complete no-record direct launch and its transport`, () => {
      const result = runShim(build, {}, (f) => {
        complete(f)
        rmSync(join(f.root, 'fixture-thread-current'))
        // The legitimate direct launch has no binding and uses its own supplied transport.
        // An indiscriminate scrub would erase the socket and make this a TCP request instead.
        f.env.NODETERM_HOOK_SOCK = join(f.dir, 'direct.sock')
      })
      expect(result.status).toBe(0)
      expect(result.response).toBe('200')
      expect(result.argv).toContain('--unix-socket')
      expect(result.argv).toContain('direct.sock')
      expect(result.agent).toBe('')
    })

    it.each(['1', '0', 'false'])(`${name} refuses a stale complete identity with capability %s`, (flag) => {
      expectRefusal(runShim(build, {}, (f) => {
        complete(f, 'fixture-node-stale')
        f.env.NODETERM_CANVAS_CONTROL = flag
      }), 'complete-context-conflict')
    })

    it(`${name} refuses a complete endpoint conflict before sourcing either endpoint`, () => {
      expectRefusal(runShim(build, {}, (f) => {
        complete(f)
        f.env.NODETERM_HOOK_ENDPOINT = join(f.dir, 'other-endpoint.env')
        writeFileSync(f.endpoint, 'printf ENDPOINT_MUST_NOT_RUN\n')
        writeFileSync(f.env.NODETERM_HOOK_ENDPOINT, 'printf OTHER_ENDPOINT_MUST_NOT_RUN\n')
      }), 'complete-context-conflict')
    })

    it(`${name} refuses an incomplete context when its record is missing`, () => {
      expectRefusal(runShim(build, { NODETERM_NODE_ID: 'fixture-node-stale' }, (f) => {
        rmSync(join(f.root, 'fixture-thread-current'))
      }), 'missing-binding')
    })

    it.each(['malformed', 'unreadable', 'ambiguous'])(`${name} refuses existing %s evidence despite complete ambient authority`, (kind) => {
      expectRefusal(runShim(build, {}, (f) => {
        complete(f)
        if (kind === 'malformed') writeFileSync(join(f.root, 'fixture-thread-current'), 'broken')
        if (kind === 'unreadable') chmodSync(join(f.root, 'fixture-thread-current'), 0)
        if (kind === 'ambiguous') {
          mkdirSync(join(f.root, 'fixture-account'))
          writeFileSync(join(f.root, 'fixture-account', 'fixture-thread-current'),
            `accountId=fixture-account\nnodeId=fixture-node-other\nendpoint=${f.endpoint}\nsignature=x\n`)
        }
      }), kind === 'malformed' ? 'invalid-binding' : `${kind}-binding`)
    })

    it(`${name} uses the exact managed account and ignores another scope's malformed record`, () => {
      expectCurrentThreadRequest(runShim(build, { NODETERM_CODEX_ACCOUNT_ID: 'fixture-account' }, (f) => {
        const record = readFileSync(join(f.root, 'fixture-thread-current'), 'utf8')
        mkdirSync(join(f.root, 'fixture-account'))
        writeFileSync(join(f.root, 'fixture-account', 'fixture-thread-current'), record.replace('accountId=\n', 'accountId=fixture-account\n'))
        writeFileSync(join(f.root, 'fixture-thread-current'), 'broken')
      }))
    })

    it(`${name} leaves non-Codex behavior and supplied role metadata unchanged`, () => {
      const result = runShim(build, { CODEX_THREAD_ID: '', NODETERM_AGENT_ID: 'claude' }, (f) => {
        complete(f)
        writeFileSync(join(f.root, 'fixture-thread-current'), 'broken')
      })
      expectCurrentThreadRequest(result)
      expect(result.agent).toBe('claude')
    })
  }

  it('canvas control recovers the exact current thread from a stale node with no canvas-control flag', () => {
    // A reused shared daemon retains a retired node A, while this tool's own thread has exactly
    // one record for B. A has no record or token here. This does not choose policy for ambiguous,
    // missing-record or direct-launch contexts; it pins only the observed incomplete stale case.
    expectCurrentThreadRequest(runShim(buildControlShimScript, {
      NODETERM_NODE_ID: 'fixture-node-stale'
    }))
  })

  it.each(['complete-context-conflict', 'invalid-binding', 'ambiguous-binding', 'missing-binding'])(
    'managed hook drains a 2 MB raw stdin writer on %s without EPIPE or payload output',
    async (reason) => {
      const f = fixture(buildCodexHook)
      if (reason === 'complete-context-conflict') complete(f, 'fixture-node-stale')
      if (reason === 'invalid-binding') writeFileSync(join(f.root, 'fixture-thread-current'), 'broken')
      if (reason === 'missing-binding') rmSync(join(f.root, 'fixture-thread-current'))
      if (reason === 'ambiguous-binding') {
        mkdirSync(join(f.root, 'fixture-account'))
        writeFileSync(join(f.root, 'fixture-account', 'fixture-thread-current'),
          `accountId=fixture-account\nnodeId=fixture-node-other\nendpoint=${f.endpoint}\nsignature=x\n`)
      }
      const child = spawn('/bin/sh', [f.script], {
        env: f.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 3000
      })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (chunk) => { stdout += chunk })
      child.stderr.on('data', (chunk) => { stderr += chunk })
      const exit = new Promise<number | null>((resolve, reject) => {
        child.on('error', reject)
        child.on('close', resolve)
      })
      const writeError = new Promise<Error | null>((resolve) => {
        // Observe the stream error before writing; execFile/communicate can swallow EPIPE.
        child.stdin.on('error', resolve)
        child.stdin.end(Buffer.alloc(2_000_000, 0x41), (error?: Error | null) => resolve(error ?? null))
      })
      expect(await writeError).toBeNull()
      expect(await exit).toBe(0)
      expect(stdout).toBe('')
      expect(stderr).toBe(`Nodeterm Codex identity refused: ${reason}.\n`)
      expect(existsSync(f.capture)).toBe(false)
      expect(existsSync(f.payload)).toBe(false)
    }
  )
})
