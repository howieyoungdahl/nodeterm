/**
 * `/hook/*` learns a THIRD label: which Claude account the posting session is actually on
 * (design D1/D3 of the claude-account-tracking plan).
 *
 * Driven through the REAL server — a POST over the socket, not a call to a helper — because the
 * property under test is that the label is attached where `verified` / `clientRevision` are, i.e.
 * once, in core, for BOTH shells. A unit test of `classifyClaudeConfigDir` (which exists, in
 * claude-accounts-core.test.ts) cannot see whether the hook server ever calls it.
 *
 * MUTATIONS this file is meant to catch: drop the `account` spread at the listener call (every
 * case but the codex one reddens); classify for every agent instead of claude (the codex case
 * reddens); read the accounts source once at boot instead of per event (the linked case reddens);
 * attach the label to the RAW listener too (the raw-contract case reddens).
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { hookServer } from './hook-server'
import { initPlatform, resetPlatformForTests } from '../platform'
import { fakePlatform } from '../platform-fake'
import {
  registerClaudeAccountsSource,
  resetClaudeAccountsSourceForTests
} from '../claude-config-dir'
import { accountConfigDir } from '../claude-accounts-core'
import type { NormalizedAgentEvent } from '../../shared/agents/normalize'
import type { ClaudeAccount } from '../../shared/types'

let dir = ''
// The linked dir is a plain PATH here — nothing on disk is required, and that is itself the point
// (D7): classification is string work, so a forged POST cannot make the server open anything.
const LINKED_DIR = '/home/test-user/.claude-2'
const LINKED: ClaudeAccount = { id: 'linked-acct-1', label: 'second', configDir: LINKED_DIR, createdAt: 0 }

let events: NormalizedAgentEvent[] = []
let raws: { agentId: string; payload: Record<string, unknown> }[] = []

function post(agentId: string, transcriptPath?: string): Promise<Response> {
  const payload: Record<string, unknown> = {
    hook_event_name: agentId === 'codex' ? 'SessionStart' : 'UserPromptSubmit',
    session_id: 's1',
    prompt: 'hi'
  }
  if (transcriptPath) payload.transcript_path = transcriptPath
  return fetch(`http://127.0.0.1:${hookServer.getPort()}/hook/${agentId}`, {
    method: 'POST',
    headers: {
      'X-Nodeterm-Hook-Token': hookServer.getToken(),
      'content-type': 'application/x-www-form-urlencoded'
    },
    body: `nodeId=n1&payload=${encodeURIComponent(JSON.stringify(payload))}`
  })
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hooksrv-account-'))
  resetPlatformForTests()
  initPlatform(fakePlatform({ userDataDir: dir }))
  registerClaudeAccountsSource(() => [LINKED])
  await hookServer.start()
  hookServer.setListener((e) => {
    events.push(e)
  })
  hookServer.setRawListener((agentId, _nodeId, payload) => {
    raws.push({ agentId, payload })
  })
})

afterAll(() => {
  hookServer.stop()
  resetClaudeAccountsSourceForTests()
  resetPlatformForTests()
  rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  events = []
  raws = []
})

describe('hook server: the observed-account label on /hook/claude', () => {
  it('labels the SYSTEM config dir — a known account with no id', async () => {
    const res = await post('claude', join(homedir(), '.claude', 'projects', '-repo', 's1.jsonl'))
    expect(res.status).toBe(204)
    expect(events).toHaveLength(1)
    expect(events[0].account).toEqual({
      configDir: join(homedir(), '.claude'),
      accountId: null,
      known: true
    })
  })

  it('labels a LINKED dir with the settings account id — read per event, not at boot', async () => {
    await post('claude', `${LINKED_DIR}/projects/-repo/s1.jsonl`)
    expect(events[0].account).toEqual({
      configDir: LINKED_DIR,
      accountId: LINKED.id,
      known: true
    })
  })

  it('labels a MANAGED dir under this instance`s userData with its id', async () => {
    const managed = accountConfigDir(dir, 'managed-1')
    await post('claude', join(managed, 'projects', '-repo', 's1.jsonl'))
    expect(events[0].account).toEqual({ configDir: managed, accountId: 'managed-1', known: true })
  })

  it('labels an UNRECORDED dir known:false — the case that offers "link it in Settings"', async () => {
    await post('claude', '/home/test-user/.claude-3/projects/-repo/s1.jsonl')
    expect(events[0].account).toEqual({
      configDir: '/home/test-user/.claude-3',
      accountId: null,
      known: false
    })
  })

  it('resolves a SUBAGENT transcript nested deeper under the same projects root', async () => {
    await post('claude', `${LINKED_DIR}/projects/-repo/parent/sub-agent.jsonl`)
    expect(events[0].account?.accountId).toBe(LINKED.id)
  })

  it('attaches NO account when the payload carries no usable transcript_path', async () => {
    // "We did not observe an account" and "the system account" are different facts: an absent
    // field is the honest answer, and a synthesized system row would be a claim nothing supports.
    await post('claude')
    expect(events[0].account).toBeUndefined()
    await post('claude', '/home/test-user/.claude/settings.json') // no `projects` segment
    expect(events[1].account).toBeUndefined()
  })

  it('never labels another agent — codex and gemini own their own identity spine', async () => {
    await post('codex', join(homedir(), '.codex', 'sessions', '2026', 'rollout-x.jsonl'))
    expect(events).toHaveLength(1)
    expect(events[0].agentId).toBe('codex')
    expect(events[0].account).toBeUndefined()
  })

  it('leaves the RAW listener contract untouched (D3: neither raw listener changes)', async () => {
    await post('claude', `${LINKED_DIR}/projects/-repo/s1.jsonl`)
    expect(raws).toHaveLength(1)
    expect('account' in raws[0].payload).toBe(false)
    expect(raws[0].payload.transcript_path).toBe(`${LINKED_DIR}/projects/-repo/s1.jsonl`)
  })

  it('a throwing accounts source costs the label, never the 204 or the event', async () => {
    registerClaudeAccountsSource(() => {
      throw new Error('settings unreadable mid-write')
    })
    try {
      const res = await post('claude', `${LINKED_DIR}/projects/-repo/s1.jsonl`)
      expect(res.status).toBe(204)
      expect(events).toHaveLength(1)
      // The snapshot fails open to `[]`, so the dir is simply unrecorded — the event still lands.
      expect(events[0].account).toEqual({
        configDir: LINKED_DIR,
        accountId: null,
        known: false
      })
    } finally {
      registerClaudeAccountsSource(() => [LINKED])
    }
  })
})
