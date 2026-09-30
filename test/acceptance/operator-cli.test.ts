import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'

const cli = path.resolve('scripts/nodeterm-operator.mjs')
const tempDirs: string[] = []
const servers: http.Server[] = []
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeterm-operator-cli-'))
  tempDirs.push(dir)
  const credential = path.join(dir, 'credential')
  fs.writeFileSync(credential, 'a'.repeat(48), { mode: 0o600 })
  const targetFile = path.join(dir, 'target.json')
  fs.writeFileSync(targetFile, JSON.stringify({ projectId: 'project1', nodeId: 'node1234', sessionId: 'session1234', generation: 'generation1234' }))
  return { dir, credential, targetFile }
}
function server(handler: (req: http.IncomingMessage, res: http.ServerResponse) => void) {
  const instance = http.createServer(handler)
  servers.push(instance)
  return new Promise<string>((resolve) => instance.listen(0, '127.0.0.1', () => {
    const addr = instance.address() as import('node:net').AddressInfo
    resolve(`http://127.0.0.1:${addr.port}`)
  }))
}
function run(args: string[], input?: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''; let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (s) => { stdout += s })
    child.stderr.setEncoding('utf8').on('data', (s) => { stderr += s })
    child.on('close', (code) => resolve({ code, stdout, stderr }))
    child.stdin.end(input)
  })
}
function baseArgs(url: string, f: ReturnType<typeof fixture>) { return ['--url', url, '--credential-file', f.credential] }

afterEach(() => {
  for (const instance of servers.splice(0)) instance.close()
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('external operator CLI', () => {
  it('calls capabilities and sessions with the separate credential, returning JSON', async () => {
    const f = fixture()
    const url = await server((req, res) => {
      expect(req.headers.authorization).toBe(`Bearer ${'a'.repeat(48)}`)
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(req.url?.endsWith('capabilities')
        ? { version: 1, permissions: { read: true, message: false }, receipts: true, pagination: 'snapshot', terminalSuggestions: false }
        : { version: 1, targets: [] }))
    })
    for (const command of ['capabilities', 'sessions']) {
      const result = await run([...baseArgs(url, f), command])
      expect(result.code).toBe(0)
      expect(JSON.parse(result.stdout).version).toBe(1)
      expect(result.stderr).toBe('')
    }
  })

  it('retrieves an authenticated receipt as JSON', async () => {
    const f = fixture()
    const receiptId = '00000000-0000-4000-8000-000000000000'
    const url = await server((req, res) => {
      expect(req.url).toBe(`/opsapi/v1/receipts/${receiptId}`)
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ version: 1, id: receiptId, target: { projectId: 'project1', nodeId: 'node1234', sessionId: 'session1234', generation: 'generation1234' }, state: 'accepted', createdAt: 'now', updatedAt: 'now', outcome: 'accepted' }))
    })
    const result = await run([...baseArgs(url, f), '--id', receiptId, 'receipt'])
    expect(result.code).toBe(0)
    expect(JSON.parse(result.stdout).id).toBe(receiptId)
  })

  it('reads a target with pagination and sends stdin body without putting message in argv', async () => {
    const f = fixture(); const bodySeen: string[] = []
    const url = await server((req, res) => {
      if (req.method === 'POST') {
        req.setEncoding('utf8'); req.on('data', (chunk) => bodySeen.push(chunk)); req.on('end', () => {
          res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ version: 1, id: '00000000-0000-4000-8000-000000000000', target: JSON.parse(bodySeen.join('')).target, state: 'accepted', createdAt: 'now', updatedAt: 'now', outcome: 'accepted' }))
        })
      } else {
        expect(req.url).toContain('limit=10'); expect(req.url).toContain('nodeId=node1234')
        res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ version: 1, target: { projectId: 'project1', nodeId: 'node1234', sessionId: 'session1234', generation: 'generation1234' }, items: [], nextCursor: null }))
      }
    })
    const read = await run([...baseArgs(url, f), '--target-file', f.targetFile, '--limit', '10', 'read'])
    expect(read.code).toBe(0)
    const secretText = 'message content stays on stdin and out of argv'
    const send = await run([...baseArgs(url, f), '--target-file', f.targetFile, '--idempotency-key', 'fern-task-001', 'send'], secretText)
    expect(send.code).toBe(0)
    expect(JSON.parse(bodySeen.join('')).text).toBe(secretText)
    expect(send.stderr).not.toContain(secretText)
  })

  it('rejects remote or path-bearing URLs before making a request', async () => {
    const f = fixture()
    for (const url of ['https://127.0.0.1:8443', 'http://example.com:8443', 'http://127.0.0.1:8443/foo', 'http://user@127.0.0.1:8443']) {
      const result = await run(['--url', url, ...baseArgs('http://127.0.0.1:1', f).slice(2), 'capabilities'])
      expect(result.code).toBe(2)
      expect(JSON.parse(result.stderr).error).toBe('loopback_url_required')
    }
  })

  it.skipIf(process.platform === 'win32')('fails closed on loose credential permissions', async () => {
    const f = fixture(); fs.chmodSync(f.credential, 0o644)
    const local = await run([...baseArgs('http://127.0.0.1:1', f), 'capabilities'])
    expect(JSON.parse(local.stderr).error).toBe('credential_file_not_private')
  })

  it('rejects protocol mismatch', async () => {
    const f = fixture()
    fs.chmodSync(f.credential, 0o600)
    const url = await server((_req, res) => { res.setHeader('content-type', 'application/json'); res.end('{"version":2}') })
    const mismatch = await run([...baseArgs(url, f), 'capabilities'])
    expect(mismatch.code).toBe(4)
    expect(JSON.parse(mismatch.stderr).error).toBe('protocol_version_mismatch')
  })
})
