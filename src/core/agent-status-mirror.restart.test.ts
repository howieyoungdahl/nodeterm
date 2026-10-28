// Restart-survival of the agent-status mirror's dedup (field bug: THREE identical "Finished —
// <same lastMessage>" APNs pushes, one per Server-Edition restart). The dedup used to live only in
// memory, so every boot re-armed it and a re-produced `done` re-fired `onInboxActionable` → the
// push service. These tests SERIALIZE the mirror to a temp file, throw away all module state
// (fresh process), re-`initAgentStatusMirror` at the same file, and assert that a re-arriving
// IDENTICAL done/needs-you fires NO new actionable event — while a genuinely new turn still does.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { NormalizedAgentEvent } from '@shared/agents/normalize'
import {
  recordAgentEvent,
  recordRawToolEvent,
  flush,
  initAgentStatusMirror,
  onInboxActionable,
  _resetForTest,
  _inboxSnapshot,
  _snapshot,
  workingNodes,
  type InboxEvent
} from './agent-status-mirror'

function ev(partial: Partial<NormalizedAgentEvent>): NormalizedAgentEvent {
  return { nodeId: 'n1', agentId: 'claude', kind: 'state', ...partial } as NormalizedAgentEvent
}

let dir: string
let file: string

beforeEach(() => {
  _resetForTest()
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-mirror-restart-'))
  file = path.join(dir, 'agent-status.json')
})

afterEach(() => {
  _resetForTest()
  fs.rmSync(dir, { recursive: true, force: true })
})

/** Serialize the live mirror to disk, then simulate a full process restart: drop ALL module state
 *  and re-init pointing at the same file (which triggers loadPersisted). */
async function restart(): Promise<void> {
  initAgentStatusMirror(file)
  await flush()
  _resetForTest()
  initAgentStatusMirror(file)
}

/** Collect actionable inbox events fired AFTER this point. */
function captureActionable(): InboxEvent[] {
  const got: InboxEvent[] = []
  onInboxActionable((e) => got.push(e))
  return got
}

describe('agent-status mirror — restart survival of the done dedup', () => {
  it('does NOT re-fire an identical done after a restart (the duplicate-APNs bug)', async () => {
    initAgentStatusMirror(file)
    // A turn runs and finishes → one done, one actionable fire (the legit push).
    recordAgentEvent(ev({ state: 'working', newTurn: true }))
    recordAgentEvent(ev({ state: 'done', lastMessage: 'Araştırma tamam.' }))

    await restart()

    // Post-restart the node's main state is restored to `done`…
    expect(_snapshot().n1?.state).toBe('done')

    const got = captureActionable()
    // …so the cold-restore's `claude --resume` re-emitting the SAME Stop is a no-op edge.
    recordAgentEvent(ev({ state: 'done', lastMessage: 'Araştırma tamam.' }))
    expect(got).toHaveLength(0)

    // And the feed did not grow a duplicate — still exactly one done.
    const dones = _inboxSnapshot().events.filter((e) => e.kind === 'done')
    expect(dones).toHaveLength(1)
  })

  it('STILL fires done for a genuinely new turn after a restart', async () => {
    initAgentStatusMirror(file)
    recordAgentEvent(ev({ state: 'working', newTurn: true }))
    recordAgentEvent(ev({ state: 'done', lastMessage: 'First answer.' }))

    await restart()

    const got = captureActionable()
    // A real new turn (UserPromptSubmit → working) re-arms the done edge…
    recordAgentEvent(ev({ state: 'working', newTurn: true }))
    recordAgentEvent(ev({ state: 'done', lastMessage: 'Second answer.' }))
    // …so this legit finish fires.
    const dones = got.filter((e) => e.kind === 'done')
    expect(dones).toHaveLength(1)
    expect(dones[0].detail).toBe('Second answer.')
  })

  it('does NOT re-push an identical approval after a restart (needs-you class)', async () => {
    initAgentStatusMirror(file)
    recordAgentEvent(ev({ state: 'working', newTurn: true }))
    // A permission summary stash + the blocked edge → one approval.
    recordRawToolEvent('n1', {
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /tmp/x' }
    })
    recordAgentEvent(ev({ state: 'blocked', lastMessage: 'Run command' }))

    await restart()

    const got = captureActionable()
    // The same still-open approval re-asserting (re-stash + blocked) must not re-fire: the feed's
    // newestUnresolved title survived the restart.
    recordRawToolEvent('n1', {
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /tmp/x' }
    })
    recordAgentEvent(ev({ state: 'blocked', lastMessage: 'Run command' }))
    expect(got).toHaveLength(0)
    expect(_inboxSnapshot().events.filter((e) => e.kind === 'approval')).toHaveLength(1)
  })

  it('is fail-open: a corrupt persisted file leaves memory empty (legacy behavior)', () => {
    fs.writeFileSync(file, '{ this is not json ')
    // Must not throw at boot.
    expect(() => initAgentStatusMirror(file)).not.toThrow()
    expect(Object.keys(_snapshot())).toHaveLength(0)
    expect(_inboxSnapshot().events).toHaveLength(0)
  })

  it('workingNodes() sees a restored working entry (keep-awake reseeds from it at boot)', async () => {
    // The restore deliberately fires NO edges, so an edge-driven consumer starts blind; the
    // tmux-backed run it describes is still going. workingNodes() is the seam that lets the
    // main shell reseed keep-awake — without it an app relaunch mid-run drops the assertion
    // until the next turn boundary.
    initAgentStatusMirror(file)
    recordAgentEvent(ev({ state: 'working', newTurn: true }))
    recordAgentEvent(ev({ nodeId: 'n2', state: 'done' }))

    await restart()

    expect(workingNodes().map((w) => w.nodeId)).toEqual(['n1'])
  })
})

describe('status retention and idle recovery', () => {
  it('preserves an explicit session start through restart and clears it on state', async () => {
    initAgentStatusMirror(file)
    recordAgentEvent(ev({ kind: 'session', sessionPhase: 'start' }))
    await restart()
    expect(_snapshot().n1?.idleSince).toEqual(expect.any(Number))
    recordAgentEvent(ev({ state: 'working', newTurn: true }))
    expect(_snapshot().n1?.idleSince).toBeUndefined()
  })
  it('retains seven-hour nodes through load, snapshot and flush, but expires older nodes', async () => {
    const now = Date.now()
    fs.writeFileSync(file, JSON.stringify({ nodes: {
      recent: { state: 'done', updatedAt: now - 7 * 60 * 60_000 },
      old: { state: 'done', updatedAt: now - 8 * 24 * 60 * 60_000 }
    } }))
    initAgentStatusMirror(file)
    const { agentStatusSnapshot } = await import('./agent-status-mirror')
    expect(agentStatusSnapshot().nodes.recent?.state).toBe('done')
    expect(agentStatusSnapshot().nodes.old).toBeUndefined()
    await flush()
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(saved.nodes.recent?.state).toBe('done')
    expect(saved.nodes.old).toBeUndefined()
  })
})

it('does not restore working older than six hours', () => {
  fs.writeFileSync(file, JSON.stringify({ nodes: { n1: { state: 'working', agentId: 'claude', updatedAt: Date.now() - 7 * 3600_000 } } }))
  initAgentStatusMirror(file)
  expect(_snapshot().n1).toBeUndefined()
})
