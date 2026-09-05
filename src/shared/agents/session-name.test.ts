import { describe, expect, it } from 'vitest'
import {
  buildSessionName,
  sessionNameForNode,
  withSessionName,
  SESSION_NAME_FALLBACK,
  SESSION_NAME_MAX
} from './session-name'

/** A canvas node id has the shape the factory mints: `<prefix>-<base36 time>-<8 hex>`. */
const NODE_A = 'term-mtnqknnm-fa9afef0'
const NODE_B = 'term-mtnqknnm-1c30d422'

describe('buildSessionName — the shape, and how it degrades', () => {
  it('carries project, task, role and a per-node discriminator', () => {
    expect(
      buildSessionName({ project: 'web-app', task: 'fix the login bug', role: 'Claude', nodeId: NODE_A })
    ).toBe('web-app·fix-the-login-bug·Claude·9afef0')
  })

  it('drops the task when there is none', () => {
    expect(buildSessionName({ project: 'web-app', role: 'Claude', nodeId: NODE_A })).toBe(
      'web-app·Claude·9afef0'
    )
  })

  it('drops the role too, and then the project', () => {
    expect(buildSessionName({ project: 'web-app', nodeId: NODE_A })).toBe('web-app·9afef0')
    expect(buildSessionName({ nodeId: NODE_A })).toBe(`${SESSION_NAME_FALLBACK}·9afef0`)
  })

  it('is never empty and never just a number', () => {
    // Nothing usable at all: no id to discriminate on, no words to describe with.
    expect(buildSessionName({})).toBe(SESSION_NAME_FALLBACK)
    // An id and nothing else must still say what it is — a bare `9afef0` in a picker of 227 rows
    // tells the reader nothing.
    expect(buildSessionName({ nodeId: NODE_A })).not.toMatch(/^[0-9a-f]+$/)
  })

  it('does not repeat a segment that duplicates one before it', () => {
    // A node whose title is still its agent's label reaches here as task === role.
    expect(buildSessionName({ project: 'web-app', task: 'Claude', role: 'Claude', nodeId: NODE_A })).toBe(
      'web-app·Claude·9afef0'
    )
  })
})

describe('buildSessionName — collision resistance', () => {
  it('separates two nodes that share EVERYTHING else', () => {
    // The failure this exists for: the CLI's own derived name is the cwd basename plus two hex
    // characters, so four sessions opened in one directory read as `claude-XX` four times.
    const a = buildSessionName({ project: 'web-app', role: 'Claude', nodeId: NODE_A })
    const b = buildSessionName({ project: 'web-app', role: 'Claude', nodeId: NODE_B })
    expect(a).not.toBe(b)
    expect(a.startsWith('web-app·Claude·')).toBe(true)
    expect(b.startsWith('web-app·Claude·')).toBe(true)
  })

  it('keeps the discriminator when the descriptive part is truncated', () => {
    // Truncation must not be able to turn two names into one. Both nodes carry the same overlong
    // task, so only the tail tells them apart — and the tail is what survives.
    const long = 'refactor the workspace serializer and every one of its call sites'
    const a = buildSessionName({ project: 'api-service', task: long, role: 'Claude', nodeId: NODE_A })
    const b = buildSessionName({ project: 'api-service', task: long, role: 'Claude', nodeId: NODE_B })
    expect(a).not.toBe(b)
    expect(a.endsWith('·9afef0')).toBe(true)
    expect(b.endsWith('·0d422')).toBe(false)
    expect(b.endsWith('·30d422')).toBe(true)
  })
})

describe('buildSessionName — sanitisation', () => {
  // The name is interpolated into a command line that is TYPED into a live shell, so the charset
  // is the guard, not the quoting alone.
  it('replaces whitespace, quotes and shell metacharacters', () => {
    expect(
      buildSessionName({ project: "we'b; rm -rf $HOME", role: 'Claude', nodeId: NODE_A })
    ).toBe('we-b-rm-rf-HOME·Claude·9afef0')
  })

  it('cannot carry a newline (which would submit the half-typed launch line)', () => {
    const name = buildSessionName({ project: 'web\napp', task: 'do\r\nit', nodeId: NODE_A })
    expect(name).not.toMatch(/[\r\n]/)
    expect(name).toBe('web-app·do-it·9afef0')
  })

  it('strips non-ASCII text rather than carrying it through', () => {
    expect(buildSessionName({ project: 'café', role: 'Claude', nodeId: NODE_A })).toBe(
      'caf·Claude·9afef0'
    )
  })

  it('never begins with punctuation and never ends with it', () => {
    const name = buildSessionName({ project: '---.leading', task: 'trailing---', nodeId: NODE_A })
    expect(name).toMatch(/^[A-Za-z0-9]/)
    expect(name).toBe('leading·trailing·9afef0')
  })

  it('is always a name the interpolation site will accept', () => {
    // The two halves of the contract meet here: whatever the builder emits, `withSessionName` must
    // be willing to put on a command line — otherwise the feature silently does nothing.
    const name = buildSessionName({
      project: '~/projects/web app (2)',
      task: 'ship it!!',
      role: 'Claude',
      nodeId: NODE_A
    })
    expect(withSessionName('claude', 'claude', name)).toBe(`claude --name '${name}'`)
  })
})

describe('buildSessionName — the length cap', () => {
  // Three DISTINCT overlong segments: identical ones would be deduped away and never reach the
  // whole-name budget this block is about.
  const LONG = {
    project: 'project-alpha-with-a-very-long-name',
    task: 'task-that-also-runs-well-past-the-cap',
    role: 'role-label-that-is-long-too',
    nodeId: NODE_A
  }

  it('holds the whole name at or under the cap', () => {
    expect(buildSessionName(LONG).length).toBeLessThanOrEqual(SESSION_NAME_MAX)
  })

  it('caps each segment before the whole name, so one long segment cannot crowd out the rest', () => {
    const name = buildSessionName(LONG)
    expect(name.startsWith('project-alpha-with-a-ver·task-that-also-runs-well·')).toBe(true)
  })

  it('spends what is left on the head and always keeps the discriminator', () => {
    expect(buildSessionName(LONG).endsWith('·9afef0')).toBe(true)
  })

  it('leaves no trailing punctuation where the truncation landed', () => {
    expect(buildSessionName(LONG)).not.toMatch(/[-._·]·9afef0$/)
  })
})

describe('buildSessionName — determinism', () => {
  it('returns the same name for the same inputs', () => {
    const inputs = { project: 'web-app', task: 'fix login', role: 'Claude', nodeId: NODE_A }
    expect(buildSessionName(inputs)).toBe(buildSessionName(inputs))
  })

  it('is idempotent on its own output', () => {
    // A name fed back in as a task must not accumulate separators or drift in length — the same
    // node relaunched from the same place has to keep the same name.
    const once = buildSessionName({ project: 'web-app', role: 'Claude', nodeId: NODE_A })
    const twice = buildSessionName({ project: once, nodeId: NODE_A })
    expect(twice).toBe(`${once.replace(/·/g, '-')}·9afef0`)
    expect(twice.length).toBeLessThanOrEqual(SESSION_NAME_MAX)
  })
})

describe('sessionNameForNode — which of a node’s facts become which segment', () => {
  it('uses the working directory’s basename as the project', () => {
    expect(sessionNameForNode({ nodeId: NODE_A, cwd: '/home/dev/projects/web-app', agentLabel: 'Claude' })).toBe(
      'web-app·Claude·9afef0'
    )
  })

  it('reads a Windows path the same way', () => {
    expect(sessionNameForNode({ nodeId: NODE_A, cwd: 'C:\\src\\api-service', agentLabel: 'Claude' })).toBe(
      'api-service·Claude·9afef0'
    )
  })

  it('prefers an explicit project name over the directory', () => {
    expect(
      sessionNameForNode({ nodeId: NODE_A, cwd: '/home/dev/wt-3', project: 'data-pipeline', agentLabel: 'Claude' })
    ).toBe('data-pipeline·Claude·9afef0')
  })

  it('still names a node with no directory at all', () => {
    expect(sessionNameForNode({ nodeId: NODE_A, agentLabel: 'Claude' })).toBe('Claude·9afef0')
  })

  it('carries the task when the caller knows one', () => {
    expect(
      sessionNameForNode({
        nodeId: NODE_A,
        cwd: '/home/dev/projects/web-app',
        agentLabel: 'Claude',
        task: 'audit the auth flow'
      })
    ).toBe('web-app·audit-the-auth-flow·Claude·9afef0')
  })

  it('separates two nodes in one directory — the case the CLI’s own naming loses', () => {
    const a = sessionNameForNode({ nodeId: NODE_A, cwd: '/home/dev/projects/web-app', agentLabel: 'Claude' })
    const b = sessionNameForNode({ nodeId: NODE_B, cwd: '/home/dev/projects/web-app', agentLabel: 'Claude' })
    expect(a).not.toBe(b)
  })
})

describe('withSessionName — the interpolation site', () => {
  it('appends the flag for claude', () => {
    expect(withSessionName('claude', 'claude', 'web-app·Claude·9afef0')).toBe(
      "claude --name 'web-app·Claude·9afef0'"
    )
  })

  it('leaves every other agent’s command line byte-identical', () => {
    for (const id of ['codex', 'gemini', 'grok', 'copilot', 'opencode'] as const) {
      expect(withSessionName(id, id, 'web-app·9afef0')).toBe(id)
    }
  })

  // The type of `name` is a compile-time promise. These values can arrive from a persisted node
  // title or a hand-edited, git-shared `.nodeterm/project.json`, and they end up on a line typed
  // into a live shell — so the charset is re-checked HERE, and a failure yields the bare command.
  it('refuses a name it cannot vouch for, and emits the bare command instead', () => {
    for (const bad of [
      '',
      '   ',
      "web'app",
      'web app',
      'web;rm -rf ~',
      'web$(id)',
      'web`id`',
      'web\napp',
      '-leading-dash',
      'x'.repeat(SESSION_NAME_MAX + 1)
    ]) {
      expect(withSessionName('claude', 'claude', bad)).toBe('claude')
    }
  })

  it('does not add a second --name when the launch command already has one', () => {
    // A per-agent launch-command override is a wrapper the user wrote, and a wrapper may name the
    // session itself; a duplicate option would leave them unable to see which one the CLI honours.
    expect(withSessionName("claude --name 'mine'", 'claude', 'web-app·9afef0')).toBe(
      "claude --name 'mine'"
    )
    expect(withSessionName('claude -n mine', 'claude', 'web-app·9afef0')).toBe('claude -n mine')
    expect(withSessionName('claude --name=mine', 'claude', 'web-app·9afef0')).toBe(
      'claude --name=mine'
    )
  })

  it('is not fooled by the flag appearing inside a quoted argument', () => {
    // `argvHasFlag` reads tokens, not substrings: a prompt that MENTIONS the flag must not suppress
    // the real one.
    expect(
      withSessionName("claude --append-system-prompt 'never use --name'", 'claude', 'web-app·9afef0')
    ).toBe("claude --append-system-prompt 'never use --name' --name 'web-app·9afef0'")
  })
})
