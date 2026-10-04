#!/usr/bin/env node
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import process from 'node:process'

const fail = (code) => { throw Object.assign(new Error(code), { code }) }
const options = new Map()
const [command, ...argv] = process.argv.slice(2)
function localPath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) ||
    (process.platform !== 'win32' && /(?:^|[\/])[A-Za-z]:[\\/]/.test(value)) ||
    (process.platform === 'win32' && !/^(?:[A-Za-z]:[\\/]|(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+[\\/])/.test(value))) fail('absolute_local_path_required')
  return value
}
function jsonFile(value) {
  const file = localPath(value)
  const stat = fs.statSync(file)
  if (!stat.isFile() || stat.size > 64_000) fail('invalid_request_file')
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
}
async function main() {
  if (!['preview', 'reviewed-preview', 'archive', 'undo', 'receipt', 'receipts'].includes(command)) fail('invalid_command')
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--url', '--credential-file', '--request-file', '--receipt-id', '--output'].includes(argv[i]) ||
      options.has(argv[i]) || !argv[i + 1] || argv[i + 1].startsWith('--')) fail('invalid_arguments')
    options.set(argv[i], argv[i + 1])
  }
  const allowed = new Set(['--url', '--credential-file', '--output',
    ...(['archive','reviewed-preview'].includes(command) ? ['--request-file'] : command === 'undo' || command === 'receipt' ? ['--receipt-id'] : [])])
  if ([...options.keys()].some(key => !allowed.has(key))) fail('unexpected_option')
  const base = new URL(options.get('--url') ?? 'http://127.0.0.1:8443')
  if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) ||
    base.username || base.password || base.pathname !== '/' || base.search || base.hash) fail('loopback_url_required')
  const file = localPath(options.get('--credential-file'))
  if (fs.lstatSync(file).isSymbolicLink()) fail('invalid_credential_file')
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
  let token
  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile() || stat.size > 4096 || (process.platform !== 'win32' &&
      ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()))) fail('credential_file_not_private')
    token = fs.readFileSync(fd, 'utf8').trim()
    if (!/^[A-Za-z0-9_-]{40,128}$/.test(token)) fail('invalid_credential_file')
  } finally { fs.closeSync(fd) }
  let body, route = `/opsapi/cleanup/${command}`, method = ['preview', 'receipt', 'receipts'].includes(command) ? 'GET' : 'POST'
  if (['archive','reviewed-preview'].includes(command)) body = jsonFile(options.get('--request-file'))
  if (command === 'undo' || command === 'receipt') {
    const id = options.get('--receipt-id')
    if (!/^[a-f0-9-]{36}$/.test(id ?? '')) fail('invalid_receipt_id')
    if (command === 'receipt') route = `/opsapi/cleanup/receipts/${id}`
    else body = { receiptId: id }
  }
  const payload = body === undefined ? undefined : JSON.stringify(body)
  // Reserve the output packet before sending a mutation. An existing or invalid output path
  // must not produce an archive followed by a misleading local EEXIST/path refusal.
  const outputFd = options.has('--output') ? fs.openSync(localPath(options.get('--output')), 'wx', 0o600) : undefined
  try {
    const result = await new Promise((resolve, reject) => {
      // Direct loopback http: no proxy environment, redirect handling, or credential in argv.
      const req = http.request(new URL(route, base), { method, headers: { authorization: `Bearer ${token}`,
        accept: 'application/json', ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}) } }, res => {
        let data = '', size = 0
        res.on('data', b => { size += b.length; if (size > 1024 * 1024) req.destroy(new Error('response_too_large')); else data += b })
        res.on('error', reject)
        res.on('end', () => {
          try {
            const json = JSON.parse(data)
            if (res.statusCode !== 200) fail(json.error ?? `http_${res.statusCode}`)
            if (json.version !== 1) fail('protocol_version_mismatch')
            resolve(json)
          } catch (e) { reject(e) }
        })
      })
      req.setTimeout(30_000, () => req.destroy(new Error('request_timeout_outcome_unknown')))
      req.on('error', reject)
      req.end(payload)
    })
    const text = `${JSON.stringify(result, null, 2)}\n`
    if (outputFd !== undefined) fs.writeFileSync(outputFd, text)
    process.stdout.write(text)
  } finally { if (outputFd !== undefined) fs.closeSync(outputFd) }
}
main().catch(e => { process.stderr.write(`${JSON.stringify({ error: e.code ?? e.message ?? 'request_failed' })}\n`); process.exitCode = 1 })
