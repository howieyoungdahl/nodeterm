// The REAL request handler — link-map ingest, authorization, and the local/remote read split.
// The cli test drives the shim against a stand-in handler; this one drives the actual code that
// decides WHICH bytes a request may see, which is the part with teeth.
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleContextLinkRequest, initContextLink, type ContextLinkDeps } from './context-link'
import { setNodeTranscript } from './context-link-core'
import { IPC } from '../shared/ipc'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform, type FakePlatform } from './platform-fake'
import type { ContextLinkMap } from '../shared/types'
import type { PtyManager } from './pty-manager'

const dir = mkdtempSync(join(tmpdir(), 'ctxlink-h-'))
let plat: FakePlatform
let captured: string[] = []

/** Enough PtyManager for context-link: the tmux binary it stamps into the doc, and the capture
 *  call that is already remote-aware in the real thing. */
function fakePty(): PtyManager {
  return {
    getTmuxBin: () => '/usr/bin/tmux',
    captureSession: async (key: string) => {
      captured.push(key)
      return `pane of ${key}`
    }
  } as unknown as PtyManager
}

async function setLinks(map: ContextLinkMap): Promise<void> {
  await plat.handlers[IPC.contextLinkSetLinks](map)
}

function start(deps: ContextLinkDeps = {}): void {
  resetPlatformForTests()
  plat = fakePlatform({ userDataDir: dir })
  initPlatform(plat)
  captured = []
  // Handler tests must not install temp-dataDir instructions into live provider homes.
  initContextLink(fakePty(), deps, { installAgentIntegrations: false })
}

beforeEach(() => start())

afterAll(() => rmSync(dir, { recursive: true, force: true }))

const CLAUDE_LINE = JSON.stringify({ type: 'user', message: { content: 'ship it' } })

describe('handleContextLinkRequest — authorization', () => {
  it('serves only the requester\'s own document', async () => {
    await setLinks({ 'node-A': [{ id: 'node-B', title: 'Builder' }] })
    const mine = await handleContextLinkRequest({ verb: 'list', nodeId: 'node-A', args: {} })
    expect(mine).toContain('Builder')
    // node-B was LINKED FROM node-A but has no document of its own: the link map is directional,
    // and a node may not read through an edge it does not itself hold.
    const theirs = await handleContextLinkRequest({ verb: 'list', nodeId: 'node-B', args: {} })
    expect(theirs).toContain('No linked nodes')
  })

  it('refuses a target that is not in the requester\'s links, even by exact id', async () => {
    await setLinks({
      'node-A': [{ id: 'node-B', title: 'Builder' }],
      'node-C': [{ id: 'node-SECRET', title: 'Secret' }]
    })
    const out = await handleContextLinkRequest({
      verb: 'transcript',
      nodeId: 'node-A',
      args: { node: 'node-SECRET' }
    })
    expect(out).toContain('No linked node matches')
    expect(out).not.toContain('Secret —')
  })

  it('answers an empty node id without touching anything', async () => {
    expect(await handleContextLinkRequest({ verb: 'list', nodeId: '', args: {} })).toContain(
      'Not a nodeterm session'
    )
  })

  it('rejects an unknown verb with the usage line', async () => {
    await setLinks({ 'node-A': [{ id: 'node-B', title: 'Builder' }] })
    const out = await handleContextLinkRequest({ verb: 'rm -rf', nodeId: 'node-A', args: {} })
    expect(out).toContain('Unknown command')
  })

  it('drops documents for links that were removed', async () => {
    await setLinks({ 'node-A': [{ id: 'node-B', title: 'Builder' }] })
    await setLinks({})
    expect(await handleContextLinkRequest({ verb: 'list', nodeId: 'node-A', args: {} })).toContain(
      'No linked nodes'
    )
  })
})

describe('handleContextLinkRequest — local reads', () => {
  it('reads a local transcript off this machine\'s disk', async () => {
    const p = join(dir, 'local.jsonl')
    writeFileSync(p, CLAUDE_LINE)
    setNodeTranscript('node-B', 'sess-1', p)
    await setLinks({ 'node-A': [{ id: 'node-B', title: 'Builder', agentId: 'claude' }] })
    const out = await handleContextLinkRequest({ verb: 'summary', nodeId: 'node-A', args: {} })
    expect(out).toContain('user: ship it')
  })

  it('captures the terminal through the pty manager', async () => {
    await setLinks({ 'node-A': [{ id: 'node-B', title: 'Builder' }] })
    const out = await handleContextLinkRequest({ verb: 'terminal', nodeId: 'node-A', args: {} })
    expect(out).toContain('pane of node-B')
    expect(captured).toEqual(['node-B'])
  })
})

describe('handleContextLinkRequest — remote (SSH) reads', () => {
  const remoteDeps = (over: Partial<ContextLinkDeps> = {}): ContextLinkDeps => ({
    isRemoteNode: (id) => id === 'node-R',
    readRemoteFile: async () => CLAUDE_LINE,
    runRemoteCommand: async () => null,
    ...over
  })

  it('routes a remote node\'s transcript over the injected remote reader', async () => {
    const readRemoteFile = vi.fn(async () => CLAUDE_LINE)
    start(remoteDeps({ readRemoteFile }))
    setNodeTranscript('node-R', 'sess-r', '/home/u/.claude/projects/x/r.jsonl')
    await setLinks({ 'node-A': [{ id: 'node-R', title: 'Remote', agentId: 'claude' }] })
    const out = await handleContextLinkRequest({ verb: 'summary', nodeId: 'node-A', args: {} })
    expect(out).toContain('user: ship it')
    expect(readRemoteFile).toHaveBeenCalledWith('node-R', '/home/u/.claude/projects/x/r.jsonl', expect.any(Number))
  })

  it('never asks the LOCAL locators for a remote node\'s transcript', async () => {
    // The locators search this machine's disk. For a remote node they would return some unrelated
    // local session's file and the agent would read a stranger's conversation, silently.
    const readRemoteFile = vi.fn(async () => CLAUDE_LINE)
    start(remoteDeps({ readRemoteFile }))
    // No hook-fed path for node-R: a codex node with a sessionId is exactly the shape the
    // locator fallback would have resolved locally.
    await setLinks({ 'node-A': [{ id: 'node-R', title: 'Remote', agentId: 'codex', sessionId: 'sess-x' }] })
    const out = await handleContextLinkRequest({ verb: 'summary', nodeId: 'node-A', args: {} })
    expect(out).toContain('no conversation transcript yet')
    expect(readRemoteFile).not.toHaveBeenCalled()
  })

  it('reports a failed remote read as "no transcript yet" rather than an error', async () => {
    start(remoteDeps({ readRemoteFile: async () => null }))
    setNodeTranscript('node-R', 'sess-r', '/home/u/.claude/projects/x/r.jsonl')
    await setLinks({ 'node-A': [{ id: 'node-R', title: 'Remote', agentId: 'claude' }] })
    const out = await handleContextLinkRequest({ verb: 'summary', nodeId: 'node-A', args: {} })
    expect(out).toContain('no conversation transcript yet')
  })

  it('shell-quotes the session id it sends to a remote opencode export', async () => {
    const sent: string[] = []
    const runRemoteCommand = async (_nodeId: string, command: string): Promise<string> => {
      sent.push(command)
      return '{"messages":[]}'
    }
    start(remoteDeps({ runRemoteCommand }))
    await setLinks({
      'node-A': [{ id: 'node-R', title: 'Remote', agentId: 'opencode', sessionId: "x'; rm -rf ~ #" }]
    })
    await handleContextLinkRequest({ verb: 'transcript', nodeId: 'node-A', args: {} })
    expect(sent[0]).toBe(`opencode export 'x'\\''; rm -rf ~ #'`)
  })

  it('falls back to local behavior when the shell injected no remote deps (Server Edition)', async () => {
    const p = join(dir, 'srv.jsonl')
    writeFileSync(p, CLAUDE_LINE)
    start() // no deps at all
    setNodeTranscript('node-B', 'sess-1', p)
    await setLinks({ 'node-A': [{ id: 'node-B', title: 'Builder', agentId: 'claude' }] })
    expect(await handleContextLinkRequest({ verb: 'summary', nodeId: 'node-A', args: {} })).toContain(
      'user: ship it'
    )
  })
})
