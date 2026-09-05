import { describe, expect, it } from 'vitest'
import {
  FAILABLE_STATES,
  NODE_STATUS_PRESENTATION,
  NODE_STATUS_SEVERITY,
  NODE_STATUS_STALE_MS,
  PANE_RECHECK_MS,
  deriveNodeStatus,
  formatStatusAge,
  paneProbeCandidates,
  rollUpNodeStatus,
  truncateReason,
  type NodeStatusInput,
  type NodeStatusKind
} from './node-status'

const NOW = 1_800_000_000_000
const fresh = NOW - 5_000
const old = NOW - (NODE_STATUS_STALE_MS + 60_000)

function view(over: Partial<NodeStatusInput> = {}) {
  return deriveNodeStatus({ now: NOW, updatedAt: fresh, ...over })
}

describe('the derivation table', () => {
  it('renders a node with no status event as the WORD unknown, never as idle or completed', () => {
    const v = deriveNodeStatus({ now: NOW })
    expect(v.kind).toBe('unknown')
    expect(v.word).toBe('UNKNOWN')
    expect(v.age).toBe('')
    expect(v.detail).toContain('no status event')
  })

  it('maps the four hook-fed states', () => {
    expect(view({ state: 'working' }).kind).toBe('working')
    expect(view({ state: 'waiting' }).kind).toBe('waiting')
    expect(view({ state: 'blocked' }).kind).toBe('blocked')
    expect(view({ state: 'done' }).kind).toBe('completed')
  })

  it('derives failed ONLY from a proven-dead pane', () => {
    for (const state of ['working', 'waiting', 'blocked'] as const) {
      expect(view({ state, pane: 'dead' }).kind).toBe('failed')
    }
  })

  it('leaves a finished session completed, however dead its pane is', () => {
    // The one state a dead pane does not change. A session that finished and then had its terminal
    // closed is a tidied-up success; failing it would put a red badge on every one of them.
    expect(view({ state: 'done', pane: 'dead' }).kind).toBe('completed')
  })

  it('names the state that was standing when the pane died', () => {
    // The operator's next move on a blocked node is to go and answer it. The point of this badge
    // is that there is nothing left to answer.
    expect(view({ state: 'blocked', pane: 'dead' }).detail).toContain('can no longer be answered')
    expect(view({ state: 'waiting', pane: 'dead' }).detail).toContain('waiting for your response')
    expect(view({ state: 'working', pane: 'dead' }).detail).toContain('it was working')
  })

  it('FAILABLE_STATES is exactly the three, and never done', () => {
    expect([...FAILABLE_STATES].sort()).toEqual(['blocked', 'waiting', 'working'])
    expect(FAILABLE_STATES.has('done' as never)).toBe(false)
  })

  it('refuses failed when there is no hook state at all, however dead the pane is', () => {
    expect(deriveNodeStatus({ now: NOW, pane: 'dead' }).kind).toBe('unknown')
  })

  it('keeps a latched failure after the working state is swept away', () => {
    // The renderer blanks a stale `working` entry to undefined after its own window. The latch is
    // what keeps a proven failure discoverable instead of decaying back into silence.
    const v = deriveNodeStatus({
      now: NOW,
      failure: { at: NOW - 3_600_000, from: 'working', reason: 'tmux session gone' }
    })
    expect(v.kind).toBe('failed')
    expect(v.age).toBe('1h')
    expect(v.reason).toBe('tmux session gone')
  })
})

describe('every "cannot tell" row', () => {
  it('a stale working with an INCONCLUSIVE probe is unknown, not working and not failed', () => {
    const v = deriveNodeStatus({ now: NOW, state: 'working', updatedAt: old, pane: 'unknown' })
    expect(v.kind).toBe('unknown')
    expect(v.detail).toContain('could not be checked')
  })

  it('a FRESH working with an inconclusive probe is still working', () => {
    // A hook event seconds old is reliable session information; nothing needs probing to say so.
    expect(view({ state: 'working', pane: 'unknown' }).kind).toBe('working')
  })

  it('a stale waiting/blocked with an inconclusive probe keeps its state, marked stale', () => {
    // Deliberately NOT downgraded to unknown the way `working` is. `working` claims something is
    // happening now; `waiting`/`blocked` claim a standing request, which does not become less true
    // by sitting still — and those are the states an operator parks overnight, so downgrading them
    // on an unverifiable probe would erase the most actionable thing on the canvas.
    for (const state of ['waiting', 'blocked'] as const) {
      const v = deriveNodeStatus({ now: NOW, state, updatedAt: old, pane: 'unknown' })
      expect(v.kind).toBe(state)
      expect(v.stale).toBe(true)
    }
  })

  it('a stale working nobody probed stays working, marked stale', () => {
    const v = deriveNodeStatus({ now: NOW, state: 'working', updatedAt: old })
    expect(v.kind).toBe('working')
    expect(v.stale).toBe(true)
  })

  it('a stale working on a pane proven ALIVE stays working, marked stale', () => {
    const v = deriveNodeStatus({ now: NOW, state: 'working', updatedAt: old, pane: 'alive' })
    expect(v.kind).toBe('working')
    expect(v.stale).toBe(true)
  })

  it('an absent clock reports no freshness rather than inventing one', () => {
    const v = deriveNodeStatus({ now: NOW, state: 'blocked' })
    expect(v.ageMs).toBeNull()
    expect(v.age).toBe('')
    expect(v.stale).toBe(false)
    expect(v.detail).toContain('No freshness information')
  })
})

describe('staleness', () => {
  it('marks past the window without changing the state', () => {
    for (const state of ['waiting', 'blocked', 'done'] as const) {
      const v = deriveNodeStatus({ now: NOW, state, updatedAt: old })
      expect(v.stale).toBe(true)
      expect(v.detail).toContain('stale')
    }
    expect(deriveNodeStatus({ now: NOW, state: 'blocked', updatedAt: old }).kind).toBe('blocked')
  })

  it('never calls a proven failure stale in the tooltip either — it is current news, and bad', () => {
    const v = deriveNodeStatus({ now: NOW, state: 'working', updatedAt: old, pane: 'dead' })
    expect(v.detail).not.toContain('stale')
  })

  it('says "just now" in a sentence rather than the badge\'s bare unit', () => {
    expect(deriveNodeStatus({ state: 'working', updatedAt: NOW, now: NOW }).detail).toContain(
      'just now'
    )
    expect(deriveNodeStatus({ state: 'working', updatedAt: NOW, now: NOW }).detail).not.toContain(
      'now ago'
    )
  })

  it('does not mark inside the window', () => {
    expect(view({ state: 'done' }).stale).toBe(false)
  })

  it('honours an injected window', () => {
    const v = deriveNodeStatus({ now: NOW, state: 'done', updatedAt: NOW - 2_000, staleMs: 1_000 })
    expect(v.stale).toBe(true)
  })

  it('a proven failure is never additionally called stale — it is current, and bad', () => {
    const v = deriveNodeStatus({
      now: NOW,
      state: 'working',
      updatedAt: old,
      pane: 'dead'
    })
    expect(v.kind).toBe('failed')
    expect(v.stale).toBe(false)
  })
})

describe('never colour alone', () => {
  const kinds = Object.keys(NODE_STATUS_PRESENTATION) as NodeStatusKind[]

  it('gives every state a distinct glyph', () => {
    const glyphs = kinds.map((k) => NODE_STATUS_PRESENTATION[k].glyph)
    expect(new Set(glyphs).size).toBe(kinds.length)
  })

  it('gives every state a distinct word', () => {
    const words = kinds.map((k) => NODE_STATUS_PRESENTATION[k].word)
    expect(new Set(words).size).toBe(kinds.length)
  })

  it('every state has a non-empty glyph AND a non-empty word', () => {
    for (const k of kinds) {
      expect(NODE_STATUS_PRESENTATION[k].glyph.length).toBeGreaterThan(0)
      expect(NODE_STATUS_PRESENTATION[k].word.length).toBeGreaterThan(0)
    }
  })

  it('ranks every state exactly once in the roll-up order', () => {
    expect([...NODE_STATUS_SEVERITY].sort()).toEqual([...kinds].sort())
  })
})

describe('the reason string (B3)', () => {
  it('carries the reason the hook event provided, truncated', () => {
    const long = 'x'.repeat(200)
    const v = view({ state: 'blocked', reason: long })
    expect(v.reason.length).toBeLessThanOrEqual(90)
    expect(v.reason.endsWith('…')).toBe(true)
  })

  it('puts the reason on the badge only where attention is what is being asked for', () => {
    // B3 is "why attention is needed", not "narrate every event". A working node's last assistant
    // message and a finished turn's closing line stay in the tooltip.
    for (const state of ['blocked', 'waiting'] as const) {
      expect(view({ state, reason: 'because' }).reason).toBe('because')
    }
    expect(view({ state: 'working', reason: 'ran a tool' }).reason).toBe('')
    expect(view({ state: 'done', reason: 'all set' }).reason).toBe('')
    // …but the tooltip still has it.
    expect(view({ state: 'done', reason: 'all set' }).detail).toContain('all set')
  })

  it('shows the state alone when the event carried no reason — it never invents one', () => {
    expect(view({ state: 'blocked' }).reason).toBe('')
  })

  it('collapses whitespace so a multi-line message stays one badge line', () => {
    expect(truncateReason('Allow\n  Bash(rm -rf)?')).toBe('Allow Bash(rm -rf)?')
  })

  it('names the ask kind the shell classified, when it has one', () => {
    expect(view({ state: 'blocked', askKind: 'question' }).detail).toContain('question')
    expect(view({ state: 'blocked', askKind: 'approval' }).detail).toContain('approval')
  })
})

describe('roll-up onto a group frame', () => {
  it('is null for a frame with no status-bearing members', () => {
    expect(rollUpNodeStatus([])).toBeNull()
  })

  it('puts a failed member above everything else', () => {
    const r = rollUpNodeStatus([
      { id: 'a', kind: 'working' },
      { id: 'b', kind: 'blocked' },
      { id: 'c', kind: 'failed' }
    ])
    expect(r?.kind).toBe('failed')
    expect(r).toMatchObject({ count: 1, total: 3 })
  })

  it('puts a blocked member above a working one — an approval stays discoverable', () => {
    expect(
      rollUpNodeStatus([
        { id: 'a', kind: 'working' },
        { id: 'b', kind: 'completed' },
        { id: 'c', kind: 'blocked' }
      ])?.kind
    ).toBe('blocked')
  })

  it('reports an unaccounted member rather than the healthy one beside it', () => {
    expect(
      rollUpNodeStatus([
        { id: 'a', kind: 'working' },
        { id: 'b', kind: 'unknown' }
      ])?.kind
    ).toBe('unknown')
  })

  it('counts how many members are in the winning state', () => {
    const r = rollUpNodeStatus([
      { id: 'a', kind: 'waiting' },
      { id: 'b', kind: 'waiting' },
      { id: 'c', kind: 'completed' }
    ])
    expect(r).toMatchObject({ kind: 'waiting', count: 2, total: 3 })
  })

  it('settles on completed only when everything has settled', () => {
    expect(
      rollUpNodeStatus([
        { id: 'a', kind: 'completed' },
        { id: 'b', kind: 'completed' }
      ])?.kind
    ).toBe('completed')
  })
})

describe('probe candidates', () => {
  it('picks every stale state a dead pane could change, and nothing else', () => {
    expect(
      paneProbeCandidates(
        [
          { id: 'stale-working', state: 'working', updatedAt: old },
          { id: 'stale-waiting', state: 'waiting', updatedAt: old },
          { id: 'stale-blocked', state: 'blocked', updatedAt: old },
          { id: 'fresh-working', state: 'working', updatedAt: fresh },
          { id: 'stale-done', state: 'done', updatedAt: old },
          { id: 'no-clock', state: 'working' },
          { id: 'no-state' }
        ],
        NOW
      )
    ).toEqual(['stale-working', 'stale-waiting', 'stale-blocked'])
  })

  it('does not re-probe a node whose pane was asked about within the re-check window', () => {
    // A `blocked` state never decays out of the candidate set on its own, so without this an
    // overnight parked approval would be probed on every pass until somebody answered it.
    const entry = { id: 'n', state: 'blocked' as const, updatedAt: old }
    expect(paneProbeCandidates([{ ...entry, paneAt: NOW - 1000 }], NOW)).toEqual([])
    expect(
      paneProbeCandidates([{ ...entry, paneAt: NOW - (PANE_RECHECK_MS + 1000) }], NOW)
    ).toEqual(['n'])
  })

  it('does not re-probe a node whose failure is already latched', () => {
    expect(
      paneProbeCandidates([{ id: 'n', state: 'working', updatedAt: old, failed: true }], NOW)
    ).toEqual([])
  })
})

describe('formatStatusAge', () => {
  it('is compact and never negative', () => {
    expect(formatStatusAge(-1)).toBe('now')
    expect(formatStatusAge(30_000)).toBe('now')
    expect(formatStatusAge(90_000)).toBe('1m')
    expect(formatStatusAge(3 * 3_600_000)).toBe('3h')
    expect(formatStatusAge(50 * 3_600_000)).toBe('2d')
  })
})
