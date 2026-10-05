#!/usr/bin/env node
// Management bearer stays in memory, never in argv, generated shell or printed diagnostics.
import fs from 'node:fs'

const fail = (message) => { throw new Error(message) }
const forbidden = new Set(['__proto__', 'prototype', 'constructor'])
const identifier = (value, min = 1, max = 128) => typeof value === 'string' &&
  new RegExp(`^[A-Za-z0-9._-]{${min},${max}}$`).test(value) && !forbidden.has(value)
const label = value => typeof value === 'string' && value.length > 0 && value.length <= 160 && !/[\x00-\x1f\x7f]/.test(value)
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key))
function validateCreation(body) {
  if (!body || !identifier(body.idempotencyKey, 8)) fail('create_requires_idempotency_key')
  const c = body.creation, o = body.organization
  if (!exact(c, ['version', 'taskId', 'creationId', 'declaredOwner', ...(c?.planning === undefined ? [] : ['planning'])]) || c.version !== 1 ||
    !identifier(c.taskId, 8) || !identifier(c.creationId, 8) || c.creationId !== body.idempotencyKey || !label(c.declaredOwner) ||
    !exact(o, ['owner', 'projectId', 'workstream', 'functionalRole']) || !label(o.owner) || o.owner !== c.declaredOwner ||
    !identifier(body.projectId) || ['.', '..'].includes(body.projectId) || o.projectId !== body.projectId ||
    !identifier(o.workstream, 1, 80) || !identifier(o.functionalRole, 1, 80))
    fail('create_requires_task_owner_organization_and_exact_creation_key')
  if (c.planning !== undefined && (!c.planning || typeof c.planning !== 'object' || Array.isArray(c.planning) || c.planning.taskId !== c.taskId))
    fail('creation_planning_requires_exact_task_identity')
}
function creationContract(contract) {
  const promised = { version: 1, taskId: 'required', creationKey: 'exact-required',
    metadata: 'owner-project-workstream-functionalRole-required', privateReceipt: 'before-save-and-spawn', verifiedCreatorSource: true,
    taskPlanning: 'category-urgency-reason-relationship-before-save-and-spawn' }
  const c = contract?.assistantCreation, p = contract?.receiptPublication
  return contract?.version === 1 && exact(c, Object.keys(promised)) && Object.entries(promised).every(([key, value]) => c[key] === value) &&
    p?.version === 1 && ['aix', 'android', 'darwin', 'freebsd', 'haiku', 'linux', 'openbsd', 'sunos', 'win32', 'cygwin', 'netbsd'].includes(p.platform) &&
    p.guarantee === (p.platform === 'win32' ? 'file-flush-visibility' : 'file-and-directory-sync')
}
const opts = {}
const [command, ...argv] = process.argv.slice(2)
async function main() {
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]
    if (!['--url', '--credential-file', '--body-file', '--node', '--key'].includes(flag) ||
      !argv[i + 1] || Object.hasOwn(opts, flag)) fail('invalid_arguments')
    opts[flag] = argv[i + 1]
  }
  const url = new URL(opts['--url'] ?? 'http://127.0.0.1:8443')
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.username || url.password || url.pathname !== '/' || url.search || url.hash) fail('loopback_url_required')
  if (!opts['--credential-file']) fail('credential_file_required')
  const fd = fs.openSync(opts['--credential-file'], fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
  let token
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.size > 4096 || (process.platform !== 'win32' &&
      ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) fail('credential_file_not_private')
    token = fs.readFileSync(fd, 'utf8').trim()
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(token)) fail('invalid_credential_file')
  } finally { fs.closeSync(fd) }
  const id = opts['--node']
  if (id !== undefined && !/^[A-Za-z0-9._-]{1,128}$/.test(id)) fail('invalid_node_id')
  const routes = {
    contract: ['GET', '/opsapi/creation-contract'],
    boards: ['GET', '/opsapi/boards'],
    create: ['POST', '/opsapi/nodes'],
    update: ['PATCH', `/opsapi/nodes/${id}`],
    preview: ['POST', '/opsapi/organization/preview'],
    audit: ['GET', `/opsapi/nodes/${id}/organization-audit`],
    undo: ['POST', `/opsapi/nodes/${id}/organization-undo`],
    receipt: ['GET', `/opsapi/creation-receipts/${encodeURIComponent(opts['--key'] ?? '')}`],
    'retry-events': ['POST', '/opsapi/organization/retry-events']
  }
  if (!Object.hasOwn(routes, command)) fail('invalid_command')
  if (['update', 'audit', 'undo'].includes(command) && !id) fail('node_required')
  if (command === 'receipt' && !/^[A-Za-z0-9._-]{8,128}$/.test(opts['--key'] ?? '')) fail('key_required')
  const [method, route] = routes[command]
  let body
  if (['create', 'update', 'preview', 'undo'].includes(command)) {
    const raw = opts['--body-file'] ? fs.readFileSync(opts['--body-file'], 'utf8') : fs.readFileSync(0, 'utf8')
    if (Buffer.byteLength(raw) > 10 * 1024) fail('body_too_large')
    const parsed = JSON.parse(raw)
    if (command === 'create') validateCreation(parsed)
    body = JSON.stringify(parsed)
  }
  const request = (method, route, body) => fetch(url.origin + route, { method, body, redirect: 'error',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, signal: AbortSignal.timeout(35_000) })
  if (command === 'create') {
    try {
      const capability = await request('GET', '/opsapi/creation-contract')
      if (!capability.ok || !creationContract(await capability.json())) fail('creation_contract_incompatible_no_post')
    } catch { fail('creation_contract_unavailable_or_incompatible_no_post') }
  }
  const response = await request(method, route, body)
  const result = await response.json()
  // Preserve partial IDs and receipts even on a rejection. Never retry a create automatically.
  process.stdout.write(`${JSON.stringify(result)}\n`)
  if (!response.ok) process.exitCode = 2
}
main().catch((error) => {
  process.stderr.write(`${error?.name === 'TimeoutError' ? 'request_timeout: inspect the same key receipt; do not create again' : error.message}\n`)
  process.exitCode = 3
})
