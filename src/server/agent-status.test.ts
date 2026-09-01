import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { ServerPlatform } from './platform-server'
import { wireAgentStatus } from './agent-status'
import { _resetForTest } from '../core/agent-status-mirror'
import { forgetGrokSession, grokSessionDirFor, readGrokSessionName } from '../core/grok-session'
import {
  registerClaudeAccountsSource,
  resetClaudeAccountsSourceForTests
} from '../core/claude-config-dir'
import { IPC } from '../shared/ipc'
import { decodePtyData } from '../shared/rpc'

// A fake hook server that captures the listeners wireAgentStatus installs, so the test can
// fire raw + normalized events without binding a real port.
function fakeHooks() {
  let listener: ((e: unknown) => void) | undefined
  let raw:
    | ((
        agentId: string,
        nodeId: string,
        payload: Record<string, unknown>,
        meta: { verified: boolean }
      ) => void)
    | undefined
  return {
    hooks: {
      setListener: (cb: (e: unknown) => void) => {
        listener = cb
      },
      setRawListener: (cb: typeof raw) => {
        raw = cb
      }
    },
    fireNormalized: (e: unknown) => listener?.(e),
    // `verified` defaults to false — the unlabelled/legacy POST, which is the ordinary case and the
    // one every existing expectation in this file was written against.
    fireRaw: (
      agentId: string,
      nodeId: string,
      payload: Record<string, unknown>,
      verified = false
    ) => raw?.(agentId, nodeId, payload, { verified })
  }
}

// A recording tail so we can assert track/finish without touching the filesystem.
function recTail() {
  const calls: Array<{ m: string; args: unknown[] }> = []
  return {
    tail: {
      track: (...args: unknown[]) => calls.push({ m: 'track', args }),
      trackFile: (...args: unknown[]) => calls.push({ m: 'trackFile', args }),
      finish: (...args: unknown[]) => calls.push({ m: 'finish', args }),
      untrack: (...args: unknown[]) => calls.push({ m: 'untrack', args })
    },
    calls
  }
}

let dir: string, platform: ServerPlatform, sent: Array<{ channel: string; args: unknown[] }>
beforeEach(() => {
  _resetForTest() // isolate the mirror singleton (stash/state) between tests
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-agst-'))
  platform = new ServerPlatform({ userDataDir: dir, appVersion: '0' })
  sent = []
  // capture broadcasts by attaching a recording sink
  platform.attach({
    sendText: (json) => sent.push(JSON.parse(json)),
    sendBinary: (buf) => {
      const f = decodePtyData(buf)
      if (f) sent.push({ channel: `pty:data:${f.sessionId}`, args: [f.data] })
    }
  })
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
  resetClaudeAccountsSourceForTests()
  _resetForTest()
})

// Newest agent:status broadcast payload (the enriched event the shell records-then-broadcasts).
function lastAgentStatus(): Record<string, unknown> | undefined {
  for (let i = sent.length - 1; i >= 0; i--) {
    const m = sent[i] as { channel?: string; args?: unknown[] }
    if (m.channel === IPC.agentStatus) return m.args?.[0] as Record<string, unknown>
  }
  return undefined
}

describe('wireAgentStatus', () => {
  it('broadcasts a normalized agent event on agent:status', () => {
    const fh = fakeHooks()
    wireAgentStatus(platform, { hooks: fh.hooks as never })
    const ev = { nodeId: 'n1', agentId: 'claude', kind: 'state', state: 'working' }
    fh.fireNormalized(ev)
    expect(sent).toContainEqual({ t: 'ev', channel: IPC.agentStatus, args: [ev] })
  })

  it('broadcasts the ENRICHED event: an AskUserQuestion blocked edge loses its pendingId (askKind question)', () => {
    const fh = fakeHooks()
    wireAgentStatus(platform, { hooks: fh.hooks as never })
    // The raw AskUserQuestion PreToolUse stashes the picker options (recordRawToolEvent).
    fh.fireRaw('claude', 'q1', {
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_input: { questions: [{ question: 'Which theme?', options: [{ label: 'Dark' }, { label: 'Light' }] }] }
    })
    // The CLI then signals the picker as a permission-style blocked carrying a held-hook pendingId.
    fh.fireNormalized({ nodeId: 'q1', agentId: 'claude', kind: 'state', state: 'blocked', pendingId: 'q1-1-1' })
    const e = lastAgentStatus()!
    expect(e.state).toBe('blocked')
    expect(e.askKind).toBe('question')
    // The pendingId is STRIPPED so the canvas approve/deny gate (blocked && pendingId) never fires.
    expect('pendingId' in e).toBe(false)
  })

  it('broadcasts a genuine approval unchanged (keeps pendingId, askKind approval)', () => {
    const fh = fakeHooks()
    wireAgentStatus(platform, { hooks: fh.hooks as never })
    // No AskUserQuestion stash → a blocked edge stays a real permission request.
    fh.fireNormalized({ nodeId: 'a1', agentId: 'claude', kind: 'state', state: 'blocked', pendingId: 'a1-1-1' })
    const e = lastAgentStatus()!
    expect(e.state).toBe('blocked')
    expect(e.askKind).toBe('approval')
    expect(e.pendingId).toBe('a1-1-1')
  })

  it('tracks a subagent on PreToolUse(Task) and finishes it on PostToolUse', () => {
    const fh = fakeHooks()
    const sub = recTail()
    wireAgentStatus(platform, { hooks: fh.hooks as never, subagentTail: sub.tail as never })
    // PreToolUse for a subagent tool → track
    fh.fireRaw('claude', 'n1', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Task',
      tool_use_id: 'tu1',
      session_id: 's1'
    })
    expect(sub.calls.some((c) => c.m === 'track' && c.args[0] === 'tu1')).toBe(true)
    // PostToolUse (non-async) → finish
    fh.fireRaw('claude', 'n1', {
      hook_event_name: 'PostToolUse',
      tool_name: 'Task',
      tool_use_id: 'tu1',
      session_id: 's1',
      tool_response: { status: 'success' }
    })
    expect(sub.calls.some((c) => c.m === 'finish' && c.args[0] === 'tu1')).toBe(true)
  })

  it('ignores non-claude raw events', () => {
    const fh = fakeHooks()
    const sub = recTail()
    wireAgentStatus(platform, { hooks: fh.hooks as never, subagentTail: sub.tail as never })
    fh.fireRaw('codex', 'n1', { hook_event_name: 'PreToolUse', tool_name: 'Task', tool_use_id: 'x' })
    expect(sub.calls).toEqual([])
  })

  // Codex subagents (spawn_agent): payload shapes from the live codex-cli 0.146.0 capture —
  // SubagentStart's transcript_path is the CHILD's rollout, keyed by agent_id.
  it('codex SubagentStart tails the child rollout via trackFile, SubagentStop finishes it', () => {
    const fh = fakeHooks()
    const sub = recTail()
    wireAgentStatus(platform, { hooks: fh.hooks as never, subagentTail: sub.tail as never })
    const childPath = path.join(os.homedir(), '.codex', 'sessions', '2026', '08', '24', 'rollout-child.jsonl')
    fh.fireRaw('codex', 'n1', {
      hook_event_name: 'SubagentStart',
      session_id: 'parent-s',
      transcript_path: childPath,
      agent_id: 'agent-1',
      agent_type: 'default'
    })
    const tf = sub.calls.find((c) => c.m === 'trackFile')
    expect(tf?.args[0]).toBe('agent-1')
    expect(tf?.args[1]).toBe(path.resolve(childPath))
    fh.fireRaw('codex', 'n1', {
      hook_event_name: 'SubagentStop',
      session_id: 'parent-s',
      agent_id: 'agent-1',
      agent_type: 'default',
      last_assistant_message: 'done'
    })
    expect(sub.calls.some((c) => c.m === 'finish' && c.args[0] === 'agent-1')).toBe(true)
  })

  it('a codex SubagentStart outside the transcript jail does not tail anything', () => {
    const fh = fakeHooks()
    const sub = recTail()
    wireAgentStatus(platform, { hooks: fh.hooks as never, subagentTail: sub.tail as never })
    fh.fireRaw('codex', 'n1', {
      hook_event_name: 'SubagentStart',
      session_id: 'parent-s',
      transcript_path: path.join(os.homedir(), '.ssh', 'id_rsa'),
      agent_id: 'agent-evil'
    })
    const tf = sub.calls.find((c) => c.m === 'trackFile')
    expect(tf?.args[1]).toBeUndefined() // jailed → tail ignores it
  })

  it("a codex child's agent_id-tagged tool event neither tracks a subagent nor throws", () => {
    const fh = fakeHooks()
    const sub = recTail()
    wireAgentStatus(platform, { hooks: fh.hooks as never, subagentTail: sub.tail as never })
    fh.fireRaw('codex', 'n1', {
      hook_event_name: 'PreToolUse',
      session_id: 'parent-s',
      agent_id: 'agent-1',
      agent_type: 'default',
      tool_name: 'Bash',
      tool_input: { command: 'echo hi' },
      transcript_path: path.join(os.homedir(), '.codex', 'sessions', 'child.jsonl')
    })
    expect(sub.calls).toEqual([])
  })

  it('codex SubagentStop finish is covered by ptyDestroy cleanup too', () => {
    const fh = fakeHooks()
    const sub = recTail()
    wireAgentStatus(platform, { hooks: fh.hooks as never, subagentTail: sub.tail as never })
    const childPath = path.join(os.homedir(), '.codex', 'sessions', 'rollout-child.jsonl')
    fh.fireRaw('codex', 'n1', {
      hook_event_name: 'SubagentStart',
      session_id: 'parent-s',
      transcript_path: childPath,
      agent_id: 'agent-1'
    })
    platform.cast(platform.attach({ sendText: () => {}, sendBinary: () => {} }), IPC.ptyDestroy, ['n1'])
    expect(sub.calls.some((c) => c.m === 'finish' && c.args[0] === 'agent-1')).toBe(true)
  })

  it('ptyDestroy untracks the node context tail and finishes its subagents, clearing the maps', () => {
    const fh = fakeHooks()
    const sub = recTail()
    const ctx = recTail()
    wireAgentStatus(platform, {
      hooks: fh.hooks as never,
      subagentTail: sub.tail as never,
      contextTail: ctx.tail as never
    })
    // A safe local transcript path so contextTail.track runs and nodeContextSession is set.
    const transcriptPath = path.join(os.homedir(), '.claude', 'projects', 't.jsonl')
    // Populate the maps: a raw PreToolUse(Task) sets nodeContextSession + tracks a subagent.
    fh.fireRaw('claude', 'n1', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Task',
      tool_use_id: 'tu1',
      session_id: 's1',
      transcript_path: transcriptPath
    })
    // Node closes → ptyDestroy cast fires the teardown listener.
    platform.cast(
      platform.attach({ sendText: () => {}, sendBinary: () => {} }),
      IPC.ptyDestroy,
      ['n1']
    )
    expect(ctx.calls.some((c) => c.m === 'untrack' && c.args[0] === 's1')).toBe(true)
    expect(sub.calls.some((c) => c.m === 'finish' && c.args[0] === 'tu1')).toBe(true)
    // Re-destroying the same node is a harmless no-op (maps already cleared).
    const before = ctx.calls.length + sub.calls.length
    platform.cast(
      platform.attach({ sendText: () => {}, sendBinary: () => {} }),
      IPC.ptyDestroy,
      ['n1']
    )
    expect(ctx.calls.length + sub.calls.length).toBe(before)
  })
})

// The transcript jail on THIS shell, and the linked half of it (design D4 / §3). Both raw
// listeners have to learn the same widening or the Server Edition silently keeps the pre-fix
// behavior for a pane running the user's own `CLAUDE_CONFIG_DIR` — the "both raw listeners change
// together" rule, which this repo has broken three times.
describe('wireAgentStatus — the transcript jail admits LINKED config dirs', () => {
  it('tracks a transcript under <linkedDir>/projects, and refuses everything else in that dir', () => {
    const linked = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-linked-jail-'))
    try {
      registerClaudeAccountsSource(() => [
        { id: 'linked-1', label: 'second', configDir: linked, createdAt: 0 }
      ])
      const fh = fakeHooks()
      const ctx = recTail()
      wireAgentStatus(platform, { hooks: fh.hooks as never, contextTail: ctx.tail as never })
      const ok = path.join(linked, 'projects', '-repo', 's1.jsonl')
      fh.fireRaw('claude', 'n1', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Read',
        session_id: 's1',
        transcript_path: ok
      })
      expect(ctx.calls.some((c) => c.m === 'track' && c.args[1] === ok)).toBe(true)
      // The linked dir is not opened up wholesale: the segment after it must be `projects`.
      const before = ctx.calls.length
      fh.fireRaw('claude', 'n2', {
        hook_event_name: 'PreToolUse',
        tool_name: 'Read',
        session_id: 's2',
        transcript_path: path.join(linked, '.ssh', 'id_rsa')
      })
      expect(ctx.calls.length).toBe(before)
    } finally {
      fs.rmSync(linked, { recursive: true, force: true })
    }
  })

  it('refuses that same path when the dir is NOT in settings (the jail reads settings, not the POST)', () => {
    const fh = fakeHooks()
    const ctx = recTail()
    wireAgentStatus(platform, { hooks: fh.hooks as never, contextTail: ctx.tail as never })
    fh.fireRaw('claude', 'n1', {
      hook_event_name: 'PreToolUse',
      tool_name: 'Read',
      session_id: 's1',
      transcript_path: path.join(os.tmpdir(), 'not-linked', 'projects', 's1.jsonl')
    })
    expect(ctx.calls.filter((c) => c.m === 'track' && c.args[1] !== undefined)).toEqual([])
  })
})

/**
 * The grok branch of the raw listener (`src/server/agent-status.ts`) had no coverage at all: a
 * mutation to `if (false && agentId === 'grok')` left the whole suite green. It is the only place
 * that records what grok's envelope never states — the node's session id and, from (cwd, sessionId),
 * the session DIRECTORY that makes `readGrokSessionName` a direct open instead of a scan of grok's
 * sessions tree — and it must run BEFORE the `if (agentId !== 'claude') return` guard that keeps grok
 * payloads out of claude's transcript machinery. Both mutations (disable the branch, or move it below
 * that guard) fail these tests.
 */
describe('wireAgentStatus — the grok raw-listener branch', () => {
  let grokHome: string, prevGrokHome: string | undefined
  beforeEach(() => {
    // Pin $GROK_HOME so the derived path is the test's own, not the developer's ~/.grok. Read
    // per-call by grokHomeDir(), so setting it here is enough.
    prevGrokHome = process.env.GROK_HOME
    grokHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-grok-'))
    process.env.GROK_HOME = grokHome
  })
  afterEach(() => {
    if (prevGrokHome === undefined) delete process.env.GROK_HOME
    else process.env.GROK_HOME = prevGrokHome
    fs.rmSync(grokHome, { recursive: true, force: true })
  })

  // Where grok stores a session: $GROK_HOME/sessions/<url-encoded cwd>/<id>/ (core/agents/grok-paths.ts).
  // Spelled out literally rather than composed with grokSessionDir(), so the assertion is about the
  // LAYOUT and not a restatement of the function under test.
  const sessionDir = (cwd: string, id: string): string =>
    path.join(grokHome, 'sessions', encodeURIComponent(cwd), id)

  it('records nodeId → sessionId (proved by ptyDestroy untracking that grok session)', () => {
    const fh = fakeHooks()
    const ctx = recTail()
    wireAgentStatus(platform, { hooks: fh.hooks as never, contextTail: ctx.tail as never })
    // grok's own dialect: camelCase keys, snake_case event VALUE, and no transcript_path at all.
    fh.fireRaw('grok', 'g1', {
      hookEventName: 'user_prompt_submit',
      sessionId: 'gs-1',
      cwd: '/w/project'
    })
    // The association is private, but `releaseNodeTails` reads it — so a node teardown untracking
    // 'gs-1' can only mean the grok branch put it there.
    platform.cast(platform.attach({ sendText: () => {}, sendBinary: () => {} }), IPC.ptyDestroy, ['g1'])
    expect(ctx.calls.some((c) => c.m === 'untrack' && c.args[0] === 'gs-1')).toBe(true)
  })

  it('remembers the DERIVED session directory, so the session name is a direct open', async () => {
    const fh = fakeHooks()
    const ctx = recTail()
    wireAgentStatus(platform, { hooks: fh.hooks as never, contextTail: ctx.tail as never })
    // A real session directory with a real summary.json, at the path grok's layout dictates.
    const dir = sessionDir('/w/project', 'gs-2')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'summary.json'), JSON.stringify({ generated_title: 'Ship the parser' }))
    // Nothing is known before the hook: the map is fed ONLY here.
    expect(grokSessionDirFor('gs-2')).toBeUndefined()
    fh.fireRaw('grok', 'g2', { hookEventName: 'pre_tool_use', sessionId: 'gs-2', cwd: '/w/project' })
    expect(grokSessionDirFor('gs-2')).toBe(dir)
    expect(await readGrokSessionName('gs-2')).toBe('Ship the parser')
    forgetGrokSession('gs-2')
  })

  it('reads the SDK snake_case dialect too (one decoder: grokRawFields)', () => {
    const fh = fakeHooks()
    wireAgentStatus(platform, { hooks: fh.hooks as never, contextTail: recTail().tail as never })
    fh.fireRaw('grok', 'g3', {
      hook_event_name: 'post_tool_use',
      session_id: 'gs-3',
      cwd: '/w/other'
    })
    expect(grokSessionDirFor('gs-3')).toBe(sessionDir('/w/other', 'gs-3'))
    forgetGrokSession('gs-3')
  })

  it('forgets the session directory on session_end', () => {
    const fh = fakeHooks()
    wireAgentStatus(platform, { hooks: fh.hooks as never, contextTail: recTail().tail as never })
    fh.fireRaw('grok', 'g4', { hookEventName: 'session_start', sessionId: 'gs-4', cwd: '/w/project' })
    expect(grokSessionDirFor('gs-4')).toBe(sessionDir('/w/project', 'gs-4'))
    fh.fireRaw('grok', 'g4', { hookEventName: 'session_end', sessionId: 'gs-4', cwd: '/w/project' })
    expect(grokSessionDirFor('gs-4')).toBeUndefined()
  })

  it('learns nothing rather than half a path when the cwd is not reconstructible', () => {
    const fh = fakeHooks()
    wireAgentStatus(platform, { hooks: fh.hooks as never, contextTail: recTail().tail as never })
    // Past GROK_ENCODED_CWD_MAX_BYTES grok switches to a slug+hash directory we cannot rebuild.
    fh.fireRaw('grok', 'g5', {
      hookEventName: 'pre_tool_use',
      sessionId: 'gs-5',
      cwd: `/w/${'x'.repeat(400)}`
    })
    expect(grokSessionDirFor('gs-5')).toBeUndefined()
  })
})
