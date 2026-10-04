/** Disposable loopback fixtures for the management caller; no provider or live server. */
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { afterEach, beforeEach, expect, it } from 'vitest'

let dir: string, base: string, server: http.Server, calls: Array<{ method: string; route: string; body?: unknown }>
let contract: unknown, status: number, createStatus: number
const promise = { version: 1, taskId: 'required', creationKey: 'exact-required',
  metadata: 'owner-project-workstream-functionalRole-required', privateReceipt: 'before-save-and-spawn', verifiedCreatorSource: true }
const capability = (platform = 'linux') => ({ version: 1, assistantCreation: promise,
  receiptPublication: { version: 1, platform, guarantee: platform === 'win32' ? 'file-flush-visibility' : 'file-and-directory-sync' } })
const input = { projectId: 'fixture-project', title: 'Explicit title', idempotencyKey: 'fixture-creation',
  creation: { version: 1, taskId: 'fixture-task', creationId: 'fixture-creation', declaredOwner: 'Declared assistant' },
  organization: { owner: 'Declared assistant', projectId: 'fixture-project', workstream: 'fixture', functionalRole: 'ops' } }
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-organization-caller-'))
  await fs.writeFile(path.join(dir, 'credential'), 'synthetic-disposable-token-0000000', { mode: 0o600 })
  calls = []; contract = capability(); status = 200; createStatus = 201
  server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    calls.push({ method: req.method!, route: req.url!, ...(raw ? { body: JSON.parse(raw) } : {}) })
    expect(req.headers.authorization).toBe('Bearer synthetic-disposable-token-0000000')
    res.setHeader('Content-Type', 'application/json')
    res.statusCode = req.method === 'GET' ? status : createStatus
    res.end(JSON.stringify(req.method === 'GET' ? contract : { id: 'fixture-node', projectId: input.projectId, idempotencyKey: input.idempotencyKey }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  await fs.rm(dir, { recursive: true, force: true })
})
const run = async (body: unknown, command = 'create') => {
  await fs.writeFile(path.join(dir, 'body.json'), JSON.stringify(body))
  return promisify(execFile)(process.execPath, [path.resolve('scripts/nodeterm-organization.mjs'), command,
    '--url', base, '--credential-file', path.join(dir, 'credential'), ...(command === 'create' ? ['--body-file', path.join(dir, 'body.json')] : [])], { timeout: 10_000 })
}

it('refuses missing/mismatched task, key, owner/project/role and unknown envelope fields before any HTTP request', async () => {
  const cases: unknown[] = [{ ...input, creation: undefined }, { ...input, organization: undefined }, { ...input, idempotencyKey: undefined },
    { ...input, creation: { ...input.creation, taskId: undefined } }, { ...input, creation: { ...input.creation, creationId: 'changed-key' } },
    { ...input, creation: { ...input.creation, declaredOwner: 'Different owner' } }, { ...input, creation: { ...input.creation, version: true } },
    { ...input, creation: { ...input.creation, trusted: true } }, { ...input, organization: { ...input.organization, projectId: 'foreign' } },
    { ...input, organization: { ...input.organization, functionalRole: undefined } }]
  for (const body of cases) await expect(run(body)).rejects.toMatchObject({ code: 3 })
  expect(calls).toEqual([])
})

it('refuses old/unavailable/weaker or inconsistent receipt publication capabilities without POST or recovery reads', async () => {
  for (const candidate of [undefined, { version: 1 }, { ...capability(), version: 2 },
    { ...capability(), assistantCreation: { ...promise, privateReceipt: 'optional' } },
    { ...capability(), receiptPublication: { version: 1, platform: 'win32', guarantee: 'file-and-directory-sync' } },
    { ...capability(), receiptPublication: { version: 1, platform: 'unknown', guarantee: 'file-and-directory-sync' } }]) {
    calls = []; contract = candidate ?? {}; status = candidate === undefined ? 404 : 200
    await expect(run(input)).rejects.toMatchObject({ code: 3, stderr: expect.stringContaining('creation_contract_unavailable_or_incompatible_no_post') })
    expect(calls.map(c => [c.method, c.route])).toEqual([['GET', '/opsapi/creation-contract']])
  }
})

it.each(['linux', 'win32'])('checks %s capability then sends exactly the reviewed body/key once, with no automatic retry', async platform => {
  contract = capability(platform)
  const result = JSON.parse((await run(input)).stdout)
  expect(result.idempotencyKey).toBe(input.idempotencyKey)
  expect(calls).toEqual([{ method: 'GET', route: '/opsapi/creation-contract' }, { method: 'POST', route: '/opsapi/nodes', body: input }])
  calls = []; createStatus = 503
  await expect(run(input)).rejects.toMatchObject({ code: 2, stdout: expect.stringContaining(input.idempotencyKey) })
  expect(calls.map(c => c.method)).toEqual(['GET', 'POST'])
})

it('exposes the authenticated contract read without creating or recovering a node', async () => {
  expect(JSON.parse((await run({}, 'contract')).stdout)).toEqual(capability())
  expect(calls.map(c => [c.method, c.route])).toEqual([['GET', '/opsapi/creation-contract']])
})
