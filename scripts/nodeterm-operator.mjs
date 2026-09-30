#!/usr/bin/env node
import fs from 'node:fs'
import process from 'node:process'

const VERSION = 1
const TIMEOUT_MS = 10_000
const fail = (code, status = 2) => { throw Object.assign(new Error(code), { code, status }) }

function args(argv) {
  const opts = { positional: [] }
  for (let i = 0; i < argv.length; i++) {
    const value = argv[i]
    if (value === '--url' || value === '--credential-file' || value === '--target-file' || value === '--cursor' || value === '--limit' || value === '--message-file' || value === '--idempotency-key' || value === '--id') {
      if (opts[value.slice(2)] !== undefined || !argv[i + 1] || argv[i + 1].startsWith('--')) fail('invalid_arguments')
      opts[value.slice(2)] = argv[++i]
    } else if (value.startsWith('--')) fail('invalid_arguments')
    else opts.positional.push(value)
  }
  return opts
}

function readPrivateFile(file) {
  if (!file) fail('credential_file_required')
  let fd
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.size > 4096) fail('invalid_credential_file')
    if (process.platform !== 'win32' && ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid()))) fail('credential_file_not_private')
    const token = fs.readFileSync(fd, 'utf8').trim()
    if (!/^[A-Za-z0-9_-]{40,128}$/.test(token)) fail('invalid_credential_file')
    return token
  } catch (error) {
    if (error?.code) throw error
    fail('credential_file_unavailable')
  } finally { if (fd !== undefined) fs.closeSync(fd) }
}

function baseUrl(value) {
  let url
  try { url = new URL(value) } catch { fail('invalid_url') }
  const loopbacks = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])
  if (url.protocol !== 'http:' || !loopbacks.has(url.hostname) || url.username || url.password ||
    (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) fail('loopback_url_required')
  return url.origin
}

function readJsonFile(file, code) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { fail(code) }
}

function targetFrom(file) {
  const value = readJsonFile(file, 'invalid_target_file')
  const keys = ['projectId', 'nodeId', 'sessionId', 'generation']
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length ||
    keys.some((key) => typeof value[key] !== 'string' || !value[key] || value[key].length > 256)) fail('invalid_target_file')
  return value
}

async function main() {
  const o = args(process.argv.slice(2))
  const command = o.positional[0]
  if (!['capabilities', 'sessions', 'read', 'send', 'receipt'].includes(command) || o.positional.length !== 1) fail('invalid_command')
  const base = baseUrl(o.url)
  const token = readPrivateFile(o['credential-file'])
  const headers = { authorization: `Bearer ${token}`, accept: 'application/json' }
  let route, method = 'GET', body
  if (command === 'capabilities') route = '/opsapi/v1/capabilities'
  if (command === 'sessions') route = '/opsapi/v1/sessions'
  if (command === 'read') {
    const target = targetFrom(o['target-file'])
    const q = new URLSearchParams(target)
    if (o.cursor) q.set('cursor', o.cursor)
    if (o.limit !== undefined) q.set('limit', o.limit)
    route = `/opsapi/v1/conversation?${q}`
  }
  if (command === 'send') {
    const target = targetFrom(o['target-file'])
    if (!o['idempotency-key'] || !/^[A-Za-z0-9._-]{8,128}$/.test(o['idempotency-key'])) fail('idempotency_key_required')
    const message = o['message-file'] ? fs.readFileSync(o['message-file'], 'utf8') : fs.readFileSync(0, 'utf8')
    if (!message.trim() || Buffer.byteLength(message) > 8000) fail('invalid_message')
    method = 'POST'; route = '/opsapi/v1/messages'; headers['content-type'] = 'application/json'
    headers['idempotency-key'] = o['idempotency-key']; body = JSON.stringify({ target, text: message })
  }
  if (command === 'receipt') {
    if (!o.id || !/^[a-f0-9-]{36}$/.test(o.id)) fail('invalid_receipt_id')
    route = `/opsapi/v1/receipts/${o.id}`
  }
  let response
  try {
    response = await fetch(base + route, { method, headers, body, redirect: 'error', signal: AbortSignal.timeout(TIMEOUT_MS) })
  } catch (error) {
    fail(error?.name === 'TimeoutError' ? 'request_timeout' : 'request_failed', 3)
  }
  let data
  try { data = await response.json() } catch { fail('invalid_server_response', 3) }
  if (data?.version !== VERSION) fail('protocol_version_mismatch', 4)
  if (!response.ok) fail(typeof data?.error === 'string' ? data.error : `http_${response.status}`, 2)
  process.stdout.write(`${JSON.stringify(data)}\n`)
}

main().catch((error) => {
  const code = typeof error?.code === 'string' ? error.code : 'request_failed'
  process.stderr.write(`${JSON.stringify({ error: code })}\n`)
  process.exitCode = error?.status ?? 2
})
