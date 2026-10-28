import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import WebSocket from 'ws'
import { startServer } from '../../src/server/index'
import { SESSION_COOKIE } from '../../src/server/http'
import { IPC } from '../../src/shared/ipc'
import { PRESENCE_COLORS, type PeerDiff, type PeerState } from '../../src/shared/presence'

interface Ev {
  t: 'ev' | 'res'
  id?: number
  channel?: string
  args?: unknown[]
  ok?: boolean
  result?: unknown
}

/** Open an authenticated WS and record every JSON message it receives. */
async function connect(port: number, cookie: string): Promise<{ ws: WebSocket; msgs: Ev[] }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie } })
  const msgs: Ev[] = []
  ws.on('message', (d, isBinary) => {
    if (isBinary) return
    msgs.push(JSON.parse(d.toString()) as Ev)
  })
  await new Promise<void>((res, rej) => {
    ws.on('open', () => res())
    ws.on('error', rej)
  })
  return { ws, msgs }
}

/** Poll until `pred` holds (or fail the test after ~2s) — the fan-out is async over sockets. */
async function until(pred: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (pred()) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`timed out waiting for: ${what}`)
}

function diffs(msgs: Ev[]): PeerDiff[] {
  return msgs
    .filter((m) => m.t === 'ev' && m.channel === IPC.presencePeer)
    .map((m) => m.args![0] as PeerDiff)
}

describe('server e2e: presence with two clients', () => {
  let dataDir: string, close: () => Promise<void>, port: number, cookie: string

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-presence-'))
    const srv = await startServer({
      port: 0,
      host: '127.0.0.1',
      dataDir,
      rendererDir: path.join(dataDir, 'no-renderer'),
      insecureHttp: false,
      passwordSeed: 'e2e-password-123',
      // Never touch the developer's real ~/.claude (see server-e2e.test.ts).
      installHooks: false
    })
    port = srv.port
    close = srv.close
    const res = await fetch(`http://127.0.0.1:${port}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'password=e2e-password-123',
      redirect: 'manual'
    })
    cookie = res.headers.get('set-cookie')!.split(';')[0]
    expect(cookie).toContain(SESSION_COOKIE)
  }, 30_000)

  afterAll(async () => {
    await close?.()
    // The server can still be flushing a file as it closes; retry the removal rather than fail the suite on ENOTEMPTY.
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })

  it('hello → own id + snapshot; cursor fans out to the other client; disconnect → leave', async () => {
    const a = await connect(port, cookie)
    const b = await connect(port, cookie)

    // B's join reached A as a diff, and B got its own snapshot on connect.
    await until(() => diffs(a.msgs).some((d) => d.op === 'join'), "A sees B's join")
    await until(
      () => b.msgs.some((m) => m.t === 'ev' && m.channel === IPC.presenceSync),
      'B receives presence:sync'
    )

    // A says hello: the response carries A's OWN clientId (so A never draws its own cursor).
    a.ws.send(
      JSON.stringify({
        t: 'req',
        id: 1,
        method: IPC.presenceHello,
        args: [{ name: 'Ada', color: PRESENCE_COLORS[2] }]
      })
    )
    await until(() => a.msgs.some((m) => m.t === 'res' && m.id === 1), 'hello response')
    const res = a.msgs.find((m) => m.t === 'res' && m.id === 1)!
    const hello = res.result as { clientId: number; peers: PeerState[] }
    expect(res.ok).toBe(true)
    expect(typeof hello.clientId).toBe('number')
    expect(hello.peers.map((p) => p.clientId)).toContain(hello.clientId)
    expect(hello.peers).toHaveLength(2)
    expect(hello.peers.find((p) => p.clientId === hello.clientId)!.name).toBe('Ada')
    expect(hello.peers.every((p) => p.kind === 'browser')).toBe(true)

    // A moves its cursor → B sees an update diff stamped with A's clientId.
    a.ws.send(JSON.stringify({ t: 'cast', method: IPC.presenceCursor, args: [{ x: 100, y: 200 }] }))
    await until(
      () =>
        diffs(b.msgs).some(
          (d) => d.op === 'update' && d.clientId === hello.clientId && d.patch.cursor?.x === 100
        ),
      "B sees A's cursor"
    )

    // A opens a project → B learns which canvas A is on (the filter that keeps A's cursor off
    // B's screen when they are on different projects).
    a.ws.send(JSON.stringify({ t: 'cast', method: IPC.presenceProject, args: ['web'] }))
    await until(
      () =>
        diffs(b.msgs).some(
          (d) => d.op === 'update' && d.clientId === hello.clientId && d.patch.projectId === 'web'
        ),
      "B sees A's project"
    )

    // A disconnects → B sees the leave.
    a.ws.close()
    await until(
      () => diffs(b.msgs).some((d) => d.op === 'leave' && d.clientId === hello.clientId),
      "B sees A's leave"
    )
    b.ws.close()
  }, 20_000)
})
