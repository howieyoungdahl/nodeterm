import { describe, it, expect } from 'vitest'
import {
  buildLinkDoc,
  buildContextLinkSkillBody,
  buildLinkedContextInstructions,
  mergeInstructionsBlock,
  resolveLinkTranscript,
  setNodeTranscript,
  shimPathForAgentDocs,
  transcriptPathOf,
  CONTEXT_SHIM_SCRIPT,
  CONTEXT_UNREACHABLE_MSG
} from './context-link-core'
import { CODEX_SANDBOX_BLOCKED_LINE } from './agents/hook-sandbox-hint-sh'

describe('buildLinkDoc', () => {
  it('enriches each link with tmux name, injected transcript path, and cwd', () => {
    const doc = buildLinkDoc(
      'node-A',
      [
        { id: 'node-B', title: 'Builder', cwd: '/proj' },
        { id: 'node-C', title: 'Tester' }
      ],
      {
        transcriptOf: (id) => (id === 'node-B' ? '/t/b.jsonl' : ''),
        tmuxBin: '/usr/bin/tmux',
        tmuxSocket: 'node-terminal'
      }
    )
    expect(doc.self).toEqual({ id: 'node-A' })
    expect(doc.tmuxBin).toBe('/usr/bin/tmux')
    expect(doc.tmuxSocket).toBe('node-terminal')
    expect(doc.links).toEqual([
      { id: 'node-B', title: 'Builder', cwd: '/proj', transcriptPath: '/t/b.jsonl', tmux: 'nt-node-B' },
      { id: 'node-C', title: 'Tester', cwd: '', transcriptPath: '', tmux: 'nt-node-C' }
    ])
  })

  it('carries a sticky note through with empty transcript/tmux', () => {
    const doc = buildLinkDoc('node-A', [{ id: 'note-1', title: 'Deploy notes', note: 'use staging' }], {
      transcriptOf: () => '/should/not/be/used.jsonl',
      tmuxBin: '/usr/bin/tmux',
      tmuxSocket: 'node-terminal'
    })
    expect(doc.links).toEqual([
      { id: 'note-1', title: 'Deploy notes', cwd: '', transcriptPath: '', tmux: '', note: 'use staging' }
    ])
  })

  it('sanitizes the tmux session name like the pty manager', () => {
    const doc = buildLinkDoc('x', [{ id: 'a b/c.d', title: 'T' }], {
      transcriptOf: () => '',
      tmuxBin: null,
      tmuxSocket: 's'
    })
    expect(doc.links[0].tmux).toBe('nt-a_b_c_d')
  })
})

describe('buildLinkDoc agent field', () => {
  it('copies agentId onto the entry; notes get none', () => {
    const doc = buildLinkDoc(
      'node-A',
      [
        { id: 'node-B', title: 'B', cwd: '', agentId: 'codex' },
        { id: 'note-1', title: 'N', note: 'txt' }
      ],
      { transcriptOf: () => '', tmuxBin: null, tmuxSocket: 's' }
    )
    expect(doc.links[0].agent).toBe('codex')
    expect(doc.links[1].agent).toBeUndefined()
  })
})

describe('buildLinkDoc sessionId field', () => {
  it('copies sessionId onto the entry (opencode exports by id); notes get none', () => {
    const doc = buildLinkDoc(
      'node-A',
      [
        { id: 'node-O', title: 'O', cwd: '', agentId: 'opencode', sessionId: 'ses_1' },
        { id: 'node-B', title: 'B', cwd: '', agentId: 'codex' },
        { id: 'note-1', title: 'N', note: 'txt' }
      ],
      { transcriptOf: () => '', tmuxBin: null, tmuxSocket: 's' }
    )
    expect(doc.links[0].sessionId).toBe('ses_1')
    expect(doc.links[1].sessionId).toBeUndefined()
    expect(doc.links[2].sessionId).toBeUndefined()
  })
})

describe('resolveLinkTranscript', () => {
  const locators = {
    claude: async (sid: string, acct?: string) => `/c/${acct ?? 'default'}/${sid}.jsonl`,
    codex: async (sid: string) => `/x/${sid}.jsonl`,
    gemini: async (sid: string) => `/g/${sid}.jsonl`
  }
  // A REMOTE node's transcript is on the host; these locators search THIS machine's disk. Without
  // the guard they resolve happily and the agent reads an unrelated local session's conversation
  // with no sign anything is wrong — so the guard must win even where a locator WOULD have answered.
  it('never consults the local locators for a remote node', async () => {
    const link = { id: 'n1', title: 'T', agentId: 'codex', sessionId: 's1' }
    const local = await resolveLinkTranscript(link, { hooked: () => '', locators })
    expect(local).toBe('/x/s1.jsonl') // proves the locator WOULD have answered
    const remote = await resolveLinkTranscript(link, {
      hooked: () => '',
      locators,
      isRemote: () => true
    })
    expect(remote).toBe('')
  })

  it("still prefers a remote node's hook-fed path (the only trustworthy source there)", async () => {
    const p = await resolveLinkTranscript(
      { id: 'n1', title: 'T', agentId: 'claude', sessionId: 's1' },
      { hooked: () => '/remote/jailed.jsonl', locators, isRemote: () => true }
    )
    expect(p).toBe('/remote/jailed.jsonl')
  })

  it('claude prefers the hook-fed path', async () => {
    const p = await resolveLinkTranscript(
      { id: 'n1', title: 'T', agentId: 'claude', sessionId: 's1' },
      { hooked: () => '/hooked.jsonl', locators }
    )
    expect(p).toBe('/hooked.jsonl')
  })
  it('claude falls back to the locator with accountId when hooks have nothing', async () => {
    const p = await resolveLinkTranscript(
      { id: 'n1', title: 'T', agentId: 'claude', sessionId: 's1', accountId: 'a1' },
      { hooked: () => '', locators }
    )
    expect(p).toBe('/c/a1/s1.jsonl')
  })
  it('a legacy entry without agentId behaves like claude', async () => {
    const p = await resolveLinkTranscript(
      { id: 'n1', title: 'T' },
      { hooked: () => '/hooked.jsonl', locators }
    )
    expect(p).toBe('/hooked.jsonl')
  })
  it('codex and gemini resolve via their locator by sessionId', async () => {
    expect(
      await resolveLinkTranscript({ id: 'n', title: 'T', agentId: 'codex', sessionId: 's2' }, { hooked: () => '/hooked', locators })
    ).toBe('/x/s2.jsonl')
    expect(
      await resolveLinkTranscript({ id: 'n', title: 'T', agentId: 'gemini', sessionId: 's3' }, { hooked: () => '/hooked', locators })
    ).toBe('/g/s3.jsonl')
  })
  it('resolves empty on: note entries, missing sessionId, unknown agent, locator throw', async () => {
    const base = { hooked: () => '', locators }
    expect(await resolveLinkTranscript({ id: 'n', title: 'T', note: 'x' }, base)).toBe('')
    expect(await resolveLinkTranscript({ id: 'n', title: 'T', agentId: 'codex' }, base)).toBe('')
    expect(await resolveLinkTranscript({ id: 'n', title: 'T', agentId: 'custom:x', sessionId: 's' }, base)).toBe('')
    expect(
      await resolveLinkTranscript(
        { id: 'n', title: 'T', agentId: 'codex', sessionId: 's' },
        { hooked: () => '', locators: { codex: async () => { throw new Error('boom') } } }
      )
    ).toBe('')
  })
})

describe('setNodeTranscript / transcriptPathOf', () => {
  it('stores and returns the transcript path by node id', () => {
    setNodeTranscript('n1', 'sess', '/path/one.jsonl')
    expect(transcriptPathOf('n1')).toBe('/path/one.jsonl')
  })
  it('ignores empty node id or path', () => {
    setNodeTranscript('', 's', '/p.jsonl')
    setNodeTranscript('n2', 's', '')
    expect(transcriptPathOf('n2')).toBe('')
  })
  it('returns empty string for an unknown node', () => {
    expect(transcriptPathOf('nope')).toBe('')
  })
})

describe('mergeInstructionsBlock', () => {
  const block = 'Use the CLI: sh "/x/context.sh" list'
  it('appends the marker-delimited block to existing content', () => {
    const out = mergeInstructionsBlock('# My rules\n\nBe nice.\n', block)
    expect(out).toContain('# My rules')
    expect(out).toContain('<!-- nodeterm:get-linked-context:start -->')
    expect(out).toContain(block)
    expect(out).toContain('<!-- nodeterm:get-linked-context:end -->')
  })
  it('is idempotent: re-merging replaces the block in place', () => {
    const once = mergeInstructionsBlock('# My rules\n', block)
    const twice = mergeInstructionsBlock(once, 'UPDATED body')
    expect(twice.match(/nodeterm:get-linked-context:start/g)).toHaveLength(1)
    expect(twice).toContain('UPDATED body')
    expect(twice).not.toContain('sh "/x/context.sh" list')
    expect(twice).toContain('# My rules')
  })
  it('works on an empty file', () => {
    const out = mergeInstructionsBlock('', block)
    expect(out.startsWith('<!-- nodeterm:get-linked-context:start -->')).toBe(true)
  })
})

describe('buildLinkedContextInstructions', () => {
  it('embeds the shim path and the four commands', () => {
    const s = buildLinkedContextInstructions('/x/context.sh')
    expect(s).toContain('sh "/x/context.sh" list')
    expect(s).toContain('summary')
    expect(s).toContain('transcript')
    expect(s).toContain('terminal')
  })

  // Issue #367 — same parity discipline as canvas-control-core.test.ts: the shim's error
  // sentences and the docs explaining them share constants, so neither can drift alone. The
  // runtime behaviour is proven against real /bin/sh in context-link.cli.test.ts.
  it('both agent-facing texts carry the codex-sandbox transport guidance (issue #367)', () => {
    for (const body of [buildContextLinkSkillBody('/x/context.sh'), buildLinkedContextInstructions('/x/context.sh')]) {
      expect(body).toContain(CONTEXT_UNREACHABLE_MSG.replace(/\.$/, ''))
      expect(body).toContain(CODEX_SANDBOX_BLOCKED_LINE)
      expect(body.toLowerCase()).toContain('escalated permissions')
      expect(body).toMatch(/never relink, reinstall or restart nodeterm/)
      expect(body).toContain('network.allow_unix_sockets')
      expect(body).toContain('~/.codex/config.toml')
    }
  })

  it('the shim embeds the sandbox hint, keeping the generic sentence for the non-sandbox case', () => {
    expect(CONTEXT_SHIM_SCRIPT).toContain('nt_codex_sandbox_hint() {')
    expect(CONTEXT_SHIM_SCRIPT).toContain('nt_codex_sandbox_hint && exit 1')
    expect(CONTEXT_SHIM_SCRIPT).toContain(`echo "${CONTEXT_UNREACHABLE_MSG}" >&2`)
  })
})

// The context-link shim is generated source that no compiler ever checks, and it is the only
// context-link client. A quoting or `for`-list slip in it fails silently on the user's machine —
// and, for an SSH project, on a machine we cannot inspect. `sh -n` is the cheap half of the
// discipline the canvas-control shim gets in full (canvas-control-shim.test.ts runs that one for
// real); the two share `nt_read_node_token`, so the behaviour is covered there.
describe('the context-link shim', () => {
  it('is valid POSIX sh', async () => {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const fs = await import('node:fs')
    const os = await import('node:os')
    const path = await import('node:path')
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeterm-context-shim-'))
    const file = path.join(dir, 'context.sh')
    fs.writeFileSync(file, CONTEXT_SHIM_SCRIPT, { mode: 0o755 })
    try {
      await expect(promisify(execFile)('/bin/sh', ['-n', file])).resolves.toBeTruthy()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('resolves the per-node token through the one shared reader (#384)', () => {
    // Not a second copy of `head -n 1 "$NODETERM_NODE_TOKEN_DIR/…"`: that copy is what left a
    // session pinned to a pre-v2 endpoint file presenting nothing for its whole life.
    expect(CONTEXT_SHIM_SCRIPT).toContain('nt_read_node_token')
    expect(CONTEXT_SHIM_SCRIPT).not.toContain('nt_node_token=$(head -n 1 "$NODETERM_NODE_TOKEN_DIR')
  })
})

describe('shimPathForAgentDocs', () => {
  // These strings are written into files the USER owns and that are routinely dotfile-managed or
  // symlinked out of a synced directory (this repo's own `~/.claude` is one). An absolute home
  // path baked into them makes the generated file differ on every machine.
  const HOME = '/home/ada'

  it('emits $HOME for a shim under the home directory', () => {
    expect(shimPathForAgentDocs('/home/ada/.nodeterm-server/context-links/context.sh', HOME)).toBe(
      '$HOME/.nodeterm-server/context-links/context.sh'
    )
  })

  it('keeps an absolute path that is outside the home directory', () => {
    // A data dir on another volume must still resolve; `$HOME` buys nothing there.
    const p = '/mnt/data/nodeterm/context-links/context.sh'
    expect(shimPathForAgentDocs(p, HOME)).toBe(p)
  })

  it('does not treat a sibling home as a prefix match', () => {
    // `/home/adam` starts with `/home/ada` as a string; without requiring the separator this
    // would emit `$HOMEm/...`, a path that silently does not exist.
    const p = '/home/adam/.nodeterm-server/context-links/context.sh'
    expect(shimPathForAgentDocs(p, HOME)).toBe(p)
  })

  it('tolerates a trailing separator on the home directory', () => {
    expect(shimPathForAgentDocs('/home/ada/x/context.sh', '/home/ada/')).toBe('$HOME/x/context.sh')
  })

  it('leaves a Windows path alone', () => {
    // `$HOME` is a POSIX-shell variable and these lines are quoted into `sh`; rewriting a Windows
    // path would emit a command that cannot run.
    const p = 'C:\\Users\\ada\\AppData\\nodeterm\\context-links\\context.sh'
    expect(shimPathForAgentDocs(p, 'C:\\Users\\ada')).toBe(p)
  })

  it('returns the path unchanged when the home directory is unknown', () => {
    // `os.homedir()` can return '' in a stripped environment. Failing open leaves the previous
    // absolute-path behaviour rather than emitting a bare `$HOME`-rooted guess.
    const p = '/home/ada/.nodeterm-server/context-links/context.sh'
    expect(shimPathForAgentDocs(p, '')).toBe(p)
  })

  it('is what the generated agent-facing docs actually carry', () => {
    // The unit above can pass while the composed document still interpolates the absolute path,
    // so assert the rendered bodies too — both files we write into the user's config dirs.
    const rendered = shimPathForAgentDocs('/home/ada/.nodeterm-server/context-links/context.sh', HOME)
    const skill = buildContextLinkSkillBody(rendered)
    const instructions = buildLinkedContextInstructions(rendered)
    for (const doc of [skill, instructions]) {
      expect(doc).toContain('$HOME/.nodeterm-server/context-links/context.sh')
      expect(doc).not.toContain('/home/ada/.nodeterm-server')
    }
  })
})
