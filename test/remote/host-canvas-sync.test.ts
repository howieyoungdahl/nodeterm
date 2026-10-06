import { describe, it, expect } from 'vitest'
import {
  createHostCanvasSync,
  CANVAS_STATE_METHOD,
  CANVAS_MUTATE_METHOD,
  type CanvasNotifySocket
} from '../../src/main/remote/host-service'
import type { CanvasMutation, CanvasNodeState, CanvasState } from '../../src/shared/types'

function fakeNotifySocket() {
  const sent: { method: string; params: unknown }[] = []
  const socket: CanvasNotifySocket = {
    notify: (method, params) => {
      sent.push({ method, params })
      return true
    }
  }
  return { socket, sent }
}

function node(id: string): CanvasNodeState {
  return {
    id,
    kind: 'terminal',
    position: { x: 0, y: 0 },
    size: { width: 480, height: 320 },
    title: id,
    color: '#888',
    group: null
  }
}

const state = (nodes: CanvasNodeState[]): CanvasState => ({ nodes })

describe('createHostCanvasSync', () => {
  it('keeps host archive identity through an older phone upsert and refuses its archived-row removal', () => {
    const { socket } = fakeNotifySocket(), received: CanvasMutation[] = []
    const sync = createHostCanvasSync(socket, m => received.push(m))
    const archived = { ...node('archived'), cleanupArchiveId: 'reviewed-receipt', agentSessionId: 'preserved-session',
      agentModel: 'gpt-6.1-sol', pinned: true, manualPlacement: true }
    sync.setState(state([archived, node('ordinary')]))
    const result = sync.handleRpc({ id: '', method: CANVAS_MUTATE_METHOD,
      params: { op: 'upsert', node: { ...node('archived'), title: 'Legacy cosmetic edit' } } }) as Extract<CanvasMutation, { op: 'upsert' }>
    expect(result.node).toMatchObject({ cleanupArchiveId: 'reviewed-receipt', agentSessionId: 'preserved-session',
      agentModel: 'gpt-6.1-sol', pinned: true, manualPlacement: true, title: 'Legacy cosmetic edit' })
    expect(sync.handleRpc({ id: '', method: CANVAS_MUTATE_METHOD, params: { op: 'remove', id: 'archived' } })).toBeNull()
    expect(received).toHaveLength(1)
    expect(sync.handleRpc({ id: '', method: CANVAS_MUTATE_METHOD, params: { op: 'remove', id: 'ordinary' } })).toEqual({ op: 'remove', id: 'ordinary' })
    expect(received).toHaveLength(2)
  })
  it('broadcasts the state to the client on setState', () => {
    const { socket, sent } = fakeNotifySocket()
    const sync = createHostCanvasSync(socket, () => {})

    const s = state([node('a')])
    sync.setState(s)

    expect(sent).toEqual([{ method: CANVAS_STATE_METHOD, params: s }])
  })

  it('broadcastCurrent re-sends the latest known state (and is a no-op before any)', () => {
    const { socket, sent } = fakeNotifySocket()
    const sync = createHostCanvasSync(socket, () => {})

    sync.broadcastCurrent()
    expect(sent).toHaveLength(0) // nothing known yet

    const s = state([node('a'), node('b')])
    sync.setState(s)
    sync.broadcastCurrent() // e.g. a fresh client connect

    expect(sent).toEqual([
      { method: CANVAS_STATE_METHOD, params: s },
      { method: CANVAS_STATE_METHOD, params: s }
    ])
  })

  it('routes a canvas:mutate RPC to onMutation for a node the host already has', () => {
    const { socket } = fakeNotifySocket()
    const received: CanvasMutation[] = []
    const sync = createHostCanvasSync(socket, (m) => received.push(m))
    sync.setState(state([node('x')]))

    const moved = { ...node('x'), position: { x: 100, y: 50 } }
    const result = sync.handleRpc({
      id: '',
      method: CANVAS_MUTATE_METHOD,
      params: { op: 'upsert', node: moved } satisfies CanvasMutation
    })

    expect(result).not.toBeNull()
    expect(received).toHaveLength(1)
    const applied = received[0] as Extract<CanvasMutation, { op: 'upsert' }>
    expect(applied.node.position).toEqual({ x: 100, y: 50 })
  })

  it('R7: rejects upserts for node ids the host does not have (no client-created nodes)', () => {
    const { socket } = fakeNotifySocket()
    const received: CanvasMutation[] = []
    const sync = createHostCanvasSync(socket, (m) => received.push(m))
    sync.setState(state([node('a')]))

    const injected = { op: 'upsert', node: node('evil') } satisfies CanvasMutation
    expect(sync.handleRpc({ id: '', method: CANVAS_MUTATE_METHOD, params: injected })).toBeNull()
    // And with NO state known yet, everything is rejected (deny-by-default).
    const empty = createHostCanvasSync(socket, (m) => received.push(m))
    expect(
      empty.handleRpc({ id: '', method: CANVAS_MUTATE_METHOD, params: { op: 'upsert', node: node('a') } })
    ).toBeNull()
    expect(received).toHaveLength(0)
  })

  it('R7: strips host-authoritative fields (shell/cwd/ssh/filePath/url/kind) from client upserts', () => {
    const { socket } = fakeNotifySocket()
    const received: CanvasMutation[] = []
    const sync = createHostCanvasSync(socket, (m) => received.push(m))
    const hostNode: CanvasNodeState = { ...node('t'), shell: '/bin/zsh', cwd: '/safe/project' }
    sync.setState(state([hostNode]))

    const malicious = {
      ...node('t'),
      kind: 'terminal' as const,
      shell: '/bin/sh',
      cwd: '/', // would widen the remote fs jail to the whole disk
      ssh: { host: 'attacker.example' } as never,
      filePath: '/Users/victim/.ssh/id_rsa',
      url: 'https://attacker.example',
      position: { x: 5, y: 5 }
    }
    const result = sync.handleRpc({
      id: '',
      method: CANVAS_MUTATE_METHOD,
      params: { op: 'upsert', node: malicious } satisfies CanvasMutation
    })

    expect(result).not.toBeNull()
    const applied = received[0] as Extract<CanvasMutation, { op: 'upsert' }>
    expect(applied.node.shell).toBe('/bin/zsh')
    expect(applied.node.cwd).toBe('/safe/project')
    expect(applied.node.ssh).toBeUndefined()
    expect(applied.node.filePath).toBeUndefined()
    expect(applied.node.url).toBeUndefined()
    expect(applied.node.position).toEqual({ x: 5, y: 5 }) // layout still applies
  })

  it('ignores non-canvas RPC methods and malformed mutations (returns null, no callback)', () => {
    const { socket } = fakeNotifySocket()
    const received: CanvasMutation[] = []
    const sync = createHostCanvasSync(socket, (m) => received.push(m))
    sync.setState(state([node('a')]))

    expect(sync.handleRpc({ id: 'r1', method: 'pty.create', params: {} })).toBeNull()
    expect(sync.handleRpc({ id: '', method: CANVAS_MUTATE_METHOD, params: null })).toBeNull()
    expect(sync.handleRpc({ id: '', method: CANVAS_MUTATE_METHOD, params: { foo: 1 } })).toBeNull()
    // Malformed layout payloads on a known node are rejected too.
    expect(
      sync.handleRpc({
        id: '',
        method: CANVAS_MUTATE_METHOD,
        params: { op: 'upsert', node: { ...node('a'), position: { x: 'NaN' } } }
      })
    ).toBeNull()
    expect(received).toHaveLength(0)
  })
})
