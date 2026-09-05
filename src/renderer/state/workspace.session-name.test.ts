import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AGENT_CONFIG, SESSION_NAME_CAPABLE } from '@shared/agents/config'
import type { AgentPermissionMode } from '@shared/agents/config'

/**
 * The COMPOSED launch line, not the composition helper.
 *
 * `withSessionName` can be right about the flag while the line `createAgentNode` types is wrong —
 * that is the failure CLAUDE.md names for `withPermissionMode`, and it applies identically here:
 * where a flag lands depends on the agent's prompt convention, which the helper never sees. So the
 * assertions below are on `data.initialCommand`, the string that is actually typed into the pane.
 *
 * The CLI caps are mocked because the flag is probe-gated: unmocked, the probe has not run in a
 * test process and every command line would (correctly) come out bare.
 */
const caps = { sessionIdFlag: false, nameFlag: true }
vi.mock('./permissionMode', () => ({
  claudeCliCapsNow: () => ({
    version: '2.1.257 (Claude Code)',
    autoPermissionMode: true,
    fullscreenTui: true,
    sessionIdFlag: caps.sessionIdFlag,
    nameFlag: caps.nameFlag
  }),
  grokCliCapsNow: () => ({ version: null, sessionIdFlag: false })
}))

const { createAgentNode } = await import('./workspace')

const CWD = '/home/dev/projects/web-app'

/** The trailing slice of the node's own id — the part of the name only that node can have. */
const discOf = (nodeId: string): string => nodeId.replace(/[^A-Za-z0-9]+/g, '').slice(-6)

/** `cwd: null` means "a project with no folder", which is a supported canvas — distinct from
 *  omitting the argument, which would take the default below. */
const launch = (
  agentId: string,
  prompt?: string,
  mode?: AgentPermissionMode,
  cwd: string | null = CWD
): { command: string; id: string } => {
  const node = createAgentNode(agentId, 0, cwd ?? undefined, undefined, prompt, undefined, undefined, mode)
  return { command: (node.data.initialCommand as string) ?? '', id: node.id }
}

beforeEach(() => {
  caps.sessionIdFlag = false
  caps.nameFlag = true
})

describe('createAgentNode — the session name on the composed launch line', () => {
  it('names a claude launch after its project, its agent and itself', () => {
    const { command, id } = launch('claude')
    expect(command).toBe(`claude --name 'web-app·Claude-Code·${discOf(id)}'`)
  })

  it('carries the launch prompt as the task segment', () => {
    const { command, id } = launch('claude', 'fix the login bug')
    expect(command).toBe(
      `claude 'fix the login bug' --name 'web-app·fix-the-login-bug·Claude-Code·${discOf(id)}'`
    )
  })

  it('lands after the permission flag, both of them after the positional prompt', () => {
    const { command, id } = launch('claude', 'fix the login bug', 'auto')
    expect(command).toBe(
      `claude 'fix the login bug' --permission-mode auto --name 'web-app·fix-the-login-bug·Claude-Code·${discOf(id)}'`
    )
  })

  it('sits beside a minted session id rather than replacing it', () => {
    caps.sessionIdFlag = true
    const { command } = launch('claude')
    expect(command).toMatch(/^claude --name '[^']+' --session-id [0-9a-f-]+$/)
  })

  it('gives two nodes in ONE directory two different names', () => {
    // The whole point. The CLI's own derived name is this directory's basename plus two hex
    // characters, which is how four sessions in one worktree end up reading as `claude-XX`.
    const a = launch('claude')
    const b = launch('claude')
    expect(a.command).not.toBe(b.command)
    expect(a.command.startsWith("claude --name 'web-app·Claude-Code·")).toBe(true)
    expect(b.command.startsWith("claude --name 'web-app·Claude-Code·")).toBe(true)
  })

  it('still names a node opened with no project directory', () => {
    const { command, id } = launch('claude', undefined, undefined, null)
    expect(command).toBe(`claude --name 'Claude-Code·${discOf(id)}'`)
  })
})

describe('createAgentNode — the flag is gated, and the ungated line is unchanged', () => {
  it('emits the bare command when the CLI does not advertise the flag', () => {
    caps.nameFlag = false
    expect(launch('claude').command).toBe('claude')
    expect(launch('claude', 'fix it', 'auto').command).toBe(
      "claude 'fix it' --permission-mode auto"
    )
  })

  it('leaves every non-capable agent byte-identical, probe or no probe', () => {
    for (const id of ['codex', 'gemini', 'grok', 'copilot', 'opencode']) {
      expect(launch(id).command).not.toContain('--name')
    }
    // grok in particular: its `--` is END OF OPTIONS, so a name appended after it would be read as
    // the first words of the prompt. Pinned on the composed line because that is the only place
    // the separator rule and the flag can meet.
    expect(launch('grok', 'explain this repo').command).toBe("grok -- 'explain this repo'")
  })

  it('refuses a remote session, whose CLI this probe knows nothing about', () => {
    // The probe reads the LOCAL claude; the command runs on the host. An unadvertised flag makes
    // the CLI exit, so guessing from this machine would take the whole launch with it — the same
    // rule the `auto` permission mode follows, where the connection carries its own probe. Until
    // there is a remote one, a remote session keeps the name its own CLI generates.
    const node = createAgentNode('claude', 0, undefined, undefined, undefined, {
      server: { host: 'box', user: 'me' },
      remoteCwd: '/srv/web-app'
    } as never)
    expect(node.data.initialCommand).toBe('claude')
  })

  /**
   * The structural reason the grok case above is safe today, asserted rather than assumed: no agent
   * that can be named has an argv prompt separator. Adding one to `SESSION_NAME_CAPABLE` reds this
   * test, which is the moment to decide where its flag belongs — not after a silent launch failure.
   */
  it('no nameable agent has an argv prompt separator', () => {
    for (const id of SESSION_NAME_CAPABLE) {
      expect(AGENT_CONFIG[id]?.argvPromptSeparator).toBeUndefined()
    }
  })
})
