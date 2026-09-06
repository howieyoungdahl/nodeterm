// The hook prelude, run by the real /bin/sh. It is prepended to every managed hook script, so a
// quoting slip here does not break "codex identity recovery" — it breaks every agent's hooks on
// every machine. It is also the one place where a data file's contents become environment
// variables, which is why the negative cases below matter as much as the positive one.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { codexThreadIdentityResolverSh } from './codex-thread-identity-sh'

const run = promisify(execFile)

let dir = ''
let root = ''
let script = ''

beforeAll(() => {
  // A space in the path on purpose: the real one is macOS's "Application Support".
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeterm codex prelude '))
  root = path.join(dir, 'codex-thread-nodes')
  fs.mkdirSync(root, { recursive: true })
  script = path.join(dir, 'prelude.sh')
  fs.writeFileSync(
    script,
    `#!/bin/sh\n${codexThreadIdentityResolverSh(root)}\n` +
      `printf '%s|%s|%s\\n' "\${NODETERM_NODE_ID-}" "\${NODETERM_HOOK_ENDPOINT-}" "\${NODETERM_CANVAS_CONTROL-}"\n`,
    { mode: 0o755 }
  )
})

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

beforeEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
  fs.mkdirSync(root, { recursive: true })
})

function record(threadId: string, body: string): void {
  fs.writeFileSync(path.join(root, threadId), body, { mode: 0o600 })
}

/** Write a managed-scope record under `<root>/<accountId>/<threadId>`. */
function scopedRecord(accountId: string, threadId: string, body: string): void {
  fs.mkdirSync(path.join(root, accountId), { recursive: true })
  fs.writeFileSync(path.join(root, accountId, threadId), body, { mode: 0o600 })
}

/** A well-formed record body for a scope (empty account = system, no accountId line = legacy). */
function body(nodeId: string, accountId?: string): string {
  const acct = accountId === undefined ? '' : `accountId=${accountId}\n`
  return `${acct}nodeId=${nodeId}\nendpoint=${dir}/hook-endpoint.env\nsignature=x\n`
}

async function resolve(env: Record<string, string>): Promise<string> {
  const { stdout } = await run('/bin/sh', [script], {
    env: { PATH: '/usr/bin:/bin', HOME: dir, TMPDIR: dir, ...env },
    timeout: 3000,
    maxBuffer: 64 * 1024
  })
  return stdout.trim()
}

function complete(env: Record<string, string> = {}): Record<string, string> {
  return {
    CODEX_THREAD_ID: 'thread-1',
    NODETERM_NODE_ID: 'node-own',
    NODETERM_HOOK_ENDPOINT: `${dir}/hook-endpoint.env`,
    NODETERM_CANVAS_CONTROL: '1',
    ...env
  }
}

async function refused(env: Record<string, string>, reason: string): Promise<void> {
  await expect(resolve(env)).rejects.toMatchObject({
    code: 1,
    stdout: '',
    stderr: `Nodeterm Codex identity refused: ${reason}.\n`
  })
}

describe('codex thread identity prelude', () => {
  it('is valid POSIX sh', async () => {
    await expect(run('/bin/sh', ['-n', script])).resolves.toBeTruthy()
  })

  it('recovers the node binding a tool shell never inherited', async () => {
    record('thread-1', `nodeId=node-7\nendpoint=${dir}/hook-endpoint.env\nsignature=x\n`)
    expect(await resolve({ CODEX_THREAD_ID: 'thread-1' })).toBe(
      `node-7|${dir}/hook-endpoint.env|1`
    )
  })

  it('recovers the exact thread even when the daemon left a stale node id', async () => {
    record('thread-1', `nodeId=node-7\nendpoint=${dir}/hook-endpoint.env\nsignature=x\n`)
    expect(await resolve({ CODEX_THREAD_ID: 'thread-1', NODETERM_NODE_ID: 'node-own' })).toBe(
      `node-7|${dir}/hook-endpoint.env|1`
    )
  })

  // #350, at the resolver: two projects, a codex node in each with its OWN thread. A daemon-spawned
  // tool shell for Project B's thread must recover B, including when a reused daemon retains A.
  // The lookup supplies that guarantee; a launch-time scrub cannot clean an already running daemon.
  it('cross-project isolation: a clean tool shell for project B resolves B, never A (#350)', async () => {
    record('thread-A', `nodeId=node-A\nendpoint=${dir}/hook-endpoint.env\nsignature=x\n`)
    record('thread-B', `nodeId=node-B\nendpoint=${dir}/hook-endpoint.env\nsignature=x\n`)
    const resolvedB = await resolve({ CODEX_THREAD_ID: 'thread-B' })
    expect(resolvedB).toBe(`node-B|${dir}/hook-endpoint.env|1`)
    expect(resolvedB).not.toContain('node-A')
    // And symmetrically, A's thread never resolves to B.
    expect(await resolve({ CODEX_THREAD_ID: 'thread-A' })).toBe(
      `node-A|${dir}/hook-endpoint.env|1`
    )
  })

  it('is inert for every other agent (no CODEX_THREAD_ID)', async () => {
    expect(await resolve({})).toBe('||')
    expect(await resolve(complete({ CODEX_THREAD_ID: '', NODETERM_NODE_ID: 'other-agent' }))).toBe(
      `other-agent|${dir}/hook-endpoint.env|1`
    )
  })

  it('refuses a thread id that could escape the record directory', async () => {
    await refused(complete({ CODEX_THREAD_ID: '../../etc/passwd' }), 'invalid-thread-id')
  })

  it('exports nothing when a record carries a node id or endpoint it should not', async () => {
    record('thread-bad-node', `nodeId=node 7; rm -rf /\nendpoint=${dir}/e\n`)
    await refused(complete({ CODEX_THREAD_ID: 'thread-bad-node' }), 'invalid-binding')
    record('thread-bad-ep', 'nodeId=node-7\nendpoint=relative/e\n')
    await refused(complete({ CODEX_THREAD_ID: 'thread-bad-ep' }), 'invalid-binding')
    record('thread-bad-ep2', 'nodeId=node-7\nendpoint=/etc/$(id)\n')
    await refused(complete({ CODEX_THREAD_ID: 'thread-bad-ep2' }), 'invalid-binding')
  })
})

// ── S6 PR 2: the account-scoped sh resolver, proven under real /bin/sh (Property 8, Constraint 8) ──
describe('codex thread identity prelude — account scoping', () => {
  it('binds the one matching managed scope when the daemon carries that account id', async () => {
    scopedRecord('acct-A', 'thr-1', body('node-A', 'acct-A'))
    expect(
      await resolve({ CODEX_THREAD_ID: 'thr-1', NODETERM_CODEX_ACCOUNT_ID: 'acct-A' })
    ).toBe(`node-A|${dir}/hook-endpoint.env|1`)
  })

  it('binds the single candidate across scopes when no account id is present (system record)', async () => {
    record('thr-1', body('node-sys')) // bare-root legacy/system record, no account line
    expect(await resolve({ CODEX_THREAD_ID: 'thr-1' })).toBe(`node-sys|${dir}/hook-endpoint.env|1`)
  })

  it('binds the single candidate across scopes when no account id is present (one managed record)', async () => {
    scopedRecord('acct-A', 'thr-1', body('node-A', 'acct-A'))
    expect(await resolve({ CODEX_THREAD_ID: 'thr-1' })).toBe(`node-A|${dir}/hook-endpoint.env|1`)
  })

  it('fails closed: two scopes hold the same thread id and no account env clears the map', async () => {
    scopedRecord('acct-A', 'thr-1', body('node-A', 'acct-A'))
    scopedRecord('acct-B', 'thr-1', body('node-B', 'acct-B'))
    await refused(complete({ CODEX_THREAD_ID: 'thr-1' }), 'ambiguous-binding')
  })

  it('fails closed: a system record and a managed record collide with no account env', async () => {
    record('thr-1', body('node-sys'))
    scopedRecord('acct-A', 'thr-1', body('node-A', 'acct-A'))
    await refused(complete({ CODEX_THREAD_ID: 'thr-1' }), 'ambiguous-binding')
  })

  it('clears the map when the record account line disagrees with its directory scope', async () => {
    // A record physically under acct-B but whose own line still claims acct-A: not honoured as B.
    scopedRecord('acct-B', 'thr-1', body('node-A', 'acct-A'))
    await refused(complete({ CODEX_THREAD_ID: 'thr-1', NODETERM_CODEX_ACCOUNT_ID: 'acct-B' }), 'invalid-binding')
    await refused(complete({ CODEX_THREAD_ID: 'thr-1' }), 'invalid-binding')
  })

  it('reads only the named account, not a same-thread record in another scope', async () => {
    scopedRecord('acct-A', 'thr-1', body('node-A', 'acct-A'))
    scopedRecord('acct-B', 'thr-1', body('node-B', 'acct-B'))
    // With the account id pinned, the scan never touches the other account — no ambiguity, binds B.
    expect(
      await resolve({ CODEX_THREAD_ID: 'thr-1', NODETERM_CODEX_ACCOUNT_ID: 'acct-B' })
    ).toBe(`node-B|${dir}/hook-endpoint.env|1`)
  })

  it('resolves nothing for a daemon account id that could escape the mapping directory', async () => {
    scopedRecord('acct-A', 'thr-1', body('node-A', 'acct-A'))
    await refused(complete({ CODEX_THREAD_ID: 'thr-1', NODETERM_CODEX_ACCOUNT_ID: '../acct-A' }), 'invalid-account-scope')
    await refused(complete({ CODEX_THREAD_ID: 'thr-1', NODETERM_CODEX_ACCOUNT_ID: 'system' }), 'invalid-account-scope')
  })

  it('treats explicit empty account as system, distinct from an unknown account', async () => {
    record('thr-1', body('node-sys', ''))
    scopedRecord('acct-A', 'thr-1', body('node-A', 'acct-A'))
    expect(await resolve({ CODEX_THREAD_ID: 'thr-1', NODETERM_CODEX_ACCOUNT_ID: '' })).toBe(
      `node-sys|${dir}/hook-endpoint.env|1`
    )
    await refused({ CODEX_THREAD_ID: 'thr-1' }, 'ambiguous-binding')
  })

  it('does not borrow a managed binding when the explicit system record is absent', async () => {
    scopedRecord('acct-A', 'thread-1', body('node-A', 'acct-A'))
    await refused({ CODEX_THREAD_ID: 'thread-1', NODETERM_CODEX_ACCOUNT_ID: '' }, 'missing-binding')
    expect(await resolve(complete({ NODETERM_CODEX_ACCOUNT_ID: '' }))).toBe(
      `node-own|${dir}/hook-endpoint.env|1`
    )
  })

  it('does not treat a valid candidate plus malformed evidence in another scope as unique', async () => {
    record('thread-1', body('node-own'))
    scopedRecord('acct-A', 'thread-1', 'broken')
    await refused(complete(), 'invalid-binding')
    expect(await resolve(complete({ NODETERM_CODEX_ACCOUNT_ID: '' }))).toBe(
      `node-own|${dir}/hook-endpoint.env|1`
    )
  })
})

describe('Codex ambient context precedence', () => {
  it('preserves complete direct in-process launches when the exact record is absent', async () => {
    expect(await resolve(complete())).toBe(`node-own|${dir}/hook-endpoint.env|1`)
    fs.rmSync(root, { recursive: true, force: true })
    expect(await resolve(complete())).toBe(`node-own|${dir}/hook-endpoint.env|1`)
  })

  it('accepts a matching complete context without requiring optional agent metadata', async () => {
    record('thread-1', body('node-own'))
    expect(await resolve(complete())).toBe(`node-own|${dir}/hook-endpoint.env|1`)
  })

  it.each(['1', '0', 'false'])('refuses conflicting complete context with capability value %s', async (flag) => {
    record('thread-1', body('node-current'))
    await refused(complete({ NODETERM_CANVAS_CONTROL: flag }), 'complete-context-conflict')
  })

  it('compares endpoint strings exactly, even for a path alias to the same file', async () => {
    record('thread-1', body('node-own'))
    await refused(complete({ NODETERM_HOOK_ENDPOINT: `${dir}/./hook-endpoint.env` }), 'complete-context-conflict')
  })

  const incompleteContexts: Record<string, string>[] = [
    {},
    { NODETERM_NODE_ID: 'node-own' },
    { NODETERM_NODE_ID: 'node-own', NODETERM_SERVER_CANVAS_CONTROL: '1', NODETERM_AGENT_ID: 'codex' },
    { NODETERM_NODE_ID: 'node-own', NODETERM_CANVAS_CONTROL: '1', NODETERM_HOOK_ENDPOINT: '' },
    { NODETERM_NODE_ID: '..', NODETERM_CANVAS_CONTROL: '1' }
  ]
  it.each(incompleteContexts)('refuses an incomplete context without a binding: %j', async (ambient) => {
    await refused({ CODEX_THREAD_ID: 'thread-1', NODETERM_HOOK_ENDPOINT: `${dir}/hook-endpoint.env`, ...ambient }, 'missing-binding')
  })

  it.each([
    'nodeId=node-own\n',
    'nodeId=node-own\nendpoint=/fixture.env\nsignature=\n',
    'nodeId=node-own\nnodeId=node-other\nendpoint=/fixture.env\nsignature=x\n',
    'nodeId=..\nendpoint=/fixture.env\nsignature=x\n',
    'nodeId=node-own\nendpoint=relative.env\nsignature=x\n',
    'nodeId=node-own\nendpoint=/fixture.env\nsignature=x\nunexpected=data\n'
  ])('refuses existing malformed evidence rather than preserving ambient authority: %j', async (raw) => {
    record('thread-1', raw)
    await refused(complete(), 'invalid-binding')
  })

  it('distinguishes an unreadable record from an absent direct-launch binding', async () => {
    record('thread-1', body('node-own'))
    fs.chmodSync(path.join(root, 'thread-1'), 0)
    await refused(complete(), 'unreadable-binding')
  })

  it('refuses an unreadable scope directory instead of assuming no record exists', async () => {
    fs.mkdirSync(path.join(root, 'acct-A'))
    fs.chmodSync(path.join(root, 'acct-A'), 0)
    try {
      await refused(complete(), 'unreadable-binding')
    } finally {
      fs.chmodSync(path.join(root, 'acct-A'), 0o700)
    }
  })

  it('refuses dangling record symlinks as existing evidence', async () => {
    fs.symlinkSync(path.join(dir, 'missing-record'), path.join(root, 'thread-1'))
    await refused(complete(), 'invalid-binding')
  })
})
