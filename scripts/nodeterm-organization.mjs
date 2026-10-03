#!/usr/bin/env node
// Management bearer stays in memory, never in argv, generated shell or printed diagnostics.
import fs from 'node:fs'

const fail = (message) => { throw new Error(message) }
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
    if (command === 'create' && !/^[A-Za-z0-9._-]{8,128}$/.test(parsed.idempotencyKey ?? '')) fail('create_requires_idempotency_key')
    body = JSON.stringify(parsed)
  }
  const response = await fetch(url.origin + route, { method, body, redirect: 'error',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, signal: AbortSignal.timeout(35_000) })
  const result = await response.json()
  // Preserve partial IDs and receipts even on a rejection. Never retry a create automatically.
  process.stdout.write(`${JSON.stringify(result)}\n`)
  if (!response.ok) process.exitCode = 2
}
main().catch((error) => {
  process.stderr.write(`${error?.name === 'TimeoutError' ? 'request_timeout: inspect the same key receipt; do not create again' : error.message}\n`)
  process.exitCode = 3
})
