import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import http from 'http'
import { WebSocketServer } from 'ws'
import WebSocket from 'ws'
import { encodePtyData, E_DISCONNECTED } from '../../shared/rpc'

// RpcClient is exported for tests
import { RpcClient } from './ws-bridge'

let server: http.Server, wss: WebSocketServer, port: number

beforeEach(async () => {
  ;(globalThis as Record<string, unknown>).WebSocket = WebSocket
  server = http.createServer()
  wss = new WebSocketServer({ server })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  port = (server.address() as { port: number }).port
})
afterEach(async () => {
  // Terminate the live client socket(s) first: an upgraded WebSocket connection is detached
  // from the http server's connection tracking, so `wss.close()` alone leaves the socket open
  // and `server.close()` would block forever waiting for it. (Test-infra cleanup only — the
  // assertions above are unchanged.)
  for (const c of wss.clients) c.terminate()
  wss.close()
  await new Promise((r) => server.close(r))
})

describe('RpcClient', () => {
  it('settles requests from responses and fans out JSON + binary events', async () => {
    wss.on('connection', (sock) => {
      sock.on('message', (d, isBinary) => {
        if (isBinary) return
        const m = JSON.parse(d.toString())
        if (m.t === 'req') sock.send(JSON.stringify({ t: 'res', id: m.id, ok: true, result: m.args[0] }))
      })
      sock.send(JSON.stringify({ t: 'ev', channel: 'pty:exit:s1', args: [0] }))
      sock.send(encodePtyData('s1', 'hello'), { binary: true })
    })
    const client = new RpcClient(`ws://127.0.0.1:${port}/`)
    await client.ready()
    const exits: unknown[] = []
    const datas: string[] = []
    client.subscribe('pty:exit:s1', (code) => exits.push(code))
    client.subscribe('pty:data:s1', (d) => datas.push(d as string))
    expect(await client.request('any:method', 'ping')).toBe('ping')
    await new Promise((r) => setTimeout(r, 200))
    expect(exits).toEqual([0])
    expect(datas).toEqual(['hello'])
  })

  it('rejects pending requests with the coded error from an err response', async () => {
    wss.on('connection', (sock) => {
      sock.on('message', (d) => {
        const m = JSON.parse(d.toString())
        sock.send(JSON.stringify({ t: 'res', id: m.id, ok: false, error: { code: 'E_NO_HANDLER', message: 'nope' } }))
      })
    })
    const client = new RpcClient(`ws://127.0.0.1:${port}/`)
    await client.ready()
    await expect(client.request('missing')).rejects.toMatchObject({ code: 'E_NO_HANDLER' })
  })

  // A response can only ever arrive over the socket that carried the request. When that socket
  // closes, every in-flight request is unanswerable — and a promise that neither resolves nor
  // rejects is the worst of the three outcomes: the caller's `finally`/`setBusy(false)` never runs,
  // so a dialog sits on "Creating…" with its Cancel button disabled forever, with no error and no
  // way out. Fail closed: reject them, so `await` throws and every caller's error path can run.
  it('rejects every in-flight request when the socket closes (never hangs them forever)', async () => {
    wss.on('connection', (sock) => {
      // Take the request, answer nothing, and drop the connection — the WS-drop-mid-call case.
      sock.on('message', () => sock.close())
    })
    const client = new RpcClient(`ws://127.0.0.1:${port}/`)
    await client.ready()
    const a = client.request('git:worktree-add', '/repo')
    const b = client.request('git:worktree-remove', '/repo')
    await expect(a).rejects.toMatchObject({ code: E_DISCONNECTED })
    await expect(b).rejects.toMatchObject({ code: E_DISCONNECTED })
  })

  it('still notifies the onClose hooks (the reconnect overlay) when it fails the pending requests', async () => {
    wss.on('connection', (sock) => sock.on('message', () => sock.close()))
    const client = new RpcClient(`ws://127.0.0.1:${port}/`)
    await client.ready()
    let closed = 0
    client.onClose(() => closed++)
    await expect(client.request('anything')).rejects.toThrow()
    expect(closed).toBe(1)
  })
})

it.each([false, true])('keeps actual WS publication ordering behind the ACK barrier, stale-save=%s', async staleSave => {
  const { useProjects } = await import('../state/projects')
  const persistence = await import('../lib/workspacePersistence')
  const { mergeWorkspacePublication } = await import('../lib/workspacePublication')
  const a = 'a'.repeat(64), b = 'b'.repeat(64), c = 'c'.repeat(64)
  const base = { id: 'p', name: 'P', color: '#888', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [] }
  const incoming = { ...base, name: 'Server edit' }
  useProjects.getState().hydrate({ version: 2, activeProjectId: 'p', revision: a, projects: [base] })
  useProjects.setState({ projects: [{ ...base, color: '#000' }] })
  const snapshots: import('@shared/types').Workspace[] = []
  wss.on('connection', sock => sock.on('message', data => {
    const request = JSON.parse(data.toString())
    snapshots.push(request.args[0])
    if (staleSave && snapshots.length === 2) {
      sock.send(JSON.stringify({ t: 'res', id: request.id, ok: true, result: { revision: c, projectRevisions: { p: c } } }))
      return
    }
    // The next server transaction can finish before the previous RPC returns to the browser.
    sock.send(JSON.stringify({ t: 'ev', channel: 'workspace:server-change', args: [{ ...incoming,
      workspaceChange: { before: staleSave ? a : b, after: staleSave ? b : c, changes: [{ before: base, after: incoming }] } }] }))
    sock.send(JSON.stringify(staleSave ? { t: 'res', id: request.id, ok: false, error: { code: 'E_WORKSPACE_CONFLICT', message: 'workspace_conflict: storage changed; reload before saving' } } : { t: 'res', id: request.id, ok: true, result: { revision: b, projectRevisions: { p: b } } }))
  }))
  const client = new RpcClient(`ws://127.0.0.1:${port}/`)
  await client.ready()
  const api = { save: (workspace: import('@shared/types').Workspace) => client.request('workspace:save', workspace),
    onServerChange: (cb: (p: import('@shared/types').Project) => void) => client.subscribe('workspace:server-change', (...args) => cb(args[0] as import('@shared/types').Project)) } as import('@shared/types').WorkspaceApi
  const conflicts: string[] = []
  const handle = (p: import('@shared/types').Project) => {
    const state = useProjects.getState()
    const merged = mergeWorkspacePublication(state.revision, state.projects, p.workspaceChange)
    if (merged.kind === 'conflict') { conflicts.push(merged.reason); return { kind: 'conflict' as const } }
    if (merged.kind === 'duplicate') return { kind: 'duplicate' as const, revision: state.revision! }
    useProjects.setState({ projects: merged.projects, revision: merged.revision })
    return { kind: 'adopt' as const, before: p.workspaceChange!.before, after: merged.revision }
  }
  const unsubscribe = persistence.subscribeWorkspacePublications
    ? persistence.subscribeWorkspacePublications(api, handle) : api.onServerChange(handle)
  try {
    await persistence.saveWorkspace(api)
    expect(conflicts).toEqual([])
    expect(useProjects.getState().revision).toBe(c)
    expect(useProjects.getState().projects[0].name).toBe('Server edit')
    expect(useProjects.getState().projects[0].color).toBe('#000')
    expect(snapshots).toHaveLength(staleSave ? 2 : 1)
    if (staleSave) expect(snapshots[1]).toMatchObject({ revision: b, projects: [{ name: 'Server edit', color: '#000' }] })
  } finally { unsubscribe() }
})
