import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync } from 'fs'
import os from 'os'
import path from 'path'
import { initPlatform, resetPlatformForTests, type CorePlatform } from './platform'
import { fakePlatform } from './platform-fake'
import {
  initCanvasSync,
  reflectTargets,
  stampMutation,
  isCanvasMutation,
  MUTATION_MAX_BYTES
} from './canvas-sync'
import { IPC } from '../shared/ipc'
import type { CanvasMutation, CanvasNodeState } from '../shared/types'

const node = (id: string, x = 0): CanvasNodeState =>
  ({
    id,
    kind: 'terminal',
    title: 't',
    color: '#fff',
    position: { x, y: 0 },
    size: { width: 10, height: 10 }
  }) as CanvasNodeState

/** Recording CorePlatform with a cast() that carries the sender id (the Stage-1 onWithSender seam). */
function testPlatform() {
  const sent: Array<{ to: number; channel: string; args: unknown[] }> = []
  const registrations: string[] = []
  let clients: number[] = []
  const senderListeners = new Map<string, (senderId: number, ...args: any[]) => void>()
  const p: CorePlatform = {
    // A fresh mkdtemp dir, never a fixed literal: this platform is registered via initPlatform,
    // so a predictable '/tmp/...' here reads (to CodeQL's js/insecure-temporary-file, and to a
    // parallel test run) as every production write through platform().userDataDir landing on a
    // shared guessable temp path — the exact fix platform-fake.ts documents.
    userDataDir: mkdtempSync(path.join(os.tmpdir(), 'nodeterm-canvas-sync-')),
    appVersion: '0.0.0-test',
    isPackaged: false,
    handle: () => {},
    on: () => {},
    handleWithSender: () => {},
    onWithSender: (ch, fn) => {
      registrations.push(ch)
      senderListeners.set(ch, fn)
    },
    clientIds: () => clients,
    sendTo: (to, channel, ...args) => void sent.push({ to, channel, args }),
    broadcast: () => {},
    openExternal: async () => {}
  }
  return {
    p,
    sent,
    registrations,
    setClients: (ids: number[]) => (clients = ids),
    cast: (senderId: number, ...args: unknown[]) =>
      senderListeners.get(IPC.canvasMut)?.(senderId, ...args)
  }
}

let t: ReturnType<typeof testPlatform>

beforeEach(() => {
  t = testPlatform()
  initPlatform(t.p)
  initCanvasSync()
})
afterEach(() => resetPlatformForTests())

describe('reflectTargets', () => {
  // The sender IS a target: its copy is the ACK that tells it where its own edit landed in the
  // total order — without which two clients editing one node cannot converge (canvas-order rule 2).
  it('is every attached client, the sender included', () => {
    expect(reflectTargets([1, 2, 3], 2)).toEqual([1, 2, 3])
    expect(reflectTargets([1], 1)).toEqual([1])
    expect(reflectTargets([], 1)).toEqual([])
  })
})

describe('stampMutation', () => {
  it('stamps the total order and keeps the sender tag', () => {
    expect(stampMutation({ op: 'remove', id: 'n1', src: 'cv-abc' }, 7)).toEqual({
      op: 'remove',
      id: 'n1',
      src: 'cv-abc',
      seq: 7
    })
  })

  it('overwrites a client-supplied seq: the order is the server\'s, never the client\'s', () => {
    expect(stampMutation({ op: 'remove', id: 'n1', seq: 999_999 }, 3).seq).toBe(3)
  })

  it('drops a malformed src rather than reflecting it to every peer', () => {
    expect(stampMutation({ op: 'remove', id: 'n1', src: 'x'.repeat(129) }, 1).src).toBeUndefined()
    expect(stampMutation({ op: 'remove', id: 'n1', src: '' }, 1).src).toBeUndefined()
    expect(
      stampMutation({ op: 'remove', id: 'n1', src: 42 as unknown as string }, 1).src
    ).toBeUndefined()
  })
})

describe('isCanvasMutation', () => {
  it('accepts well-formed mutations and rejects malformed ones', () => {
    expect(isCanvasMutation({ op: 'remove', id: 'n1' })).toBe(true)
    expect(isCanvasMutation({ op: 'upsert', node: node('n1') })).toBe(true)
    expect(isCanvasMutation({ op: 'upsert' })).toBe(false)
    expect(isCanvasMutation({ op: 'upsert', node: { position: { x: 1, y: 1 } } })).toBe(false)
    expect(isCanvasMutation({ op: 'remove' })).toBe(false)
    expect(isCanvasMutation({ op: 'nope', id: 'n1' })).toBe(false)
    expect(isCanvasMutation(null)).toBe(false)
    expect(isCanvasMutation('n1')).toBe(false)
  })

  it('rejects a non-finite position (NaN/Infinity would wedge React Flow)', () => {
    expect(isCanvasMutation({ op: 'upsert', node: { ...node('n1'), position: { x: NaN, y: 0 } } })).toBe(false)
    expect(
      isCanvasMutation({ op: 'upsert', node: { ...node('n1'), position: { x: 0, y: Infinity } } })
    ).toBe(false)
  })

  it('bounds what comes off the wire: over-long ids and oversized nodes are rejected', () => {
    expect(isCanvasMutation({ op: 'remove', id: 'x'.repeat(129) })).toBe(false)
    expect(isCanvasMutation({ op: 'upsert', node: { ...node('x'.repeat(129)) } })).toBe(false)
    const fat = { ...node('n1'), data: { text: 'a'.repeat(MUTATION_MAX_BYTES) } }
    expect(isCanvasMutation({ op: 'upsert', node: fat })).toBe(false)
  })
})

describe('initCanvasSync (reflector)', () => {
  // Every client, sender included — the sender's copy is its ack (see reflectTargets above). The
  // client drops its own echo instead of re-applying it (canvas-order rule 1), so this is not a
  // loop: the publisher's adopt guard means nothing is ever re-published.
  it('fans a mutation to every attached client, stamped with the total order', () => {
    t.setClients([1, 2, 3])
    const m: CanvasMutation = { op: 'upsert', node: node('n1', 42), src: 'cv-b' }
    t.cast(2, 'p1', m)
    const stamped = { ...m, seq: 1 }
    expect(t.sent).toEqual([
      { to: 1, channel: IPC.canvasMut, args: ['p1', stamped] },
      { to: 2, channel: IPC.canvasMut, args: ['p1', stamped] },
      { to: 3, channel: IPC.canvasMut, args: ['p1', stamped] }
    ])
  })

  it('seq is monotone across senders and projects — one total order for everyone', () => {
    t.setClients([1, 2])
    t.cast(1, 'p1', { op: 'remove', id: 'n1' })
    t.cast(2, 'p2', { op: 'remove', id: 'n2' })
    t.cast(2, 'p1', { op: 'remove', id: 'n3' })
    expect(t.sent.map((s) => (s.args[1] as CanvasMutation).seq)).toEqual([1, 1, 2, 2, 3, 3])
  })

  it('a solo client still gets its own mutation back (the ack), and nothing else happens', () => {
    t.setClients([1])
    t.cast(1, 'p1', { op: 'remove', id: 'n1' })
    expect(t.sent).toEqual([
      { to: 1, channel: IPC.canvasMut, args: ['p1', { op: 'remove', id: 'n1', seq: 1 }] }
    ])
  })

  it('drops a malformed mutation instead of reflecting it', () => {
    t.setClients([1, 2])
    t.cast(1, 'p1', { op: 'upsert' })
    t.cast(1, 'p1', undefined)
    t.cast(1, undefined, { op: 'remove', id: 'n1' })
    t.cast(1, 'p'.repeat(129), { op: 'remove', id: 'n1' })
    expect(t.sent).toEqual([])
  })

  it('holds no canvas state: it reflects each mutation verbatim (bar the stamp), in order', () => {
    t.setClients([1, 2])
    t.cast(1, 'p1', { op: 'upsert', node: node('a') })
    t.cast(2, 'p1', { op: 'remove', id: 'a' })
    expect(t.sent).toEqual([
      { to: 1, channel: IPC.canvasMut, args: ['p1', { op: 'upsert', node: node('a'), seq: 1 }] },
      { to: 2, channel: IPC.canvasMut, args: ['p1', { op: 'upsert', node: node('a'), seq: 1 }] },
      { to: 1, channel: IPC.canvasMut, args: ['p1', { op: 'remove', id: 'a', seq: 2 }] },
      { to: 2, channel: IPC.canvasMut, args: ['p1', { op: 'remove', id: 'a', seq: 2 }] }
    ])
  })

  it('is NOT rate-limited: a bulk delete of many nodes reflects every one', () => {
    t.setClients([1, 2])
    for (let i = 0; i < 200; i++) t.cast(1, 'p1', { op: 'remove', id: `n${i}` })
    expect(t.sent).toHaveLength(400) // 200 mutations × (peer + sender ack)
    expect(t.sent[399]).toEqual({
      to: 2,
      channel: IPC.canvasMut,
      args: ['p1', { op: 'remove', id: 'n199', seq: 200 }]
    })
  })

  // `on` and `onWithSender` COMPOSE on the same channel — on BOTH shells (see
  // pty-manager-platform.test.ts). A second, plain listener on canvas:mut would reflect every
  // mutation TWICE to every peer. Registration must be sender-aware and singular.
  it('registers canvas:mut EXACTLY ONCE, sender-aware (no composed plain listener)', () => {
    resetPlatformForTests()
    const fake = fakePlatform()
    initPlatform(fake)
    initCanvasSync()
    expect(fake.senderListeners[IPC.canvasMut]).toBeDefined()
    expect(fake.listeners[IPC.canvasMut]).toBeUndefined()
    expect(fake.handlers[IPC.canvasMut]).toBeUndefined()
  })

  // ServerPlatform keeps an ORDERED SET of listeners per channel, so a second registration on the
  // same platform is not an overwrite — it would reflect every mutation twice to every peer.
  it('is idempotent per platform: initCanvasSync twice registers the listener once', () => {
    expect(t.registrations).toEqual([IPC.canvasMut]) // beforeEach registered it
    initCanvasSync()
    expect(t.registrations).toEqual([IPC.canvasMut])
  })
})

it('browser mutations cannot forge an already persisted workspace revision',()=> {
  const m: CanvasMutation={op:'upsert',node:node('foreign'),workspaceRevision:'a'.repeat(64)}
  expect(stampMutation(m,1).workspaceRevision).toBeUndefined()
})
